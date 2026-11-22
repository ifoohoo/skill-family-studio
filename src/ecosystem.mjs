import { tmpdir } from 'node:os';
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
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
const DEFAULT_CATEGORY_DIRS = ['skill-family', 'artifact-ecosystem', 'glaf4-skills'];
const SAFE_EXTRA_DOCS = new Set(['README.md', 'README.zh-CN.md', 'docs/USER-GUIDE.md', 'USER-GUIDE.md', 'artifacts/README.md', 'artifact-graph.config.yaml']);

export const GROUP_LABELS = Object.freeze({
  'skill-family': 'Skill Family 支撑线',
  'artifact-ecosystem': 'Artifact 制品线',
  'glaf4-skills': 'GLAF4 业务线',
});

export function resolveGroupLabel(group) {
  return GROUP_LABELS[group] || '当前工作区与其他项目';
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
  { ...DEFAULT_LAYERS[0], match: new Set(['requirement', 'spec']) },
  { ...DEFAULT_LAYERS[1], match: new Set(['prd', 'feature', 'user_story', 'story', 'lifecycle', 'lifecycle_story']) },
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

async function exists(absPath) {
  try { await lstat(absPath); return true; } catch { return false; }
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

  let tmpReal = tmpdir();
  try { tmpReal = await realpath(tmpReal); } catch {}
  const sourceParent = resolve(rootReal, '../..');
  const isBareTmpChild = dirname(rootReal) === tmpReal || sourceParent === tmpReal || sourceParent === dirname(tmpReal);
  if (sourceParent === '/' || isBareTmpChild) {
    return [rootReal];
  }
  const candidates = [];
  for (const cat of DEFAULT_CATEGORY_DIRS) {
    const dir = join(sourceParent, cat);
    if (await exists(dir)) candidates.push(dir);
  }
  const immediateParent = resolve(rootReal, '..');
  if (!candidates.includes(immediateParent) && await exists(immediateParent)) {
    candidates.push(immediateParent);
  }
  return candidates.length ? candidates : [rootReal];
}

async function readQuickRepoMeta(repoReal) {
  let pkgName = basename(repoReal);
  let description = '';
  let version = '';
  try {
    const pkg = JSON.parse(await readFileContained(repoReal, 'package.json', { encoding: 'utf8' }));
    if (typeof pkg.name === 'string' && pkg.name) pkgName = pkg.name;
    if (typeof pkg.description === 'string') description = sanitizePublicText(pkg.description);
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {}

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
      if (item?.from) uidSet.add(item.from);
      if (item?.to) uidSet.add(item.to);
      if (item?.artifact) uidSet.add(item.artifact);
    }
    estimatedNodes = uidSet.size;
  } catch {}

  let richItemBonus = 0;
  if (await exists(join(repoReal, 'local/lifecycle-user-stories/stories.json'))) {
    richItemBonus += 147;
  }

  let runtimeActive = false;
  let runtimeLabel = '无运行任务';
  for (const rel of ['.artifacts/runtime-monitor/registry.json', 'artifacts/runtime-monitor/registry.json', '.runs']) {
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
    lockPresent,
    lockedCount,
    versionLockLabel: lockPresent ? `已锁 (${lockedCount})` : '未建锁',
    estimatedNodeCount: Math.max(estimatedNodes, richItemBonus > 0 ? estimatedNodes + richItemBonus : 0),
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
    return { available: false, count: 0, primaryRepoId: null, repos: [], byId: new Map() };
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

  const usedIds = new Set();
  const records = [];
  for (const realPath of found) {
    const name = basename(realPath);
    const group = basename(dirname(realPath)) || 'workspace';
    let id = `${group}/${name}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    usedIds.add(id);
    const meta = await readQuickRepoMeta(realPath);
    records.push({
      id,
      name,
      packageName: meta.pkgName,
      group,
      groupLabel: resolveGroupLabel(group),
      version: meta.version,
      description: meta.description,
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
  };
}

async function loadRichWorkspaceExtensions(repoReal) {
  const extraItems = [];
  const archifyDiagrams = [];
  const allowedArchifyDirs = new Set();

  // 1. 加载 14 张 Archify 业务逻辑与场景图（如 skill-family-workspace）
  try {
    const msRel = 'artifact-reading/business/inputs/model-and-scenes.json';
    const msAbs = await resolveContained(repoReal, msRel);
    await lstat(msAbs);
    const ms = JSON.parse(await readFileContained(repoReal, msRel, { encoding: 'utf8' }));
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
          docTitle: sanitizePublicText(doc.title || ''),
          htmlPath: cleanHtml,
          resources: Array.isArray(fig.resources) ? fig.resources : [],
        });
      }
    }
  } catch {}

  return { extraItems, archifyDiagrams, allowedArchifyDirs };
}

async function loadLifecycleItems(repoReal) {
  const baseRel = 'local/lifecycle-user-stories';
  try {
    const abs = await resolveContained(repoReal, `${baseRel}/stories.json`);
    await lstat(abs);
  } catch {
    return [];
  }
  const items = [];
  const storiesRaw = JSON.parse(await readFileContained(repoReal, `${baseRel}/stories.json`, { encoding: 'utf8' }));
  const groups = storiesRaw.groups ?? {};

  const gapMap = new Map();
  try {
    const compMd = sanitizePublicText(await readFileContained(repoReal, `${baseRel}/replacement-comparison.md`, { encoding: 'utf8' }));
    const gapRegex = /^###\s+(US-\d{3})\s*·\s*(.+)$/gm;
    const matches = [...compMd.matchAll(gapRegex)];
    const tableStart = compMd.indexOf('## 全部81条旧故事的对应位置');
    for (let idx = 0; idx < matches.length; idx += 1) {
      const m = matches[idx];
      const start = m.index + m[0].length;
      const end = idx + 1 < matches.length ? matches[idx + 1].index : (tableStart > start ? tableStart : compMd.length);
      gapMap.set(m[1].trim(), compMd.slice(start, end).trim());
    }
  } catch {}

  try {
    const expDir = await resolveContained(repoReal, `${baseRel}/explanations`);
    const expFiles = (await readdir(expDir)).filter(n => /^\d{2}\.md$/.test(n)).sort();
    for (const fileName of expFiles) {
      const num = fileName.slice(0, 2);
      const md = sanitizePublicText(await readFileContained(repoReal, `${baseRel}/explanations/${fileName}`, { encoding: 'utf8' }));
      const lcId = (/故事编号\s+(LC-\d+)/i.exec(md)?.[1] || `LC-${num}`).toUpperCase();
      const rendered = renderMarkdownToHtml(md, { idPrefix: `lc-${num}`, stripNavLine: true });
      const cleanTitle = (rendered.title || lcId).replace(/^\d{2}\s*·\s*/, '').trim();
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
        path: `${baseRel}/explanations/${fileName}`,
        status: 'active',
        isDesignNode: true,
        inDegree: 0,
        outDegree: 0,
        inlineDoc: { title: `${lcId} · ${cleanTitle}`, headings: rendered.headings, html: rendered.html },
      });
    }
  } catch {}

  for (const st of storiesRaw.stories ?? []) {
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
      path: `${baseRel}/stories.json#${st.id}`,
      status: gapBody ? 'accepted' : 'active',
      isDesignNode: true,
      inDegree: 0,
      outDegree: 0,
      inlineDoc: { title: `${st.id} · ${st.title}`, headings: rendered.headings, html: rendered.html },
    });
  }
  return items;
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
    return {
      uid: nd.uid,
      target: nd.uid,
      type: nd.type,
      typeLabel: tc.displayName || TYPE_LABELS[nd.type] || nd.type,
      category: ld.id,
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

  const [richExt, lcItems] = await Promise.all([
    loadRichWorkspaceExtensions(record.realPath),
    loadLifecycleItems(record.realPath),
  ]);

  const lockExists = await exists(join(record.realPath, VERSION_LOCK_PATH));
  let versionLock = { present: lockExists, status: 'missing', badgeTone: 'zinc', badgeLabel: '未建版本锁', issueCount: 0 };
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
      };
    } catch {
      versionLock = { present: true, status: 'diagnostic', badgeTone: 'amber', badgeLabel: '版本锁待核实', issueCount: 0 };
    }
  }

  const designGraphNodes = graphNodes.filter(n => n.isDesignNode);
  const allReviewItems = sortItemsForGuidedReview([
    ...(designGraphNodes.length ? designGraphNodes : graphNodes),
    ...richExt.extraItems,
    ...lcItems,
  ]);
  const inlineDocs = new Map();
  for (const item of [...richExt.extraItems, ...lcItems]) {
    if (item.inlineDoc) inlineDocs.set(item.uid, item.inlineDoc);
  }
  const publicItems = allReviewItems.map(({ inlineDoc: _omit, ...rest }) => rest);

  const catDefs = [
    ...DEFAULT_LAYERS.map(l => ({ id: l.id, label: l.label })),
    { id: 'lc_explanations', label: '生命周期讲解 (LC)' },
    { id: 'us_stories', label: '原始需求故事 (US)' },
    { id: 'gap_resolutions', label: '差异承接决议' },
    { id: 'business_articles', label: '业务专题文稿' },
  ];
  const categories = [
    { id: 'all', label: '全部审阅项', count: publicItems.length },
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
      configStatus,
      configMessage,
      counts: {
        nodes: graphNodes.length,
        designNodes: designGraphNodes.length,
        edges: edges.length,
        reviewItems: publicItems.length,
        archifyDiagrams: richExt.archifyDiagrams.length,
      },
      layers: DEFAULT_LAYERS,
      versionLock,
      nodes: graphNodes,
      edges,
      categories,
      reviewItems: publicItems,
      archifyDiagrams: richExt.archifyDiagrams,
    },
    contents,
    inlineDocs,
    allowedArchifyDirs: richExt.allowedArchifyDirs,
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
