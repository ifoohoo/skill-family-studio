// @feature STU004

import { tmpdir } from 'node:os';
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  VERSION_LOCK_PATH,
  auditVersionLock,
  isVersionLockIssueBlocking,
  loadConfig,
  matchesConfiguredArtifactPath,
  scanArtifacts,
} from 'artifact-graph';
import { readFileContained, resolveContained } from 'skill-family-harness-node';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_LAYERS } from './graph-layout.mjs';
import { escapeHtml, renderMarkdownToHtml, sanitizePublicText } from './markdown-render.mjs';
import { sortItemsForGuidedReview } from './review-state.mjs';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.artifact-graph', '.artifacts', '.runs',
  '.release-skill', '.cache', '.qoder', '.codex', '.claude', '.kimi', '.skill-family-studio',
  '.worktrees', '.tmp', 'target', 'deliveries', '_archives', '_worktrees', '_runs',
]);
const SKIP_CLONE_DIR_RE = /(?:-hotfix-|-smoke-|-self-governance-renewal-|\.release-skill-archive$|\.pre-migration-archive$)/i;
const shouldSkipDir = name => name.startsWith('.') || SKIP_DIRS.has(name) || SKIP_CLONE_DIR_RE.test(name);
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|rs|go|sh|java|kt)$/i;
const SAFE_EXTRA_DOCS = new Set([
  'README.md',
  'README.zh-CN.md',
  'docs/USER-GUIDE.md',
  'USER-GUIDE.md',
  'artifacts/README.md',
  'artifact-graph.config.yaml',
  '.studio-workspace.json',
  'artifacts/portfolio-allocations.json',
  'artifacts/upstream-bindings.json',
]);

export const GROUP_LABELS = Object.freeze({});

export function resolveGroupLabel(group, customLabels = {}) {
  const key = String(group ?? '').trim();
  if (customLabels && typeof customLabels[key] === 'string' && customLabels[key].trim()) {
    return customLabels[key].trim();
  }
  if (!key || key === 'workspace') return '当前工作区';
  return key;
}

const TYPE_LABELS = Object.freeze({
  requirement: '原始需求',
  prd: '产品需求 PRD',
  feature: '功能特性',
  user_story: '用户故事',
  story: '用户故事',
  lifecycle: '生命周期讲解',
  lifecycle_story: '原始故事对照',
  business_article: '业务专题文稿',
  entity: '领域实体',
  domain_model: '领域模型',
  'domain-glossary': '领域术语表',
  'bounded-context-map': '限界上下文图',
  decision: '架构决策',
  design: '架构设计',
  interface_contracts: '接口契约',
  data_contracts: '数据契约',
  application_state_machines: '状态机契约',
  error_model: '错误模型',
  scenario: '场景剧本',
  spec: '接口与规格 SPEC',
  e2e_test: '端到端测试规格',
  e2e_registry: '测试注册表',
  'test-strategy': '测试策略',
  'rule-golden-cases': '规则黄金用例',
  agent_skill: '技能规格',
  test: '测试验证',
  implementation: '实现追溯',
});

const EDGE_LABELS = Object.freeze({
  covers: '覆盖场景',
  references: '关联引用',
  depends_on: '前置依赖',
  verifies: '验证覆盖',
  implements: '代码实现',
  'derives-from': '派生自',
  decomposes: '分解自',
  supersedes: '完整替代',
  'partial-supersedes': '部分替代',
  'external-reference': '跨仓引用',
  evidence: '验证证据',
  'change-target': '变更目标',
});

const LAYER_MATCH = [
  { ...DEFAULT_LAYERS[0], match: new Set(['requirement', 'spec', 'prd']) },
  { ...DEFAULT_LAYERS[1], match: new Set(['feature', 'user_story', 'story', 'lifecycle', 'lifecycle_story']) },
  { ...DEFAULT_LAYERS[2], match: new Set(['entity', 'domain_model', 'domain-glossary', 'bounded-context-map', 'decision']) },
  { ...DEFAULT_LAYERS[3], match: new Set(['design', 'interface_contracts', 'data_contracts', 'application_state_machines', 'error_model', 'agent_skill']) },
  { ...DEFAULT_LAYERS[4], match: new Set(['scenario']) },
  { ...DEFAULT_LAYERS[5], match: new Set(['e2e_test', 'e2e_registry', 'test-strategy', 'rule-golden-cases', 'test', 'implementation']) },
];

function classifyLayer(type, configuredLayer) {
  for (const def of LAYER_MATCH) if (def.match.has(type)) return def;
  const lower = String(configuredLayer ?? '').toLowerCase();
  if (lower.includes('req') || lower.includes('spec')) return LAYER_MATCH[0];
  if (lower.includes('prd') || lower.includes('story') || lower.includes('feature')) return LAYER_MATCH[1];
  if (lower.includes('domain') || lower.includes('decision')) return LAYER_MATCH[2];
  if (lower.includes('scenario')) return LAYER_MATCH[4];
  if (lower.includes('verif') || lower.includes('test') || lower.includes('impl')) return LAYER_MATCH[5];
  return LAYER_MATCH[3];
}

function classifyReviewCategory(type, layerId) {
  if (['user_story', 'story', 'lifecycle', 'lifecycle_story'].includes(type)) return 'stories';
  if (['requirement', 'prd', 'spec'].includes(type)) return 'requirements';
  if (type === 'scenario') return 'scenarios';
  if (['domain_model', 'entity', 'domain-glossary', 'bounded-context-map', 'decision', 'business_article'].includes(type)) return 'domain';
  if (['e2e_test', 'e2e_registry', 'test-strategy', 'rule-golden-cases', 'test', 'implementation'].includes(type)) return 'verification';
  if (['feature', 'design', 'interface_contracts', 'data_contracts', 'application_state_machines', 'error_model', 'agent_skill'].includes(type)) {
    return 'architecture';
  }
  if (layerId === 'requirements') return 'requirements';
  if (layerId === 'scenarios') return 'scenarios';
  if (layerId === 'domain') return 'domain';
  if (layerId === 'verification') return 'verification';
  return 'architecture';
}

async function exists(absPath) {
  try { await lstat(absPath); return true; } catch { return false; }
}

async function readJsonSafeContained(repoReal, relPath) {
  try {
    const abs = await resolveContained(repoReal, relPath);
    const st = await lstat(abs);
    if (!st.isFile()) return null;
    const parsed = JSON.parse(await readFileContained(repoReal, relPath, { encoding: 'utf8' }));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadStudioWorkspaceConfig(repoReal) {
  const wsJson = await readJsonSafeContained(repoReal, '.studio-workspace.json');
  let yamlStudio = null;
  try {
    const rawCfg = await readFileContained(repoReal, 'artifact-graph.config.yaml', { encoding: 'utf8' });
    const parsed = parseYaml(rawCfg);
    if (parsed?.studio && typeof parsed.studio === 'object' && !Array.isArray(parsed.studio)) {
      yamlStudio = parsed.studio;
    }
  } catch {}

  const mergedLabels = {};
  for (const src of [yamlStudio?.groupLabels, wsJson?.groupLabels]) {
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (!['__proto__', 'constructor', 'prototype'].includes(k) && typeof v === 'string' && v.trim()) {
          mergedLabels[k] = v.trim();
        }
      }
    }
  }

  const rawScanRoots = Array.isArray(wsJson?.scanRoots)
    ? wsJson.scanRoots
    : (Array.isArray(yamlStudio?.scanRoots) ? yamlStudio.scanRoots : null);
  const scanRoots = rawScanRoots
    ? [...new Set(rawScanRoots.map(s => String(s ?? '').trim()).filter(Boolean).map(s => resolve(repoReal, s)))]
    : null;

  const collections = Array.isArray(wsJson?.collections)
    ? wsJson.collections
    : (Array.isArray(yamlStudio?.collections) ? yamlStudio.collections : []);

  return {
    hasConfig: Boolean(wsJson || yamlStudio),
    role: wsJson?.role || yamlStudio?.role || null,
    title: wsJson?.title || yamlStudio?.title || null,
    scanRoots,
    groupLabels: mergedLabels,
    collections: collections.filter(c => c && typeof c === 'object' && typeof c.kind === 'string'),
  };
}
export async function resolveStudioScanRoots(workspaceRoot, explicitScanRoots, env = process.env) {
  if (explicitScanRoots !== undefined && explicitScanRoots !== null) {
    const raw = Array.isArray(explicitScanRoots) ? explicitScanRoots : String(explicitScanRoots).split(',');
    return raw.map(s => String(s).trim()).filter(s => s && s !== 'none');
  }
  const fromEnv = env?.STUDIO_SCAN_ROOTS || env?.WORKBENCH_SCAN_ROOTS;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    if (fromEnv.trim() === 'none') return [];
    return fromEnv.split(',').map(s => s.trim()).filter(Boolean);
  }
  let rootReal;
  try { rootReal = await realpath(resolve(workspaceRoot)); } catch { return []; }

  const cfg = await loadStudioWorkspaceConfig(rootReal);
  if (Array.isArray(cfg.scanRoots) && cfg.scanRoots.length > 0) {
    const existing = [];
    for (const r of cfg.scanRoots) {
      if (await exists(r)) existing.push(r);
    }
    if (existing.length > 0) return existing;
  }

  let tmpReal = tmpdir();
  try { tmpReal = await realpath(tmpReal); } catch {}
  const immediateParent = resolve(rootReal, '..');
  if (rootReal === '/' || immediateParent === '/' || immediateParent === tmpReal || immediateParent === dirname(tmpReal)) {
    return [rootReal];
  }
  return (await exists(immediateParent)) ? [immediateParent] : [rootReal];
}

async function resolveEffectiveCollections(repoReal, studioCfg = null) {
  const cfg = studioCfg ?? await loadStudioWorkspaceConfig(repoReal);
  if (Array.isArray(cfg.collections) && cfg.collections.length > 0) {
    return cfg.collections;
  }
  const auto = [];
  for (const candidate of [
    {
      id: 'standard-stories-pack',
      kind: 'lifecycle-story-pack',
      storiesJson: 'artifacts/stories/stories.json',
      explanationsDir: 'artifacts/stories/explanations',
      comparisonMarkdown: 'artifacts/stories/replacement-comparison.md',
    },
  ]) {
    if (await exists(join(repoReal, candidate.storiesJson)) || await exists(join(repoReal, candidate.explanationsDir))) {
      auto.push(candidate);
      break;
    }
  }
  for (const manifestJson of [
    'artifact-reading/business/inputs/model-and-scenes.json',
    'artifacts/diagrams/model-and-scenes.json',
  ]) {
    if (await exists(join(repoReal, manifestJson))) {
      auto.push({ id: 'archify-scenes', kind: 'archify-model-scenes', manifestJson });
      break;
    }
  }
  return auto;
}

function extractLockEndpointKey(endpoint) {
  if (!endpoint) return null;
  if (typeof endpoint === 'string') {
    const clean = endpoint.trim();
    return clean || null;
  }
  if (typeof endpoint === 'object') {
    if (typeof endpoint.type === 'string' && typeof endpoint.id === 'string' && endpoint.type && endpoint.id) {
      return `${endpoint.type}:${endpoint.id}`;
    }
    if (typeof endpoint.type === 'string' && typeof endpoint.path === 'string' && endpoint.type && endpoint.path) {
      return `${endpoint.type}:${endpoint.path}`;
    }
    if (typeof endpoint.id === 'string' && endpoint.id) return endpoint.id;
    if (typeof endpoint.path === 'string' && endpoint.path) return endpoint.path;
  }
  return null;
}

async function countConfiguredArtifactFiles(repoReal) {
  try {
    const { schema } = await loadRepoSchemaSafe(repoReal);
    const prefixes = new Set();
    let rootWalk = false;
    for (const def of Object.values(schema.types ?? {})) {
      for (const p of def.paths ?? []) {
        const seg = String(p).replace(/^\.\//, '').split('/')[0];
        if (!seg || /[*?[\]{}]/.test(seg)) rootWalk = true;
        else prefixes.add(seg);
      }
    }
    const matched = new Set();
    const walkCount = async absDir => {
      let entries;
      try { entries = await readdir(absDir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) && !prefixes.has(e.name)) continue;
        if (e.isSymbolicLink()) continue;
        const full = join(absDir, e.name);
        if (e.isDirectory()) {
          await walkCount(full);
        } else if (e.isFile()) {
          const rel = relative(repoReal, full).split('\\').join('/');
          if (matchesConfiguredArtifactPath(rel, schema)) matched.add(rel);
        }
      }
    };
    if (rootWalk) {
      await walkCount(repoReal);
    } else {
      for (const pre of prefixes) {
        const target = join(repoReal, pre);
        try {
          const st = await lstat(target);
          if (!st.isSymbolicLink() && st.isDirectory()) await walkCount(target);
          else if (!st.isSymbolicLink() && st.isFile() && matchesConfiguredArtifactPath(pre, schema)) {
            matched.add(pre);
          }
        } catch {}
      }
    }
    return matched.size;
  } catch {
    return 0;
  }
}

export async function readQuickRepoMeta(repoReal) {
  let pkgName = basename(repoReal);
  let description = '';
  let version = '';
  try {
    const pkg = JSON.parse(await readFileContained(repoReal, 'package.json', { encoding: 'utf8' }));
    if (typeof pkg.name === 'string' && pkg.name) pkgName = pkg.name;
    if (typeof pkg.description === 'string') description = sanitizePublicText(pkg.description);
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {}

  const studioCfg = await loadStudioWorkspaceConfig(repoReal);
  const hasPortfolio = await exists(join(repoReal, 'artifacts/portfolio-allocations.json'));
  const hasUpstream = await exists(join(repoReal, 'artifacts/upstream-bindings.json'));
  const repoRole = (hasPortfolio || studioCfg.role === 'portfolio')
    ? 'portfolio'
    : (hasUpstream ? 'subproject' : 'standalone');
  const repoRoleLabel = repoRole === 'portfolio' ? '高阶规划仓' : (repoRole === 'subproject' ? '详设子仓' : '单项目仓');

  let lockPresent = false;
  let lockedCount = 0;
  let estimatedNodes = 0;
  try {
    const lk = JSON.parse(await readFileContained(repoReal, VERSION_LOCK_PATH, { encoding: 'utf8' }));
    lockPresent = true;
    const locksArr = Array.isArray(lk.locks) ? lk.locks : [];
    const relArr = Array.isArray(lk.artifactRelations) ? lk.artifactRelations : [];
    lockedCount = locksArr.length + relArr.length;
    const uidSet = new Set();
    for (const item of [...locksArr, ...relArr]) {
      for (const rawEp of [item?.source, item?.target, item?.from, item?.to, item?.artifact]) {
        const key = extractLockEndpointKey(rawEp);
        if (key) uidSet.add(key);
      }
    }
    estimatedNodes = uidSet.size;
  } catch {}

  if (estimatedNodes === 0) {
    estimatedNodes = await countConfiguredArtifactFiles(repoReal);
  }

  let richItemBonus = 0;
  const collections = await resolveEffectiveCollections(repoReal, studioCfg);
  for (const col of collections) {
    if (col.kind === 'lifecycle-story-pack') {
      if (col.storiesJson) {
        const stRaw = await readJsonSafeContained(repoReal, col.storiesJson);
        if (Array.isArray(stRaw?.stories)) richItemBonus += stRaw.stories.length;
      }
      if (col.explanationsDir) {
        try {
          const expAbs = await resolveContained(repoReal, col.explanationsDir);
          const expFiles = (await readdir(expAbs)).filter(n => /^\d+\.md$/i.test(n));
          richItemBonus += expFiles.length;
        } catch {}
      }
    } else if (col.kind === 'archify-model-scenes' && col.manifestJson) {
      const msRaw = await readJsonSafeContained(repoReal, col.manifestJson);
      for (const doc of msRaw?.documents ?? []) {
        if (typeof doc?.markdown === 'string' && doc.markdown) richItemBonus += 1;
      }
    }
  }

  let runtimeActive = false;
  let runtimeLabel = '无运行任务';
  for (const rel of ['.skill-family-studio/runtime-registry.json', '.artifacts/runtime-monitor/registry.json', 'artifacts/runtime-monitor/registry.json', '.runs']) {
    if (await exists(join(repoReal, rel))) {
      runtimeActive = true;
      runtimeLabel = '含运行记录';
      break;
    }
  }

  return {
    pkgName,
    description,
    version,
    studioCfg,
    repoRole,
    repoRoleLabel,
    lockPresent,
    lockedCount,
    versionLockLabel: lockPresent ? `已锁 (${lockedCount})` : '未建锁',
    estimatedNodeCount: estimatedNodes + richItemBonus,
    runtimeActive,
    runtimeLabel,
  };
}
export async function discoverStudioRepos(workspaceRoot, { scanRoots, env } = {}) {
  const roots = await resolveStudioScanRoots(workspaceRoot, scanRoots, env);
  let primaryReal = null;
  try {
    const r = await realpath(resolve(workspaceRoot));
    if (await exists(join(r, 'artifact-graph.config.yaml'))) primaryReal = r;
  } catch {}
  if (!roots.length && !primaryReal) {
    return { available: false, count: 0, primaryRepoId: null, repos: [], byId: new Map(), groupLabels: {} };
  }

  const found = [];
  const seen = new Set();
  const tryAdd = async dir => {
    if (!(await exists(join(dir, 'artifact-graph.config.yaml')))) return false;
    let real;
    try { real = await realpath(dir); } catch { return false; }
    if (seen.has(real)) return true;
    seen.add(real);
    found.push(real);
    return true;
  };
  if (primaryReal) await tryAdd(primaryReal);

  for (const sr of roots) {
    let srReal;
    try { srReal = await realpath(resolve(sr)); } catch { continue; }
    if (!SKIP_CLONE_DIR_RE.test(basename(srReal)) && await tryAdd(srReal)) continue;
    let l1 = [];
    try { l1 = await readdir(srReal, { withFileTypes: true }); } catch { continue; }
    for (const e1 of l1.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e1.isDirectory() || shouldSkipDir(e1.name)) continue;
      const d1 = join(srReal, e1.name);
      if (await tryAdd(d1)) continue;
      let l2 = [];
      try { l2 = await readdir(d1, { withFileTypes: true }); } catch { continue; }
      for (const e2 of l2.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e2.isDirectory() || shouldSkipDir(e2.name)) continue;
        await tryAdd(join(d1, e2.name));
      }
    }
  }

  const rootCfg = await loadStudioWorkspaceConfig(resolve(workspaceRoot)).catch(() => ({ groupLabels: {} }));
  const metas = await Promise.all(found.map(realPath => readQuickRepoMeta(realPath)));

  // 合并工作区及发现的高阶仓提供的自然分组标签（启动仓声明优先）
  const mergedGroupLabels = {};
  for (const m of metas) {
    Object.assign(mergedGroupLabels, m.studioCfg?.groupLabels ?? {});
  }
  Object.assign(mergedGroupLabels, rootCfg.groupLabels ?? {});

  const usedIds = new Set();
  const records = [];
  for (let i = 0; i < found.length; i += 1) {
    const realPath = found[i];
    const meta = metas[i];
    const name = basename(realPath);
    const group = basename(dirname(realPath)) || 'workspace';
    let id = `${group}/${name}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    usedIds.add(id);
    records.push({
      id,
      name,
      packageName: meta.pkgName,
      group,
      groupLabel: resolveGroupLabel(group, mergedGroupLabels),
      version: meta.version,
      description: meta.description,
      repoRole: meta.repoRole,
      repoRoleLabel: meta.repoRoleLabel,
      hasStudioConfig: Boolean(meta.studioCfg?.hasConfig),
      isPrimary: primaryReal !== null && realPath === primaryReal,
      lockPresent: meta.lockPresent,
      lockedCount: meta.lockedCount,
      versionLockLabel: meta.versionLockLabel,
      nodeCount: meta.estimatedNodeCount,
      reviewableCount: meta.estimatedNodeCount,
      runtimeActive: meta.runtimeActive,
      runtimeLabel: meta.runtimeLabel,
      realPath,
    });
  }

  records.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return `${a.group}/${a.name}`.localeCompare(`${b.group}/${b.name}`);
  });

  const publicRepos = records.map(({ realPath: _omit, ...pub }) => pub);
  return {
    available: publicRepos.length > 0,
    count: publicRepos.length,
    primaryRepoId: publicRepos[0]?.id ?? null,
    repos: publicRepos,
    byId: new Map(records.map(r => [r.id, r])),
    groupLabels: mergedGroupLabels,
  };
}

async function loadArchifyCollection(repoReal, manifestRel, extraItems, archifyDiagrams, allowedArchifyDirs) {
  const ms = await readJsonSafeContained(repoReal, manifestRel);
  if (!ms) return;
  for (const doc of ms.documents ?? []) {
    if (doc.markdown && typeof doc.markdown === 'string') {
      try {
        const mdRaw = sanitizePublicText(await readFileContained(repoReal, doc.markdown, { encoding: 'utf8' }));
        const rendered = renderMarkdownToHtml(mdRaw, { idPrefix: `art-${doc.pageId || 'doc'}` });
        extraItems.push({
          uid: `business_article:${doc.pageId || basename(doc.markdown, '.md')}`,
          target: `business_article:${doc.pageId || basename(doc.markdown, '.md')}`,
          type: 'business_article',
          typeLabel: '业务专题文稿',
          category: 'business_articles',
          layer: 'domain',
          layerOrder: 2,
          layerLabel: '领域与决策',
          code: String(doc.pageId || basename(doc.markdown, '.md')).toUpperCase(),
          title: sanitizePublicText(doc.title || rendered.title || basename(doc.markdown)),
          path: doc.markdown,
          status: 'active',
          isDesignNode: true,
          inDegree: 0,
          outDegree: (doc.figures ?? []).length,
          inlineDoc: { title: doc.title || rendered.title, headings: rendered.headings, html: rendered.html },
        });
      } catch {}
    }
    for (const fig of doc.figures ?? []) {
      if (!fig?.html) continue;
      const cleanHtml = String(fig.html).replace(/\\/g, '/').replace(/^\.\//, '');
      allowedArchifyDirs.add(dirname(cleanHtml));
      archifyDiagrams.push({
        id: fig.id,
        title: sanitizePublicText(fig.title || fig.id),
        docPageId: doc.pageId ? String(doc.pageId) : null,
        docTitle: sanitizePublicText(doc.title || ''),
        htmlPath: cleanHtml,
        resources: Array.isArray(fig.resources) ? fig.resources : [],
        bindings: Array.isArray(fig.bindings)
          ? fig.bindings
              .filter(b => b?.nodeId && b?.pageId)
              .map(b => ({
                nodeId: String(b.nodeId),
                pageId: String(b.pageId),
                anchor: b.anchor ? String(b.anchor) : null,
              }))
          : [],
      });
    }
  }
}

async function loadLifecycleStoryPack(repoReal, col) {
  const items = [];
  const storiesRel = col.storiesJson || null;
  const storiesRaw = storiesRel ? await readJsonSafeContained(repoReal, storiesRel) : null;
  const groups = storiesRaw?.groups ?? {};

  const gapMap = new Map();
  if (col.comparisonMarkdown) {
    try {
      const compMd = sanitizePublicText(await readFileContained(repoReal, col.comparisonMarkdown, { encoding: 'utf8' }));
      const gapRegex = /^###\s+(US-\d{3,})\s*·\s*(.+)$/gm;
      const matches = [...compMd.matchAll(gapRegex)];
      const tableMatch = /^##\s+全部.*旧故事/m.exec(compMd);
      const tableStart = tableMatch ? tableMatch.index : -1;
      for (let idx = 0; idx < matches.length; idx += 1) {
        const m = matches[idx];
        const start = m.index + m[0].length;
        const end = idx + 1 < matches.length ? matches[idx + 1].index : (tableStart > start ? tableStart : compMd.length);
        gapMap.set(m[1].trim(), compMd.slice(start, end).trim());
      }
    } catch {}
  }

  if (col.explanationsDir) {
    try {
      const expDir = await resolveContained(repoReal, col.explanationsDir);
      const expFiles = (await readdir(expDir)).filter(n => /^\d+\.md$/i.test(n)).sort();
      for (const fileName of expFiles) {
        const num = fileName.replace(/\.md$/i, '');
        const relFile = `${col.explanationsDir.replace(/\/$/, '')}/${fileName}`;
        const md = sanitizePublicText(await readFileContained(repoReal, relFile, { encoding: 'utf8' }));
        const lcId = (/故事编号\s+(LC-\d+)/i.exec(md)?.[1] || `LC-${num}`).toUpperCase();
        const rendered = renderMarkdownToHtml(md, { idPrefix: `lc-${num}`, stripNavLine: true });
        const cleanTitle = (rendered.title || lcId).replace(/^\d+\s*·\s*/, '').trim();
        items.push({
          uid: `lifecycle:${lcId}`,
          target: `lifecycle:${lcId}`,
          type: 'lifecycle',
          typeLabel: '生命周期讲解',
          category: 'lc_explanations',
          layer: 'product',
          layerOrder: 1,
          layerLabel: '产品与故事',
          code: lcId,
          title: cleanTitle,
          path: relFile,
          status: 'active',
          isDesignNode: true,
          inDegree: 0,
          outDegree: 0,
          inlineDoc: { title: `${lcId} · ${cleanTitle}`, headings: rendered.headings, html: rendered.html },
        });
      }
    } catch {}
  }

  for (const st of storiesRaw?.stories ?? []) {
    const fields = st.fields ?? {};
    const gapBody = gapMap.get(st.id) || '';
    const mdLines = [
      `## ${st.id} · ${st.title}`,
      '',
      `- **所属能力分组**：${groups[st.group] ?? st.group ?? '默认分组'}`,
      ...Object.entries(fields).map(([k, v]) => `- **${k}**：${v}`),
    ];
    if (gapBody) {
      mdLines.push('', '## 新旧承接对照说明', '', gapBody);
    }
    const rendered = renderMarkdownToHtml(sanitizePublicText(mdLines.join('\n')), { idPrefix: `us-${st.id.toLowerCase()}` });
    items.push({
      uid: `lifecycle_story:${st.id}`,
      target: `lifecycle_story:${st.id}`,
      type: 'lifecycle_story',
      typeLabel: gapBody ? '差异对照故事' : '原始需求故事',
      category: gapBody ? 'gap_resolutions' : 'us_stories',
      layer: 'product',
      layerOrder: 1,
      layerLabel: '产品与故事',
      code: st.id,
      title: sanitizePublicText(st.title),
      path: `${storiesRel}#${st.id}`,
      status: gapBody ? 'accepted' : 'active',
      isDesignNode: true,
      inDegree: 0,
      outDegree: 0,
      inlineDoc: { title: `${st.id} · ${st.title}`, headings: rendered.headings, html: rendered.html },
    });
  }
  return items;
}
async function loadRepoCollections(repoReal) {
  const studioCfg = await loadStudioWorkspaceConfig(repoReal);
  const collections = await resolveEffectiveCollections(repoReal, studioCfg);
  const extraItems = [];
  const archifyDiagrams = [];
  const allowedArchifyDirs = new Set();

  for (const col of collections) {
    if (col.kind === 'archify-model-scenes' && col.manifestJson) {
      await loadArchifyCollection(repoReal, col.manifestJson, extraItems, archifyDiagrams, allowedArchifyDirs);
    } else if (col.kind === 'lifecycle-story-pack') {
      extraItems.push(...await loadLifecycleStoryPack(repoReal, col));
    }
  }

  // 若无声明式 Archify 清单，通用兜底发现 artifacts/diagrams/**/*.html
  if (archifyDiagrams.length === 0) {
    try {
      const diagRoot = await resolveContained(repoReal, 'artifacts/diagrams');
      const entries = await readdir(diagRoot, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isFile() && e.name.endsWith('.html')) {
          const relHtml = `artifacts/diagrams/${e.name}`;
          allowedArchifyDirs.add('artifacts/diagrams');
          archifyDiagrams.push({
            id: basename(e.name, '.html'),
            title: basename(e.name, '.html'),
            docPageId: null,
            docTitle: '',
            htmlPath: relHtml,
            resources: [],
            bindings: [],
          });
        }
      }
    } catch {}
  }

  return { studioCfg, extraItems, archifyDiagrams, allowedArchifyDirs };
}

async function loadRepoSchemaSafe(repoReal) {
  try {
    return { schema: await loadConfig(repoReal), configStatus: 'ok', configMessage: null };
  } catch (error) {
    if (String(error?.message ?? '').includes('allowedEdges')) {
      const raw = await readFileContained(repoReal, 'artifact-graph.config.yaml', { encoding: 'utf8' });
      const tmp = await mkdtemp(join(tmpdir(), 'sfs-cfg-'));
      try {
        await writeFile(join(tmp, 'artifact-graph.config.yaml'), `${raw}\nallowedEdges: null\n`);
        return {
          schema: await loadConfig(tmp),
          configStatus: 'legacy_diagnostic',
          configMessage: '该仓库尚未在配置中显式声明 allowedEdges，当前按默认边规则只读展示。',
        };
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

export async function inspectProjectRepo(record, emptyScanDir) {
  const { schema, configStatus, configMessage } = await loadRepoSchemaSafe(record.realPath);
  const prefixes = new Set();
  let rootWalk = false;
  for (const def of Object.values(schema.types ?? {})) {
    for (const p of def.paths ?? []) {
      const seg = String(p).replace(/^\.\//, '').split('/')[0];
      if (!seg || /[*?[\]{}]/.test(seg)) rootWalk = true;
      else prefixes.add(seg);
    }
  }
  const contents = new Map();
  async function walk(absDir) {
    let entries;
    try { entries = await readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) && !prefixes.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const full = join(absDir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = relative(record.realPath, full).split('\\').join('/');
        if (matchesConfiguredArtifactPath(rel, schema)) {
          try { contents.set(rel, await readFileContained(record.realPath, rel, { encoding: 'utf8' })); } catch {}
        }
      }
    }
  }
  if (rootWalk) await walk(record.realPath);
  else {
    for (const pre of prefixes) {
      const target = join(record.realPath, pre);
      try {
        const st = await lstat(target);
        if (!st.isSymbolicLink() && st.isDirectory()) await walk(target);
        else if (!st.isSymbolicLink() && st.isFile() && matchesConfiguredArtifactPath(pre, schema)) {
          contents.set(pre, await readFileContained(record.realPath, pre, { encoding: 'utf8' }));
        }
      } catch {}
    }
  }

  const graph = await scanArtifacts(emptyScanDir, schema, { contents });
  const inDeg = new Map(), outDeg = new Map();
  for (const e of graph.edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const graphNodes = graph.nodes.map(nd => {
    const tc = schema.types?.[nd.type] ?? {};
    const ld = classifyLayer(nd.type, tc.layer);
    const isCode = nd.type === 'test' || nd.type === 'implementation' || CODE_EXT_RE.test(nd.path);
    const category = classifyReviewCategory(nd.type, ld.id);
    return {
      uid: nd.uid,
      target: nd.uid,
      type: nd.type,
      typeLabel: tc.displayName || TYPE_LABELS[nd.type] || nd.type,
      category,
      layer: ld.id,
      layerOrder: ld.order,
      layerLabel: ld.label,
      code: nd.code,
      title: sanitizePublicText(nd.title || nd.code),
      path: nd.path,
      line: nd.line,
      status: nd.status ?? null,
      isDesignNode: !isCode,
      inDegree: inDeg.get(nd.uid) ?? 0,
      outDegree: outDeg.get(nd.uid) ?? 0,
    };
  });

  const relSem = schema.relationSemantics ?? {};
  const edges = graph.edges.map(e => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    kindLabel: relSem[e.kind]?.label || EDGE_LABELS[e.kind] || e.kind,
    sourcePath: e.sourcePath,
    sourceLine: e.sourceLine,
  }));

  const colResult = await loadRepoCollections(record.realPath);

  const lockExists = await exists(join(record.realPath, VERSION_LOCK_PATH));
  let versionLock = { present: lockExists, status: 'missing', badgeTone: 'zinc', badgeLabel: '未建版本锁', issueCount: 0, codeLocksCount: 0 };
  if (lockExists) {
    try {
      const audit = await auditVersionLock(record.realPath, VERSION_LOCK_PATH, graph, schema);
      const blockingCount = (audit.issues ?? []).filter(i => isVersionLockIssueBlocking(i, { strictMissingLock: true })).length;
      const totalAll = (audit.totalLocks ?? 0) + (audit.totalArtifactRelationLocks ?? 0);
      const freshAll = (audit.fresh ?? 0) + (audit.artifactRelationFresh ?? 0);
      const ok = blockingCount === 0 && (audit.issues ?? []).length === 0;
      versionLock = {
        present: true,
        status: ok ? 'fresh' : 'stale',
        badgeTone: ok ? 'emerald' : (blockingCount > 0 ? 'rose' : 'amber'),
        badgeLabel: ok ? (totalAll > 0 ? `锁新鲜 (${freshAll}/${totalAll})` : '版本锁就绪 (0 条边)') : `锁漂移 (${audit.issues.length})`,
        issueCount: (audit.issues ?? []).length,
        codeLocksCount: audit.totalLocks ?? 0,
        relationLocksCount: audit.totalArtifactRelationLocks ?? 0,
      };
    } catch {
      versionLock = { present: true, status: 'diagnostic', badgeTone: 'amber', badgeLabel: '版本锁待核实', issueCount: 0, codeLocksCount: 0 };
    }
  }

  const designGraphNodes = graphNodes.filter(n => n.isDesignNode);
  const allReviewItems = sortItemsForGuidedReview([
    ...(designGraphNodes.length ? designGraphNodes : graphNodes),
    ...colResult.extraItems,
  ]);
  const inlineDocs = new Map();
  for (const item of colResult.extraItems) {
    if (item.inlineDoc) inlineDocs.set(item.uid, item.inlineDoc);
  }
  const publicItems = allReviewItems.map(({ inlineDoc: _omit, ...rest }) => rest);

  // 按阅读任务主次分组与排序分类胶囊
  const catDefs = [
    { id: 'stories', label: '理解诉求 · 用户故事', group: 'primary', groupLabel: '首要阅读' },
    { id: 'lc_explanations', label: '生命周期讲解 (LC)', group: 'primary', groupLabel: '首要阅读' },
    { id: 'us_stories', label: '原始需求故事 (US)', group: 'primary', groupLabel: '首要阅读' },
    { id: 'gap_resolutions', label: '差异承接决议', group: 'primary', groupLabel: '首要阅读' },
    { id: 'requirements', label: '核对进展 · 需求总纲', group: 'primary', groupLabel: '首要阅读' },
    { id: 'scenarios', label: '细看行为 · 场景剧本', group: 'primary', groupLabel: '首要阅读' },
    { id: 'domain', label: '领域与决策', group: 'supporting', groupLabel: '关联依据' },
    { id: 'business_articles', label: '业务专题文稿', group: 'supporting', groupLabel: '关联依据' },
    { id: 'architecture', label: '架构与规格', group: 'supporting', groupLabel: '关联依据' },
    { id: 'verification', label: '测试与实现追溯', group: 'supporting', groupLabel: '关联依据' },
  ];
  const categories = [
    { id: 'all', label: '全部审阅项', group: 'all', groupLabel: '全部', count: publicItems.length },
    ...catDefs
      .map(c => ({ ...c, count: publicItems.filter(i => i.category === c.id).length }))
      .filter(c => c.count > 0),
  ];

  return {
    publicSnapshot: {
      repoId: record.id,
      repoName: record.name,
      group: record.group,
      groupLabel: record.groupLabel,
      repoRole: record.repoRole,
      repoRoleLabel: record.repoRoleLabel,
      configStatus,
      configMessage,
      counts: {
        nodes: graphNodes.length,
        designNodes: designGraphNodes.length,
        edges: edges.length,
        reviewItems: publicItems.length,
        archifyDiagrams: colResult.archifyDiagrams.length,
      },
      layers: DEFAULT_LAYERS,
      versionLock,
      nodes: graphNodes,
      edges,
      categories,
      reviewItems: publicItems,
      archifyDiagrams: colResult.archifyDiagrams,
    },
    contents,
    inlineDocs,
    allowedArchifyDirs: colResult.allowedArchifyDirs,
  };
}

export async function readRepoDocument(record, cachedEntry, { path: rawPath, uid: rawUid } = {}) {
  if (rawUid && cachedEntry.inlineDocs.has(rawUid)) {
    const inline = cachedEntry.inlineDocs.get(rawUid);
    return {
      ok: true,
      repoId: record.id,
      uid: rawUid,
      path: rawPath || rawUid,
      format: 'markdown',
      title: inline.title,
      frontmatter: {},
      headings: inline.headings,
      html: inline.html,
    };
  }
  const cleanPath = String(rawPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').split('#')[0];
  if (!cleanPath || cleanPath.startsWith('/') || cleanPath.split('/').includes('..')) {
    throw Object.assign(new Error('非法的文档路径请求；禁止绝对路径或上级目录跳转。'), { statusCode: 400 });
  }
  const known = cachedEntry.contents.has(cleanPath)
    || cachedEntry.publicSnapshot.nodes.some(n => n.path === cleanPath)
    || SAFE_EXTRA_DOCS.has(cleanPath);
  if (!known) {
    throw Object.assign(new Error('请求的文档不在当前仓库制品图受管读取范围内。'), { statusCode: 404 });
  }
  let rawText = cachedEntry.contents.get(cleanPath);
  if (rawText === undefined) {
    try { rawText = await readFileContained(record.realPath, cleanPath, { encoding: 'utf8' }); }
    catch { throw Object.assign(new Error('未找到对应的制品原件文件。'), { statusCode: 404 }); }
  }
  const sanitized = sanitizePublicText(rawText);
  if (extname(cleanPath).toLowerCase() === '.md') {
    let frontmatter = {};
    let body = sanitized;
    const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(sanitized.replace(/\r\n/g, '\n'));
    if (fm) {
      try {
        const parsed = parseYaml(fm[1]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (!['__proto__', 'constructor', 'prototype'].includes(k)) frontmatter[k] = v;
          }
        }
      } catch {}
      body = fm[2];
    }
    const rendered = renderMarkdownToHtml(body, { idPrefix: 'doc-sec' });
    return {
      ok: true,
      repoId: record.id,
      path: cleanPath,
      format: 'markdown',
      title: rendered.title || String(frontmatter.title ?? basename(cleanPath)),
      frontmatter,
      headings: rendered.headings,
      html: rendered.html,
    };
  }
  return {
    ok: true,
    repoId: record.id,
    path: cleanPath,
    format: extname(cleanPath).slice(1) || 'text',
    title: basename(cleanPath),
    frontmatter: {},
    headings: [],
    html: `<pre class="st-code-block"><code>${escapeHtml(sanitized)}</code></pre>`,
  };
}

export async function readRepoArchifyAsset(record, cachedEntry, rawAssetPath) {
  const cleanPath = String(rawAssetPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleanPath || cleanPath.startsWith('/') || cleanPath.split('/').includes('..')) {
    throw Object.assign(new Error('非法的 Archify 资源路径请求。'), { statusCode: 400 });
  }
  const allowed = [...cachedEntry.allowedArchifyDirs].some(dir => cleanPath.startsWith(`${dir}/`));
  if (!allowed) {
    throw Object.assign(new Error('请求的图谱文件不在受管 Archify 目录白名单内。'), { statusCode: 404 });
  }
  const bytes = await readFileContained(record.realPath, cleanPath);
  return { cleanPath, bytes };
}
