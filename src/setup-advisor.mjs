// @feature STU006
// @feature STU004

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readFileContained, writeFileAtomic } from 'skill-family-harness-node';
import { loadStudioWorkspaceConfig, readQuickRepoMeta, resolveGroupLabel } from './ecosystem.mjs';
import { sanitizePublicText } from './markdown-render.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SKIP_CHILD_DIRS = new Set([
  'node_modules', '.git', 'dist', '.cache', '.artifact-graph', '.artifacts',
  '.runs', '.skill-family-studio', '.release-skill', '.worktrees', '.tmp',
]);

async function exists(p) {
  try { await lstat(p); return true; } catch { return false; }
}

async function safeReadJson(absPath) {
  try {
    const st = await lstat(absPath);
    if (!st.isFile()) return null;
    const raw = await readFileContained(dirname(absPath), basename(absPath), { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function computePathDigest(absPath) {
  return createHash('sha256').update(String(absPath || ''), 'utf8').digest('hex').slice(0, 16);
}

async function scanImmediateChildRepos(dirReal) {
  const repos = [];
  let ents = [];
  try { ents = await readdir(dirReal, { withFileTypes: true }); } catch { return repos; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_CHILD_DIRS.has(e.name)) continue;
    const childDir = join(dirReal, e.name);
    if (await exists(join(childDir, 'artifact-graph.config.yaml'))) {
      repos.push(childDir);
      continue;
    }
    let subEnts = [];
    try { subEnts = await readdir(childDir, { withFileTypes: true }); } catch { continue; }
    for (const se of subEnts.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!se.isDirectory() || se.name.startsWith('.') || SKIP_CHILD_DIRS.has(se.name)) continue;
      const grand = join(childDir, se.name);
      if (await exists(join(grand, 'artifact-graph.config.yaml'))) repos.push(grand);
    }
  }
  return repos;
}

async function detectPlanFiles(rootReal) {
  const candidates = [];
  const checkNames = new Set(['plan.md', 'execution-plan.md', 'execution_plan.md', 'tasks.json', 'plan.json']);
  for (const relDir of ['', 'artifacts', 'docs', '.runs']) {
    const dir = relDir ? join(rootReal, relDir) : rootReal;
    let ents = [];
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile()) continue;
      const low = e.name.toLowerCase();
      if (checkNames.has(low) || /plan\.(?:md|json|csv)$/i.test(low)) {
        candidates.push(relDir ? `${relDir}/${e.name}` : e.name);
      }
    }
  }
  return candidates.slice(0, 12);
}

async function detectFleetAvailability(env = process.env) {
  const home = env?.HOME || homedir();
  const brainDir = env?.STUDIO_ANTIGRAVITY_BRAIN_DIR || join(home, '.gemini', 'antigravity', 'brain');
  const claudeDir = env?.STUDIO_CLAUDE_PROJECTS_DIR || join(home, '.claude', 'projects');
  const codexDir = env?.STUDIO_CODEX_SESSIONS_DIR || join(home, '.codex', 'sessions');
  const countEntries = async dir => {
    try {
      const ents = await readdir(dir, { withFileTypes: true });
      return ents.filter(e => e.isDirectory() && !e.name.startsWith('.')).length;
    } catch {
      return 0;
    }
  };
  const [antigravity, claude, codex] = await Promise.all([
    countEntries(brainDir),
    countEntries(claudeDir),
    countEntries(codexDir),
  ]);
  return { antigravity, claude, codex, hasAny: antigravity + claude + codex > 0 };
}

export async function inspectSetup({ root = '.', env = process.env } = {}) {
  const resolved = resolve(root);
  let rootReal = resolved;
  let rootExists = true;
  try {
    rootReal = await realpath(resolved);
  } catch {
    rootExists = false;
  }

  const hasArtifactGraph = rootExists && await exists(join(rootReal, 'artifact-graph.config.yaml'));
  const hasPortfolioFile = rootExists && await exists(join(rootReal, 'artifacts/portfolio-allocations.json'));
  const hasUpstreamFile = rootExists && await exists(join(rootReal, 'artifacts/upstream-bindings.json'));
  const hasVersionLock = rootExists && await exists(join(rootReal, 'artifacts/traceability-version-lock.json'));
  const studioCfg = rootExists
    ? await loadStudioWorkspaceConfig(rootReal)
    : { hasConfig: false, role: null, title: null, scanRoots: null, groupLabels: {}, collections: [] };

  let role = 'uninitialized';
  let roleLabel = '未初始化目录';
  if (hasArtifactGraph) {
    if (hasPortfolioFile || studioCfg.role === 'portfolio') {
      role = 'portfolio';
      roleLabel = '高阶规划仓';
    } else if (hasUpstreamFile) {
      role = 'subproject';
      roleLabel = '详设子仓';
    } else {
      role = 'standalone';
      roleLabel = '单技能族仓';
    }
  } else if (rootExists) {
    const children = await scanImmediateChildRepos(rootReal);
    if (children.length > 0) {
      role = 'workspace-parent';
      roleLabel = '多仓工作区父目录';
    }
  }

  const relatedRepos = [];
  const seenRelated = new Set([rootReal]);
  const pushRelated = async (absDir, relation, relationLabel) => {
    let real;
    try { real = await realpath(absDir); } catch { return; }
    if (seenRelated.has(real) || !(await exists(join(real, 'artifact-graph.config.yaml')))) return;
    seenRelated.add(real);
    const meta = await readQuickRepoMeta(real);
    relatedRepos.push({
      name: basename(real),
      group: basename(dirname(real)),
      groupLabel: resolveGroupLabel(basename(dirname(real)), studioCfg.groupLabels),
      relation,
      relationLabel,
      role: meta.repoRole,
      roleLabel: meta.repoRoleLabel,
      relPath: relative(rootReal, real).split('\\').join('/') || '.',
      pathDigest: computePathDigest(real),
    });
  };

  if (hasPortfolioFile) {
    const portDoc = await safeReadJson(join(rootReal, 'artifacts/portfolio-allocations.json'));
    for (const item of portDoc?.items ?? []) {
      for (const al of item?.allocations ?? []) {
        if (al?.targetRepo) await pushRelated(resolve(rootReal, al.targetRepo), 'downstream', '下游承接子仓');
      }
    }
  }
  if (hasUpstreamFile) {
    const upDoc = await safeReadJson(join(rootReal, 'artifacts/upstream-bindings.json'));
    if (upDoc?.upstreamPortfolio) {
      await pushRelated(resolve(rootReal, upDoc.upstreamPortfolio), 'upstream', '上游高阶规划仓');
    }
  }

  const parentDir = resolve(rootReal, '..');
  let tmpReal = tmpdir();
  try { tmpReal = await realpath(tmpReal); } catch {}
  const safeParent = rootExists && rootReal !== '/' && parentDir !== '/' && parentDir !== tmpReal && parentDir !== dirname(tmpReal);
  const siblingCandidates = [];
  if (role === 'workspace-parent') {
    for (const c of await scanImmediateChildRepos(rootReal)) {
      await pushRelated(c, 'child', '旗下子仓');
    }
  } else if (safeParent) {
    for (const sib of await scanImmediateChildRepos(parentDir)) {
      if (sib !== rootReal) siblingCandidates.push(sib);
    }
  }

  const planFiles = rootExists ? await detectPlanFiles(rootReal) : [];
  const runtimeRegExists = rootExists && (
    await exists(join(rootReal, '.skill-family-studio/runtime-registry.json'))
    || await exists(join(rootReal, '.artifacts/runtime-monitor/registry.json'))
    || await exists(join(rootReal, '.runs'))
  );
  const fleetDetected = await detectFleetAvailability(env);

  const hasLinkedUpDown = relatedRepos.some(r => r.relation === 'upstream' || r.relation === 'downstream');
  const isMultiRepoContext = hasLinkedUpDown || role === 'workspace-parent';
  const needsUserChoice = !studioCfg.hasConfig && isMultiRepoContext;
  const recommendedMode = studioCfg.hasConfig || isMultiRepoContext ? 'related-suite' : 'single-repo';
  const recommendedScanRoots = recommendedMode === 'single-repo' && !studioCfg.hasConfig
    ? 'none'
    : (studioCfg.scanRoots?.length
      ? studioCfg.scanRoots.map(p => relative(rootReal, p).split('\\').join('/') || '.').join(',')
      : (isMultiRepoContext ? '..' : 'none'));

  const recommendedTab = (hasPortfolioFile || hasUpstreamFile) ? 'review' : (hasArtifactGraph ? 'graph' : (runtimeRegExists || planFiles.length ? 'runtime' : 'guide'));
  const scanFlag = recommendedScanRoots === 'none' ? ' --scan-roots none' : '';
  const recommendedCommand = `npx skill-family-studio ensure --root . --port 57630 --tab ${recommendedTab}${scanFlag}`;

  const choicePrompt = needsUserChoice
    ? {
        question: hasLinkedUpDown
          ? `检测到当前仓库已与 ${relatedRepos.length} 个上下游仓库绑定，尚未建立 .studio-workspace.json，希望如何打开控制台？`
          : `检测到当前目录下还有 ${role === 'workspace-parent' ? relatedRepos.length : siblingCandidates.length} 个相邻技能族仓库，希望聚焦当前仓还是组套查看？`,
        options: [
          {
            id: 'single',
            label: '1. 仅聚焦当前仓（界面最清爽）',
            description: '只加载本仓制品与版本锁，不混入父目录其他仓库。',
            command: `npx skill-family-studio ensure --root . --port 57630 --tab ${recommendedTab} --scan-roots none`,
          },
          {
            id: 'related',
            label: `2. 自动纳入关联${hasLinkedUpDown ? '上下游' : '兄弟'}仓（支持跨仓互跳）`,
            description: '同时生成推荐 .studio-workspace.json 边界并打开跨仓对照视图。',
            action: 'init-workspace --mode related',
          },
          {
            id: 'custom',
            label: '3. 指定业务域扫描目录并写好 .studio-workspace.json',
            description: '由智能体按你的目录路径配置 scanRoots 与分组名称。',
            action: 'init-workspace --mode custom --scan-roots <dirs>',
          },
        ],
      }
    : null;

  return {
    schemaVersion: 1,
    ok: rootExists,
    rootName: basename(rootReal),
    pathDigest: computePathDigest(rootReal),
    role,
    roleLabel,
    hasArtifactGraph,
    hasStudioConfig: studioCfg.hasConfig,
    hasPortfolioFile,
    hasUpstreamFile,
    hasVersionLock,
    siblingCount: siblingCandidates.length,
    relatedRepos,
    runtimeDetected: {
      hasRuntimeFiles: runtimeRegExists,
      planFilesCount: planFiles.length,
      planFiles,
    },
    fleetDetected,
    recommendedMode,
    recommendedTab,
    recommendedScanRoots,
    recommendedCommand: sanitizePublicText(recommendedCommand),
    needsUserChoice,
    choicePrompt,
  };
}

export async function initWorkspaceConfig({
  root = '.',
  mode = 'single',
  scanRoots = null,
  groupLabels = null,
  title = null,
  role = null,
} = {}) {
  const rootReal = await realpath(resolve(root));
  const setup = await inspectSetup({ root: rootReal });

  let resolvedScanRoots = [];
  if (Array.isArray(scanRoots) && scanRoots.length > 0) {
    resolvedScanRoots = scanRoots.map(s => String(s).trim()).filter(Boolean);
  } else if (typeof scanRoots === 'string' && scanRoots.trim() && scanRoots.trim() !== 'none') {
    resolvedScanRoots = scanRoots.split(',').map(s => s.trim()).filter(Boolean);
  } else if (mode === 'related') {
    const parents = new Set();
    for (const rel of setup.relatedRepos) {
      const targetAbs = resolve(rootReal, rel.relPath);
      const relParent = relative(rootReal, dirname(targetAbs)).split('\\').join('/') || '.';
      parents.add(relParent);
    }
    resolvedScanRoots = parents.size > 0 ? [...parents] : (setup.role === 'workspace-parent' ? ['.'] : ['..']);
  } else if (mode === 'single') {
    resolvedScanRoots = ['.'];
  } else {
    resolvedScanRoots = ['..'];
  }

  const safeLabels = {};
  if (groupLabels && typeof groupLabels === 'object' && !Array.isArray(groupLabels)) {
    for (const [k, v] of Object.entries(groupLabels)) {
      if (!FORBIDDEN_KEYS.has(k) && typeof v === 'string' && v.trim()) safeLabels[k] = v.trim();
    }
  }

  const cfg = {
    schemaVersion: '1.0',
    role: role || (setup.role === 'portfolio' ? 'portfolio' : 'workspace'),
    title: title || `${basename(rootReal)} 工作区`,
    scanRoots: resolvedScanRoots,
    ...(Object.keys(safeLabels).length > 0 ? { groupLabels: safeLabels } : {}),
  };

  await mkdir(rootReal, { recursive: true });
  await writeFileAtomic(rootReal, '.studio-workspace.json', `${JSON.stringify(cfg, null, 2)}\n`);
  return {
    ok: true,
    configPath: '.studio-workspace.json',
    config: cfg,
  };
}
