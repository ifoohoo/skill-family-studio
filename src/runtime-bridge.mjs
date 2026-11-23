// @feature STU003

import { lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { digestDocument } from 'skill-family-contracts';
import {
  FOUNDATION_PACKAGE_VERSION,
  PROCESS_STATUSES,
  STATE_GENESIS_DIGEST,
  acquireFilesystemLock,
  appendEvent,
  closeStateStore,
  inspectFilesystemLock,
  inspectStateStoreLock,
  openStateStore,
  releaseFilesystemLock,
  resolveContained,
  superviseProcess,
  writeFileAtomic,
  writeSnapshot,
} from 'skill-family-harness-node';
import { cleanInlinePlain, extractArtifactBrief, sanitizePublicText } from './markdown-render.mjs';

export const STUDIO_RUNTIME_REGISTRY_PATH = '.skill-family-studio/runtime-registry.json';
export const FOUNDATION_RUNTIME_REGISTRY_PATH = '.artifacts/runtime-monitor/registry.json';
export const LEGACY_RUNTIME_REGISTRY_PATH = 'artifacts/runtime-monitor/registry.json';
export const DEFAULT_LOCK_WARN_MS = 30_000;

const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'keychains']);
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.venv', '__pycache__']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSensitiveSegment(pathVal) {
  return String(pathVal ?? '').split(/[\\/]+/).some(seg => {
    const low = seg.toLowerCase();
    return SENSITIVE_SEGMENTS.has(low) || low === '.env' || low.startsWith('.env.');
  });
}

function canonicalAncestorSync(targetAbs) {
  let cur = resolve(targetAbs);
  const tail = [];
  while (true) {
    try {
      lstatSync(cur);
      const realBase = realpathSync(cur);
      return tail.length ? resolve(realBase, ...tail.reverse()) : realBase;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw Object.assign(new Error(`无法核验监控路径：${err.message}`), { statusCode: 403 });
    }
    const parent = dirname(cur);
    if (parent === cur) return tail.length ? resolve(cur, ...tail.reverse()) : cur;
    tail.push(basename(cur));
    cur = parent;
  }
}

function isWithin(candidateAbs, rootAbs) {
  if (!rootAbs) return false;
  return candidateAbs === rootAbs || candidateAbs.startsWith(rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`);
}

export function resolveRuntimeTargetPath(root, inputPath, { allowedRoots = [], strict = false } = {}) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const trimmed = inputPath.trim();
  if (!trimmed) return null;
  const fail = msg => {
    if (strict) throw Object.assign(new Error(msg), { statusCode: 403 });
    return null;
  };
  if (trimmed.includes('\0') || trimmed.split(/[\\/]+/).includes('..')) {
    return fail(`监控目标路径禁止包含 ".." 上级跳转或控制字符：${trimmed}`);
  }
  if (hasSensitiveSegment(trimmed)) {
    return fail(`已拒绝注册或读取敏感隐藏目录路径：${trimmed}`);
  }
  const baseRoot = resolve(root || '.');
  const rawCandidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseRoot, trimmed);
  let canonical;
  let canonicalBase;
  try {
    canonical = canonicalAncestorSync(rawCandidate);
    canonicalBase = canonicalAncestorSync(baseRoot);
  } catch (err) {
    return fail(err.message);
  }
  if (hasSensitiveSegment(canonical)) return fail(`已拒绝注册或读取敏感隐藏目录路径：${trimmed}`);
  if (!isAbsolute(trimmed) && !isWithin(canonical, canonicalBase)) {
    return fail(`相对监控路径超出当前工作区根目录边界：${trimmed}`);
  }
  const roots = [baseRoot, tmpdir(), ...allowedRoots].map(r => {
    try { return canonicalAncestorSync(resolve(r)); } catch { return null; }
  }).filter(Boolean);
  if (!roots.some(r => isWithin(canonical, r))) {
    return fail(`监控目标路径超出允许观测的根目录边界：${trimmed}`);
  }
  return canonical;
}

function shortDisplayPath(fullPath) {
  const clean = sanitizePublicText(String(fullPath ?? ''));
  const parts = clean.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return clean;
  return `…/${parts.slice(-3).join('/')}`;
}

async function safeLstat(p) { try { return await lstat(p); } catch { return null; } }
async function safeJson(p) { try { return { ok: true, value: JSON.parse(await readFile(p, 'utf8')) }; } catch { return { ok: false }; } }

async function walkBounded(rootDir, maxDepth = 3, accept = null) {
  const out = [];
  async function visit(dir, d) {
    if (d > maxDepth || out.length >= 120) return;
    let ents = [];
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory() && !SKIP_SCAN_DIRS.has(e.name) && !e.name.startsWith('.')) await visit(full, d + 1);
      else if (e.isFile() && (!accept || accept(e.name))) out.push(full);
    }
  }
  await visit(rootDir, 0);
  return out;
}

function cleanMarkdownInline(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTaskStatus(raw) {
  const text = String(raw ?? '').trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  if (/\[done\]|^done$|^completed?$|^passed?$|^pass$|^succeeded$|^ok$|^exited$/i.test(lower)) return 'done';
  if (/\[process\]|\[running\]|\[wip\]|^running$|^in[_-\s]?progress$|^active$|^supervising$/i.test(lower)) return 'running';
  if (/\[blocked\]|\[failed\]|^blocked$|^failed$|^error$|^timed_out$|^terminated$/i.test(lower)) return 'blocked';
  if (/\[todo\]|^todo$|^pending$|^planned$|^queued$/i.test(lower)) return 'todo';
  if (/不适用/.test(text)) return null;
  if (/失败|阻断|异常|超时/.test(text) && !/零失败|0\s*fail|无异常/.test(text)) return 'blocked';
  if (/进行中|正在|待授权|待重验|待用户/.test(text)) return 'running';
  if (/尚未|待推进|未启动|未完成|待办/.test(text)) return 'todo';
  if (/已完成|全部通过|验证通过|核对通过|全绿|完成/.test(text)) return 'done';
  return null;
}

function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csvText[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some(cell => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some(cell => cell.length > 0)) rows.push(row);
  return rows;
}

function summarizeMilestones(tasks) {
  const map = new Map();
  for (const task of tasks) {
    const group = task.group || '默认阶段';
    if (!map.has(group)) {
      map.set(group, { name: group, total: 0, done: 0, running: 0, todo: 0, blocked: 0, percent: 0 });
    }
    const item = map.get(group);
    item.total += 1;
    if (task.status === 'done') item.done += 1;
    else if (task.status === 'running') item.running += 1;
    else if (task.status === 'blocked') item.blocked += 1;
    else item.todo += 1;
  }
  const milestones = [...map.values()];
  for (const m of milestones) {
    m.percent = m.total > 0 ? Math.round((m.done / m.total) * 100) : 0;
  }
  return milestones;
}

function aggregateTreeNode(node) {
  if (!node.children || node.children.length === 0) {
    const st = node.status || 'todo';
    node.total = 1;
    node.done = st === 'done' ? 1 : 0;
    node.running = st === 'running' ? 1 : 0;
    node.blocked = st === 'blocked' ? 1 : 0;
    node.todo = st === 'todo' ? 1 : 0;
    node.percent = st === 'done' ? 100 : 0;
    return node;
  }
  let total = 0, done = 0, running = 0, blocked = 0, todo = 0;
  for (const ch of node.children) {
    aggregateTreeNode(ch);
    total += ch.total;
    done += ch.done;
    running += ch.running;
    blocked += ch.blocked;
    todo += ch.todo;
  }
  node.total = total;
  node.done = done;
  node.running = running;
  node.blocked = blocked;
  node.todo = todo;
  node.percent = total > 0 ? Math.round((done / total) * 100) : 0;
  node.status = blocked > 0 ? 'blocked' : (running > 0 ? 'running' : (done === total && total > 0 ? 'done' : 'todo'));
  return node;
}

function collectLeafTasks(tree, out = []) {
  for (const node of tree) {
    if (!node.children || node.children.length === 0) {
      out.push(node);
    } else {
      collectLeafTasks(node.children, out);
    }
  }
  return out;
}

function buildFocusBanner(tree, tasks) {
  const runningLeaf = tasks.find(t => t.status === 'running') || tasks.find(t => t.status === 'blocked') || tasks.find(t => t.status === 'todo') || null;
  const activePath = [];
  const findPath = (nodes, targetId, trail) => {
    for (const n of nodes) {
      const next = [...trail, n.title];
      if (n.id === targetId && (!n.children || n.children.length === 0)) return next;
      if (n.children?.length) {
        const hit = findPath(n.children, targetId, next);
        if (hit) return hit;
      }
    }
    return null;
  };
  if (runningLeaf) {
    const p = findPath(tree, runningLeaf.id, []);
    if (p) activePath.push(...p);
  }
  return {
    activePath,
    currentTaskId: runningLeaf?.id || null,
    currentTitle: runningLeaf?.title || (tasks.length ? '全部任务已完结' : '暂无活跃任务'),
    currentStatus: runningLeaf?.status || (tasks.length ? 'done' : 'none'),
  };
}

function extractBlockedBy(text) {
  const m = /(?:\(|（|\b)(?:blockedBy|dependsOn|依赖)\s*[:：]\s*([^)）]+)(?:\)|）)?/i.exec(String(text ?? ''));
  if (!m) return [];
  return m[1].split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
}

export function parsePlanSummary(content, ext = '.md', sourceLabel = 'plan') {
  const cleanExt = String(ext ?? '.md').toLowerCase();
  const tasks = [];
  let tree = [];
  let format = 'markdown';

  if (cleanExt === '.csv' || cleanExt === 'csv') {
    format = 'csv';
    const rows = parseCsvRows(String(content ?? ''));
    if (rows.length >= 2) {
      const headers = rows[0].map(h => h.toLowerCase());
      const findIdx = names => headers.findIndex(h => names.some(n => h === n || h.includes(n)));
      const idIdx = findIdx(['id', 'task_id', '编号', 'code']);
      const titleIdx = findIdx(['title', 'name', 'task', '标题', '任务', '事项']);
      const statusIdx = findIdx(['status', 'state', 'phase', '状态', '阶段']);
      const groupIdx = findIdx(['group', 'milestone', 'stage', '里程碑', '分组']);
      const detailIdx = findIdx(['detail', 'note', 'owner', '说明', '负责人']);
      const stageMap = new Map();
      for (let i = 1; i < rows.length; i += 1) {
        const cols = rows[i];
        const rawTitle = titleIdx >= 0 ? cols[titleIdx] : cols[1] ?? cols[0];
        if (!rawTitle) continue;
        const rawStatus = statusIdx >= 0 ? cols[statusIdx] : 'todo';
        const status = normalizeTaskStatus(rawStatus) ?? 'todo';
        const grp = sanitizePublicText((groupIdx >= 0 && cols[groupIdx]) ? cols[groupIdx] : 'CSV 进度清单');
        const leaf = {
          id: (idIdx >= 0 && cols[idIdx]) ? cols[idIdx] : `CSV-${i}`,
          title: sanitizePublicText(rawTitle),
          kind: 'step',
          depth: 1,
          status,
          rawStatus: rawStatus || status,
          group: grp,
          detail: sanitizePublicText((detailIdx >= 0 && cols[detailIdx]) ? cols[detailIdx] : ''),
          blockedBy: [],
          sourceType: 'csv',
          sourceLabel,
          children: [],
        };
        tasks.push(leaf);
        if (!stageMap.has(grp)) {
          const stNode = { id: `GRP:${grp}`, title: grp, kind: 'stage', depth: 0, children: [], sourceLabel };
          stageMap.set(grp, stNode);
          tree.push(stNode);
        }
        stageMap.get(grp).children.push(leaf);
      }
    }
  } else if (cleanExt === '.json' || cleanExt === 'json') {
    format = 'json';
    try {
      const parsed = JSON.parse(String(content ?? ''));
      const convertNode = (entry, idx, depth, groupName) => {
        if (!entry || typeof entry !== 'object') return null;
        const rawChildren = entry.children || entry.subtasks || entry.steps || entry.tasks || entry.stages || entry.phases || null;
        const title = sanitizePublicText(String(entry.title ?? entry.name ?? entry.id ?? `节点 ${idx + 1}`));
        const curGroup = depth === 0 ? title : groupName;
        const children = Array.isArray(rawChildren)
          ? rawChildren.map((ch, ci) => convertNode(ch, ci, depth + 1, curGroup)).filter(Boolean)
          : [];
        const status = entry.status
          ? (normalizeTaskStatus(entry.status) ?? 'todo')
          : (typeof entry.exitCode === 'number' ? (entry.exitCode === 0 ? 'done' : 'blocked') : (entry.done === true ? 'done' : 'todo'));
        return {
          id: String(entry.id ?? entry.code ?? `STEP-${depth}-${idx + 1}`),
          title,
          kind: children.length ? (depth === 0 ? 'wave' : 'task') : 'step',
          depth,
          status,
          rawStatus: String(entry.status ?? (typeof entry.exitCode === 'number' ? `exit=${entry.exitCode}` : status)),
          group: sanitizePublicText(String(entry.group ?? entry.milestone ?? curGroup ?? 'JSON 阶段步骤')),
          detail: sanitizePublicText(typeof entry.durationMs === 'number' ? `耗时 ${(entry.durationMs / 1000).toFixed(2)}s` : String(entry.detail ?? '')),
          blockedBy: Array.isArray(entry.blockedBy) ? entry.blockedBy.map(String) : [],
          sourceType: 'json',
          sourceLabel,
          children,
        };
      };
      const topList = Array.isArray(parsed)
        ? parsed
        : (parsed?.waves || parsed?.phases || parsed?.milestones || parsed?.tasks || parsed?.steps || parsed?.actual_steps || []);
      tree = (Array.isArray(topList) ? topList : []).map((e, i) => convertNode(e, i, 0, 'JSON 阶段步骤')).filter(Boolean);
      tasks.push(...collectLeafTasks(tree));
    } catch {}
  } else {
    const lines = String(content ?? '').split(/\r?\n/);
    let inFence = false;
    let currentGroup = '核心待办与执行阶段';
    let checkboxSeq = 0;
    let tableSeq = 0;
    const headingStack = [];
    const cbStack = [];
    const rootTreeNodes = [];

    const attachHeading = (level, cleanHeading) => {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      cbStack.length = 0;
      const node = {
        id: `HD-${headingStack.length + 1}-${cleanHeading.slice(0, 24)}`,
        title: cleanHeading,
        kind: level <= 2 ? 'wave' : 'stage',
        depth: headingStack.length,
        level,
        group: cleanHeading,
        blockedBy: [],
        sourceLabel,
        children: [],
      };
      if (headingStack.length > 0) headingStack[headingStack.length - 1].children.push(node);
      else rootTreeNodes.push(node);
      headingStack.push(node);
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const cleanHeading = sanitizePublicText(cleanMarkdownInline(headingMatch[2]));
        if (cleanHeading) {
          currentGroup = cleanHeading;
          if (level >= 2) attachHeading(level, cleanHeading);
        }
        continue;
      }
      const cbMatch = /^(\s*)[-*+]\s+\[([ xX/\-~!])\]\s+(.+)$/.exec(line);
      if (cbMatch) {
        checkboxSeq += 1;
        const indent = cbMatch[1].replace(/\t/g, '  ').length;
        const mark = cbMatch[2].toLowerCase();
        const status = mark === 'x' ? 'done' : (mark === '!' ? 'blocked' : ((mark === '/' || mark === '-' || mark === '~') ? 'running' : 'todo'));
        const cleaned = sanitizePublicText(cleanMarkdownInline(cbMatch[3]));
        const idExtract = /^\[([A-Za-z0-9_.-]+)\]\s*(.+)$/.exec(cleaned);
        const blockedBy = extractBlockedBy(cleaned);
        while (cbStack.length > 0 && cbStack[cbStack.length - 1].indent >= indent) cbStack.pop();
        const parentContainer = cbStack.length > 0
          ? cbStack[cbStack.length - 1].node
          : (headingStack.length > 0 ? headingStack[headingStack.length - 1] : null);
        const node = {
          id: idExtract ? idExtract[1] : `TASK-${String(checkboxSeq).padStart(2, '0')}`,
          title: idExtract ? idExtract[2] : cleaned,
          kind: 'step',
          depth: parentContainer ? parentContainer.depth + 1 : 0,
          status,
          rawStatus: `[${mark}]`,
          group: currentGroup,
          detail: '',
          blockedBy,
          sourceType: 'markdown-checkbox',
          sourceLabel,
          children: [],
        };
        if (parentContainer) {
          if (parentContainer.kind === 'step') parentContainer.kind = 'task';
          parentContainer.children.push(node);
        } else {
          rootTreeNodes.push(node);
        }
        cbStack.push({ indent, node });
        continue;
      }
      if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const splitCells = rowLine => rowLine.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const headers = splitCells(line).map(h => cleanMarkdownInline(h));
        const statusColIdx = headers.findIndex(h => /状态|当前安排|进展|status|phase/i.test(h));
        i += 2;
        while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
          const rawCells = splitCells(lines[i]);
          const cells = rawCells.map(c => cleanMarkdownInline(c));
          let detectedStatus = null;
          let rawStatusText = '';
          for (const rc of rawCells) {
            if (/\[(done|process|todo|blocked|running)\]/i.test(rc)) {
              detectedStatus = normalizeTaskStatus(rc);
              rawStatusText = cleanMarkdownInline(rc);
              break;
            }
          }
          if (!detectedStatus && statusColIdx >= 0 && statusColIdx < rawCells.length) {
            detectedStatus = normalizeTaskStatus(rawCells[statusColIdx]);
            rawStatusText = cells[statusColIdx];
          }
          if (detectedStatus) {
            tableSeq += 1;
            const titleCell = cells.find((c, idx) => idx !== statusColIdx && c.length > 0) || `条目 ${tableSeq}`;
            const parentContainer = headingStack.length > 0 ? headingStack[headingStack.length - 1] : null;
            const leaf = {
              id: `ROW-${String(tableSeq).padStart(2, '0')}`,
              title: sanitizePublicText(titleCell),
              kind: 'step',
              depth: parentContainer ? parentContainer.depth + 1 : 0,
              status: detectedStatus,
              rawStatus: rawStatusText || detectedStatus,
              group: currentGroup,
              detail: sanitizePublicText(cells.slice(1).filter(Boolean).slice(0, 2).join(' · ')),
              blockedBy: [],
              sourceType: 'markdown-table',
              sourceLabel,
              children: [],
            };
            if (parentContainer) parentContainer.children.push(leaf);
            else rootTreeNodes.push(leaf);
          }
          i += 1;
        }
        i -= 1;
      }
    }

    const pruneEmptyContainers = nodes => nodes
      .map(n => {
        if (n.kind === 'wave' || n.kind === 'stage') {
          n.children = pruneEmptyContainers(n.children);
          return n.children.length > 0 ? n : null;
        }
        return n;
      })
      .filter(Boolean);
    tree = pruneEmptyContainers(rootTreeNodes);
    tasks.push(...collectLeafTasks(tree));
  }

  for (const rootNode of tree) aggregateTreeNode(rootNode);
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const todo = tasks.filter(t => t.status === 'todo').length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    format,
    total,
    done,
    running,
    blocked,
    todo,
    percent,
    tasks,
    milestones: summarizeMilestones(tasks),
    tree,
    focusBanner: buildFocusBanner(tree, tasks),
  };
}
export async function inspectStateStoreReadOnly(stateDir, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now() } = {}) {
  if (!stateDir) return null;
  const st = await safeLstat(stateDir);
  if (!st?.isDirectory()) {
    return {
      path: stateDir,
      displayPath: shortDisplayPath(stateDir),
      exists: false,
      isStateStore: false,
      integrity: 'MISSING',
      integrityError: null,
      lastSequence: 0,
      headDigest: STATE_GENESIS_DIGEST,
      fencing: 0,
      writerLock: null,
      hasActiveMutation: false,
      hasActiveRecovery: false,
      snapshotsCount: 0,
      events: [],
    };
  }
  const dir = await realpath(stateDir).catch(() => stateDir);
  const headJson = await safeJson(join(dir, 'chain-head.json'));
  const fencingJson = await safeJson(join(dir, 'fencing.json'));
  const evDir = await safeLstat(join(dir, 'events'));
  const snapshotsDir = await safeLstat(join(dir, 'snapshots'));
  const mutationLockStat = await safeLstat(join(dir, 'writer-mutation.lock'));
  const recoveryLockStat = await safeLstat(join(dir, 'writer-recovery.lock'));

  if (!headJson.ok && !evDir?.isDirectory()) {
    return {
      path: dir,
      displayPath: shortDisplayPath(dir),
      exists: true,
      isStateStore: false,
      integrity: 'NOT_STORE',
      integrityError: null,
      lastSequence: 0,
      headDigest: STATE_GENESIS_DIGEST,
      fencing: 0,
      writerLock: null,
      hasActiveMutation: false,
      hasActiveRecovery: false,
      snapshotsCount: 0,
      events: [],
    };
  }

  let writerLock = null;
  try {
    const lk = await inspectStateStoreLock(dir);
    if (lk?.locked) {
      const ageMs = Math.max(0, nowMs - Date.parse(lk.acquiredAt));
      writerLock = { ...lk, ageMs, isStaleWarning: ageMs >= lockWarnMs };
    }
  } catch {}

  const events = [];
  let integrity = 'EMPTY';
  let integrityError = null;
  let prevDigest = STATE_GENESIS_DIGEST;
  if (evDir?.isDirectory()) {
    const names = (await readdir(join(dir, 'events'))).filter(n => /^\d{6}\.json$/.test(n)).sort();
    for (let i = 0; i < names.length; i += 1) {
      const evFull = join(dir, 'events', names[i]);
      const parsed = await safeJson(evFull);
      const evStat = await safeLstat(evFull);
      if (!parsed.ok || Number(names[i].slice(0, 6)) !== i + 1) {
        integrity = 'CHAIN_BROKEN';
        integrityError = `事件序号或 JSON 损坏：${names[i]}`;
        break;
      }
      const rec = parsed.value;
      const { recordDigest: _omit, ...unsigned } = rec;
      const calc = (() => { try { return digestDocument(unsigned); } catch { return null; } })();
      const ok = rec.sequence === i + 1 && rec.prevDigest === prevDigest && calc === rec.recordDigest;
      if (!ok && integrity !== 'CHAIN_BROKEN') {
        integrity = 'CHAIN_BROKEN';
        integrityError = `事件 #${i + 1} 哈希链校验失败`;
      }
      prevDigest = rec.recordDigest ?? prevDigest;
      events.push({
        sequence: rec.sequence,
        eventId: rec.eventId,
        eventType: rec.eventType,
        producer: rec.producer,
        writerFencing: rec.writerFencing ?? null,
        prevDigest: rec.prevDigest ?? null,
        recordDigest: rec.recordDigest ?? null,
        digestVerified: ok,
        recordedAt: rec.payload?.timestamp ?? rec.payload?.at ?? (evStat ? new Date(evStat.mtimeMs).toISOString() : null),
      });
    }
    if (integrity !== 'CHAIN_BROKEN') {
      integrity = events.length === 0
        ? 'EMPTY'
        : (headJson.ok && (headJson.value?.lastSequence !== events.length || headJson.value?.headDigest !== prevDigest) ? 'STALE_HEAD' : 'VALID');
      if (integrity === 'STALE_HEAD') integrityError = 'chain-head.json 与最新事件序号或摘要不一致';
    }
  }

  let snapshotsCount = 0;
  if (snapshotsDir?.isDirectory()) {
    try {
      snapshotsCount = (await readdir(join(dir, 'snapshots'))).filter(n => /^\d{6}\.json$/.test(n)).length;
    } catch {}
  }

  return {
    path: dir,
    displayPath: shortDisplayPath(dir),
    exists: true,
    isStateStore: true,
    integrity,
    integrityError,
    lastSequence: events.length > 0 ? events[events.length - 1].sequence : (headJson.value?.lastSequence ?? 0),
    headDigest: events.length > 0 ? prevDigest : (headJson.value?.headDigest ?? STATE_GENESIS_DIGEST),
    fencing: fencingJson.value?.lastFencing ?? writerLock?.fencing ?? 0,
    writerLock,
    hasActiveMutation: Boolean(mutationLockStat?.isFile()),
    hasActiveRecovery: Boolean(recoveryLockStat?.isFile()),
    snapshotsCount,
    events,
  };
}

async function inspectSingleLockFile(fullPath, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now(), targetId } = {}) {
  const fileStat = await safeLstat(fullPath);
  if (!fileStat || !fileStat.isFile()) return null;
  const name = basename(fullPath);

  if (name === 'traceability-version-lock.json') {
    return null;
  }

  if (name === 'writer.lock' || name === 'writer-mutation.lock' || name === 'writer-recovery.lock') {
    const parsed = await safeJson(fullPath);
    const val = parsed.ok ? parsed.value : {};
    const acquiredAt = val?.acquiredAt ?? new Date(fileStat.mtimeMs).toISOString();
    const ageMs = Math.max(0, nowMs - Date.parse(acquiredAt));
    const isStaleWarning = Number.isFinite(ageMs) && ageMs >= lockWarnMs;
    return {
      id: `sslock:${fullPath}`,
      targetId,
      name,
      path: fullPath,
      displayPath: shortDisplayPath(fullPath),
      lockKind: name === 'writer.lock' ? 'state-store-writer' : 'state-store-control',
      owner: val?.owner ?? (name === 'writer-recovery.lock' ? 'recovery-coordinator' : 'unknown'),
      acquiredAt,
      ageMs: Number.isFinite(ageMs) ? ageMs : 0,
      isActive: true,
      isStaleWarning,
      status: name === 'writer-recovery.lock' ? 'RECOVERING' : (isStaleWarning ? 'WARN_HELD_LONG' : 'ACTIVE'),
      summary: name === 'writer.lock'
        ? `State-Store 写入锁 (fencing #${val?.fencing ?? 0})`
        : (name === 'writer-mutation.lock' ? `原子变更守卫 (${val?.operation ?? 'mutation'})` : '显式锁恢复守卫'),
    };
  }

  if (name.endsWith('.lock')) {
    try {
      const parentReal = await realpath(dirname(fullPath));
      const inspected = await inspectFilesystemLock(parentReal, name);
      if (inspected?.locked) {
        const ageMs = Math.max(0, nowMs - Date.parse(inspected.acquiredAt));
        const isStaleWarning = ageMs >= lockWarnMs;
        return {
          id: `tlock:${fullPath}`,
          targetId,
          name,
          path: fullPath,
          displayPath: shortDisplayPath(fullPath),
          lockKind: 'token-lock',
          owner: inspected.owner,
          tokenDigest: inspected.tokenDigest ? `${String(inspected.tokenDigest).slice(0, 12)}…` : null,
          acquiredAt: inspected.acquiredAt,
          ageMs,
          isActive: true,
          isStaleWarning,
          status: isStaleWarning ? 'WARN_HELD_LONG' : 'ACTIVE',
          summary: `Foundation 令牌排他锁 (${String(inspected.tokenDigest || '').slice(0, 12)}…)`,
        };
      }
    } catch (error) {
      const fallback = await safeJson(fullPath);
      const ageMs = Math.max(0, nowMs - fileStat.mtimeMs);
      const isStaleWarning = ageMs >= lockWarnMs;
      return {
        id: `flock:${fullPath}`,
        targetId,
        name,
        path: fullPath,
        displayPath: shortDisplayPath(fullPath),
        lockKind: 'file-lock',
        owner: fallback.value?.owner ?? 'active-holder',
        acquiredAt: fallback.value?.acquiredAt ?? new Date(fileStat.mtimeMs).toISOString(),
        ageMs,
        isActive: true,
        isStaleWarning,
        status: fallback.ok ? (isStaleWarning ? 'WARN_HELD_LONG' : 'ACTIVE') : 'CORRUPT',
        summary: fallback.ok ? '自定义 JSON 文件锁' : `锁记录校验异常 (${error?.message ?? 'corrupt'})`,
      };
    }
  }
  return null;
}

async function scanLocksReadOnly(resolvedTarget, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now() } = {}) {
  const candidates = new Set();
  for (const d of [resolvedTarget.stateDir, resolvedTarget.runsDir].filter(Boolean)) {
    for (const f of await walkBounded(d, 3, n => n.endsWith('.lock'))) candidates.add(f);
  }
  for (const p of resolvedTarget.lockPaths ?? []) {
    if (basename(p) === 'traceability-version-lock.json') continue;
    const st = await safeLstat(p);
    if (st?.isFile()) candidates.add(p);
    else if (st?.isDirectory()) {
      for (const f of await walkBounded(p, 2, n => n.endsWith('.lock'))) candidates.add(f);
    }
  }
  const locks = [];
  for (const full of candidates) {
    const item = await inspectSingleLockFile(full, { lockWarnMs, nowMs, targetId: resolvedTarget.id });
    if (item) locks.push(item);
  }
  locks.sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.isStaleWarning) - Number(a.isStaleWarning) || a.name.localeCompare(b.name));
  return locks;
}

async function scanProcessesReadOnly(resolvedTarget) {
  const files = new Set();
  for (const d of [resolvedTarget.runsDir, resolvedTarget.stateDir].filter(Boolean)) {
    for (const f of await walkBounded(d, 3, n => n === 'invocation.json' || n.endsWith('.watchdog.json') || n.endsWith('.envelope.json'))) {
      files.add(f);
    }
  }
  const processes = [];
  for (const full of files) {
    const parsed = await safeJson(full);
    if (!parsed.ok || !parsed.value) continue;
    const doc = parsed.value;
    const ev = doc.evidence && typeof doc.evidence === 'object' ? doc.evidence : {};
    const rawSt = String(doc.processStatus ?? doc.status ?? '').toUpperCase();
    const processStatus = PROCESS_STATUSES.includes(rawSt)
      ? rawSt
      : (rawSt === 'ACTIVE' || rawSt === 'SUPERVISING' ? 'RUNNING' : 'EXITED');
    const exitCode = typeof doc.exitCode === 'number'
      ? doc.exitCode
      : (typeof doc.exitStatus === 'number'
        ? doc.exitStatus
        : (typeof ev.childExitCode === 'number'
          ? ev.childExitCode
          : (typeof doc.exit_code === 'number' ? doc.exit_code : null)));
    const pid = typeof doc.pid === 'number' ? doc.pid : (typeof ev.pid === 'number' ? ev.pid : null);
    const startedAt = doc.startedAt ?? ev.startedAt ?? doc.createdAt ?? null;
    const endedAt = doc.endedAt ?? doc.finishedAt ?? ev.finishedAt ?? null;
    const durationMs = typeof doc.durationMs === 'number'
      ? doc.durationMs
      : (typeof ev.durationMs === 'number'
        ? ev.durationMs
        : (startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null));
    const timedOut = processStatus === 'TIMED_OUT' || Boolean(doc.timedOut);
    const cmdSrc = typeof doc.command === 'string' ? doc.command : (typeof ev.command === 'string' ? ev.command : null);
    const cmdArgs = Array.isArray(doc.args) ? doc.args : (Array.isArray(ev.args) ? ev.args : null);
    const command = Array.isArray(doc.argv)
      ? doc.argv.map(s => basename(String(s)) || String(s)).slice(0, 4).join(' ')
      : (cmdSrc
        ? `${basename(cmdSrc)} ${cmdArgs ? cmdArgs.slice(0, 3).join(' ') : ''}`.trim()
        : basename(full));
    const sigSeq = Array.isArray(ev.signalSequence) && ev.signalSequence.length
      ? ev.signalSequence.map(s => (typeof s === 'string' ? s : s?.signal)).filter(Boolean).join('→')
      : null;

    processes.push({
      id: `proc:${full}`,
      targetId: resolvedTarget.id,
      filePath: full,
      displayPath: shortDisplayPath(full),
      label: basename(full),
      pid,
      command: sanitizePublicText(command),
      processStatus,
      exitCode,
      durationMs,
      timedOut,
      killSignal: doc.killSignal ?? doc.signal ?? ev.childSignal ?? sigSeq ?? (timedOut ? 'SIGTERM/SIGKILL' : null),
      startedAt,
      endedAt,
      ok: typeof doc.ok === 'boolean' ? doc.ok : (exitCode === 0),
    });
  }
  return processes;
}
export async function loadMonitorRegistry(root = '.', registryPath = STUDIO_RUNTIME_REGISTRY_PATH, { allowedRoots = [] } = {}) {
  const base = resolve(root);
  const abs = isAbsolute(registryPath)
    ? resolveRuntimeTargetPath(base, registryPath, { allowedRoots, strict: true })
    : await resolveContained(base, registryPath);
  const st = await safeLstat(abs);
  if (!st?.isFile()) return { schemaVersion: 1, updatedAt: null, targets: [] };
  const parsed = await safeJson(abs);
  return { schemaVersion: 1, updatedAt: parsed.value?.updatedAt ?? null, targets: Array.isArray(parsed.value?.targets) ? parsed.value.targets : [] };
}

export async function loadMergedMonitorTargets(root = '.', { registryPath = STUDIO_RUNTIME_REGISTRY_PATH, allowedRoots = [] } = {}) {
  const base = resolve(root);
  const candidatePaths = [...new Set([
    registryPath || STUDIO_RUNTIME_REGISTRY_PATH,
    STUDIO_RUNTIME_REGISTRY_PATH,
    FOUNDATION_RUNTIME_REGISTRY_PATH,
    LEGACY_RUNTIME_REGISTRY_PATH,
  ])];
  const primaryCustomPath = registryPath || STUDIO_RUNTIME_REGISTRY_PATH;
  const merged = [];
  const seenIds = new Set();
  for (const cand of candidatePaths) {
    try {
      const reg = await loadMonitorRegistry(base, cand, { allowedRoots });
      const isUserReg = cand === primaryCustomPath
        && cand !== FOUNDATION_RUNTIME_REGISTRY_PATH
        && cand !== LEGACY_RUNTIME_REGISTRY_PATH;
      for (const t of reg.targets ?? []) {
        if (!t?.id || seenIds.has(t.id)) continue;
        seenIds.add(t.id);
        merged.push({ ...t, ...(isUserReg ? { isUserRegistered: true } : {}) });
      }
    } catch {}
  }
  return merged;
}

export async function registerMonitorTarget(root = '.', input = {}, registryPath = STUDIO_RUNTIME_REGISTRY_PATH, { allowedRoots = [] } = {}) {
  const base = resolve(root);
  const id = String(input.id ?? '').trim();
  if (!id || FORBIDDEN_KEYS.has(id) || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw Object.assign(new Error('监控目标 id 须为合法字符且不得使用保留原型属性名。'), { statusCode: 400 });
  }
  const title = String(input.title ?? id).trim().slice(0, 160);
  const rawStateDir = input.stateDir ? String(input.stateDir).trim() : '';
  const rawPlanPath = input.planPath ? String(input.planPath).trim() : '';
  const rawRunsDir = input.runsDir ? String(input.runsDir).trim() : '';
  const lockPaths = Array.isArray(input.lockPaths)
    ? input.lockPaths.map(p => String(p).trim()).filter(Boolean)
    : (typeof input.lockPaths === 'string'
      ? input.lockPaths.split(',').map(p => p.trim()).filter(Boolean)
      : []);

  for (const c of [rawStateDir, rawPlanPath, rawRunsDir, ...lockPaths]) {
    if (c) resolveRuntimeTargetPath(base, c, { allowedRoots, strict: true });
  }

  const current = await loadMonitorRegistry(base, registryPath, { allowedRoots });
  const now = new Date().toISOString();
  const entry = {
    id,
    title,
    badge: String(input.badge ?? '已注册任务').trim().slice(0, 40),
    ...(rawStateDir ? { stateDir: rawStateDir } : {}),
    ...(rawPlanPath ? { planPath: rawPlanPath } : {}),
    ...(rawRunsDir ? { runsDir: rawRunsDir } : {}),
    ...(lockPaths.length ? { lockPaths } : {}),
    isUserRegistered: true,
    registeredAt: now,
  };
  const idx = current.targets.findIndex(t => t.id === id);
  if (idx >= 0) current.targets[idx] = { ...entry, registeredAt: current.targets[idx].registeredAt ?? now, updatedAt: now };
  else current.targets.unshift(entry);

  const payload = { schemaVersion: 1, updatedAt: now, targets: current.targets };
  if (isAbsolute(registryPath)) {
    const safeRegAbs = resolveRuntimeTargetPath(base, registryPath, { allowedRoots, strict: true });
    await mkdir(dirname(safeRegAbs), { recursive: true });
    await writeFile(safeRegAbs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } else {
    const absReg = await resolveContained(base, registryPath);
    await mkdir(dirname(absReg), { recursive: true });
    await writeFileAtomic(base, registryPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return { entry, registry: payload };
}

export async function removeMonitorTarget(root = '.', inputOrId = '', registryPath = STUDIO_RUNTIME_REGISTRY_PATH, { allowedRoots = [] } = {}) {
  const base = resolve(root);
  const rawId = typeof inputOrId === 'string' ? inputOrId : inputOrId?.id;
  const id = String(rawId ?? '').trim();
  if (!id || FORBIDDEN_KEYS.has(id) || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw Object.assign(new Error('监控目标 id 须为合法字符且不得使用保留原型属性名。'), { statusCode: 400 });
  }
  const current = await loadMonitorRegistry(base, registryPath, { allowedRoots });
  const idx = current.targets.findIndex(t => t.id === id);
  if (idx < 0) {
    throw Object.assign(new Error(`未在自定义挂载清单找到运行源：${id}（仅支持移除用户手动挂载的运行源）`), { statusCode: 404 });
  }
  const remaining = current.targets.filter(t => t.id !== id);
  const now = new Date().toISOString();
  const payload = { schemaVersion: 1, updatedAt: now, targets: remaining };
  if (isAbsolute(registryPath)) {
    const safeRegAbs = resolveRuntimeTargetPath(base, registryPath, { allowedRoots, strict: true });
    await mkdir(dirname(safeRegAbs), { recursive: true });
    await writeFile(safeRegAbs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } else {
    const absReg = await resolveContained(base, registryPath);
    await mkdir(dirname(absReg), { recursive: true });
    await writeFileAtomic(base, registryPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return { removedId: id, registry: payload };
}

export async function runSandboxExercise({ holdLock = true, simulateTimeout = true } = {}) {
  const rootDir = await mkdtemp(join(await realpath(tmpdir()), 'studio-runtime-sandbox-'));
  const stateDir = join(rootDir, 'state-store');
  const locksDir = join(rootDir, 'locks');
  const runsDir = join(rootDir, 'runs');
  const planPath = join(rootDir, 'execution-plan.md');
  await mkdir(locksDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });

  await writeFile(
    planPath,
    [
      '# 隔离沙箱演练计划',
      '',
      '## Wave 1 · 沙箱三层长任务推进树',
      '',
      '### 阶段一：并发写集锁与哈希链初始化',
      '- [x] [SBX-01] 获取 Foundation 令牌排他锁 (`token-lock`)',
      '- [x] [SBX-02] 追加 `state-store` SHA-256 创世与步骤事件链 (blockedBy: SBX-01)',
      '',
      '### 阶段二：子进程监督与超时保护',
      '- [x] [SBX-03] 运行正常退出的轻量探针进程 (`EXITED`, blockedBy: SBX-02)',
      '- [/] [SBX-04] 运行受管超时强杀探针并保持沙箱排他锁待手动释放 (blockedBy: SBX-03)',
      '',
    ].join('\n'),
    'utf8',
  );

  const lockHandle = await acquireFilesystemLock(locksDir, 'sandbox-write-set.lock', {
    owner: `studio-sandbox-pid-${process.pid}`,
  });
  let lockHeld = true;

  const schemas = { 'sandbox.step': { 1: { type: 'object', additionalProperties: true } } };
  const store = await openStateStore(stateDir, { owner: `studio-sandbox-${process.pid}`, payloadSchemas: schemas });
  try {
    const tag = Date.now();
    await appendEvent(store, {
      eventId: `sbx-${tag}-1`,
      eventType: 'sandbox.step',
      payloadSchemaVersion: 1,
      producer: 'studio.sandbox',
      idempotencyKey: `idem-${tag}-1`,
      payload: { step: 'lock-acquired', timestamp: new Date().toISOString() },
    });
    await appendEvent(store, {
      eventId: `sbx-${tag}-2`,
      eventType: 'sandbox.step',
      payloadSchemaVersion: 1,
      producer: 'studio.sandbox',
      idempotencyKey: `idem-${tag}-2`,
      payload: { step: 'watchdog-probe-completed', timestamp: new Date().toISOString() },
    });
    await writeSnapshot(store, { stepsCompleted: 2 }, {
      reducer: prev => ({ stepsCompleted: (prev?.stepsCompleted ?? 0) + 1 }),
      initial: null,
      hostSessionRef: `sbx-${tag}`,
    });
  } finally {
    await closeStateStore(store);
  }

  await superviseProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok\\n")'],
    cwd: rootDir,
    timeoutPolicy: { maxSeconds: 5, killGraceSeconds: 1 },
    checkIntervalSeconds: 0.05,
    evidencePath: join(runsDir, 'healthy-probe.watchdog.json'),
  });
  if (simulateTimeout) {
    await superviseProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: rootDir,
      timeoutPolicy: { maxSeconds: 0.15, killGraceSeconds: 0.1 },
      checkIntervalSeconds: 0.05,
      evidencePath: join(runsDir, 'timeout-guard.watchdog.json'),
    });
  }
  if (!holdLock) {
    await releaseFilesystemLock(lockHandle);
    lockHeld = false;
  }

  return {
    sandboxRoot: rootDir,
    isLockHeld: () => lockHeld,
    releaseLock: async () => {
      if (!lockHeld) return false;
      lockHeld = false;
      await releaseFilesystemLock(lockHandle);
      return true;
    },
    targetEntry: {
      id: 'foundation-live-sandbox',
      title: 'Foundation 实时隔离沙箱演练',
      badge: '实时沙箱',
      isSandbox: true,
      stateDir,
      planPath,
      runsDir,
      lockPaths: [locksDir],
    },
  };
}

function sanitizeDeep(val) {
  if (typeof val === 'string') return sanitizePublicText(val);
  if (Array.isArray(val)) return val.map(sanitizeDeep);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = sanitizeDeep(v);
    return out;
  }
  return val;
}

export async function collectStudioRuntimeView({
  root = '.',
  catalog,
  selectedRepoId = null,
  registryPath = STUDIO_RUNTIME_REGISTRY_PATH,
  extraTargets = [],
  hasActiveSandboxLock = false,
  lockWarnMs = DEFAULT_LOCK_WARN_MS,
  allowedRoots = [],
  workbenchUrl = null,
} = {}) {
  const base = resolve(root);
  const repoRoots = catalog?.byId ? [...catalog.byId.values()].map(r => r.realPath) : [];
  const effectiveRoots = [base, ...repoRoots, ...allowedRoots, tmpdir()];

  const regTargets = (await loadMergedMonitorTargets(base, { registryPath, allowedRoots: effectiveRoots }))
    .map(t => ({ ...t, repoId: t.repoId || catalog?.primaryRepoId || selectedRepoId || null }));
  const autoTargets = [];
  if (catalog?.byId) {
    for (const rec of catalog.byId.values()) {
      const siblingRegs = await loadMergedMonitorTargets(rec.realPath, {
        registryPath: FOUNDATION_RUNTIME_REGISTRY_PATH,
        allowedRoots: [rec.realPath, tmpdir(), ...allowedRoots],
      });
      for (const stItem of siblingRegs) {
        if (rec.isPrimary) continue;
        const relToAbs = p => (p && !isAbsolute(p) ? join(rec.realPath, p) : p);
        autoTargets.push({
          ...stItem,
          id: `${rec.name}:${stItem.id}`,
          repoId: rec.id,
          title: `${rec.name} · ${stItem.title || stItem.id}`,
          stateDir: relToAbs(stItem.stateDir),
          planPath: relToAbs(stItem.planPath),
          runsDir: relToAbs(stItem.runsDir),
          lockPaths: (stItem.lockPaths ?? []).map(relToAbs).filter(Boolean),
        });
      }
      const runsDir = join(rec.realPath, '.runs');
      const stateDir = (await safeLstat(join(rec.realPath, '.artifacts/state-store'))) ? join(rec.realPath, '.artifacts/state-store') : undefined;
      let autoPlanPath;
      for (const candPlan of ['PLAN.md', 'execution-plan.md', 'artifacts/plan.md', '.runs/execution-plan.md']) {
        if ((await safeLstat(join(rec.realPath, candPlan)))?.isFile()) {
          autoPlanPath = join(rec.realPath, candPlan);
          break;
        }
      }
      if ((await safeLstat(runsDir)) || stateDir || autoPlanPath) {
        autoTargets.push({
          id: `auto:${rec.id}`,
          repoId: rec.id,
          title: `${rec.name} · 默认运行目录`,
          badge: '自动发现',
          runsDir: (await safeLstat(runsDir)) ? runsDir : undefined,
          stateDir,
          planPath: autoPlanPath,
          lockPaths: [],
        });
      }
    }
  }

  const seen = new Set();
  const rawList = [...extraTargets, ...regTargets, ...autoTargets].filter(t => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const relField = p => {
    if (!p) return '';
    if (!isAbsolute(p)) return p;
    const rel = p.startsWith(`${base}/`) ? p.slice(base.length + 1) : '';
    return rel;
  };

  const inspected = await Promise.all(rawList.map(async raw => {
    const resolved = {
      id: raw.id,
      repoId: raw.repoId || (raw.isSandbox ? selectedRepoId : null),
      title: raw.title || raw.id,
      badge: raw.badge || '运行源',
      isSandbox: Boolean(raw.isSandbox),
      isUserRegistered: Boolean(raw.isUserRegistered),
      editConfig: raw.isUserRegistered ? {
        id: raw.id,
        title: raw.title || raw.id,
        stateDir: relField(raw.stateDir),
        planPath: relField(raw.planPath),
        runsDir: relField(raw.runsDir),
        lockPaths: (raw.lockPaths ?? []).map(relField).filter(Boolean),
      } : null,
      stateDir: resolveRuntimeTargetPath(base, raw.stateDir, { allowedRoots: effectiveRoots }),
      planPath: resolveRuntimeTargetPath(base, raw.planPath, { allowedRoots: effectiveRoots }),
      runsDir: resolveRuntimeTargetPath(base, raw.runsDir, { allowedRoots: effectiveRoots }),
      lockPaths: (raw.lockPaths ?? []).map(p => resolveRuntimeTargetPath(base, p, { allowedRoots: effectiveRoots })).filter(Boolean),
    };
    let taskSummary = { format: 'none', total: 0, done: 0, running: 0, blocked: 0, todo: 0, percent: 0, tasks: [], milestones: [] };
    if (resolved.planPath && (await safeLstat(resolved.planPath))?.isFile()) {
      taskSummary = parsePlanSummary(
        await readFile(resolved.planPath, 'utf8'),
        extname(resolved.planPath).toLowerCase(),
        resolved.title,
      );
    }
    const [stateStore, locks, processes] = await Promise.all([
      inspectStateStoreReadOnly(resolved.stateDir, { lockWarnMs }),
      scanLocksReadOnly(resolved, { lockWarnMs }),
      scanProcessesReadOnly(resolved),
    ]);
    return {
      ...resolved,
      taskSummary,
      activeLockCount: locks.filter(l => l.isActive).length,
      processCount: processes.length,
      eventCount: stateStore?.events?.length ?? 0,
      chainIntegrity: stateStore?.integrity ?? 'NONE',
      stateStore,
      locks,
      processes,
    };
  }));

  const seenLockKeys = new Set();
  const allLocks = [];
  for (const t of inspected) {
    for (const l of t.locks || []) {
      const k = l.path || l.id;
      if (k && seenLockKeys.has(k)) continue;
      if (k) seenLockKeys.add(k);
      allLocks.push(l);
    }
  }
  const allProcs = inspected.flatMap(t => t.processes);
  const allTasks = inspected.flatMap(t => t.taskSummary?.tasks ?? []);
  const stores = inspected.map(t => t.stateStore).filter(s => s?.isStateStore);
  const totalEvents = stores.reduce((n, s) => n + s.events.length, 0);
  const counts = Object.fromEntries(PROCESS_STATUSES.map(s => [s, allProcs.filter(p => p.processStatus === s).length]));

  const tTotal = allTasks.length;
  const tDone = allTasks.filter(t => t.status === 'done').length;
  const tRunning = allTasks.filter(t => t.status === 'running').length;
  const tBlocked = allTasks.filter(t => t.status === 'blocked').length;
  const tTodo = allTasks.filter(t => t.status === 'todo').length;

  const kpi = {
    targetsCount: inspected.length,
    lockWarnMs,
    tasks: {
      total: tTotal,
      done: tDone,
      running: tRunning,
      blocked: tBlocked,
      todo: tTodo,
      percent: tTotal > 0 ? Math.round((tDone / tTotal) * 100) : 0,
    },
    locks: {
      activeCount: allLocks.filter(l => l.isActive).length,
      staleWarnCount: allLocks.filter(l => l.isStaleWarning).length,
      versionLockCount: allLocks.filter(l => l.lockKind === 'version-lock').length,
    },
    processes: { total: allProcs.length, counts },
    eventChain: {
      storeCount: stores.length,
      totalEvents,
      integrity: stores.some(s => s.integrity === 'CHAIN_BROKEN') ? 'CHAIN_BROKEN' : (stores.length ? (totalEvents ? 'VALID' : 'EMPTY') : 'NO_STORE'),
    },
  };

  const cleanTargets = sanitizeDeep(inspected);
  const currentRepoTargets = selectedRepoId ? cleanTargets.filter(t => t.repoId === selectedRepoId || t.isSandbox) : cleanTargets;
  const ecosystemActiveTargets = cleanTargets.filter(t => t.activeLockCount > 0 || t.processCount > 0 || t.eventCount > 0 || t.taskSummary.total > 0);
  const plans = await discoverExecutionPlans(base, catalog, inspected);

  return {
    schemaVersion: 1,
    ok: true,
    foundationVersion: FOUNDATION_PACKAGE_VERSION,
    generatedAt: new Date().toISOString(),
    workbenchUrl,
    hasActiveSandboxLock: Boolean(hasActiveSandboxLock),
    kpi,
    targets: cleanTargets,
    plans,
    currentRepoTargets,
    currentRepoHasRuntime: currentRepoTargets.length > 0,
    ecosystemActiveTargets,
  };
}

async function discoverExecutionPlans(base, catalog, liveInspected = [], maxHistorical = 20) {
  const repoNameById = new Map();
  if (catalog?.byId) {
    for (const r of catalog.byId.values()) repoNameById.set(r.id, r.displayName || r.name);
  }

  const plans = [];
  const seenPlanRealPaths = new Set();

  for (const t of liveInspected) {
    if (!t.planPath && !(t.taskSummary?.total > 0)) continue;
    let rp = t.planPath || '';
    if (rp) {
      try { rp = await realpath(rp); } catch {}
      seenPlanRealPaths.add(rp);
    }
    const ts = t.taskSummary || { total: 0, done: 0, running: 0, blocked: 0, todo: 0, percent: 0, tree: [], tasks: [] };
    let status = 'pending';
    if (ts.total > 0 && ts.done === ts.total && ts.running === 0 && ts.blocked === 0) status = 'completed';
    else if (ts.running > 0 || ts.done > 0 || ts.blocked > 0 || t.activeLockCount > 0) status = 'in_progress';
    let summary = ts.focusBanner?.detail || '';
    let liveMarkdown = '';
    if ((!summary || ts.total === 0) && t.planPath) {
      try {
        const raw = await readFile(t.planPath, 'utf8');
        if (!summary) {
          summary = extractArtifactBrief({ rawText: raw, fallbackTitle: t.title, typeLabel: '活跃执行计划', path: t.planPath }).summary;
        }
        if (ts.total === 0) {
          liveMarkdown = sanitizePublicText(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')).trim().slice(0, 60000);
        }
      } catch {}
    }
    if (!summary) summary = `${t.badge || '运行计划'}：共 ${ts.total} 步，已完成 ${ts.done} 步（${ts.percent}%）。`;
    const st = t.planPath ? await safeLstat(t.planPath) : null;
    plans.push(sanitizeDeep({
      id: `live:${t.id}`,
      targetId: t.id,
      title: cleanInlinePlain(t.title || t.id),
      summary: cleanInlinePlain(summary),
      status,
      statusLabel: status === 'completed' ? '已完成' : (status === 'in_progress' ? '进行中' : '待启动'),
      repoId: t.repoId || null,
      repoName: repoNameById.get(t.repoId) || (t.isSandbox ? '隔离沙箱演练' : '当前工作区'),
      badge: t.isSandbox ? '实时沙箱' : (t.isUserRegistered ? '手动挂载' : '活跃运行计划'),
      updatedAt: st?.mtime ? new Date(st.mtime).toISOString() : new Date().toISOString(),
      isHistorical: false,
      isSandbox: Boolean(t.isSandbox),
      planPath: shortDisplayPath(t.planPath || ''),
      completedSteps: ts.done,
      totalSteps: ts.total,
      percent: ts.percent,
      taskSummary: ts,
      markdownText: liveMarkdown || undefined,
      target: t,
    }));
  }

  const candidateFiles = [];
  const seenCandAbs = new Set();
  const addCandidate = async (absPath, repoId, repoName, badge) => {
    if (!absPath || hasSensitiveSegment(absPath) || seenCandAbs.has(absPath)) return;
    const st = await safeLstat(absPath);
    if (!st?.isFile()) return;
    let rp = absPath;
    try { rp = await realpath(absPath); } catch {}
    if (seenPlanRealPaths.has(rp) || seenCandAbs.has(rp)) return;
    seenCandAbs.add(absPath);
    seenCandAbs.add(rp);
    candidateFiles.push({ abs: rp, mtimeMs: st.mtimeMs || 0, repoId, repoName, badge });
  };

  const repoDirs = catalog?.byId ? [...catalog.byId.values()] : [{ id: null, name: basename(base), displayName: basename(base), realPath: base }];
  for (const r of repoDirs) {
    const rName = r.displayName || r.name;
    for (const rootFile of ['PLAN.md', 'execution-plan.md']) {
      await addCandidate(join(r.realPath, rootFile), r.id, rName, '仓库执行计划');
    }
    for (const sub of ['.runs', '.artifacts', 'docs/plans', 'artifacts/plans']) {
      const files = await walkBounded(join(r.realPath, sub), 2, n => /\.(md|json)$/i.test(n) && /(plan|spec|roadmap|execution)/i.test(n));
      for (const f of files) await addCandidate(f, r.id, rName, '历史运行/规划');
    }
  }

  for (const plannerCand of [join(base, '..', '..', 'planner', 'plans'), join(base, '..', 'planner', 'plans')]) {
    const pst = await safeLstat(plannerCand);
    if (!pst?.isDirectory()) continue;
    let ents = [];
    try { ents = await readdir(plannerCand, { withFileTypes: true }); } catch { ents = []; }
    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      if (!/(spec|roadmap|plan|wave)/i.test(ent.name)) continue;
      await addCandidate(join(plannerCand, ent.name), null, '生态总规 (planner)', '历史规格计划');
    }
  }

  candidateFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let histCount = 0;
  for (const cand of candidateFiles) {
    if (histCount >= maxHistorical) break;
    let raw = '';
    try { raw = await readFile(cand.abs, 'utf8'); } catch { continue; }
    const ext = extname(cand.abs).toLowerCase();
    const stem = basename(cand.abs, ext);
    const ts = parsePlanSummary(raw, ext, stem);
    const brief = extractArtifactBrief({ rawText: raw, fallbackTitle: stem, code: stem, typeLabel: cand.badge, path: cand.abs });
    let status = 'completed';
    if (ts.total > 0) {
      if (ts.done === ts.total && ts.running === 0 && ts.blocked === 0) status = 'completed';
      else if (ts.running > 0 || ts.done > 0 || ts.blocked > 0) status = 'in_progress';
      else status = 'pending';
    } else if (/status\s*:\s*(active|draft|in_progress|running)|进行中|待实施/i.test(raw.slice(0, 1200))) {
      status = 'in_progress';
    }
    const percent = ts.total > 0 ? ts.percent : (status === 'completed' ? 100 : 0);
    histCount += 1;
    plans.push(sanitizeDeep({
      id: `hist:${cand.repoName}:${basename(cand.abs)}`.replace(/[^A-Za-z0-9_.:/-]+/g, '_'),
      targetId: null,
      title: cleanInlinePlain(brief.title || stem),
      summary: cleanInlinePlain(brief.summary),
      status,
      statusLabel: status === 'completed' ? '已完成' : (status === 'in_progress' ? '进行中' : '待启动'),
      repoId: cand.repoId,
      repoName: cand.repoName,
      badge: cand.badge,
      updatedAt: cand.mtimeMs ? new Date(cand.mtimeMs).toISOString() : null,
      isHistorical: true,
      isSandbox: false,
      planPath: shortDisplayPath(cand.abs),
      completedSteps: ts.done,
      totalSteps: ts.total,
      percent,
      taskSummary: ts,
      markdownText: ts.total === 0
        ? sanitizePublicText(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')).trim().slice(0, 60000)
        : undefined,
      target: null,
    }));
  }
  return plans;
}
