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
import { sanitizePublicText } from './markdown-render.mjs';

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

async function safeLstat(p) { try { return await lstat(p); } catch { return null; } }
async function safeJson(p) { try { return { ok: true, value: JSON.parse(await readFile(p, 'utf8')) }; } catch { return { ok: false }; } }

async function walkBounded(rootDir, maxDepth = 3, accept = null) {
  const out = [];
  async function visit(dir, d) {
    if (d > maxDepth || out.length >= 100) return;
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

export async function inspectStateStoreReadOnly(stateDir, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now() } = {}) {
  if (!stateDir) return null;
  const st = await safeLstat(stateDir);
  if (!st?.isDirectory()) return { path: stateDir, exists: false, isStateStore: false, integrity: 'MISSING', lastSequence: 0, events: [] };
  const dir = await realpath(stateDir).catch(() => stateDir);
  const headJson = await safeJson(join(dir, 'chain-head.json'));
  const evDir = await safeLstat(join(dir, 'events'));
  if (!headJson.ok && !evDir?.isDirectory()) {
    return { path: dir, exists: true, isStateStore: false, integrity: 'NOT_STORE', lastSequence: 0, events: [] };
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
  let prevDigest = STATE_GENESIS_DIGEST;
  if (evDir?.isDirectory()) {
    const names = (await readdir(join(dir, 'events'))).filter(n => /^\d{6}\.json$/.test(n)).sort();
    for (let i = 0; i < names.length; i += 1) {
      const parsed = await safeJson(join(dir, 'events', names[i]));
      if (!parsed.ok || Number(names[i].slice(0, 6)) !== i + 1) { integrity = 'CHAIN_BROKEN'; break; }
      const rec = parsed.value;
      const { recordDigest: _omit, ...unsigned } = rec;
      const calc = (() => { try { return digestDocument(unsigned); } catch { return null; } })();
      const ok = rec.sequence === i + 1 && rec.prevDigest === prevDigest && calc === rec.recordDigest;
      if (!ok) integrity = 'CHAIN_BROKEN';
      prevDigest = rec.recordDigest ?? prevDigest;
      events.push({ sequence: rec.sequence, eventId: rec.eventId, eventType: rec.eventType, producer: rec.producer, recordedAt: rec.payload?.timestamp ?? null });
    }
    if (integrity !== 'CHAIN_BROKEN') {
      integrity = events.length === 0 ? 'EMPTY' : (headJson.ok && (headJson.value?.lastSequence !== events.length || headJson.value?.headDigest !== prevDigest) ? 'STALE_HEAD' : 'VALID');
    }
  }
  return { path: dir, exists: true, isStateStore: true, integrity, lastSequence: events.length, writerLock, events };
}

async function scanLocksReadOnly(resolvedTarget, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now() } = {}) {
  const candidates = new Set();
  for (const d of [resolvedTarget.stateDir, resolvedTarget.runsDir].filter(Boolean)) {
    for (const f of await walkBounded(d, 3, n => n.endsWith('.lock'))) candidates.add(f);
  }
  for (const p of resolvedTarget.lockPaths ?? []) {
    const st = await safeLstat(p);
    if (st?.isFile()) candidates.add(p);
    else if (st?.isDirectory()) {
      for (const f of await walkBounded(p, 2, n => n.endsWith('.lock'))) candidates.add(f);
    }
  }
  const locks = [];
  for (const full of candidates) {
    const name = basename(full);
    try {
      const parentReal = await realpath(dirname(full));
      const inspected = await inspectFilesystemLock(parentReal, name);
      if (inspected?.locked) {
        const ageMs = Math.max(0, nowMs - Date.parse(inspected.acquiredAt));
        locks.push({
          id: `tlock:${full}`,
          name,
          path: full,
          lockKind: 'token-lock',
          owner: inspected.owner,
          acquiredAt: inspected.acquiredAt,
          ageMs,
          isActive: true,
          isStaleWarning: ageMs >= lockWarnMs,
        });
      }
    } catch {
      const st = await safeLstat(full);
      if (st?.isFile()) {
        const ageMs = Math.max(0, nowMs - st.mtimeMs);
        locks.push({
          id: `flock:${full}`,
          name,
          path: full,
          lockKind: 'file-lock',
          owner: 'active-holder',
          ageMs,
          isActive: true,
          isStaleWarning: ageMs >= lockWarnMs,
        });
      }
    }
  }
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
    const rawSt = String(doc.processStatus ?? doc.status ?? '').toUpperCase();
    const processStatus = PROCESS_STATUSES.includes(rawSt) ? rawSt : (rawSt === 'ACTIVE' ? 'RUNNING' : 'EXITED');
    processes.push({
      id: `proc:${full}`,
      filePath: full,
      label: basename(full),
      processStatus,
      ok: typeof doc.ok === 'boolean' ? doc.ok : (doc.exit_code === 0),
    });
  }
  return processes;
}

function parsePlanSummary(content, ext) {
  if (ext === '.json') {
    try {
      const p = JSON.parse(content);
      const list = Array.isArray(p?.tasks) ? p.tasks : [];
      const done = list.filter(t => t.done || t.status === 'done').length;
      return { total: list.length, done, percent: list.length ? Math.round((done / list.length) * 100) : 0 };
    } catch { return { total: 0, done: 0, percent: 0 }; }
  }
  const boxes = [...String(content ?? '').matchAll(/^\s*[-*+]\s+\[([ xX/\-~])\]/gm)];
  const total = boxes.length;
  const done = boxes.filter(m => m[1].toLowerCase() === 'x').length;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
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
  const merged = [];
  const seenIds = new Set();
  for (const cand of candidatePaths) {
    try {
      const reg = await loadMonitorRegistry(base, cand, { allowedRoots });
      for (const t of reg.targets ?? []) {
        if (!t?.id || seenIds.has(t.id)) continue;
        seenIds.add(t.id);
        merged.push(t);
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
  const lockPaths = Array.isArray(input.lockPaths) ? input.lockPaths.map(p => String(p).trim()).filter(Boolean) : [];

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
    registeredAt: now,
  };
  const idx = current.targets.findIndex(t => t.id === id);
  if (idx >= 0) current.targets[idx] = { ...current.targets[idx], ...entry };
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
    '# 隔离沙箱演练计划\n\n- [x] 获取令牌排他锁\n- [x] 追加 state-store 事件哈希链\n- [/] 运行子进程健康与超时保护探针\n',
    'utf8',
  );

  const lockHandle = await acquireFilesystemLock(locksDir, 'sandbox-write-set.lock', {
    owner: `studio-sandbox-pid-${process.pid}`,
  });

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
    await writeSnapshot(store, { stepsCompleted: 1 }, {
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
  if (!holdLock) await releaseFilesystemLock(lockHandle);

  return {
    sandboxRoot: rootDir,
    releaseLock: holdLock ? () => releaseFilesystemLock(lockHandle) : null,
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
      if ((await safeLstat(runsDir)) || stateDir) {
        autoTargets.push({ id: `auto:${rec.id}`, repoId: rec.id, title: `${rec.name} · 默认运行目录`, badge: '自动发现', runsDir, stateDir });
      }
    }
  }

  const seen = new Set();
  const rawList = [...extraTargets, ...regTargets, ...autoTargets].filter(t => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const inspected = await Promise.all(rawList.map(async raw => {
    const resolved = {
      id: raw.id,
      repoId: raw.repoId || (raw.isSandbox ? selectedRepoId : null),
      title: raw.title || raw.id,
      badge: raw.badge || '运行源',
      isSandbox: Boolean(raw.isSandbox),
      stateDir: resolveRuntimeTargetPath(base, raw.stateDir, { allowedRoots: effectiveRoots }),
      planPath: resolveRuntimeTargetPath(base, raw.planPath, { allowedRoots: effectiveRoots }),
      runsDir: resolveRuntimeTargetPath(base, raw.runsDir, { allowedRoots: effectiveRoots }),
      lockPaths: (raw.lockPaths ?? []).map(p => resolveRuntimeTargetPath(base, p, { allowedRoots: effectiveRoots })).filter(Boolean),
    };
    let taskSummary = { total: 0, done: 0, percent: 0 };
    if (resolved.planPath && (await safeLstat(resolved.planPath))?.isFile()) {
      taskSummary = parsePlanSummary(await readFile(resolved.planPath, 'utf8'), extname(resolved.planPath).toLowerCase());
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

  const allLocks = inspected.flatMap(t => t.locks);
  const allProcs = inspected.flatMap(t => t.processes);
  const stores = inspected.map(t => t.stateStore).filter(s => s?.isStateStore);
  const totalEvents = stores.reduce((n, s) => n + s.events.length, 0);
  const counts = Object.fromEntries(PROCESS_STATUSES.map(s => [s, allProcs.filter(p => p.processStatus === s).length]));

  const kpi = {
    targetsCount: inspected.length,
    locks: { activeCount: allLocks.filter(l => l.isActive).length, staleWarnCount: allLocks.filter(l => l.isStaleWarning).length },
    processes: { total: allProcs.length, counts },
    eventChain: {
      storeCount: stores.length,
      totalEvents,
      integrity: stores.some(s => s.integrity === 'CHAIN_BROKEN') ? 'CHAIN_BROKEN' : stores.length ? (totalEvents ? 'VALID' : 'EMPTY') : 'NO_STORE',
    },
  };

  const cleanTargets = sanitizeDeep(inspected);
  const currentRepoTargets = selectedRepoId ? cleanTargets.filter(t => t.repoId === selectedRepoId || t.isSandbox) : cleanTargets;
  const ecosystemActiveTargets = cleanTargets.filter(t => t.activeLockCount > 0 || t.processCount > 0 || t.eventCount > 0 || t.taskSummary.total > 0);

  return {
    schemaVersion: 1,
    ok: true,
    foundationVersion: FOUNDATION_PACKAGE_VERSION,
    generatedAt: new Date().toISOString(),
    workbenchUrl,
    kpi,
    targets: cleanTargets,
    currentRepoTargets,
    currentRepoHasRuntime: currentRepoTargets.length > 0,
    ecosystemActiveTargets,
  };
}
