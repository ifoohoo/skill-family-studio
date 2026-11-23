// @feature STU002

import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFileContained, resolveContained, writeFileAtomic } from 'skill-family-harness-node';

export const DEFAULT_STUDIO_REVIEWS_PATH = '.skill-family-studio/reviews.json';
export const LEGACY_WORKBENCH_REVIEWS_PATH = 'artifacts/reviews/workbench-reviews.json';

export const REVIEW_STATUS_META = Object.freeze({
  pending: { id: 'pending', label: '待审阅', tone: 'zinc', dot: '⚪' },
  reviewing: { id: 'reviewing', label: '审阅中', tone: 'indigo', dot: '🔵' },
  changes_requested: { id: 'changes_requested', label: '需修改', tone: 'amber', dot: '🟠' },
  approved: { id: 'approved', label: '已通过', tone: 'emerald', dot: '🟢' },
  deferred: { id: 'deferred', label: '暂缓', tone: 'purple', dot: '🟣' },
});

export const VALID_DECISION_STATUSES = new Set(Object.keys(REVIEW_STATUS_META));
export const VALID_DISPOSITIONS = new Set(['', 'retained', 'deferred', 'merged', 'abandoned', 'unknown']);
const TERMINAL_DECISION_STATUSES = new Set(['approved', 'changes_requested', 'deferred']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function cleanString(value, maxLen = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLen);
}

export function assertSafeObjectKeys(obj, label = '请求对象') {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw Object.assign(
        new Error(`${label}包含受保护的原型属性名 "${key}"，已拒绝写入以防原型污染。`),
        { statusCode: 400 },
      );
    }
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      assertSafeObjectKeys(val, label);
    }
  }
}

export function validateTargetId(target) {
  const clean = cleanString(target, 280);
  if (!clean || FORBIDDEN_OBJECT_KEYS.has(clean) || !/^[A-Za-z0-9_.:/#-]+$/.test(clean)) {
    throw Object.assign(
      new Error('无效的审阅对象标识 target：须为非空合法字符，且不得使用保留原型属性名。'),
      { statusCode: 400 },
    );
  }
  const parts = clean.split(/[:/#.]/);
  if (parts.some(part => FORBIDDEN_OBJECT_KEYS.has(part))) {
    throw Object.assign(
      new Error('无效的审阅对象标识 target：路径分段中不得包含 __proto__、constructor 或 prototype。'),
      { statusCode: 400 },
    );
  }
  return clean;
}

export function normalizeLegacyTargetKey(rawKey, defaultPrimaryRepoId = null) {
  const clean = validateTargetId(rawKey);
  if (clean.startsWith('repo:')) return clean;
  const ecoMatch = /^eco:([^:]+):(.+)$/.exec(clean);
  if (ecoMatch) {
    return validateTargetId(`repo:${ecoMatch[1]}:${ecoMatch[2]}`);
  }
  if (defaultPrimaryRepoId) {
    return validateTargetId(`repo:${defaultPrimaryRepoId}:${clean}`);
  }
  return clean;
}

export function qualifyRepoTargetId(repoId, rawTarget) {
  const cleanTarget = validateTargetId(rawTarget);
  const cleanRepo = cleanString(repoId, 140);
  if (cleanRepo && (FORBIDDEN_OBJECT_KEYS.has(cleanRepo) || !/^[A-Za-z0-9_./-]+$/.test(cleanRepo))) {
    throw Object.assign(new Error(`无效的仓库标识 repo：${cleanRepo}`), { statusCode: 400 });
  }
  const embedded = splitQualifiedTargetId(cleanTarget);
  if (embedded.repoId !== null) {
    if (FORBIDDEN_OBJECT_KEYS.has(embedded.repoId) || !/^[A-Za-z0-9_./-]+$/.test(embedded.repoId)) {
      throw Object.assign(new Error(`target 内嵌了非法的仓库标识：${embedded.repoId}`), { statusCode: 400 });
    }
    if (cleanRepo && cleanRepo !== embedded.repoId) {
      throw Object.assign(
        new Error(`请求体 repo (${cleanRepo}) 与 target 内嵌仓库前缀 (${embedded.repoId}) 不一致。`),
        { statusCode: 400 },
      );
    }
    return validateTargetId(`repo:${embedded.repoId}:${embedded.rawTarget}`);
  }
  if (!cleanRepo) return cleanTarget;
  return validateTargetId(`repo:${cleanRepo}:${cleanTarget}`);
}

export function splitQualifiedTargetId(qualifiedTarget) {
  const m = /^repo:([^:]+):(.+)$/.exec(String(qualifiedTarget ?? ''));
  if (m) return { repoId: m[1], rawTarget: m[2] };
  const eco = /^eco:([^:]+):(.+)$/.exec(String(qualifiedTarget ?? ''));
  if (eco) return { repoId: eco[1], rawTarget: eco[2] };
  return { repoId: null, rawTarget: String(qualifiedTarget ?? '') };
}

export function emptyReviewStore() {
  return {
    schemaVersion: 2,
    updatedAt: null,
    decisions: Object.create(null),
    annotations: [],
  };
}

export function countUnresolvedAnnotationsForTarget(store, qualifiedTarget) {
  const list = Array.isArray(store?.annotations) ? store.annotations : [];
  let count = 0;
  for (const ann of list) {
    if (ann && ann.target === qualifiedTarget && !ann.resolved) count += 1;
  }
  return count;
}

/**
 * 计算单篇制品的有效审阅状态（四态自动感知规则）：
 * 1. 若已显式给出终态结论（approved / changes_requested / deferred），以该结论为准；
 * 2. 若尚未给终态结论，但存在至少 1 条未解决批注，或用户显式点选了 reviewing，状态为 reviewing（审阅中）；
 * 3. 其余情况（无终态结论且无未解决批注）为 pending（待审阅）。
 */
export function computeEffectiveReviewStatus(qualifiedTarget, store) {
  const decisions = store?.decisions ?? {};
  const dec = Object.hasOwn(decisions, qualifiedTarget) ? decisions[qualifiedTarget] : null;
  const explicit = dec?.status || 'pending';
  if (TERMINAL_DECISION_STATUSES.has(explicit)) {
    return explicit;
  }
  if (countUnresolvedAnnotationsForTarget(store, qualifiedTarget) > 0) {
    return 'reviewing';
  }
  if (explicit === 'reviewing') {
    return 'reviewing';
  }
  return 'pending';
}

function sanitizeParsedStore(parsed, defaultPrimaryRepoId = null) {
  const decisions = Object.create(null);
  const rawDecisions = parsed?.decisions && typeof parsed.decisions === 'object' && !Array.isArray(parsed.decisions)
    ? parsed.decisions
    : {};
  for (const [k, v] of Object.entries(rawDecisions)) {
    if (FORBIDDEN_OBJECT_KEYS.has(k) || !v || typeof v !== 'object') continue;
    try {
      const qKey = normalizeLegacyTargetKey(k, defaultPrimaryRepoId);
      decisions[qKey] = {
        target: qKey,
        status: VALID_DECISION_STATUSES.has(v.status) ? v.status : 'pending',
        dispositionIntent: VALID_DISPOSITIONS.has(v.dispositionIntent ?? '') ? (v.dispositionIntent ?? '') : '',
        note: cleanString(v.note, 1000),
        updatedAt: v.updatedAt ?? null,
      };
    } catch {}
  }
  const annotations = [];
  for (const rawAnn of Array.isArray(parsed?.annotations) ? parsed.annotations : []) {
    if (!rawAnn || typeof rawAnn !== 'object') continue;
    try {
      const qTarget = normalizeLegacyTargetKey(rawAnn.target, defaultPrimaryRepoId);
      const body = cleanString(rawAnn.body ?? rawAnn.text, 4000);
      if (!body) continue;
      annotations.push({
        id: cleanString(rawAnn.id, 80) || `ann-${randomUUID().slice(0, 12)}`,
        target: qTarget,
        anchor: cleanString(rawAnn.anchor, 160) || null,
        quote: cleanString(rawAnn.quote, 1000) || null,
        body,
        author: cleanString(rawAnn.author, 80) || '审阅者',
        resolved: Boolean(rawAnn.resolved),
        createdAt: rawAnn.createdAt ?? null,
        updatedAt: rawAnn.updatedAt ?? null,
      });
    } catch {}
  }
  return {
    schemaVersion: 2,
    updatedAt: parsed?.updatedAt ?? null,
    decisions,
    annotations,
  };
}

export async function readStudioReviewStore(
  root,
  {
    reviewsPath = DEFAULT_STUDIO_REVIEWS_PATH,
    legacyFallbackRoot = null,
    defaultPrimaryRepoId = null,
  } = {},
) {
  try {
    const abs = await resolveContained(root, reviewsPath);
    await lstat(abs);
    const raw = await readFileContained(root, reviewsPath, { encoding: 'utf8' });
    return sanitizeParsedStore(JSON.parse(raw), defaultPrimaryRepoId);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  for (const candidateRoot of [root, legacyFallbackRoot].filter(Boolean)) {
    try {
      const legAbs = await resolveContained(candidateRoot, LEGACY_WORKBENCH_REVIEWS_PATH);
      await lstat(legAbs);
      const raw = await readFileContained(candidateRoot, LEGACY_WORKBENCH_REVIEWS_PATH, { encoding: 'utf8' });
      return sanitizeParsedStore(JSON.parse(raw), defaultPrimaryRepoId);
    } catch {}
  }
  return emptyReviewStore();
}

export async function writeStudioReviewStore(root, store, { reviewsPath = DEFAULT_STUDIO_REVIEWS_PATH } = {}) {
  const targetAbs = await resolveContained(root, reviewsPath);
  await mkdir(dirname(targetAbs), { recursive: true });
  const plainDecisions = {};
  for (const [k, v] of Object.entries(store.decisions ?? {})) {
    if (!FORBIDDEN_OBJECT_KEYS.has(k)) plainDecisions[k] = v;
  }
  const payload = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    decisions: plainDecisions,
    annotations: Array.isArray(store.annotations) ? store.annotations : [],
  };
  await writeFileAtomic(root, reviewsPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function applyAnnotationMutation(store, body, { repoId, now = new Date().toISOString() } = {}) {
  assertSafeObjectKeys(body, '批注请求体');
  const action = body.action ?? 'create';

  const syncReviewingAfterAnnotationClear = qualifiedTarget => {
    const remainingUnresolved = countUnresolvedAnnotationsForTarget(store, qualifiedTarget);
    if (remainingUnresolved === 0 && Object.hasOwn(store.decisions, qualifiedTarget)) {
      const cur = store.decisions[qualifiedTarget];
      if (cur.status === 'reviewing') {
        if (!cur.dispositionIntent && !cur.note) {
          delete store.decisions[qualifiedTarget];
        } else {
          store.decisions[qualifiedTarget] = { ...cur, status: 'pending', updatedAt: now };
        }
      }
    }
  };

  if (action === 'create') {
    const qualifiedTarget = qualifyRepoTargetId(repoId, body.target);
    const text = cleanString(body.body ?? body.text, 4000);
    if (!text) {
      throw Object.assign(new Error('批注正文不能为空；请填写具体修改建议或审阅疑问。'), { statusCode: 400 });
    }
    const annotation = {
      id: `ann-${randomUUID().slice(0, 12)}`,
      target: qualifiedTarget,
      anchor: cleanString(body.anchor, 160) || null,
      quote: cleanString(body.quote, 1000) || null,
      body: text,
      author: cleanString(body.author, 80) || '审阅者',
      resolved: false,
      createdAt: now,
      updatedAt: now,
    };
    store.annotations.push(annotation);
    return { annotation, effectiveStatus: computeEffectiveReviewStatus(qualifiedTarget, store) };
  }

  if (action === 'resolve' || action === 'toggle') {
    const id = cleanString(body.id, 80);
    const found = store.annotations.find(item => item.id === id);
    if (!found) throw Object.assign(new Error(`未找到对应的批注记录：${id}`), { statusCode: 404 });
    found.resolved = typeof body.resolved === 'boolean' ? body.resolved : !found.resolved;
    found.updatedAt = now;
    syncReviewingAfterAnnotationClear(found.target);
    return { annotation: found, effectiveStatus: computeEffectiveReviewStatus(found.target, store) };
  }

  if (action === 'delete') {
    const id = cleanString(body.id, 80);
    const found = store.annotations.find(item => item.id === id);
    if (!found) throw Object.assign(new Error(`未找到对应的批注记录：${id}`), { statusCode: 404 });
    store.annotations = store.annotations.filter(item => item.id !== id);
    syncReviewingAfterAnnotationClear(found.target);
    return { deletedId: id, target: found.target, effectiveStatus: computeEffectiveReviewStatus(found.target, store) };
  }

  throw Object.assign(
    new Error(`不支持的批注操作 "${action}"；仅允许 create、resolve、toggle 或 delete。`),
    { statusCode: 400 },
  );
}

export function applyDecisionMutation(store, body, { repoId, now = new Date().toISOString() } = {}) {
  assertSafeObjectKeys(body, '审阅结论请求体');
  const qualifiedTarget = qualifyRepoTargetId(repoId, body.target);
  const status = body.status === undefined ? undefined : cleanString(body.status, 40);
  if (status !== undefined && !VALID_DECISION_STATUSES.has(status)) {
    throw Object.assign(
      new Error(`无效的审阅状态 "${status}"；仅支持 pending、reviewing、changes_requested、approved 或 deferred。`),
      { statusCode: 400 },
    );
  }
  const dispositionIntent = body.dispositionIntent === undefined
    ? undefined
    : cleanString(body.dispositionIntent, 40);
  if (dispositionIntent !== undefined && !VALID_DISPOSITIONS.has(dispositionIntent)) {
    throw Object.assign(new Error(`无效的处置意向 "${dispositionIntent}"。`), { statusCode: 400 });
  }

  const prev = Object.hasOwn(store.decisions, qualifiedTarget)
    ? store.decisions[qualifiedTarget]
    : { target: qualifiedTarget, status: 'pending', dispositionIntent: '', note: '' };
  const next = {
    target: qualifiedTarget,
    status: status ?? prev.status ?? 'pending',
    dispositionIntent: dispositionIntent ?? prev.dispositionIntent ?? '',
    note: body.note !== undefined ? cleanString(body.note, 1000) : (prev.note ?? ''),
    updatedAt: now,
  };
  if (next.status === 'pending' && next.dispositionIntent === '' && next.note === '') {
    delete store.decisions[qualifiedTarget];
  } else {
    store.decisions[qualifiedTarget] = next;
  }
  return {
    decision: next,
    effectiveStatus: computeEffectiveReviewStatus(qualifiedTarget, store),
  };
}

const READING_ORDER_TIER = Object.freeze({
  user_story: 10,
  story: 10,
  lifecycle: 12,
  lifecycle_story: 14,
  requirement: 18,
  prd: 19,
  spec: 20,
  scenario: 24,
  domain_model: 30,
  entity: 32,
  'domain-glossary': 32,
  'bounded-context-map': 33,
  decision: 34,
  business_article: 36,
  feature: 40,
  design: 42,
  interface_contracts: 44,
  data_contracts: 44,
  application_state_machines: 44,
  error_model: 44,
  agent_skill: 46,
  archify_diagram: 48,
  e2e_test: 54,
  'test-strategy': 56,
  'rule-golden-cases': 58,
  test: 60,
  implementation: 62,
});

export function sortItemsForGuidedReview(items = []) {
  return [...items].sort((a, b) => {
    const tierA = a.isMachineContract ? 52 : (READING_ORDER_TIER[a.type] ?? (typeof a.layerOrder === 'number' ? 10 + a.layerOrder * 10 : 45));
    const tierB = b.isMachineContract ? 52 : (READING_ORDER_TIER[b.type] ?? (typeof b.layerOrder === 'number' ? 10 + b.layerOrder * 10 : 45));
    if (tierA !== tierB) return tierA - tierB;
    return String(a.code ?? a.uid ?? '').localeCompare(String(b.code ?? b.uid ?? ''), 'zh-CN', { numeric: true });
  });
}

export function findNextGuidedReviewItem(orderedItems, store, repoId, currentTarget = null) {
  if (!Array.isArray(orderedItems) || orderedItems.length === 0) return null;
  const humanItems = orderedItems.filter(i => !i.isMachineContract);
  const pool = humanItems.length > 0 ? humanItems : orderedItems;
  const startIdx = currentTarget
    ? pool.findIndex(item => (item.uid || item.target) === currentTarget)
    : -1;
  const rotated = startIdx >= 0
    ? [...pool.slice(startIdx + 1), ...pool.slice(0, startIdx + 1)]
    : pool;

  // 优先找下一篇尚未终态签收（待审阅或审阅中）的人读文稿条目
  for (const item of rotated) {
    const rawId = item.uid || item.target;
    if (rawId === currentTarget && pool.length > 1) continue;
    const eff = computeEffectiveReviewStatus(qualifyRepoTargetId(repoId, rawId), store);
    if (eff === 'pending' || eff === 'reviewing') return item;
  }
  return rotated[0] ?? null;
}

export function summarizeRepoReviewProgress(repoId, reviewableRawTargets = [], store) {
  const counts = {
    total: reviewableRawTargets.length,
    approved: 0,
    reviewing: 0,
    changesRequested: 0,
    deferred: 0,
    pending: 0,
    decided: 0,
  };
  for (const raw of reviewableRawTargets) {
    const eff = computeEffectiveReviewStatus(qualifyRepoTargetId(repoId, raw), store);
    if (eff === 'approved') { counts.approved++; counts.decided++; }
    else if (eff === 'changes_requested') { counts.changesRequested++; counts.decided++; }
    else if (eff === 'deferred') { counts.deferred++; counts.decided++; }
    else if (eff === 'reviewing') counts.reviewing++;
    else counts.pending++;
  }
  return counts;
}

export function buildStudioReviewSummary(store, { repos = [], generatedAt = new Date().toISOString(), itemMetaByTarget = null } = {}) {
  const allTargets = new Set();
  for (const k of Object.keys(store?.decisions ?? {})) allTargets.add(k);
  for (const ann of Array.isArray(store?.annotations) ? store.annotations : []) {
    if (ann?.target) allTargets.add(ann.target);
  }

  const counts = {
    approved: 0,
    reviewing: 0,
    changesRequested: 0,
    deferred: 0,
    pending: 0,
    totalTouched: 0,
    totalCatalogItems: repos.reduce((sum, r) => sum + (r.reviewableCount ?? r.nodeCount ?? 0), 0),
    totalAnnotations: Array.isArray(store?.annotations) ? store.annotations.length : 0,
    unresolvedAnnotations: 0,
    resolvedAnnotations: 0,
  };

  const repoBuckets = new Map();
  const ensureBucket = repoId => {
    const key = repoId || 'workspace';
    if (!repoBuckets.has(key)) {
      const meta = repos.find(r => r.id === key);
      repoBuckets.set(key, {
        repoId: key,
        repoName: meta?.name ?? key.split('/').pop(),
        groupLabel: meta?.groupLabel ?? meta?.group ?? '工作区',
        items: [],
        annotations: [],
      });
    }
    return repoBuckets.get(key);
  };

  for (const qTarget of [...allTargets].sort()) {
    const eff = computeEffectiveReviewStatus(qTarget, store);
    const dec = Object.hasOwn(store?.decisions ?? {}, qTarget) ? store.decisions[qTarget] : null;
    if (eff === 'pending' && !dec?.note && !dec?.dispositionIntent) continue;
    counts.totalTouched += 1;
    if (eff === 'approved') counts.approved += 1;
    else if (eff === 'reviewing') counts.reviewing += 1;
    else if (eff === 'changes_requested') counts.changesRequested += 1;
    else if (eff === 'deferred') counts.deferred += 1;

    const { repoId, rawTarget } = splitQualifiedTargetId(qTarget);
    const itemMeta = itemMetaByTarget instanceof Map
      ? (itemMetaByTarget.get(qTarget) || itemMetaByTarget.get(rawTarget) || null)
      : (itemMetaByTarget && typeof itemMetaByTarget === 'object' ? (itemMetaByTarget[qTarget] || itemMetaByTarget[rawTarget] || null) : null);
    ensureBucket(repoId).items.push({
      target: qTarget,
      rawTarget,
      title: itemMeta?.title || '',
      summary: itemMeta?.summary || '',
      typeLabel: itemMeta?.typeLabel || '',
      effectiveStatus: eff,
      statusLabel: REVIEW_STATUS_META[eff]?.label ?? eff,
      dispositionIntent: dec?.dispositionIntent || '',
      note: dec?.note || '',
      unresolvedCount: countUnresolvedAnnotationsForTarget(store, qTarget),
      updatedAt: dec?.updatedAt || null,
    });
  }

  const unresolvedList = [];
  for (const ann of Array.isArray(store?.annotations) ? store.annotations : []) {
    if (ann.resolved) counts.resolvedAnnotations += 1;
    else counts.unresolvedAnnotations += 1;
    const { repoId, rawTarget } = splitQualifiedTargetId(ann.target);
    const enriched = { ...ann, repoId, rawTarget };
    if (!ann.resolved) unresolvedList.push(enriched);
    ensureBucket(repoId).annotations.push(enriched);
  }

  const groupedRepos = [...repoBuckets.values()].sort((a, b) => a.repoId.localeCompare(b.repoId));
  const md = [
    '# Skill Family Studio 设计与制品审阅验收单',
    '',
    `- **导出时间**：${generatedAt}`,
    `- **审阅状态汇总**：已通过 **${counts.approved}** · 审阅中 **${counts.reviewing}** · 需修改 **${counts.changesRequested}** · 暂缓 **${counts.deferred}**（全生态受审条目基数：${counts.totalCatalogItems}）`,
    `- **批注处理统计**：共 **${counts.totalAnnotations}** 条（待解决 **${counts.unresolvedAnnotations}** · 已解决 **${counts.resolvedAnnotations}**）`,
    '- **零侵入保证**：全部结论与批注集中保存在 Studio 本地台账，未修改任何受审仓库的 Git 跟踪文件。',
    '',
  ];
  if (!groupedRepos.length) {
    md.push('当前尚无已记录的审阅结论或批注。', '');
  } else {
    for (const bucket of groupedRepos) {
      md.push(`## ${bucket.groupLabel} · ${bucket.repoName} (\`${bucket.repoId}\`)`, '');
      for (const item of bucket.items) {
        const displayHead = item.title
          ? `${item.title} (\`${item.rawTarget}\`)`
          : `\`${item.rawTarget}\``;
        const extra = [
          item.summary ? `简介：${item.summary}` : '',
          item.unresolvedCount > 0 ? `待解决批注 ${item.unresolvedCount} 条` : '',
          item.dispositionIntent ? `处置意向：${item.dispositionIntent}` : '',
          item.note ? `结论说明：${item.note}` : '',
        ].filter(Boolean).join('；');
        md.push(`- **[${item.statusLabel}]** ${displayHead}${extra ? ` — ${extra}` : ''}`);
      }
      md.push('');
    }
  }
  if (unresolvedList.length > 0) {
    md.push('## 待解决批注清单', '');
    for (const a of unresolvedList) {
      md.push(`- [${a.repoId || 'workspace'}] \`${a.rawTarget}\`${a.anchor ? ` (#${a.anchor})` : ''}：${a.body}${a.quote ? `（摘录：「${a.quote.replace(/\s+/g, ' ').slice(0, 100)}」）` : ''}`);
    }
    md.push('');
  }
  return { generatedAt, counts, repos: groupedRepos, unresolvedAnnotations: unresolvedList, markdown: md.join('\n') };
}
