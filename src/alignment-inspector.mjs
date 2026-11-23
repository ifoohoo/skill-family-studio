// @feature STU005

import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { VERSION_LOCK_PATH } from 'artifact-graph';
import { readFileContained, resolveContained } from 'skill-family-harness-node';
import { parse as parseYaml } from 'yaml';
import { cleanInlinePlain, extractArtifactBrief, sanitizePublicText } from './markdown-render.mjs';

const UID_TYPE_LABELS = Object.freeze({
  story: '用户故事',
  lifecycle_story: '需求故事',
  lifecycle: '生命周期讲解',
  requirement: '需求总纲',
  feature: '详细设计',
  scenario: '验收场景',
  domain_model: '领域模型',
  design_doc: '架构设计',
  adr: '架构决策',
  implementation: '源码实现',
  test: '测试验证',
});

function inferCodeFromUid(uid, relPath) {
  const s = String(uid ?? '').trim();
  if (s.includes(':')) {
    const tail = s.split(':').slice(1).join(':').trim();
    if (tail && !tail.includes('/')) return tail;
  }
  const stem = relPath ? basename(String(relPath), extname(String(relPath))) : '';
  return stem || s || '';
}

function inferTypeLabelFromUid(uid, fallback = '受管制品') {
  const prefix = String(uid ?? '').split(':')[0];
  return UID_TYPE_LABELS[prefix] || fallback;
}

async function resolveEntityBriefContained(repoReal, relPath, { uid = '', fallbackTitle = '', defaultTypeLabel = '' } = {}, cache = new Map()) {
  const cleanRel = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const code = inferCodeFromUid(uid, cleanRel);
  const typeLabel = inferTypeLabelFromUid(uid, defaultTypeLabel || '受管制品');
  const cacheKey = `${repoReal || ''}::${cleanRel}::${uid || ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let rawText = '';
  if (repoReal && cleanRel && !cleanRel.startsWith('/') && !cleanRel.split('/').includes('..')) {
    try {
      rawText = await readFileContained(repoReal, cleanRel, { encoding: 'utf8' });
    } catch {}
  }
  const brief = extractArtifactBrief({
    rawText,
    fallbackTitle: fallbackTitle || code || (cleanRel ? basename(cleanRel) : ''),
    code,
    typeLabel,
    path: cleanRel,
  });
  const res = {
    title: sanitizePublicText(brief.title || fallbackTitle || code || '未命名制品'),
    summary: brief.summary,
    code,
    typeLabel,
    path: cleanRel,
  };
  cache.set(cacheKey, res);
  return res;
}

const SKIP_SCAN_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.artifact-graph', '.artifacts', '.runs',
  '.release-skill', '.cache', '.skill-family-studio', '.worktrees', '.tmp', 'target', 'site',
]);

async function existsFile(absPath) {
  try {
    const st = await lstat(absPath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

async function readJsonContainedSafe(repoReal, relPath) {
  try {
    const abs = await resolveContained(repoReal, relPath);
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const raw = await readFileContained(repoReal, relPath, { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function sha256FilePrefixed(repoReal, relPath) {
  const clean = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) return null;
  try {
    const abs = await resolveContained(repoReal, clean);
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const bytes = await readFileContained(repoReal, clean);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch {
    return null;
  }
}

export function globToRegExp(pattern) {
  const clean = String(pattern ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '^';
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '*') {
      if (clean[i + 1] === '*') {
        if (clean[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const end = clean.indexOf('}', i + 1);
      if (end > i) {
        const parts = clean.slice(i + 1, end).split(',').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${parts.join('|')})`;
        i = end + 1;
      } else {
        out += '\\{';
        i += 1;
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out);
}

async function listRepoFiles(repoReal) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP_SCAN_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) files.push(relative(repoReal, full).split('\\').join('/'));
    }
  }
  await walk(repoReal);
  return files.sort();
}

async function resolveRelativeRepo(baseRepoReal, relRepoPath, catalog) {
  const raw = String(relRepoPath ?? '').trim();
  if (!raw || raw.includes('\0')) return null;
  const candidate = resolve(baseRepoReal, raw);
  let targetReal;
  try {
    targetReal = await realpath(candidate);
  } catch {
    return null;
  }
  if (catalog?.byId) {
    for (const rec of catalog.byId.values()) {
      if (rec.realPath === targetReal) {
        return { repoId: rec.id, name: rec.name, realPath: rec.realPath, inCatalog: true };
      }
    }
  }
  if (await existsFile(join(targetReal, 'artifact-graph.config.yaml'))) {
    return { repoId: null, name: targetReal.split('/').pop(), realPath: targetReal, inCatalog: false };
  }
  return null;
}

function isValidReceiptPayload(recJson) {
  if (!recJson || typeof recJson !== 'object') return false;
  if (recJson.ok === false || recJson.valid === false) return false;
  if (recJson.status === 'failed' || recJson.decision === 'FAIL') return false;
  return true;
}

export async function inspectDownstreamLockFreshness(targetRepoReal, verifiedReceiptPath = null) {
  if (verifiedReceiptPath) {
    const recJson = await readJsonContainedSafe(targetRepoReal, verifiedReceiptPath);
    if (isValidReceiptPayload(recJson)) {
      return { fresh: true, hasCodeLocks: true, mode: 'receipt', issueCount: 0 };
    }
    return { fresh: false, hasCodeLocks: false, mode: 'receipt_invalid', issueCount: 1 };
  }
  const lockJson = await readJsonContainedSafe(targetRepoReal, VERSION_LOCK_PATH);
  if (!lockJson) return { fresh: false, hasCodeLocks: false, mode: 'missing_lock_file', issueCount: 1 };
  const locks = Array.isArray(lockJson.locks) ? lockJson.locks : [];
  if (locks.length === 0) {
    return { fresh: false, hasCodeLocks: false, mode: 'empty_code_locks', issueCount: 1 };
  }
  const hasValidHashRef = ref => Boolean(
    ref && typeof ref === 'object'
    && typeof ref.path === 'string' && ref.path.trim()
    && typeof ref.contentHash === 'string' && ref.contentHash.trim(),
  );
  const verifyHashRef = async ref => {
    if (!hasValidHashRef(ref)) return false;
    const h = await sha256FilePrefixed(targetRepoReal, ref.path);
    return h === ref.contentHash;
  };
  let staleCount = 0;
  let hasFreshImplements = false;
  let hasFreshVerifies = false;
  for (const lk of locks) {
    if (!lk || typeof lk !== 'object') {
      staleCount += 1;
      continue;
    }
    if (!(await verifyHashRef(lk.artifact)) || !(await verifyHashRef(lk.source))) {
      staleCount += 1;
      continue;
    }
    if (lk.verifiedBy !== undefined && !Array.isArray(lk.verifiedBy)) {
      staleCount += 1;
      continue;
    }
    const verifiedBy = Array.isArray(lk.verifiedBy) ? lk.verifiedBy : [];
    let verifiedByAllFresh = true;
    for (const vb of verifiedBy) {
      if (!(await verifyHashRef(vb))) {
        verifiedByAllFresh = false;
        break;
      }
    }
    if (!verifiedByAllFresh) {
      staleCount += 1;
      continue;
    }
    if (lk.kind === 'implements') {
      hasFreshImplements = true;
      if (verifiedBy.length > 0) hasFreshVerifies = true;
    } else if (lk.kind === 'verifies') {
      hasFreshVerifies = true;
    } else {
      staleCount += 1;
    }
  }
  const hasCodeLocks = hasFreshImplements && hasFreshVerifies;
  const missingKinds = (hasFreshImplements ? 0 : 1) + (hasFreshVerifies ? 0 : 1);
  return {
    fresh: staleCount === 0 && hasCodeLocks,
    hasCodeLocks,
    hasFreshImplements,
    hasFreshVerifies,
    mode: hasCodeLocks ? 'code_locks' : 'incomplete_code_locks',
    issueCount: staleCount + missingKinds,
  };
}

export async function inspectInternalCodeLocks(repoReal) {
  let implSurface = { entryGlobs: [], excludeGlobs: ['**/*.test.*', '**/dist/**'], requireCodeLocks: false };
  try {
    const rawYaml = await readFileContained(repoReal, 'artifact-graph.config.yaml', { encoding: 'utf8' });
    const parsed = parseYaml(rawYaml);
    if (parsed?.implementationSurface && typeof parsed.implementationSurface === 'object') {
      const cfg = parsed.implementationSurface;
      implSurface = {
        entryGlobs: Array.isArray(cfg.entryGlobs) ? cfg.entryGlobs.map(String) : [],
        excludeGlobs: Array.isArray(cfg.excludeGlobs) ? cfg.excludeGlobs.map(String) : ['**/*.test.*', '**/dist/**'],
        requireCodeLocks: Boolean(cfg.requireCodeLocks),
      };
    }
  } catch {}

  const lockJson = await readJsonContainedSafe(repoReal, VERSION_LOCK_PATH);
  const locks = Array.isArray(lockJson?.locks) ? lockJson.locks : [];
  const relLocks = Array.isArray(lockJson?.artifactRelations) ? lockJson.artifactRelations : [];

  const claimedSources = new Set();
  const implementsLocks = [];
  const verifiesLocks = [];
  const drifts = [];

  for (const lk of locks) {
    if (lk?.source?.path) claimedSources.add(lk.source.path);
    for (const vb of lk?.verifiedBy ?? []) {
      if (vb?.path) claimedSources.add(vb.path);
    }
    if (lk?.kind === 'verifies') verifiesLocks.push(lk);
    else implementsLocks.push(lk);

    if (lk?.artifact?.path && lk?.artifact?.contentHash) {
      const cur = await sha256FilePrefixed(repoReal, lk.artifact.path);
      if (cur !== lk.artifact.contentHash) {
        drifts.push({ code: 'artifact_changed', path: lk.artifact.path, edgeId: lk.edgeId });
      }
    }
    if (lk?.source?.path && lk?.source?.contentHash) {
      const cur = await sha256FilePrefixed(repoReal, lk.source.path);
      if (cur !== lk.source.contentHash) {
        drifts.push({ code: 'source_changed', path: lk.source.path, edgeId: lk.edgeId });
      }
    }
  }

  let matchedEntries = [];
  let unclaimedEntries = [];
  if (implSurface.entryGlobs.length > 0) {
    const incRes = implSurface.entryGlobs.map(globToRegExp);
    const excRes = implSurface.excludeGlobs.map(globToRegExp);
    const allFiles = await listRepoFiles(repoReal);
    matchedEntries = allFiles.filter(f => incRes.some(r => r.test(f)) && !excRes.some(r => r.test(f)));
    unclaimedEntries = matchedEntries.filter(f => !claimedSources.has(f));
  }

  const briefCache = new Map();
  const unclaimedEntryDetails = [];
  for (const rel of unclaimedEntries) {
    const brief = await resolveEntityBriefContained(repoReal, rel, { defaultTypeLabel: '源码入口' }, briefCache);
    unclaimedEntryDetails.push({
      path: rel,
      code: basename(rel),
      title: sanitizePublicText(brief.title || basename(rel)),
      summary: brief.summary.startsWith('查看')
        ? `属于实现边界清单内的受管源码入口（${rel}），当前尚未建立版本锁绑定。`
        : brief.summary,
      typeLabel: '源码入口',
    });
  }
  const driftDetails = [];
  for (const d of drifts) {
    const brief = await resolveEntityBriefContained(repoReal, d.path, { defaultTypeLabel: d.code === 'artifact_changed' ? '受管制品' : '源码实现' }, briefCache);
    driftDetails.push({
      ...d,
      title: sanitizePublicText(brief.title || basename(String(d.path || ''))),
      summary: brief.summary,
      typeLabel: d.code === 'artifact_changed' ? '制品原文已修订' : '源码已演进',
    });
  }

  const missingRequiredCodeLocks = implSurface.requireCodeLocks && locks.length === 0;
  const healthy = !missingRequiredCodeLocks && unclaimedEntries.length === 0 && drifts.length === 0;

  return {
    lockPresent: Boolean(lockJson),
    requireCodeLocks: implSurface.requireCodeLocks,
    entryGlobsCount: implSurface.entryGlobs.length,
    matchedEntriesCount: matchedEntries.length,
    totalCodeLocks: locks.length,
    implementsCount: implementsLocks.length,
    verifiesCount: verifiesLocks.length,
    relationLocksCount: relLocks.length,
    unclaimedEntries,
    unclaimedEntryDetails,
    drifts,
    driftDetails,
    missingRequiredCodeLocks,
    healthy,
  };
}
const SATISFACTION_META = Object.freeze({
  verified_satisfied: { code: 'verified_satisfied', label: '🟢 已验证满足', tone: 'emerald' },
  partially_allocated: { code: 'partially_allocated', label: '🔵 部分覆盖', tone: 'indigo' },
  allocated_in_progress: { code: 'allocated_in_progress', label: '⏳ 已派单推进中', tone: 'amber' },
  not_applicable: { code: 'not_applicable', label: '⚪ 按处置不计满足', tone: 'zinc' },
  unallocated: { code: 'unallocated', label: '🔴 漏拆未派单', tone: 'rose' },
});

const DISPOSITION_LABELS = Object.freeze({
  allocated: '已拆派推进',
  deferred: '已暂缓',
  merged: '已合并',
  abandoned: '已废弃',
});

export async function inspectPortfolioAllocations(repoReal, catalog) {
  const doc = await readJsonContainedSafe(repoReal, 'artifacts/portfolio-allocations.json');
  if (!doc) return { present: false, portfolioId: null, title: null, items: [], summary: null };

  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  const briefCache = new Map();
  const items = [];
  const summary = {
    total: rawItems.length,
    verifiedSatisfied: 0,
    partiallyAllocated: 0,
    allocatedInProgress: 0,
    notApplicable: 0,
    unallocated: 0,
    driftCount: 0,
    missingCount: 0,
  };

  for (const raw of rawItems) {
    const disposition = String(raw?.disposition || 'allocated');
    const remainingScope = Array.isArray(raw?.remainingScope) ? raw.remainingScope.map(String) : [];
    const allocsRaw = Array.isArray(raw?.allocations) ? raw.allocations : [];
    const srcBrief = await resolveEntityBriefContained(
      repoReal,
      raw?.sourcePath,
      { uid: raw?.sourceUid, fallbackTitle: raw?.title || raw?.sourceUid, defaultTypeLabel: '高阶规划项' },
      briefCache,
    );
    const currentSourceDigest = raw?.sourcePath ? await sha256FilePrefixed(repoReal, raw.sourcePath) : null;
    const itemIssues = [];

    if (!currentSourceDigest) {
      itemIssues.push({ code: 'SOURCE_ARTIFACT_MISSING', message: `高阶源文件缺失：${raw?.sourcePath || ''}` });
    } else if (raw?.sourceDigest && currentSourceDigest !== raw.sourceDigest) {
      itemIssues.push({ code: 'UPSTREAM_DESIGN_CHANGED', message: '高阶需求原文已修订，待同步下游详细设计' });
    }

    const allocations = [];
    for (const a of allocsRaw) {
      const targetMeta = await resolveRelativeRepo(repoReal, a?.targetRepo, catalog);
      const allocIssues = [];
      let currentTargetDigest = null;
      let reciprocalBinding = null;
      let lockCheck = { fresh: false, hasCodeLocks: false, mode: 'missing' };
      const targetBrief = targetMeta
        ? await resolveEntityBriefContained(
          targetMeta.realPath,
          a?.targetPath,
          { uid: a?.targetUid, fallbackTitle: a?.targetTitle || a?.targetUid, defaultTypeLabel: '详设制品' },
          briefCache,
        )
        : {
          title: sanitizePublicText(a?.targetTitle || inferCodeFromUid(a?.targetUid, a?.targetPath) || '未定位详设'),
          summary: `目标仓库尚未注册或无法解析（${a?.targetRepo || '未知路径'}）。`,
          code: inferCodeFromUid(a?.targetUid, a?.targetPath),
          typeLabel: inferTypeLabelFromUid(a?.targetUid, '详设制品'),
          path: a?.targetPath || '',
        };

      if (!targetMeta) {
        allocIssues.push({ code: 'TARGET_MISSING', message: `未找到下游承接仓库：${a?.targetRepo || ''}` });
      } else {
        currentTargetDigest = a?.targetPath ? await sha256FilePrefixed(targetMeta.realPath, a.targetPath) : null;
        if (!currentTargetDigest) {
          allocIssues.push({ code: 'TARGET_MISSING', message: `下游制品文件缺失：${a?.targetPath || ''}` });
        } else if (a?.targetDigest && currentTargetDigest !== a.targetDigest) {
          allocIssues.push({ code: 'DOWNSTREAM_DESIGN_EVOLVED', message: '下游详设已演进，待回写更新高阶规划清单' });
        }

        if (a?.readonlyTarget === true) {
          lockCheck = await inspectDownstreamLockFreshness(targetMeta.realPath, a?.verifiedReceiptPath || null);
        } else {
          const upDoc = await readJsonContainedSafe(targetMeta.realPath, 'artifacts/upstream-bindings.json');
          const bindings = Array.isArray(upDoc?.bindings) ? upDoc.bindings : [];
          reciprocalBinding = bindings.find(b =>
            (b?.localUid === a?.targetUid && b?.upstreamUid === raw?.sourceUid)
            || (b?.localPath === a?.targetPath && b?.upstreamPath === raw?.sourcePath),
          ) || null;
          if (!reciprocalBinding) {
            allocIssues.push({ code: 'UNRECIPROCATED_ALLOCATION', message: '下游仓库缺少对应 upstream-bindings.json 回指声明' });
          } else {
            if (currentSourceDigest && reciprocalBinding.upstreamDigest && currentSourceDigest !== reciprocalBinding.upstreamDigest) {
              allocIssues.push({ code: 'UPSTREAM_DESIGN_CHANGED', message: '高阶原文已变更，下游 upstream-bindings 尚未同步' });
            }
            if (currentTargetDigest && reciprocalBinding.localDigest && currentTargetDigest !== reciprocalBinding.localDigest) {
              allocIssues.push({ code: 'DOWNSTREAM_DESIGN_EVOLVED', message: '下游详设已变更，本地回指摘要尚未更新' });
            }
          }
          lockCheck = await inspectDownstreamLockFreshness(targetMeta.realPath, a?.verifiedReceiptPath || null);
        }
      }

      for (const iss of allocIssues) {
        if (!itemIssues.some(x => x.code === iss.code && x.message === iss.message)) itemIssues.push(iss);
      }

      allocations.push({
        targetRepo: a?.targetRepo || '',
        targetRepoId: targetMeta?.repoId || null,
        targetRepoName: targetMeta?.name || String(a?.targetRepo || '').split('/').pop(),
        targetUid: a?.targetUid || '',
        targetPath: a?.targetPath || '',
        targetTitle: targetBrief.title,
        targetSummary: targetBrief.summary,
        targetCode: targetBrief.code,
        targetTypeLabel: targetBrief.typeLabel,
        coverageRole: a?.coverageRole || 'primary',
        readonlyTarget: Boolean(a?.readonlyTarget),
        verifiedReceiptPath: a?.verifiedReceiptPath || null,
        targetExists: Boolean(currentTargetDigest),
        reciprocalFound: Boolean(reciprocalBinding) || Boolean(a?.readonlyTarget),
        codeLocksFresh: lockCheck.fresh && lockCheck.hasCodeLocks,
        lockMode: lockCheck.mode,
        issues: allocIssues,
      });
    }

    let computedSatisfaction = 'allocated_in_progress';
    if (disposition !== 'allocated') {
      computedSatisfaction = 'not_applicable';
      summary.notApplicable += 1;
    } else if (allocations.length === 0) {
      computedSatisfaction = 'unallocated';
      summary.unallocated += 1;
      itemIssues.push({ code: 'UNALLOCATED_ACTIVE_DEMAND', message: '有效高阶需求尚未拆派给任何子项目' });
    } else if (remainingScope.length > 0) {
      computedSatisfaction = 'partially_allocated';
      summary.partiallyAllocated += 1;
    } else {
      const allTargetsReady = allocations.every(al => al.targetExists && al.reciprocalFound && al.codeLocksFresh);
      const noBlockingDrift = !itemIssues.some(iss =>
        ['SOURCE_ARTIFACT_MISSING', 'TARGET_MISSING', 'UPSTREAM_DESIGN_CHANGED', 'DOWNSTREAM_DESIGN_EVOLVED', 'UNRECIPROCATED_ALLOCATION'].includes(iss.code),
      );
      if (allTargetsReady && noBlockingDrift) {
        computedSatisfaction = 'verified_satisfied';
        summary.verifiedSatisfied += 1;
      } else {
        computedSatisfaction = 'allocated_in_progress';
        summary.allocatedInProgress += 1;
      }
    }

    const issueCodes = new Set(itemIssues.map(i => i.code));
    let health = { code: 'SYNCED', label: '🟢 双向一致', tone: 'emerald' };
    if (issueCodes.has('UNALLOCATED_ACTIVE_DEMAND') || issueCodes.has('SOURCE_ARTIFACT_MISSING') || issueCodes.has('TARGET_MISSING')) {
      health = { code: 'MISSING_OR_UNALLOCATED', label: '🔴 漏拆或目标缺失', tone: 'rose' };
      summary.missingCount += 1;
    } else if (issueCodes.has('UNRECIPROCATED_ALLOCATION')) {
      health = { code: 'UNRECIPROCATED_ALLOCATION', label: '🔴 单边未互认', tone: 'rose' };
      summary.driftCount += 1;
    } else if (issueCodes.has('UPSTREAM_DESIGN_CHANGED')) {
      health = { code: 'UPSTREAM_DESIGN_CHANGED', label: '🟠 高阶已变待同步详设', tone: 'amber' };
      summary.driftCount += 1;
    } else if (issueCodes.has('DOWNSTREAM_DESIGN_EVOLVED')) {
      health = { code: 'DOWNSTREAM_DESIGN_EVOLVED', label: '🟠 详设已演进待回写高阶', tone: 'amber' };
      summary.driftCount += 1;
    } else if (disposition !== 'allocated') {
      health = { code: 'DISPOSED', label: '⚪ 按处置结案', tone: 'zinc' };
    } else if (computedSatisfaction !== 'verified_satisfied') {
      health = { code: 'IN_PROGRESS', label: '🔵 摘要对齐·实施验证中', tone: 'indigo' };
    }

    const itemDisplayTitle = raw?.title && raw.title !== raw?.sourceUid
      ? cleanInlinePlain(raw.title)
      : srcBrief.title;
    items.push({
      sourceUid: raw?.sourceUid || '',
      sourcePath: raw?.sourcePath || '',
      sourceCode: srcBrief.code,
      sourceTypeLabel: srcBrief.typeLabel,
      title: sanitizePublicText(itemDisplayTitle || srcBrief.title),
      sourceSummary: srcBrief.summary,
      disposition,
      dispositionLabel: DISPOSITION_LABELS[disposition] || disposition,
      dispositionNote: raw?.dispositionNote || '',
      mergedInto: raw?.mergedInto || null,
      remainingScope,
      allocations,
      computedSatisfaction,
      satisfactionMeta: SATISFACTION_META[computedSatisfaction] || SATISFACTION_META.allocated_in_progress,
      health,
      issues: itemIssues,
    });
  }

  return {
    present: true,
    portfolioId: doc.portfolioId || null,
    title: doc.title || '高阶需求拆分与承接总表',
    items,
    summary,
  };
}

export async function inspectUpstreamBindings(repoReal, catalog) {
  const doc = await readJsonContainedSafe(repoReal, 'artifacts/upstream-bindings.json');
  if (!doc) return { present: false, upstreamPortfolio: null, upstreamRepoId: null, upstreamRepoName: null, bindings: [], driftCount: 0 };

  const upstreamMeta = await resolveRelativeRepo(repoReal, doc.upstreamPortfolio, catalog);
  const upstreamPortfolioDoc = upstreamMeta
    ? await readJsonContainedSafe(upstreamMeta.realPath, 'artifacts/portfolio-allocations.json')
    : null;
  const upItems = Array.isArray(upstreamPortfolioDoc?.items) ? upstreamPortfolioDoc.items : [];

  const bindings = [];
  const briefCache = new Map();
  let driftCount = 0;

  for (const b of Array.isArray(doc.bindings) ? doc.bindings : []) {
    const localBrief = await resolveEntityBriefContained(
      repoReal,
      b?.localPath,
      { uid: b?.localUid, fallbackTitle: b?.localTitle || b?.localUid, defaultTypeLabel: '本仓详设' },
      briefCache,
    );
    const upBrief = upstreamMeta
      ? await resolveEntityBriefContained(
        upstreamMeta.realPath,
        b?.upstreamPath,
        { uid: b?.upstreamUid, fallbackTitle: b?.upstreamTitle || b?.upstreamUid, defaultTypeLabel: '上游高阶' },
        briefCache,
      )
      : {
        title: sanitizePublicText(b?.upstreamTitle || inferCodeFromUid(b?.upstreamUid, b?.upstreamPath) || '上游高阶条目'),
        summary: `来源自高阶规划仓 ${String(doc.upstreamPortfolio || '').split('/').pop() || ''} 的承接需求条目。`,
        code: inferCodeFromUid(b?.upstreamUid, b?.upstreamPath),
        typeLabel: inferTypeLabelFromUid(b?.upstreamUid, '上游高阶'),
        path: b?.upstreamPath || '',
      };
    const curLocalDigest = b?.localPath ? await sha256FilePrefixed(repoReal, b.localPath) : null;
    const curUpstreamDigest = (upstreamMeta && b?.upstreamPath)
      ? await sha256FilePrefixed(upstreamMeta.realPath, b.upstreamPath)
      : null;

    const matchedUpItem = upItems.find(it => it?.sourceUid === b?.upstreamUid || it?.sourcePath === b?.upstreamPath) || null;
    const matchedAlloc = matchedUpItem
      ? (matchedUpItem.allocations ?? []).find(al => al?.targetUid === b?.localUid || al?.targetPath === b?.localPath) || null
      : null;

    const issues = [];
    if (!curLocalDigest) issues.push({ code: 'TARGET_MISSING', message: `本地制品缺失：${b?.localPath || ''}` });
    if (!upstreamMeta || !curUpstreamDigest) issues.push({ code: 'TARGET_MISSING', message: `上游高阶文件缺失：${b?.upstreamPath || ''}` });
    if (upstreamPortfolioDoc && !matchedAlloc) {
      issues.push({ code: 'UNRECIPROCATED_ALLOCATION', message: '上游高阶清单未登记对本条目的承接分配' });
    }
    if (curUpstreamDigest && ((b?.upstreamDigest && curUpstreamDigest !== b.upstreamDigest)
      || (matchedUpItem?.sourceDigest && curUpstreamDigest !== matchedUpItem.sourceDigest))) {
      issues.push({ code: 'UPSTREAM_DESIGN_CHANGED', message: '上游高阶需求已修订，本详设需同步对齐' });
    }
    if (curLocalDigest && ((b?.localDigest && curLocalDigest !== b.localDigest)
      || (matchedAlloc?.targetDigest && curLocalDigest !== matchedAlloc.targetDigest))) {
      issues.push({ code: 'DOWNSTREAM_DESIGN_EVOLVED', message: '本详设已演进，需反向回写上游高阶清单' });
    }

    const codes = new Set(issues.map(i => i.code));
    let health = { code: 'SYNCED', label: '🟢 与高阶双向一致', tone: 'emerald' };
    if (codes.has('TARGET_MISSING') || codes.has('UNRECIPROCATED_ALLOCATION')) {
      health = { code: 'UNRECIPROCATED_ALLOCATION', label: '🔴 来源缺失或未互认', tone: 'rose' };
      driftCount += 1;
    } else if (codes.has('UPSTREAM_DESIGN_CHANGED')) {
      health = { code: 'UPSTREAM_DESIGN_CHANGED', label: '🟠 高阶已变待同步详设', tone: 'amber' };
      driftCount += 1;
    } else if (codes.has('DOWNSTREAM_DESIGN_EVOLVED')) {
      health = { code: 'DOWNSTREAM_DESIGN_EVOLVED', label: '🟠 详设已演进待回写高阶', tone: 'amber' };
      driftCount += 1;
    }

    bindings.push({
      localUid: b?.localUid || '',
      localPath: b?.localPath || '',
      localCode: localBrief.code,
      localTitle: localBrief.title,
      localSummary: localBrief.summary,
      localTypeLabel: localBrief.typeLabel,
      upstreamUid: b?.upstreamUid || '',
      upstreamPath: b?.upstreamPath || '',
      upstreamCode: upBrief.code,
      upstreamTitle: cleanInlinePlain(matchedUpItem?.title || upBrief.title || b?.upstreamUid || ''),
      upstreamSummary: upBrief.summary,
      upstreamTypeLabel: upBrief.typeLabel,
      upstreamRepoId: upstreamMeta?.repoId || null,
      upstreamRepoName: upstreamMeta?.name || String(doc.upstreamPortfolio || '').split('/').pop(),
      health,
      issues,
    });
  }

  return {
    present: true,
    upstreamPortfolio: doc.upstreamPortfolio || null,
    upstreamRepoId: upstreamMeta?.repoId || null,
    upstreamRepoName: upstreamMeta?.name || String(doc.upstreamPortfolio || '').split('/').pop(),
    bindings,
    driftCount,
  };
}

export async function inspectRepoAlignment(record, catalog) {
  const [portfolio, upstreamBindings, internalCodeLocks] = await Promise.all([
    inspectPortfolioAllocations(record.realPath, catalog),
    inspectUpstreamBindings(record.realPath, catalog),
    inspectInternalCodeLocks(record.realPath),
  ]);

  const totalAlerts = (portfolio.summary?.driftCount ?? 0)
    + (portfolio.summary?.missingCount ?? 0)
    + (portfolio.summary?.unallocated ?? 0)
    + (upstreamBindings.driftCount ?? 0)
    + (internalCodeLocks.unclaimedEntries?.length ?? 0)
    + (internalCodeLocks.drifts?.length ?? 0)
    + (internalCodeLocks.missingRequiredCodeLocks ? 1 : 0);

  return {
    ok: true,
    repoId: record.id,
    repoName: record.name,
    role: portfolio.present ? 'portfolio' : (upstreamBindings.present ? 'subproject' : 'standalone'),
    totalAlerts,
    portfolio,
    upstreamBindings,
    internalCodeLocks,
  };
}
