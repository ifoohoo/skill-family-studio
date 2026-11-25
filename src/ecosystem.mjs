// @feature STU004
// @feature STU006

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  VERSION_LOCK_PATH,
  auditVersionLock,
  isVersionLockIssueBlocking,
  loadConfig,
  matchesConfiguredArtifactPath,
  scanArtifacts,
} from 'artifact-graph';
import { readFileContained, resolveContained, writeFileAtomic } from 'skill-family-harness-node';
import { parse as parseYaml } from 'yaml';
import {
  computeFoundationBaseline,
  evaluateRepoFoundationAlignment,
  readRepoTrackedDependencies,
  resolveRepoTier,
} from './alignment-inspector.mjs';
import { DEFAULT_LAYERS } from './graph-layout.mjs';
import { cleanInlinePlain, escapeHtml, extractArtifactBrief, renderMarkdownToHtml, sanitizePublicText, stripYamlFrontmatter } from './markdown-render.mjs';
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

function classifyReviewCategory(type, layerId, isMachineContract = false) {
  if (isMachineContract) return 'contracts';
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

  const repoTier = wsJson?.repoTier || yamlStudio?.repoTier || null;
  const repoTierSource = wsJson?.repoTier
    ? '.studio-workspace.json'
    : (yamlStudio?.repoTier ? 'artifact-graph.config.yaml#studio' : null);
  const repoTiers = (wsJson?.repoTiers && typeof wsJson.repoTiers === 'object' && !Array.isArray(wsJson.repoTiers))
    ? wsJson.repoTiers
    : ((yamlStudio?.repoTiers && typeof yamlStudio.repoTiers === 'object' && !Array.isArray(yamlStudio.repoTiers)) ? yamlStudio.repoTiers : {});
  const groupTiers = (wsJson?.groupTiers && typeof wsJson.groupTiers === 'object' && !Array.isArray(wsJson.groupTiers))
    ? wsJson.groupTiers
    : ((yamlStudio?.groupTiers && typeof yamlStudio.groupTiers === 'object' && !Array.isArray(yamlStudio.groupTiers)) ? yamlStudio.groupTiers : {});

  return {
    hasConfig: Boolean(wsJson || yamlStudio),
    role: wsJson?.role || yamlStudio?.role || null,
    title: wsJson?.title || yamlStudio?.title || null,
    repoTier,
    repoTierSource,
    repoTiers,
    groupTiers,
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
  const configured = Array.isArray(cfg.collections) ? [...cfg.collections] : [];
  const hasStories = configured.some(c => c.kind === 'lifecycle-story-pack');
  const hasArchify = configured.some(c => c.kind === 'archify-model-scenes');

  if (!hasStories) {
    const candidate = {
      id: 'standard-stories-pack',
      kind: 'lifecycle-story-pack',
      storiesJson: 'artifacts/stories/stories.json',
      explanationsDir: 'artifacts/stories/explanations',
      comparisonMarkdown: 'artifacts/stories/replacement-comparison.md',
    };
    if (await exists(join(repoReal, candidate.storiesJson)) || await exists(join(repoReal, candidate.explanationsDir))) {
      configured.push(candidate);
    }
  }
  if (!hasArchify) {
    for (const manifestJson of [
      'artifact-reading/business/inputs/model-and-scenes.json',
      'artifacts/diagrams/model-and-scenes.json',
    ]) {
      if (await exists(join(repoReal, manifestJson))) {
        configured.push({ id: 'archify-scenes', kind: 'archify-model-scenes', manifestJson });
        break;
      }
    }
  }
  return configured;
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

export const STUDIO_WORKSPACE_PROJECTS_PATH = '.skill-family-studio/workspace-projects.json';

const SENSITIVE_SYSTEM_PREFIXES = ['/etc', '/private/etc', '/System', '/Library', '/var/root', '/private/var/root', '/root'];
const SENSITIVE_PATH_SEGMENTS = new Set([
  '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'keychains',
]);

function isSensitiveSystemOrCredentialPath(absPath) {
  const clean = resolve(String(absPath || ''));
  for (const prefix of SENSITIVE_SYSTEM_PREFIXES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return `系统受限目录 (${prefix})`;
    }
  }
  for (const seg of clean.split(/[\\/]+/)) {
    const low = seg.toLowerCase();
    if (!low) continue;
    if (SENSITIVE_PATH_SEGMENTS.has(low) || low === '.env' || low.startsWith('.env.')) {
      return `包含敏感凭据路径段 (${seg})`;
    }
  }
  return null;
}

async function validateSafeLocalRepoPath(rawOrAbs, rootReal = null) {
  const candidateAbs = isAbsolute(rawOrAbs) ? resolve(rawOrAbs) : resolve(rootReal || '.', rawOrAbs);
  const rawHit = isSensitiveSystemOrCredentialPath(candidateAbs);
  if (rawHit) {
    throw Object.assign(new Error(`安全守卫拒绝接入目录：${rawHit}。`), { statusCode: 403 });
  }
  let cur = candidateAbs;
  while (cur && cur !== dirname(cur)) {
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      throw Object.assign(new Error(`未找到可读取的本地目录：${sanitizePublicText(rawOrAbs)}（${err.message}）`), { statusCode: 400 });
    }
    if (st.isSymbolicLink() && cur !== '/var' && cur !== '/tmp') {
      throw Object.assign(new Error('安全守卫拒绝接入目录：目标路径或父级路径存在符号链接跳板。'), { statusCode: 403 });
    }
    cur = dirname(cur);
  }
  const stSelf = await lstat(candidateAbs);
  if (stSelf.isSymbolicLink() || !stSelf.isDirectory()) {
    throw Object.assign(new Error('目标路径必须是真实存在的普通本地目录（不可为文件或符号链接）。'), { statusCode: 400 });
  }
  const targetReal = await realpath(candidateAbs);
  const realHit = isSensitiveSystemOrCredentialPath(targetReal);
  if (realHit) {
    throw Object.assign(new Error(`安全守卫拒绝接入目录：${realHit}。`), { statusCode: 403 });
  }
  return targetReal;
}

async function loadWorkspaceProjectOverrides(workspaceRoot) {
  let rootReal;
  try { rootReal = await realpath(resolve(workspaceRoot)); } catch { return { storagePath: STUDIO_WORKSPACE_PROJECTS_PATH, extraRepos: [], excludedRepos: [], repoMeta: {} }; }
  const hasWsJson = await exists(join(rootReal, '.studio-workspace.json'));
  const wsDoc = hasWsJson ? await readJsonSafeContained(rootReal, '.studio-workspace.json') : null;
  const localDoc = await readJsonSafeContained(rootReal, STUDIO_WORKSPACE_PROJECTS_PATH);

  const rawExtra = [
    ...(Array.isArray(wsDoc?.extraRepos) ? wsDoc.extraRepos : []),
    ...(Array.isArray(localDoc?.extraRepos) ? localDoc.extraRepos : []),
  ];
  const rawExcl = [
    ...(Array.isArray(wsDoc?.excludedRepos) ? wsDoc.excludedRepos : []),
    ...(Array.isArray(localDoc?.excludedRepos) ? localDoc.excludedRepos : []),
  ];
  const repoMeta = {};
  for (const src of [wsDoc?.repoMeta, localDoc?.repoMeta]) {
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
        repoMeta[k] = { ...(Object.hasOwn(repoMeta, k) ? repoMeta[k] : {}), ...v };
      }
    }
  }
  return {
    rootReal,
    storagePath: STUDIO_WORKSPACE_PROJECTS_PATH,
    extraRepos: [...new Set(rawExtra.map(s => String(s ?? '').trim()).filter(Boolean))],
    excludedRepos: [...new Set(rawExcl.map(s => String(s ?? '').trim()).filter(Boolean))],
    repoMeta,
  };
}

async function mutateWorkspaceProjectOverrides(workspaceRoot, mutator) {
  const rootReal = await realpath(resolve(workspaceRoot));
  const relPath = STUDIO_WORKSPACE_PROJECTS_PATH;
  const existing = await readJsonSafeContained(rootReal, relPath)
    || { schemaVersion: 1, extraRepos: [], excludedRepos: [], repoMeta: {} };
  if (!Array.isArray(existing.extraRepos)) existing.extraRepos = [];
  if (!Array.isArray(existing.excludedRepos)) existing.excludedRepos = [];
  if (!existing.repoMeta || typeof existing.repoMeta !== 'object' || Array.isArray(existing.repoMeta)) {
    existing.repoMeta = {};
  }
  await mutator(existing, rootReal, relPath);
  existing.updatedAt = new Date().toISOString();
  const absTarget = await resolveContained(rootReal, relPath);
  await mkdir(dirname(absTarget), { recursive: true });
  await writeFileAtomic(rootReal, relPath, `${JSON.stringify(existing, null, 2)}\n`);
  return { storagePath: relPath, doc: existing };
}

function portableRepoRef(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal).split('\\').join('/');
  if (!rel) return '.';
  if (!rel.startsWith('..') || /^(\.\.\/){1,2}[^/]/.test(rel)) return rel;
  return targetReal;
}

export async function registerStudioRepo(workspaceRoot, input = {}) {
  const rawPath = String(input.repoPath ?? '').trim();
  if (!rawPath || rawPath.includes('\0')) {
    throw Object.assign(new Error('请提供有效的本地仓库目录路径。'), { statusCode: 400 });
  }
  const rootReal = await realpath(resolve(workspaceRoot));
  const targetReal = await validateSafeLocalRepoPath(rawPath, rootReal);
  if (!(await exists(join(targetReal, 'artifact-graph.config.yaml')))) {
    throw Object.assign(new Error('目标目录缺少 artifact-graph.config.yaml；请确认路径指向技能族或受管制品仓库根目录。'), { statusCode: 400 });
  }

  const ref = portableRepoRef(rootReal, targetReal);
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
  const groupLabel = typeof input.groupLabel === 'string' ? input.groupLabel.trim().slice(0, 80) : '';
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 400) : '';

  const saved = await mutateWorkspaceProjectOverrides(workspaceRoot, async doc => {
    doc.excludedRepos = doc.excludedRepos.filter(x => {
      try { return resolve(rootReal, x) !== targetReal && x !== targetReal && x !== ref; } catch { return true; }
    });
    const alreadyInExtra = doc.extraRepos.some(x => {
      try { return resolve(rootReal, x) === targetReal || x === targetReal || x === ref; } catch { return false; }
    });
    if (!alreadyInExtra) doc.extraRepos.push(ref);
    if (title || groupLabel || description) {
      const prev = Object.hasOwn(doc.repoMeta, ref) ? doc.repoMeta[ref] : {};
      doc.repoMeta[ref] = {
        ...prev,
        ...(title ? { title } : {}),
        ...(groupLabel ? { groupLabel } : {}),
        ...(description ? { description } : {}),
      };
    }
  });
  return { ok: true, repoPath: sanitizePublicText(ref), realPath: targetReal, storagePath: saved.storagePath };
}

export async function unregisterStudioRepo(workspaceRoot, input = {}, catalog = null) {
  const repoId = String(typeof input === 'string' ? input : (input.repoId ?? '')).trim();
  if (!repoId) throw Object.assign(new Error('请指定要移除的 repoId。'), { statusCode: 400 });
  const rec = catalog?.byId?.get(repoId);
  if (!rec) throw Object.assign(new Error(`未找到指定的项目仓库：${repoId}`), { statusCode: 404 });
  if (catalog.count <= 1) {
    throw Object.assign(new Error('当前仅剩最后 1 个受管仓库，不可全部清空；如需切换请先添加其他项目。'), { statusCode: 400 });
  }
  const rootReal = await realpath(resolve(workspaceRoot));
  const ref = portableRepoRef(rootReal, rec.realPath);

  const saved = await mutateWorkspaceProjectOverrides(workspaceRoot, async doc => {
    const matchesTarget = x => {
      if (x === repoId || x === ref || x === rec.realPath) return true;
      try { return resolve(rootReal, x) === rec.realPath; } catch { return false; }
    };
    const wasExtra = doc.extraRepos.some(matchesTarget);
    doc.extraRepos = doc.extraRepos.filter(x => !matchesTarget(x));
    if (!wasExtra && !doc.excludedRepos.some(matchesTarget)) {
      doc.excludedRepos.push(ref);
    }
  });
  return { ok: true, removedRepoId: repoId, storagePath: saved.storagePath };
}

export async function updateStudioRepoMeta(workspaceRoot, input = {}, catalog = null) {
  const repoId = String(input.repoId ?? '').trim();
  if (!repoId) throw Object.assign(new Error('请指定要编辑的 repoId。'), { statusCode: 400 });
  const rec = catalog?.byId?.get(repoId);
  if (!rec) throw Object.assign(new Error(`未找到指定的项目仓库：${repoId}`), { statusCode: 404 });

  const rootReal = await realpath(resolve(workspaceRoot));
  const ref = portableRepoRef(rootReal, rec.realPath);

  if (input.reset === true) {
    const saved = await mutateWorkspaceProjectOverrides(workspaceRoot, async doc => {
      for (const k of [ref, repoId, rec.realPath]) {
        if (k && Object.hasOwn(doc.repoMeta, k)) delete doc.repoMeta[k];
      }
    });
    return { ok: true, repoId, reset: true, storagePath: saved.storagePath };
  }

  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : undefined;
  const groupLabel = typeof input.groupLabel === 'string' ? input.groupLabel.trim().slice(0, 80) : undefined;
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 400) : undefined;

  const saved = await mutateWorkspaceProjectOverrides(workspaceRoot, async doc => {
    const key = Object.hasOwn(doc.repoMeta, ref)
      ? ref
      : (Object.hasOwn(doc.repoMeta, repoId) ? repoId : ref);
    const prev = Object.hasOwn(doc.repoMeta, key) && doc.repoMeta[key] && typeof doc.repoMeta[key] === 'object'
      ? doc.repoMeta[key]
      : {};
    const nextMeta = { ...prev };
    if (title !== undefined) {
      if (title) nextMeta.title = title;
      else delete nextMeta.title;
    }
    if (groupLabel !== undefined) {
      if (groupLabel) nextMeta.groupLabel = groupLabel;
      else delete nextMeta.groupLabel;
    }
    if (description !== undefined) {
      if (description) nextMeta.description = description;
      else delete nextMeta.description;
    }
    if (Object.keys(nextMeta).length > 0) doc.repoMeta[key] = nextMeta;
    else delete doc.repoMeta[key];
  });
  return { ok: true, repoId, reset: false, storagePath: saved.storagePath };
}

export async function readQuickRepoMeta(repoReal) {
  let pkgName = basename(repoReal);
  let description = '';
  let version = '';
  const metaSources = [];
  let pkgDescPresent = false;
  try {
    const pkg = JSON.parse(await readFileContained(repoReal, 'package.json', { encoding: 'utf8' }));
    if (typeof pkg.name === 'string' && pkg.name) pkgName = pkg.name;
    if (typeof pkg.description === 'string' && pkg.description.trim()) {
      description = sanitizePublicText(pkg.description.trim());
      pkgDescPresent = true;
      metaSources.push({ field: '项目说明', sourceFile: 'package.json#description', active: true });
    }
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {}

  let readmeDesc = '';
  try {
    const rmMd = await readFileContained(repoReal, 'README.md', { encoding: 'utf8' });
    const brief = extractArtifactBrief({ rawText: rmMd, fallbackTitle: pkgName, path: 'README.md' });
    if (brief.summary && !brief.summary.startsWith('查看')) {
      readmeDesc = brief.summary;
      metaSources.push({ field: '项目说明候选', sourceFile: 'README.md 首段', active: !pkgDescPresent });
      if (!description) description = readmeDesc;
    }
  } catch {}

  const studioCfg = await loadStudioWorkspaceConfig(repoReal);
  if (studioCfg.title) metaSources.push({ field: '工作区标题', sourceFile: '.studio-workspace.json / studio.title', active: true });
  const declaredDeps = await readRepoTrackedDependencies(repoReal);
  const hasPortfolio = await exists(join(repoReal, 'artifacts/portfolio-allocations.json'));
  const hasUpstream = await exists(join(repoReal, 'artifacts/upstream-bindings.json'));
  const repoRole = (hasPortfolio || studioCfg.role === 'portfolio')
    ? 'portfolio'
    : (hasUpstream ? 'subproject' : 'standalone');
  const repoRoleLabel = repoRole === 'portfolio' ? '高阶规划仓' : (repoRole === 'subproject' ? '详设子仓' : '单项目仓');

  let lockPresent = false;
  let lockedCount = 0;
  let estimatedNodes = 0;
  let estimatedDesignNodes = 0;
  const isCodeEndpoint = ep => {
    if (!ep || typeof ep !== 'object') return false;
    if (ep.type === 'code' || ep.type === 'test' || ep.type === 'implementation') return true;
    return typeof ep.path === 'string' && CODE_EXT_RE.test(ep.path);
  };
  try {
    const lk = JSON.parse(await readFileContained(repoReal, VERSION_LOCK_PATH, { encoding: 'utf8' }));
    lockPresent = true;
    const locksArr = Array.isArray(lk.locks) ? lk.locks : [];
    const relArr = Array.isArray(lk.artifactRelations) ? lk.artifactRelations : [];
    lockedCount = locksArr.length + relArr.length;
    const uidSet = new Set();
    const designUidSet = new Set();
    for (const item of locksArr) {
      for (const rawEp of [item?.source, item?.target, item?.from, item?.to, item?.artifact]) {
        const key = extractLockEndpointKey(rawEp);
        if (key) {
          uidSet.add(key);
          if (!isCodeEndpoint(rawEp)) designUidSet.add(key);
        }
      }
    }
    for (const item of relArr) {
      for (const rawEp of [item?.source, item?.target, item?.from, item?.to, item?.artifact]) {
        const key = extractLockEndpointKey(rawEp);
        if (key) {
          uidSet.add(key);
          if (!isCodeEndpoint(rawEp)) designUidSet.add(key);
        }
      }
    }
    estimatedNodes = uidSet.size;
    estimatedDesignNodes = designUidSet.size;
  } catch {}

  const configuredArtifactFiles = estimatedNodes === 0 || estimatedDesignNodes === 0
    ? await countConfiguredArtifactFiles(repoReal)
    : 0;
  if (estimatedNodes === 0) {
    estimatedNodes = configuredArtifactFiles;
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

  const reviewableBase = estimatedDesignNodes > 0
    ? estimatedDesignNodes
    : (configuredArtifactFiles > 0 ? configuredArtifactFiles : estimatedNodes);

  return {
    pkgName,
    description,
    readmeDesc,
    metaSources,
    version,
    declaredDeps,
    studioCfg,
    repoRole,
    repoRoleLabel,
    lockPresent,
    lockedCount,
    versionLockLabel: lockPresent ? `已锁 (${lockedCount})` : '未建锁',
    estimatedNodeCount: estimatedNodes + richItemBonus,
    estimatedReviewableCount: reviewableBase + richItemBonus,
    runtimeActive,
    runtimeLabel,
  };
}
export async function discoverStudioRepos(workspaceRoot, { scanRoots, env } = {}) {
  const roots = await resolveStudioScanRoots(workspaceRoot, scanRoots, env);
  const overrides = await loadWorkspaceProjectOverrides(workspaceRoot);
  let primaryReal = null;
  try {
    const r = await realpath(resolve(workspaceRoot));
    if (await exists(join(r, 'artifact-graph.config.yaml'))) primaryReal = r;
  } catch {}
  if (!roots.length && !primaryReal && !overrides.extraRepos.length) {
    return { available: false, count: 0, primaryRepoId: null, repos: [], byId: new Map(), groupLabels: {} };
  }

  const excludedAbsSet = new Set();
  for (const ex of overrides.excludedRepos) {
    try {
      const absEx = isAbsolute(ex) ? resolve(ex) : resolve(overrides.rootReal, ex);
      excludedAbsSet.add(await realpath(absEx).catch(() => absEx));
    } catch {}
  }
  const excludedIdSet = new Set(overrides.excludedRepos);

  const found = [];
  const seen = new Set();
  const extraSet = new Set();
  const tryAdd = async (dir, { isExtra = false } = {}) => {
    if (!(await exists(join(dir, 'artifact-graph.config.yaml')))) return false;
    let real;
    try { real = await realpath(dir); } catch { return false; }
    if (!isExtra && excludedAbsSet.has(real)) return false;
    if (isExtra) extraSet.add(real);
    if (seen.has(real)) return true;
    seen.add(real);
    found.push(real);
    return true;
  };
  if (primaryReal) await tryAdd(primaryReal);
  for (const ex of overrides.extraRepos) {
    try {
      const safeExReal = await validateSafeLocalRepoPath(ex, overrides.rootReal);
      await tryAdd(safeExReal, { isExtra: true });
    } catch {}
  }

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
  const foundationBaseline = await computeFoundationBaseline(metas.map(m => m.declaredDeps));

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
    if (!extraSet.has(realPath) && excludedIdSet.has(id)) continue;

    const pRef = portableRepoRef(overrides.rootReal, realPath);
    const metaOverride = (Object.hasOwn(overrides.repoMeta, pRef) ? overrides.repoMeta[pRef] : null)
      || (Object.hasOwn(overrides.repoMeta, id) ? overrides.repoMeta[id] : null)
      || (Object.hasOwn(overrides.repoMeta, realPath) ? overrides.repoMeta[realPath] : null)
      || {};
    const naturalGroupLabel = resolveGroupLabel(group, mergedGroupLabels);
    const originalTitle = meta.studioCfg?.title || name;
    const displayName = metaOverride.title ? sanitizePublicText(metaOverride.title) : originalTitle;
    const description = metaOverride.description
      ? sanitizePublicText(metaOverride.description)
      : (meta.description || `${meta.repoRoleLabel}，含 ${meta.estimatedNodeCount} 个受管制品`);
    const groupLabel = metaOverride.groupLabel ? sanitizePublicText(metaOverride.groupLabel) : naturalGroupLabel;
    const sources = [...meta.metaSources];
    if (metaOverride.title || metaOverride.description || metaOverride.groupLabel) {
      sources.unshift({ field: '自定义覆写说明', sourceFile: overrides.storagePath, active: true });
    }

    const tierInfo = await resolveRepoTier(realPath, {
      repoId: id,
      repoName: name,
      packageName: meta.pkgName,
      group,
      repoRole: meta.repoRole,
      studioCfg: meta.studioCfg,
      rootWorkspaceCfg: rootCfg,
    });
    const foundationAlignment = evaluateRepoFoundationAlignment({
      repoTier: tierInfo.repoTier,
      repoTierLabel: tierInfo.repoTierLabel,
      repoTierSource: tierInfo.source,
      declaredDeps: meta.declaredDeps,
      baseline: foundationBaseline,
    });

    records.push({
      id,
      name,
      displayName,
      originalName: originalTitle,
      packageName: meta.pkgName,
      group,
      groupLabel,
      originalGroupLabel: naturalGroupLabel,
      version: meta.version,
      description,
      originalDescription: meta.description,
      metaSources: sources,
      hasCustomMeta: Boolean(metaOverride.title || metaOverride.description || metaOverride.groupLabel),
      isExtraRepo: extraSet.has(realPath),
      overrideStoragePath: overrides.storagePath,
      repoRole: meta.repoRole,
      repoRoleLabel: meta.repoRoleLabel,
      repoTier: tierInfo.repoTier,
      repoTierLabel: tierInfo.repoTierLabel,
      repoTierSource: tierInfo.source,
      foundationAlignment,
      hasStudioConfig: Boolean(meta.studioCfg?.hasConfig),
      isPrimary: primaryReal !== null && realPath === primaryReal,
      pathDigest: createHash('sha256').update(realPath, 'utf8').digest('hex').slice(0, 16),
      lockPresent: meta.lockPresent,
      lockedCount: meta.lockedCount,
      versionLockLabel: meta.versionLockLabel,
      nodeCount: meta.estimatedNodeCount,
      reviewableCount: meta.estimatedReviewableCount ?? meta.estimatedNodeCount,
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
    foundationBaseline,
  };
}

function parseMarkdownFrontmatterSafe(rawText) {
  const { frontmatterRaw, body } = stripYamlFrontmatter(rawText);
  const frontmatter = {};
  if (frontmatterRaw) {
    try {
      const parsed = parseYaml(frontmatterRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (!['__proto__', 'constructor', 'prototype'].includes(k)) frontmatter[k] = v;
        }
      }
    } catch {}
  }
  return { frontmatter, body };
}

function normalizeSafeRelativeAssetPath(rawPath) {
  const clean = String(rawPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.includes('\0') || clean.startsWith('/') || clean.split('/').includes('..')) {
    return null;
  }
  return clean;
}

async function loadArchifyCollection(repoReal, manifestRel, extraItems, archifyDiagrams, allowedArchifyFiles, allowedArchifyDirs) {
  const ms = await readJsonSafeContained(repoReal, manifestRel);
  if (!ms) return;
  for (const doc of ms.documents ?? []) {
    if (doc.markdown && typeof doc.markdown === 'string') {
      try {
        const mdRaw = sanitizePublicText(await readFileContained(repoReal, doc.markdown, { encoding: 'utf8' }));
        const { frontmatter, body } = parseMarkdownFrontmatterSafe(mdRaw);
        const code = String(doc.pageId || basename(doc.markdown, '.md')).toUpperCase();
        const brief = extractArtifactBrief({
          rawText: body,
          frontmatter,
          fallbackTitle: doc.title,
          code,
          typeLabel: '业务专题文稿',
          path: doc.markdown,
        });
        const rendered = renderMarkdownToHtml(body, {
          idPrefix: `art-${doc.pageId || 'doc'}`,
          heroMeta: {
            title: sanitizePublicText(doc.title || brief.title),
            summary: doc.summary ? cleanInlinePlain(doc.summary) : brief.summary,
            code,
            typeLabel: '业务专题文稿',
            path: doc.markdown,
            status: String(frontmatter.status || 'active'),
            frontmatter,
          },
        });
        extraItems.push({
          uid: `business_article:${doc.pageId || basename(doc.markdown, '.md')}`,
          target: `business_article:${doc.pageId || basename(doc.markdown, '.md')}`,
          type: 'business_article',
          typeLabel: '业务专题文稿',
          category: 'business_articles',
          layer: 'domain',
          layerOrder: 2,
          layerLabel: '领域与决策',
          code,
          title: sanitizePublicText(doc.title || rendered.title || brief.title || basename(doc.markdown)),
          summary: cleanInlinePlain(doc.summary || brief.summary),
          path: doc.markdown,
          status: String(frontmatter.status || 'active'),
          isDesignNode: true,
          inDegree: 0,
          outDegree: (doc.figures ?? []).length,
          inlineDoc: { title: doc.title || rendered.title, summary: cleanInlinePlain(doc.summary || brief.summary), frontmatter, headings: rendered.headings, html: rendered.html },
        });
      } catch {}
    }
    for (const fig of doc.figures ?? []) {
      if (!fig?.html) continue;
      const cleanHtml = normalizeSafeRelativeAssetPath(fig.html);
      if (!cleanHtml) continue;
      allowedArchifyFiles.add(cleanHtml);
      const figDir = dirname(cleanHtml);
      if (figDir && figDir !== '.') allowedArchifyDirs.add(figDir);
      const safeResources = [];
      for (const r of Array.isArray(fig.resources) ? fig.resources : []) {
        const cleanRes = normalizeSafeRelativeAssetPath(r);
        if (cleanRes) {
          allowedArchifyFiles.add(cleanRes);
          safeResources.push(cleanRes);
        }
      }
      archifyDiagrams.push({
        id: fig.id,
        title: sanitizePublicText(fig.title || fig.id),
        summary: cleanInlinePlain(fig.summary || fig.subtitle || doc.summary || `${sanitizePublicText(fig.title || fig.id)}交互式架构说明图`),
        docPageId: doc.pageId ? String(doc.pageId) : null,
        docTitle: sanitizePublicText(doc.title || ''),
        htmlPath: cleanHtml,
        resources: safeResources,
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
        const brief = extractArtifactBrief({ rawText: md, fallbackTitle: lcId, code: lcId, typeLabel: '生命周期讲解', path: relFile });
        const cleanTitle = (brief.title || lcId).replace(/^\d+\s*·\s*/, '').trim();
        const rendered = renderMarkdownToHtml(md, {
          idPrefix: `lc-${num}`,
          stripNavLine: true,
          heroMeta: {
            title: cleanTitle,
            summary: brief.summary,
            code: lcId,
            typeLabel: '生命周期讲解',
            path: relFile,
            status: 'active',
          },
        });
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
          summary: brief.summary,
          path: relFile,
          status: 'active',
          isDesignNode: true,
          inDegree: 0,
          outDegree: 0,
          inlineDoc: { title: `${lcId} · ${cleanTitle}`, summary: brief.summary, headings: rendered.headings, html: rendered.html },
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
    const rawStoryLead = cleanInlinePlain(fields['价值'] || fields['目标'] || fields['以便'] || Object.values(fields)[0] || '');
    const storySummary = rawStoryLead.length > 105 ? `${rawStoryLead.slice(0, 99).replace(/[，、；：,\s]+$/, '')}…` : (rawStoryLead || `${groups[st.group] ?? '核心流程'}相关用户故事`);
    const rendered = renderMarkdownToHtml(sanitizePublicText(mdLines.join('\n')), {
      idPrefix: `us-${st.id.toLowerCase()}`,
      heroMeta: {
        title: sanitizePublicText(st.title),
        summary: storySummary,
        code: st.id,
        typeLabel: gapBody ? '差异对照故事' : '原始需求故事',
        path: `${storiesRel}#${st.id}`,
        status: gapBody ? 'accepted' : 'active',
        frontmatter: { 能力分组: groups[st.group] ?? st.group ?? '默认分组' },
      },
    });
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
      summary: storySummary,
      path: `${storiesRel}#${st.id}`,
      status: gapBody ? 'accepted' : 'active',
      isDesignNode: true,
      inDegree: 0,
      outDegree: 0,
      inlineDoc: { title: `${st.id} · ${st.title}`, summary: storySummary, headings: rendered.headings, html: rendered.html },
    });
  }
  return items;
}
async function loadRepoCollections(repoReal) {
  const studioCfg = await loadStudioWorkspaceConfig(repoReal);
  const collections = await resolveEffectiveCollections(repoReal, studioCfg);
  const extraItems = [];
  const archifyDiagrams = [];
  const allowedArchifyFiles = new Set();
  const allowedArchifyDirs = new Set();

  for (const col of collections) {
    if (col.kind === 'archify-model-scenes' && col.manifestJson) {
      await loadArchifyCollection(repoReal, col.manifestJson, extraItems, archifyDiagrams, allowedArchifyFiles, allowedArchifyDirs);
    } else if (col.kind === 'lifecycle-story-pack') {
      extraItems.push(...await loadLifecycleStoryPack(repoReal, col));
    }
  }
  const lifecycleDocPaths = new Set();
  for (const col of studioCfg.collections ?? []) {
    if (col?.kind !== 'lifecycle-collaboration-model') continue;
    for (const k of ['modelJson', 'registryJson', 'architectureDoc', 'roadmapSpec']) {
      const clean = normalizeSafeRelativeAssetPath(col[k]);
      if (clean) lifecycleDocPaths.add(clean);
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
          allowedArchifyFiles.add(relHtml);
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

  return { studioCfg, extraItems, archifyDiagrams, allowedArchifyFiles, allowedArchifyDirs, lifecycleDocPaths };
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

function extractContractBrief(rawContent, fallbackTitle, typeLabel, rel, parsedObj = null) {
  let obj = parsedObj;
  if (obj === null && rawContent) {
    try {
      const ext = extname(String(rel || '')).toLowerCase();
      obj = ext === '.json' ? JSON.parse(rawContent) : parseYaml(rawContent);
    } catch {}
  }
  const title = cleanInlinePlain((obj && !Array.isArray(obj) ? (obj.title || obj.name) : '') || fallbackTitle || basename(String(rel || '契约')));
  let summary = obj && typeof obj === 'object' && !Array.isArray(obj)
    ? cleanInlinePlain(obj.summary || obj.description || obj.purpose || '')
    : '';
  if (summary.length < 10) {
    if (Array.isArray(obj)) {
      summary = `结构化列表契约，共收录 ${obj.length} 条记录，供自动化门禁与脚本读取。`;
    } else if (obj && typeof obj === 'object') {
      const keys = Object.keys(obj).filter(k => !['__proto__', 'constructor', 'prototype'].includes(k));
      summary = keys.length
        ? `包含 ${keys.length} 项结构化字段（如 ${keys.slice(0, 3).join('、')}）的${typeLabel || '机器数据契约'}。`
        : `${typeLabel || '结构化数据契约'}，供脚本校验与工程同步读取。`;
    } else {
      summary = `${typeLabel || '结构化数据契约'}，供脚本校验与工程同步读取。`;
    }
  }
  return {
    title,
    summary: summary.length > 105 ? `${summary.slice(0, 99).replace(/[，、；：,\s]+$/, '')}…` : summary,
  };
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
    const ext = extname(nd.path || '').toLowerCase();
    const isMachineContract = !isCode && (ext === '.json' || ext === '.yaml' || ext === '.yml');
    const fileFormat = isCode ? 'code' : (ext === '.json' ? 'json' : (ext === '.yaml' || ext === '.yml' ? 'yaml' : 'markdown'));
    const formatLabel = isMachineContract
      ? (fileFormat === 'yaml' ? 'YAML 数据契约' : 'JSON 数据契约')
      : (isCode ? '代码与验证文件' : 'Markdown 阅读稿');
    const category = classifyReviewCategory(nd.type, ld.id, isMachineContract);
    const typeLabel = tc.displayName || TYPE_LABELS[nd.type] || nd.type;
    const rawContent = contents.get(nd.path) || '';
    let localRaw = rawContent;
    if (rawContent && nd.line && nd.line > 1 && !isMachineContract && !isCode) {
      const sliced = rawContent.split('\n').slice(Math.max(0, nd.line - 1), nd.line + 40).join('\n');
      if (sliced.trim().length > 20) localRaw = sliced;
    }
    const brief = isMachineContract
      ? extractContractBrief(rawContent, nd.title || nd.code, typeLabel, nd.path)
      : extractArtifactBrief({
        rawText: localRaw || rawContent,
        fallbackTitle: nd.title || nd.code,
        code: nd.code,
        typeLabel,
        path: nd.path,
      });
    const cleanNodeTitle = nd.title && !/^[-*#|]/.test(String(nd.title).trim())
      ? cleanInlinePlain(nd.title)
      : brief.title;
    return {
      uid: nd.uid,
      target: nd.uid,
      type: nd.type,
      typeLabel,
      category,
      layer: ld.id,
      layerOrder: ld.order,
      layerLabel: ld.label,
      code: nd.code,
      title: sanitizePublicText(cleanNodeTitle || nd.code),
      summary: brief.summary,
      path: nd.path,
      line: nd.line,
      status: nd.status ?? null,
      isDesignNode: !isCode,
      isMachineContract,
      fileFormat,
      formatLabel,
      inDegree: inDeg.get(nd.uid) ?? 0,
      outDegree: outDeg.get(nd.uid) ?? 0,
    };
  });

  // 对已在 artifact-graph.config.yaml `paths` 中声明但未被内置 parser 转成节点的 JSON/YAML 契约，补齐为受管机器契约节点
  const coveredPaths = new Set(graphNodes.map(n => n.path).filter(Boolean));
  const typeEntries = Object.entries(schema.types ?? {}).sort((a, b) => {
    const score = def => Math.max(...(def?.paths ?? []).map(p => (p.includes('*') ? 0 : 1e5) + p.length - ((p.match(/\*/g) ?? []).length * 1e3)), 0);
    return score(b[1]) - score(a[1]) || a[0].localeCompare(b[0]);
  });
  for (const [rel, rawContent] of [...contents.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!rel || coveredPaths.has(rel) || CODE_EXT_RE.test(rel)) continue;
    const ext = extname(rel).toLowerCase();
    if (ext !== '.json' && ext !== '.yaml' && ext !== '.yml') continue;
    let matchedType = null;
    let matchedDef = null;
    for (const [tName, tDef] of typeEntries) {
      if (matchesConfiguredArtifactPath(rel, { types: { [tName]: tDef } })) {
        matchedType = tName;
        matchedDef = tDef;
        break;
      }
    }
    if (!matchedType) continue;
    let parsedMeta = null;
    try {
      parsedMeta = ext === '.json' ? JSON.parse(rawContent) : parseYaml(rawContent);
    } catch {}
    const ld = classifyLayer(matchedType, matchedDef?.layer);
    const stemCode = basename(rel, ext);
    const metaObj = parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta) ? parsedMeta : null;
    const code = String(metaObj?.id || metaObj?.code || stemCode);
    const title = String(metaObj?.title || metaObj?.name || basename(rel));
    const typeLabel = matchedDef?.displayName || TYPE_LABELS[matchedType] || matchedType;
    const contractBrief = extractContractBrief(rawContent, title, typeLabel, rel, metaObj);
    const fileFormat = ext === '.json' ? 'json' : 'yaml';
    const uid = `${matchedType}:${code}:${rel}`;
    graphNodes.push({
      uid,
      target: uid,
      type: matchedType,
      typeLabel,
      category: 'contracts',
      layer: ld.id,
      layerOrder: ld.order,
      layerLabel: ld.label,
      code,
      title: sanitizePublicText(title),
      summary: contractBrief.summary,
      path: rel,
      line: 1,
      status: metaObj?.status ? String(metaObj.status) : null,
      isDesignNode: true,
      isMachineContract: true,
      fileFormat,
      formatLabel: fileFormat === 'yaml' ? 'YAML 数据契约' : 'JSON 数据契约',
      inDegree: 0,
      outDegree: 0,
    });
  }

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
  const allReviewItems = [
    ...(designGraphNodes.length ? designGraphNodes : graphNodes),
    ...colResult.extraItems,
  ];

  // 自动配对同源 Markdown 文稿与 JSON/YAML 数据契约，支持正文顶栏一键互跳；图谱未收录时安全受控探测磁盘派生人读文稿
  const companionPaths = new Set(colResult.lifecycleDocPaths ?? []);
  const humanItems = allReviewItems.filter(i => !i.isMachineContract && i.path);
  const contractItems = allReviewItems.filter(i => i.isMachineContract && i.path);
  const GENERIC_CONTRACT_STEMS = new Set(['source', 'original', 'story-source.candidate', 'index', 'readme', 'coverage', 'reading']);
  const stemOf = p => basename(String(p || ''), extname(String(p || ''))).toLowerCase();
  const normCodeToken = v => {
    const m = /(REQ-\d+|DM-\d+|US-[A-Z]+-\d+|SPEC-[A-Z0-9-]+|LC-\d+)/i.exec(String(v || ''));
    return m ? m[1].toLowerCase() : '';
  };
  const findCompanion = (srcItem, candidates) => {
    const srcStem = stemOf(srcItem.path);
    const srcDir = dirname(String(srcItem.path || ''));
    const srcCode = String(srcItem.code || '').toLowerCase();
    const srcToken = normCodeToken(srcItem.code || srcStem);
    return candidates.find(c => dirname(String(c.path || '')) === srcDir && stemOf(c.path) === srcStem)
      || (!GENERIC_CONTRACT_STEMS.has(srcStem) && srcStem.length >= 2
        ? candidates.find(c => stemOf(c.path) === srcStem)
        : null)
      || (srcCode ? candidates.find(c => String(c.code || '').toLowerCase() === srcCode) : null)
      || (srcToken ? candidates.find(c => normCodeToken(c.code || c.path) === srcToken) : null)
      || null;
  };
  const buildDiskCompanionCandidates = cItem => {
    const cleanP = String(cItem.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const relDir = dirname(cleanP);
    const dirPrefix = relDir === '.' ? '' : `${relDir}/`;
    const stem = basename(cleanP, extname(cleanP));
    const baseLower = basename(cleanP).toLowerCase();
    const out = [];
    out.push(`${dirPrefix}${stem}.md`);
    if (GENERIC_CONTRACT_STEMS.has(stem.toLowerCase()) || baseLower === 'story-source.candidate.json') {
      for (const name of ['article.md', 'article.edited.md', 'article.candidate.md', 'README.md', 'index.md']) {
        out.push(`${dirPrefix}${name}`);
      }
      if (relDir !== '.') {
        const parentDir = dirname(relDir);
        const parentPrefix = parentDir === '.' ? '' : `${parentDir}/`;
        out.push(`${parentPrefix}${basename(relDir)}.md`);
        if (cItem.code && !/[\\/]/.test(cItem.code)) out.push(`${parentPrefix}${cItem.code}.md`);
      }
    }
    const tok = normCodeToken(cItem.code || stem);
    if (tok) {
      const upper = tok.toUpperCase();
      if (relDir !== '.') {
        const parentDir = dirname(relDir);
        const parentPrefix = parentDir === '.' ? '' : `${parentDir}/`;
        out.push(`${parentPrefix}${upper}.md`);
      }
      out.push(`artifacts/requirements/${upper}.md`, `artifacts/domain-models/${upper}.md`);
    }
    return [...new Set(out)].filter(p => p && !p.startsWith('/') && !p.split('/').includes('..') && p.endsWith('.md'));
  };

  for (const cItem of contractItems) {
    let peer = findCompanion(cItem, humanItems);
    if (!peer) {
      for (const candRel of buildDiskCompanionCandidates(cItem)) {
        const existingHuman = humanItems.find(h => h.path === candRel);
        if (existingHuman) {
          peer = existingHuman;
          break;
        }
        try {
          const candAbs = await resolveContained(record.realPath, candRel);
          const st = await lstat(candAbs);
          if (!st.isFile() || st.isSymbolicLink()) continue;
          const mdRaw = await readFileContained(record.realPath, candRel, { encoding: 'utf8' });
          const mdBrief = extractArtifactBrief({
            rawText: mdRaw,
            fallbackTitle: `${cItem.code || basename(candRel, '.md')} 人读说明`,
            code: cItem.code || basename(candRel, '.md'),
            typeLabel: `${cItem.typeLabel || TYPE_LABELS[cItem.type] || cItem.type} · 人读文稿`,
            path: candRel,
          });
          const safeUid = `companion:${cItem.type}:${candRel.replace(/[^A-Za-z0-9_.:/#-]+/g, '_')}`;
          const peerItem = {
            uid: safeUid,
            target: safeUid,
            type: cItem.type,
            typeLabel: `${cItem.typeLabel || TYPE_LABELS[cItem.type] || cItem.type} · 人读文稿`,
            category: classifyReviewCategory(cItem.type, cItem.layer, false),
            layer: cItem.layer,
            layerOrder: cItem.layerOrder,
            layerLabel: cItem.layerLabel,
            code: cItem.code || basename(candRel, '.md'),
            title: sanitizePublicText(mdBrief.title),
            summary: mdBrief.summary,
            path: candRel,
            line: 1,
            status: cItem.status ?? null,
            isDesignNode: true,
            isMachineContract: false,
            isCompanionDoc: true,
            fileFormat: 'markdown',
            formatLabel: 'Markdown 阅读稿',
            inDegree: 0,
            outDegree: 0,
          };
          humanItems.push(peerItem);
          allReviewItems.push(peerItem);
          companionPaths.add(candRel);
          peer = peerItem;
          break;
        } catch {}
      }
    }
    if (peer) {
      cItem.pairedUid = peer.uid;
      cItem.pairedPath = peer.path;
      cItem.pairedTitle = peer.title;
      cItem.pairedFormat = 'markdown';
      if (!peer.pairedUid) {
        peer.pairedUid = cItem.uid;
        peer.pairedPath = cItem.path;
        peer.pairedTitle = cItem.title;
        peer.pairedFormat = cItem.fileFormat || 'json';
      }
    }
  }
  const sortedReviewItems = sortItemsForGuidedReview(allReviewItems);
  const graphNodeByUid = new Map(graphNodes.map(n => [n.uid, n]));
  for (const item of sortedReviewItems) {
    if (item.pairedUid && (graphNodeByUid.has(item.pairedUid) || item.pairedPath)) {
      const gn = graphNodeByUid.get(item.uid);
      if (gn) {
        gn.pairedUid = item.pairedUid;
        gn.pairedPath = item.pairedPath;
        gn.pairedTitle = item.pairedTitle;
        gn.pairedFormat = item.pairedFormat;
      }
    }
  }

  const inlineDocs = new Map();
  for (const item of colResult.extraItems) {
    if (item.inlineDoc) inlineDocs.set(item.uid, item.inlineDoc);
  }
  const publicItems = sortedReviewItems.map(({ inlineDoc: _omit, ...rest }) => rest);

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
    { id: 'contracts', label: '结构化数据契约 (.json/.yaml)', group: 'contracts', groupLabel: '结构化数据契约（供脚本校验）' },
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
      repoTier: record.repoTier,
      repoTierLabel: record.repoTierLabel,
      foundationAlignment: record.foundationAlignment,
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
    companionPaths,
    allowedArchifyFiles: colResult.allowedArchifyFiles,
    allowedArchifyDirs: colResult.allowedArchifyDirs,
  };
}

function buildStructuredContractHtml(parsed, cleanPath) {
  const fmtVal = v => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.length} 项] ${v.slice(0, 4).map(x => (typeof x === 'object' ? (x?.id || x?.name || x?.title || '{…}') : String(x))).join(' · ')}`;
    return JSON.stringify(v).slice(0, 120);
  };
  const blocks = [
    `<div class="st-contract-notice"><strong>🗂️ 结构化数据契约（${escapeHtml(basename(cleanPath))}）</strong><div class="st-muted-xs">本文件供自动化脚本、状态机校验或工程门禁读取，已自动整理为可读字段摘要；若需查看原始文本，可点上方「{ } 原始源码」切换。</div></div>`,
  ];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const scalars = [];
    const collections = [];
    const nested = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) scalars.push([k, v]);
      else if (Array.isArray(v)) collections.push([k, v]);
      else nested.push([k, v]);
    }
    if (scalars.length > 0) {
      blocks.push(`<h3 class="st-prose-heading">核心基础字段</h3><div class="st-table-wrap"><table class="st-prose-table"><thead><tr><th>字段键名</th><th>字段值</th></tr></thead><tbody>${scalars.slice(0, 30).map(([k, v]) => `<tr><td><code>${escapeHtml(k)}</code></td><td>${escapeHtml(String(v ?? '—'))}</td></tr>`).join('')}</tbody></table></div>`);
    }
    for (const [k, arr] of collections.slice(0, 8)) {
      blocks.push(`<h3 class="st-prose-heading">${escapeHtml(k)}（共 ${arr.length} 项）</h3>`);
      if (arr.length === 0) {
        blocks.push('<p class="st-muted-xs">空列表 []</p>');
      } else if (arr.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
        const colKeys = [...new Set(arr.slice(0, 20).flatMap(o => Object.keys(o)))].slice(0, 6);
        blocks.push(`<div class="st-table-wrap"><table class="st-prose-table"><thead><tr>${colKeys.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${arr.slice(0, 40).map(row => `<tr>${colKeys.map(c => `<td>${escapeHtml(fmtVal(row[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else {
        blocks.push(`<ul>${arr.slice(0, 30).map(x => `<li><code>${escapeHtml(fmtVal(x))}</code></li>`).join('')}</ul>`);
      }
    }
    for (const [k, obj] of nested.slice(0, 8)) {
      const subRows = Object.entries(obj).slice(0, 20).map(([sk, sv]) => `<tr><td><code>${escapeHtml(sk)}</code></td><td>${escapeHtml(fmtVal(sv))}</td></tr>`).join('');
      blocks.push(`<h3 class="st-prose-heading">${escapeHtml(k)}</h3><div class="st-table-wrap"><table class="st-prose-table"><thead><tr><th>键名</th><th>值</th></tr></thead><tbody>${subRows}</tbody></table></div>`);
    }
  } else if (Array.isArray(parsed)) {
    blocks.push(`<p class="st-muted-xs">顶层数组，共 ${parsed.length} 条记录。</p><ul>${parsed.slice(0, 40).map(x => `<li><code>${escapeHtml(fmtVal(x))}</code></li>`).join('')}</ul>`);
  }
  return blocks.join('\n');
}

export async function readRepoDocument(record, cachedEntry, { path: rawPath, uid: rawUid } = {}) {
  const normRawPath = String(rawPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').split('#')[0];
  const matchedMeta = (rawUid ? cachedEntry.publicSnapshot.reviewItems?.find(i => i.uid === rawUid || i.target === rawUid) : null)
    || cachedEntry.publicSnapshot.reviewItems?.find(i => i.path === normRawPath)
    || cachedEntry.publicSnapshot.nodes?.find(n => n.path === normRawPath);
  if (rawUid && cachedEntry.inlineDocs.has(rawUid)) {
    const inline = cachedEntry.inlineDocs.get(rawUid);
    return {
      ok: true,
      repoId: record.id,
      uid: rawUid,
      path: rawPath || rawUid,
      format: 'markdown',
      isMachineContract: false,
      title: inline.title,
      summary: inline.summary || matchedMeta?.summary || '',
      frontmatter: inline.frontmatter || {},
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
    || Boolean(cachedEntry.publicSnapshot.reviewItems?.some(i => i.path === cleanPath))
    || Boolean(cachedEntry.companionPaths?.has(cleanPath))
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
  const ext = extname(cleanPath).toLowerCase();
  if (ext === '.md') {
    const { frontmatter, body } = parseMarkdownFrontmatterSafe(sanitized);
    const brief = extractArtifactBrief({
      rawText: body,
      frontmatter,
      fallbackTitle: String(frontmatter.title || matchedMeta?.title || basename(cleanPath)),
      code: String(matchedMeta?.code || frontmatter.id || ''),
      typeLabel: matchedMeta?.typeLabel || '',
      path: cleanPath,
    });
    const finalTitle = brief.title || String(frontmatter.title ?? basename(cleanPath));
    const rendered = renderMarkdownToHtml(body, {
      idPrefix: 'doc-sec',
      heroMeta: {
        title: finalTitle,
        summary: matchedMeta?.summary || brief.summary,
        code: String(matchedMeta?.code || frontmatter.id || ''),
        typeLabel: matchedMeta?.typeLabel || '受管制品说明',
        path: cleanPath,
        status: String(frontmatter.status || matchedMeta?.status || ''),
        frontmatter,
      },
    });
    return {
      ok: true,
      repoId: record.id,
      path: cleanPath,
      format: 'markdown',
      isMachineContract: false,
      title: rendered.title || finalTitle,
      summary: matchedMeta?.summary || brief.summary,
      frontmatter,
      headings: rendered.headings,
      html: rendered.html,
    };
  }
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
    let parsed = null;
    try { parsed = ext === '.json' ? JSON.parse(sanitized) : parseYaml(sanitized); } catch {}
    const html = parsed !== null
      ? buildStructuredContractHtml(parsed, cleanPath)
      : `<pre class="st-code-block"><code>${escapeHtml(sanitized)}</code></pre>`;
    return {
      ok: true,
      repoId: record.id,
      path: cleanPath,
      format: ext === '.json' ? 'json' : 'yaml',
      isMachineContract: true,
      rawText: sanitized,
      title: String(parsed?.title || basename(cleanPath)),
      frontmatter: {},
      headings: [],
      html,
    };
  }
  return {
    ok: true,
    repoId: record.id,
    path: cleanPath,
    format: ext.slice(1) || 'text',
    isMachineContract: false,
    rawText: sanitized,
    title: basename(cleanPath),
    frontmatter: {},
    headings: [],
    html: `<pre class="st-code-block"><code>${escapeHtml(sanitized)}</code></pre>`,
  };
}

export async function readRepoArchifyAsset(record, cachedEntry, rawAssetPath) {
  const cleanPath = normalizeSafeRelativeAssetPath(rawAssetPath);
  if (!cleanPath) {
    throw Object.assign(new Error('非法的 Archify 资源路径请求。'), { statusCode: 400 });
  }
  const exactAllowed = Boolean(cachedEntry.allowedArchifyFiles?.has(cleanPath));
  const dirAllowed = [...(cachedEntry.allowedArchifyDirs ?? [])].some(dir => {
    const norm = String(dir ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return norm && norm !== '.' && cleanPath.startsWith(`${norm}/`);
  });
  if (!exactAllowed && !dirAllowed) {
    throw Object.assign(new Error('请求的图谱文件不在受管 Archify 目录白名单内。'), { statusCode: 404 });
  }
  const bytes = await readFileContained(record.realPath, cleanPath);
  return { cleanPath, bytes };
}
