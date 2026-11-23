// @feature STU001
// @feature STU002
// @feature STU003
// @feature STU005
// @feature STU006

import { computeAdaptiveGraphLayout, pickDefaultArtifactNode } from '../graph-layout.mjs';
import { buildReviewStatusFlowSvg, buildTriLayerLockSvg } from './diagram-svg.mjs';
import { mountFleetMonitor } from './fleet-ui.mjs';
import { closeGlobalTooltip, infoTrigger, initTooltipManager, isTooltipOpen } from './tooltips.mjs';

const STATUS_META = {
  pending: { label: '待审阅', badge: 'st-badge st-badge-zinc', dot: '⚪', color: '#64748b' },
  reviewing: { label: '审阅中', badge: 'st-badge st-badge-indigo', dot: '🔵', color: '#4f46e5' },
  changes_requested: { label: '需修改', badge: 'st-badge st-badge-amber', dot: '🟠', color: '#d97706' },
  approved: { label: '已通过', badge: 'st-badge st-badge-emerald', dot: '🟢', color: '#059669' },
  deferred: { label: '暂缓', badge: 'st-badge st-badge-purple', dot: '🟣', color: '#7c3aed' },
};

const state = {
  tab: 'graph',
  repoId: null,
  repos: [],
  decisions: {},
  annotations: [],
  guide: null,
  snap: null,
  alignment: null,
  runtime: null,
  fleet: null,
  selectedUid: null,
  reviewMode: 'reader', // 'alignment' | 'reader'
  alignFilter: 'all',
  alignQuery: '',
  reviewCategory: 'all',
  reviewStatusFilter: 'all',
  reviewQuery: '',
  proseWidth: typeof localStorage !== 'undefined' && localStorage.getItem('st-prose-width') === 'full' ? 'full' : 'comfort',
  docViewMode: 'summary', // 'summary' | 'raw'
  graphMode: 'dag',
  archifyIdx: 0,
  fitWidth: true,
  wrapGrid: true,
  focusSubgraph: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  fullscreenGraph: false,
  selectedAnchor: null,
  archifySelectedNode: null,
  docCache: new Map(),
  rtScope: 'repo', // 'repo' | 'workspace'
  rtSelectedTargetId: '__all__',
  rtView: 'tasks', // 'tasks' | 'fleet' | 'diag'
  rtTaskFilter: 'all', // 'all' | 'incomplete' | 'focus'
  rtTaskQuery: '',
  rtCollapsedTreeIds: new Set(),
  rtLockFilter: 'all',
  rtFleetFamilyId: null,
  rtFleetSelectedAgent: null,
  rtFleetSelectedEventId: null,
  rtFleetEventKind: 'all',
  rtFleetTaskPhase: 'all',
  rtFleetAgentQuery: '',
  rtFleetEventQuery: '',
  rtFleetRichMode: true,
  rtSseStatus: 'connected',
};

const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
};

function resolveStudioItemByPageId(pageId) {
  if (!pageId || !state.snap) return null;
  const items = [...(state.snap.reviewItems || []), ...(state.snap.nodes || [])];
  const raw = String(pageId).trim();
  const exactArticle = items.find(i => i.uid === `business_article:${raw}`);
  if (exactArticle) return exactArticle;
  const exactUid = items.find(i => i.uid === raw || i.target === raw);
  if (exactUid) return exactUid;
  const normalized = raw.replace(/^story-/i, '').toUpperCase();
  return items.find(i =>
    String(i.code || '').toUpperCase() === raw.toUpperCase()
    || String(i.code || '').toUpperCase() === normalized
    || String(i.uid || '').toLowerCase().endsWith(`:${raw.toLowerCase()}`),
  ) || null;
}

function qualifiedTarget(rawTarget, repoId = state.repoId) {
  if (!rawTarget) return '';
  if (String(rawTarget).startsWith('repo:')) return rawTarget;
  return repoId ? `repo:${repoId}:${rawTarget}` : rawTarget;
}

function getTargetAnnotations(rawTarget, repoId = state.repoId) {
  const q = qualifiedTarget(rawTarget, repoId);
  return state.annotations.filter(a => a.target === q);
}

function getEffectiveStatus(rawTarget, repoId = state.repoId) {
  const q = qualifiedTarget(rawTarget, repoId);
  const dec = state.decisions[q];
  const exp = dec?.status || 'pending';
  if (exp === 'approved' || exp === 'changes_requested' || exp === 'deferred') return exp;
  if (state.annotations.some(a => a.target === q && !a.resolved)) return 'reviewing';
  if (exp === 'reviewing') return 'reviewing';
  return 'pending';
}

function countRepoProgress(repo) {
  const prefix = `repo:${repo.id}:`;
  let approved = 0, reviewing = 0, changes = 0, deferred = 0;
  const targets = new Set();
  for (const k of Object.keys(state.decisions)) if (k.startsWith(prefix)) targets.add(k.slice(prefix.length));
  for (const a of state.annotations) if (a.target?.startsWith(prefix)) targets.add(a.target.slice(prefix.length));
  if (state.snap && state.snap.repoId === repo.id) {
    for (const item of state.snap.reviewItems || []) targets.add(item.target || item.uid);
  }
  for (const raw of targets) {
    const s = getEffectiveStatus(raw, repo.id);
    if (s === 'approved') approved++;
    else if (s === 'reviewing') reviewing++;
    else if (s === 'changes_requested') changes++;
    else if (s === 'deferred') deferred++;
  }
  const total = state.snap?.repoId === repo.id
    ? (state.snap.reviewItems?.length || repo.reviewableCount || targets.size)
    : Math.max(repo.reviewableCount || 0, targets.size);
  return { approved, reviewing, changes, deferred, decided: approved + changes + deferred, total };
}

async function apiJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${String(remSec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatIsoShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function closeRepoPopover() {
  const pop = document.getElementById('st-repo-popover');
  const trig = document.getElementById('st-repo-trigger');
  if (pop) pop.hidden = true;
  if (trig) trig.setAttribute('aria-expanded', 'false');
}

function updateTopbarSummary() {
  const curRepo = state.repos.find(r => r.id === state.repoId);
  document.getElementById('st-current-repo-name').textContent = curRepo ? curRepo.name : '未发现仓库';

  const roleBadge = document.getElementById('st-repo-role-badge');
  const infoSlot = document.getElementById('st-topbar-info-slot');
  if (roleBadge && curRepo) {
    const rRole = curRepo.repoRole || 'standalone';
    roleBadge.textContent = curRepo.repoRoleLabel || '单项目仓';
    roleBadge.className = `st-badge ${rRole === 'portfolio' ? 'st-badge-amber' : (rRole === 'subproject' ? 'st-badge-emerald' : 'st-badge-zinc')}`;
    roleBadge.hidden = false;
  } else if (roleBadge) {
    roleBadge.hidden = true;
  }

  const lockBadge = document.getElementById('st-repo-lock-badge');
  if (state.snap?.versionLock) {
    lockBadge.textContent = state.snap.versionLock.badgeLabel;
    lockBadge.className = `st-badge st-badge-${state.snap.versionLock.badgeTone || 'zinc'}`;
  } else if (curRepo) {
    lockBadge.textContent = curRepo.versionLockLabel || '待核实';
    lockBadge.className = 'st-badge st-badge-zinc';
  }
  if (infoSlot && curRepo) {
    infoSlot.replaceChildren(
      infoTrigger(`role:${curRepo.repoRole || 'standalone'}`, document),
      infoTrigger('versionLock', document),
    );
  }
  if (curRepo) {
    const p = countRepoProgress(curRepo);
    document.getElementById('st-progress-text').textContent =
      `审阅进度：已通过 ${p.approved} · 审阅中 ${p.reviewing} · 需修改 ${p.changes} / 共 ${p.total} 项`;
  }
  const capWrap = document.getElementById('st-progress-capsule')?.parentElement;
  if (capWrap && !capWrap.querySelector('[data-info-key="progressCapsule"]')) {
    const refBtn = document.getElementById('st-progress-capsule');
    if (refBtn) refBtn.after(infoTrigger('progressCapsule', document));
  }
}

function renderRepoPopover() {
  const host = document.getElementById('st-repo-groups');
  const q = (document.getElementById('st-repo-search').value || '').trim().toLowerCase();
  host.replaceChildren();
  const filtered = state.repos.filter(r => !q || `${r.name} ${r.groupLabel} ${r.repoRoleLabel || ''} ${r.description}`.toLowerCase().includes(q));
  const byGroup = new Map();
  for (const r of filtered) {
    if (!byGroup.has(r.groupLabel)) byGroup.set(r.groupLabel, []);
    byGroup.get(r.groupLabel).push(r);
  }
  for (const [gLabel, list] of byGroup.entries()) {
    host.append(el('div', `${gLabel} (${list.length})`, 'st-repo-group-title'));
    for (const r of list) {
      const p = countRepoProgress(r);
      const btn = el('button', null, `st-repo-option${r.id === state.repoId ? ' is-selected' : ''}`);
      btn.type = 'button';
      const head = el('div', null, 'st-repo-opt-head');
      const leftHead = el('div', null, 'st-graph-controls');
      leftHead.append(el('span', r.name));
      if (r.repoRoleLabel) {
        const roleTone = r.repoRole === 'portfolio' ? 'st-badge-amber' : (r.repoRole === 'subproject' ? 'st-badge-emerald' : 'st-badge-zinc');
        leftHead.append(el('span', r.repoRoleLabel, `st-badge ${roleTone}`));
      }
      head.append(leftHead, el('span', `已审 ${p.decided}/${p.total}`, 'st-badge st-badge-indigo'));
      const metrics = el('div', null, 'st-repo-opt-metrics');
      metrics.append(
        el('span', `制品节点 ${r.nodeCount ?? 0}`),
        el('span', `· ${r.versionLockLabel}`),
        el('span', `· 审阅中 ${p.reviewing}`),
        el('span', `· ${r.runtimeLabel}`),
      );
      btn.append(head, metrics);
      btn.addEventListener('click', () => {
        closeRepoPopover();
        selectRepo(r.id);
      });
      host.append(btn);
    }
  }
}

function normalizeUiTab(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === 'overview') return 'guide';
  if (t === 'monitor') return 'runtime';
  return ['guide', 'graph', 'review', 'runtime'].includes(t) ? t : 'graph';
}

let lockTickTimer = null;
function stopLockTicker() {
  if (lockTickTimer) {
    clearInterval(lockTickTimer);
    lockTickTimer = null;
  }
}

function switchTab(nextTab) {
  nextTab = normalizeUiTab(nextTab);
  closeRepoPopover();
  if (nextTab !== 'runtime') stopLockTicker();
  state.tab = nextTab;
  const u = new URL(location.href);
  u.searchParams.set('tab', nextTab);
  if (state.repoId) u.searchParams.set('repo', state.repoId);
  history.replaceState(null, '', u);
  document.querySelectorAll('.st-tab-btn').forEach(b => {
    const active = b.dataset.tab === nextTab;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== nextTab; });
  renderActiveTab();
}

async function jumpToRepoAndItem(targetRepoId, targetUidOrCode, nextTab = 'review', nextReviewMode = 'reader') {
  if (targetRepoId && targetRepoId !== state.repoId) {
    await selectRepo(targetRepoId, { skipRender: true });
  }
  if (targetUidOrCode && state.snap) {
    const clean = String(targetUidOrCode).trim();
    const list = [...(state.snap.reviewItems || []), ...(state.snap.nodes || [])];
    const hit = list.find(i => i.uid === clean || i.target === clean || i.code === clean)
      || list.find(i => clean.includes(':') && (i.uid === clean || i.code === clean.split(':').slice(1).join(':')));
    if (hit) state.selectedUid = hit.uid;
  }
  state.selectedAnchor = null;
  state.reviewMode = nextReviewMode;
  switchTab(nextTab);
}

function findNextUnreviewed(currentUid = state.selectedUid) {
  const list = state.snap?.reviewItems ?? [];
  if (!list.length) return null;
  const humanOnly = list.filter(i => !i.isMachineContract);
  const pool = humanOnly.length > 0 ? humanOnly : list;
  const idx = currentUid ? pool.findIndex(i => i.uid === currentUid) : -1;
  const ordered = idx >= 0 ? [...pool.slice(idx + 1), ...pool.slice(0, idx + 1)] : pool;
  for (const item of ordered) {
    if (item.uid === currentUid && pool.length > 1) continue;
    const eff = getEffectiveStatus(item.target || item.uid);
    if (eff === 'pending' || eff === 'reviewing') return item;
  }
  return ordered[0] ?? null;
}

function startGuidedReview() {
  const first = findNextUnreviewed(null);
  if (first) state.selectedUid = first.uid;
  state.reviewMode = 'reader';
  switchTab('review');
}

function captureReviewScroll() {
  const sb = document.querySelector('#st-panel-review .st-review-sidebar');
  const dock = document.querySelector('#st-panel-review .st-reader-dock');
  return {
    winY: typeof window !== 'undefined' ? window.scrollY : 0,
    sidebarTop: sb ? sb.scrollTop : 0,
    dockTop: dock ? dock.scrollTop : 0,
  };
}

function restoreReviewScroll(snapScroll) {
  if (!snapScroll) return;
  requestAnimationFrame(() => {
    const sb = document.querySelector('#st-panel-review .st-review-sidebar');
    const dock = document.querySelector('#st-panel-review .st-reader-dock');
    if (sb) sb.scrollTop = snapScroll.sidebarTop;
    if (dock) dock.scrollTop = snapScroll.dockTop;
    if (typeof window !== 'undefined' && Math.abs(window.scrollY - snapScroll.winY) > 4) {
      window.scrollTo(0, snapScroll.winY);
    }
  });
}

async function submitDecision(rawTarget, status, note, andAdvance = false) {
  const scrollSnap = andAdvance ? null : captureReviewScroll();
  const payload = { repo: state.repoId, target: rawTarget, status };
  if (note !== undefined) payload.note = note;
  const res = await apiJson('/api/studio/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.decisions = res.decisions || {};
  if (andAdvance) {
    const next = findNextUnreviewed(state.selectedUid);
    if (next) state.selectedUid = next.uid;
  }
  updateTopbarSummary();
  renderActiveTab();
  restoreReviewScroll(scrollSnap);
}

async function mutateAnnotation(payload) {
  const scrollSnap = captureReviewScroll();
  const res = await apiJson('/api/studio/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: state.repoId, ...payload }),
  });
  state.annotations = res.annotations || [];
  if (res.decisions) state.decisions = res.decisions;
  updateTopbarSummary();
  renderActiveTab();
  restoreReviewScroll(scrollSnap);
}

function resolveCompanionItem(item) {
  if (!item || !state.snap) return null;
  const list = [...(state.snap.reviewItems || []), ...(state.snap.nodes || [])];
  if (item.pairedUid) {
    const hit = list.find(x => x.uid === item.pairedUid);
    if (hit) return hit;
  }
  return null;
}

async function mountDocumentReader(container, item, options = {}) {
  container.replaceChildren();
  if (!item) {
    container.append(el('div', '请在左侧或图谱中点击任意制品节点开始阅读与审阅。', 'st-prose-container st-muted-xs'));
    return;
  }
  const anchorId = options.anchorId ?? state.selectedAnchor ?? null;
  const archifyContext = options.archifyContext ?? state.archifySelectedNode ?? null;
  const rawTarget = item.target || item.uid;
  const eff = getEffectiveStatus(rawTarget);
  const meta = STATUS_META[eff] || STATUS_META.pending;
  const qTarget = qualifiedTarget(rawTarget);
  const curDec = state.decisions[qTarget] || {};
  const anns = getTargetAnnotations(rawTarget);

  const actionBar = el('div', null, 'st-action-bar');
  const leftInfo = el('div', null, 'st-graph-controls');
  leftInfo.append(
    el('span', item.code || item.uid, 'st-badge st-badge-zinc'),
    el('span', item.formatLabel || (item.isMachineContract ? 'JSON 数据契约' : 'Markdown 阅读稿'), `st-badge ${item.isMachineContract ? 'st-badge-amber' : 'st-badge-zinc'}`),
    infoTrigger(item.isMachineContract ? 'docFmt:json' : 'docFmt:markdown', document),
    el('span', `${meta.dot} ${meta.label}`, meta.badge),
    infoTrigger(`status:${eff}`, document),
  );
  const rightBtns = el('div', null, 'st-graph-controls');
  const approveNextBtn = el('button', '✓ 通过并审下一项 →', 'st-btn st-btn-emerald');
  approveNextBtn.type = 'button';
  approveNextBtn.addEventListener('click', () => submitDecision(rawTarget, 'approved', undefined, true));

  const skipNextBtn = el('button', '跳过看下一项 →', 'st-btn');
  skipNextBtn.type = 'button';
  skipNextBtn.addEventListener('click', () => {
    const nxt = findNextUnreviewed(item.uid);
    if (nxt) { state.selectedUid = nxt.uid; state.selectedAnchor = null; renderActiveTab(); }
  });

  const widthToggle = el('button', state.proseWidth === 'full' ? '切换舒适行宽' : '铺满全屏阅读', 'st-btn');
  widthToggle.type = 'button';
  widthToggle.addEventListener('click', () => {
    state.proseWidth = state.proseWidth === 'full' ? 'comfort' : 'full';
    localStorage.setItem('st-prose-width', state.proseWidth);
    mountDocumentReader(container, item, options);
  });

  rightBtns.append(approveNextBtn, skipNextBtn, widthToggle);
  actionBar.append(leftInfo, rightBtns);
  container.append(actionBar);

  // 同源 Markdown <-> JSON 数据契约互跳条
  const companion = resolveCompanionItem(item);
  if (companion || item.isMachineContract) {
    const pairBar = el('div', null, 'st-contract-pair-bar');
    const pairLeft = el('div', null, 'st-graph-controls');
    if (companion) {
      const jumpLabel = item.isMachineContract
        ? `📖 切换到对应的人读版 Markdown 文档（${companion.code || companion.title}）→`
        : `🗂️ 查看对应的结构化数据契约（${companion.path || companion.code}）→`;
      const jumpBtn = el('button', jumpLabel, 'st-jump-pill');
      jumpBtn.type = 'button';
      jumpBtn.addEventListener('click', () => {
        state.selectedUid = companion.uid;
        state.selectedAnchor = null;
        renderActiveTab();
      });
      pairLeft.append(jumpBtn);
    } else if (item.isMachineContract) {
      pairLeft.append(el('span', '🗂️ 机器数据契约文件（供自动化校验读取；主阅读队列已默认跳过）', 'st-muted-xs'));
    }
    const pairRight = el('div', null, 'st-graph-controls');
    if (item.isMachineContract) {
      const sumBtn = el('button', '📊 结构化可读摘要', `st-btn${state.docViewMode === 'summary' ? ' is-active' : ''}`);
      sumBtn.type = 'button';
      sumBtn.addEventListener('click', () => { state.docViewMode = 'summary'; mountDocumentReader(container, item, options); });
      const rawBtn = el('button', '{ } 原始源码', `st-btn${state.docViewMode === 'raw' ? ' is-active' : ''}`);
      rawBtn.type = 'button';
      rawBtn.addEventListener('click', () => { state.docViewMode = 'raw'; mountDocumentReader(container, item, options); });
      pairRight.append(sumBtn, rawBtn);
    }
    pairBar.append(pairLeft, pairRight);
    container.append(pairBar);
  }

  // 若当前制品或当前仓库关联了上游高阶规划来源，渲染「↖ 上游高阶来源」跨仓回跳胶囊栏
  const upInfo = state.alignment?.upstreamBindings;
  if (upInfo?.present && Array.isArray(upInfo.bindings) && upInfo.bindings.length > 0) {
    const directMatches = upInfo.bindings.filter(b => b.localUid === item.uid || b.localPath === item.path);
    const listToShow = directMatches.length > 0 ? directMatches : upInfo.bindings.slice(0, 3);
    const upBar = el('div', null, 'st-upstream-capsule-bar');
    const upLeft = el('div', null, 'st-graph-controls');
    upLeft.append(el('span', directMatches.length > 0 ? '↖ 上游高阶来源：' : `↖ 所属高阶规划仓 (${upInfo.upstreamRepoName})：`, 'st-muted-xs'));
    for (const b of listToShow) {
      const pill = el('button', `${upInfo.upstreamRepoName} · ${b.upstreamUid}`, 'st-jump-pill');
      pill.type = 'button';
      pill.title = b.upstreamTitle || b.upstreamUid;
      pill.addEventListener('click', () => jumpToRepoAndItem(b.upstreamRepoId || upInfo.upstreamRepoId, b.upstreamUid, 'review', 'reader'));
      upLeft.append(pill);
      const tone = b.health?.tone || 'zinc';
      upLeft.append(el('span', b.health?.label || '已绑定', `st-badge st-badge-${tone}`));
    }
    upBar.append(upLeft);
    container.append(upBar);
  }

  if (archifyContext && Array.isArray(archifyContext.bindings) && archifyContext.bindings.length > 0) {
    const bindBar = el('div', null, 'st-archify-bindings');
    bindBar.append(el('span', `图节点「${archifyContext.label || archifyContext.nodeId}」关联说明：`, 'st-muted-xs'));
    for (const b of archifyContext.bindings.slice(0, 8)) {
      const targetItem = resolveStudioItemByPageId(b.pageId);
      const labelTxt = `${targetItem?.code || b.pageId}${b.anchor ? ` #${b.anchor}` : ''}`;
      const isCur = targetItem?.uid === item.uid && (b.anchor || null) === anchorId;
      const chipBtn = el('button', labelTxt, `st-btn${isCur ? ' is-active' : ''}`);
      chipBtn.type = 'button';
      chipBtn.style.height = '26px';
      chipBtn.style.fontSize = '11.5px';
      chipBtn.addEventListener('click', () => {
        if (!targetItem) return;
        state.selectedUid = targetItem.uid;
        state.selectedAnchor = b.anchor || null;
        mountDocumentReader(container, targetItem, { anchorId: state.selectedAnchor, archifyContext });
      });
      bindBar.append(chipBtn);
    }
    container.append(bindBar);
  }

  const readerLayout = el('div', null, 'st-reader-layout');
  const mainCol = el('div', null, 'st-reader-main');
  const dockCol = el('div', null, 'st-reader-dock');

  const quickStatusRow = el('div', null, 'st-graph-toolbar');
  const statusGroup = el('div', null, 'st-graph-controls');
  for (const [stKey, label] of [
    ['approved', '🟢 标为已通过'],
    ['reviewing', '🔵 标为审阅中'],
    ['changes_requested', '🟠 需修改'],
    ['deferred', '🟣 暂缓'],
    ['pending', '⚪ 重置待审'],
  ]) {
    const b = el('button', label, `st-btn${eff === stKey ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => submitDecision(rawTarget, stKey, noteInput.value));
    statusGroup.append(b, infoTrigger(`status:${stKey}`, document));
  }
  const noteInput = el('input', null, 'st-input');
  noteInput.style.maxWidth = '320px';
  noteInput.placeholder = '审阅结论备注（可选，回车或点状态保存）…';
  noteInput.value = curDec.note || '';
  noteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitDecision(rawTarget, curDec.status || eff, noteInput.value);
  });
  quickStatusRow.append(statusGroup, noteInput);

  const proseWrap = el('article', null, 'st-prose-container');
  proseWrap.dataset.proseWidth = state.proseWidth;
  proseWrap.append(el('p', '正在加载制品正文…', 'st-muted-xs'));

  const annBox = el('div', null, 'st-ann-box');
  annBox.append(el('div', `审阅批注（共 ${anns.length} 条，添加未解决批注即自动点亮「🔵 审阅中」；全部解决或清空且未给结论时自动回到「⚪ 待审阅」）`, 'st-muted-xs'));
  const annInput = el('textarea', null, 'st-textarea');
  annInput.style.marginTop = '8px';
  annInput.placeholder = '记录本篇具体修改意见或疑问，点击下方「添加批注」立即落盘…';
  const addAnnBtn = el('button', '＋ 添加批注（自动转入审阅中）', 'st-btn st-btn-primary');
  addAnnBtn.type = 'button';
  addAnnBtn.style.marginTop = '8px';
  addAnnBtn.addEventListener('click', () => {
    const val = annInput.value.trim();
    if (!val) return;
    mutateAnnotation({ action: 'create', target: rawTarget, body: val });
  });
  annBox.append(annInput, addAnnBtn);

  for (const a of anns) {
    const row = el('div', null, `st-ann-item${a.resolved ? ' is-resolved' : ''}`);
    const head = el('div', null, 'st-repo-opt-head');
    head.append(
      el('span', `${a.resolved ? '✓ 已解决' : '● 待解决'} · ${a.anchor ? `#${a.anchor}` : '全文批注'}`, 'st-muted-xs'),
      (() => {
        const g = el('div', null, 'st-graph-controls');
        const tBtn = el('button', a.resolved ? '重新打开' : '标为已解决', 'st-btn');
        tBtn.type = 'button';
        tBtn.addEventListener('click', () => mutateAnnotation({ action: 'toggle', id: a.id }));
        const dBtn = el('button', '删除', 'st-btn');
        dBtn.type = 'button';
        dBtn.addEventListener('click', () => mutateAnnotation({ action: 'delete', id: a.id }));
        g.append(tBtn, dBtn);
        return g;
      })(),
    );
    row.append(head, el('div', a.body, ''));
    annBox.append(row);
  }

  mainCol.append(proseWrap);
  dockCol.append(quickStatusRow, annBox);
  readerLayout.append(mainCol, dockCol);
  container.append(readerLayout);

  const cacheKey = `${state.repoId}::${item.uid}::${item.path}`;
  let doc = state.docCache.get(cacheKey);
  if (!doc) {
    try {
      const q = new URLSearchParams({ repo: state.repoId || '', path: item.path || '', uid: item.uid || '' });
      doc = await apiJson(`/api/studio/doc?${q}`);
      state.docCache.set(cacheKey, doc);
    } catch (err) {
      proseWrap.replaceChildren(el('p', `读取原件失败：${err.message}`, 'st-muted-xs'));
      return;
    }
  }
  proseWrap.replaceChildren();
  const h1 = el('h1', doc.title || item.title);
  h1.style.marginTop = '0';

  const bodyDiv = el('div');
  bodyDiv.innerHTML = doc.html || '';
  if (doc.isMachineContract && state.docViewMode === 'raw') {
    bodyDiv.hidden = true;
    const rawPre = el('pre', doc.rawText || '', 'st-code-block');
    proseWrap.append(h1, bodyDiv, rawPre);
  } else {
    bodyDiv.addEventListener('click', e => {
      const jump = e.target.closest('[data-jump-target]');
      if (jump) {
        const t = jump.dataset.jumpTarget;
        const hit = (state.snap?.reviewItems || []).find(x => x.uid === t || x.target === t);
        if (hit) { state.selectedUid = hit.uid; state.selectedAnchor = null; renderActiveTab(); }
      }
      const anc = e.target.closest('[data-anchor-id]');
      if (anc) {
        annInput.value = `[#${anc.dataset.anchorId}] ${annInput.value}`;
        annInput.focus();
      }
    });
    proseWrap.append(h1, bodyDiv);
  }

  if (anchorId && !(doc.isMachineContract && state.docViewMode === 'raw')) {
    const hitHeading = bodyDiv.querySelector(`#${CSS.escape(anchorId)}`)
      || [...bodyDiv.querySelectorAll('.st-prose-heading')].find(h => String(h.id || '').endsWith(`-${anchorId}`));
    if (hitHeading) {
      hitHeading.classList.add('is-anchor-hit');
      hitHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

function triggerGuideAction(actionId) {
  if (actionId === 'open-repo-switcher') {
    const pop = document.getElementById('st-repo-popover');
    const trig = document.getElementById('st-repo-trigger');
    pop.hidden = false;
    trig?.setAttribute('aria-expanded', 'true');
    renderRepoPopover();
  } else if (actionId === 'go-tab-graph') switchTab('graph');
  else if (actionId === 'go-tab-alignment') { state.reviewMode = 'alignment'; switchTab('review'); }
  else if (actionId === 'start-guided-review') startGuidedReview();
  else if (actionId === 'go-tab-review') { state.reviewMode = 'reader'; switchTab('review'); }
  else if (actionId === 'open-export-drawer') openExportDrawer();
  else if (actionId === 'go-tab-runtime') { state.rtView = 'tasks'; switchTab('runtime'); }
  else if (actionId === 'go-tab-fleet') { state.rtView = 'fleet'; switchTab('runtime'); }
  else if (actionId === 'go-tab-diag') { state.rtView = 'diag'; switchTab('runtime'); }
}

function renderGuidePanel() {
  const host = document.getElementById('st-panel-guide');
  host.replaceChildren();
  const g = state.guide;
  if (!g) return;

  const banner = el('div', null, 'st-guided-banner');
  const bLeft = el('div');
  bLeft.append(el('h1', g.title, ''), el('p', g.subtitle, 'st-muted-xs'));
  bLeft.firstChild.style.margin = '0 0 4px 0';
  bLeft.lastChild.style.margin = '0';
  const bRight = el('div', null, 'st-graph-controls');
  const alignQuickBtn = el('button', '📋 查看需求进展与双向对齐总览', 'st-btn');
  alignQuickBtn.type = 'button';
  alignQuickBtn.addEventListener('click', () => triggerGuideAction('go-tab-alignment'));
  const startBtn = el('button', '▶ 开始按推荐顺序审阅（用户故事 → 需求总纲 → 场景剧本）', 'st-btn st-btn-primary');
  startBtn.type = 'button';
  startBtn.addEventListener('click', startGuidedReview);
  bRight.append(alignQuickBtn, startBtn);
  banner.append(bLeft, bRight);
  host.append(banner);

  // 一、这款工具解决什么问题
  const whyCard = el('div', null, 'st-card st-guide-section');
  whyCard.append(el('h2', '一、这款工具解决什么问题', ''));
  for (const p of g.whyItExists || []) whyCard.append(el('p', p));
  host.append(whyCard);

  // 二、零门槛开启：直接对智能体说一句话即可 + 两种工作模式
  if (g.conversationalStart) {
    const cs = g.conversationalStart;
    const csCard = el('div', null, 'st-card st-guide-section');
    csCard.append(el('h2', '二、零门槛开启：直接对智能体说一句话即可', ''), el('p', cs.intro));
    const tbl = el('table', null, 'st-prose-table');
    const th = el('thead');
    const htr = el('tr');
    htr.append(el('th', '你的目的'), el('th', '对智能体说的一句话示例'));
    th.append(htr);
    const tb = el('tbody');
    for (const sp of cs.samplePrompts || []) {
      const tr = el('tr');
      tr.append(el('td', sp.intent), el('td', sp.say));
      tb.append(tr);
    }
    tbl.append(th, tb);
    const ul = el('ul');
    for (const s of cs.behindTheScenes || []) ul.append(el('li', s));
    csCard.append(tbl, ul);

    if (Array.isArray(g.usageModes) && g.usageModes.length > 0) {
      const modeGrid = el('div', null, 'st-mode-grid');
      modeGrid.style.marginTop = '14px';
      for (const mode of g.usageModes) {
        const card = el('div', null, 'st-card st-mode-card');
        card.append(
          el('span', mode.audience, 'st-badge st-badge-indigo'),
          el('h3', mode.title, ''),
          el('p', `何时选用：${mode.whenToUse}`, 'st-muted-xs'),
          el('p', mode.howItWorks, ''),
        );
        card.querySelector('h3').style.margin = '4px 0';
        modeGrid.append(card);
      }
      csCard.append(modeGrid);
    }
    host.append(csCard);
  }

  // 三、按你的角色与来意选一条动线（唯一编号，消除旧 1~4站 / 1~5步 冲突）
  if (Array.isArray(g.roleRoutes) && g.roleRoutes.length > 0) {
    const rSec = el('div', null, 'st-card st-guide-section');
    rSec.append(el('h2', '三、按你的角色与来意选一条动线（免自由抽样）', ''));
    for (const route of g.roleRoutes) {
      const rBox = el('div', null, 'st-reading-step');
      rBox.style.marginBottom = '12px';
      rBox.append(el('h3', route.roleTitle, ''), el('p', route.when, 'st-muted-xs'));
      rBox.querySelector('h3').style.margin = '0 0 4px 0';
      const stepGrid = el('div', null, 'st-guide-grid');
      stepGrid.style.margin = '10px 0 4px';
      for (const s of route.steps || []) {
        const card = el('div', null, 'st-card st-guide-step');
        const top = el('div');
        top.append(
          el('span', `步骤 ${s.step}`, 'st-badge st-badge-indigo'),
          el('h4', s.title, ''),
          el('p', s.detail, 'st-muted-xs'),
        );
        top.querySelector('h4').style.margin = '6px 0 4px 0';
        const act = el('button', s.actionLabel, 'st-btn st-btn-primary');
        act.type = 'button';
        act.addEventListener('click', () => triggerGuideAction(s.actionId));
        card.append(top, act);
        stepGrid.append(card);
      }
      rBox.append(stepGrid);
      rSec.append(rBox);
    }
    host.append(rSec);
  }

  // 四、逐页界面全拆解（零基础新读者一眼看懂）
  if (Array.isArray(g.perPageAnatomy) && g.perPageAnatomy.length > 0) {
    const pCard = el('div', null, 'st-card st-guide-section');
    pCard.append(el('h2', '四、逐页界面全拆解（每个区域是什么、什么时候看、怎么用）', ''));
    const pGrid = el('div', null, 'st-mode-grid');
    for (const page of g.perPageAnatomy) {
      const box = el('div', null, 'st-reading-step');
      box.append(el('h3', page.page, ''), el('p', `何时看这里：${page.when}`, 'st-muted-xs'));
      box.firstChild.style.margin = '0 0 4px 0';
      const ul = el('ul');
      for (const a of page.areas || []) ul.append(el('li', a));
      box.append(ul);
      pGrid.append(box);
    }
    pCard.append(pGrid);
    host.append(pCard);
  }

  // 五、状态流转图与三层双向互锁原理图（双主题 SVG 流程图 + 规则速查表）
  const diagCard = el('div', null, 'st-card st-guide-section');
  diagCard.append(el('h2', '五、状态流转图与三层双向互锁原理图', ''));
  diagCard.append(el('h3', '1. 审阅四态自动与手动迁移图', ''));
  const svgWrap1 = el('div', null, 'st-guide-svg-wrap');
  svgWrap1.append(buildReviewStatusFlowSvg(document));
  diagCard.append(svgWrap1);

  const tbl = el('table', null, 'st-prose-table');
  const thead = el('thead');
  const headTr = el('tr');
  for (const h of ['状态标识', '触发与自动感知条件', '业务含义']) headTr.append(el('th', h));
  thead.append(headTr);
  const tbody = el('tbody');
  for (const r of g.statusRules || []) {
    const tr = el('tr');
    const td1 = el('td');
    td1.append(el('strong', r.badge), document.createTextNode(' ('), el('code', r.code), document.createTextNode(')'));
    tr.append(td1, el('td', r.trigger), el('td', r.meaning));
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  diagCard.append(tbl);

  if (g.alignmentGuide) {
    diagCard.append(el('h3', '2. 高阶 ⇄ 详设 ⇄ 代码测试三层双向互锁闭环图', ''));
    const svgWrap2 = el('div', null, 'st-guide-svg-wrap');
    svgWrap2.append(buildTriLayerLockSvg(document));
    diagCard.append(svgWrap2);

    const satTbl = el('table', null, 'st-prose-table');
    const satHead = el('thead');
    const satHr = el('tr');
    satHr.append(el('th', '满足概况（机器派生）'), el('th', '严格判定条件与业务含义'));
    satHead.append(satHr);
    const satBody = el('tbody');
    for (const st of g.alignmentGuide.satisfactionStates || []) {
      const tr = el('tr');
      const td1 = el('td');
      td1.append(el('strong', st.badge), document.createTextNode(' ('), el('code', st.code), document.createTextNode(')'));
      tr.append(td1, el('td', st.meaning));
      satBody.append(tr);
    }
    satTbl.append(satHead, satBody);

    const driftTbl = el('table', null, 'st-prose-table');
    driftTbl.style.marginTop = '12px';
    const dHead = el('thead');
    const dHr = el('tr');
    dHr.append(el('th', '告警徽章与错误码'), el('th', '识别到什么问题'), el('th', '推荐处理动作'));
    dHead.append(dHr);
    const dBody = el('tbody');
    for (const dr of g.alignmentGuide.driftChecks || []) {
      const tr = el('tr');
      const td1 = el('td');
      td1.append(el('strong', dr.badge), document.createTextNode(' ('), el('code', dr.code), document.createTextNode(')'));
      tr.append(td1, el('td', dr.meaning), el('td', dr.action));
      dBody.append(tr);
    }
    driftTbl.append(dHead, dBody);
    diagCard.append(satTbl, driftTbl);
  }
  host.append(diagCard);

  // 六、高频疑问解答 FAQ & 折叠脚本附录
  if (Array.isArray(g.faq) && g.faq.length > 0) {
    const fCard = el('div', null, 'st-card st-guide-section');
    fCard.append(el('h2', '六、高频疑问解答 FAQ', ''));
    for (const f of g.faq) {
      const fBox = el('div', null, 'st-reading-step');
      fBox.style.marginBottom = '8px';
      fBox.append(el('strong', `Q：${f.q}`), el('p', `A：${f.a}`, 'st-muted-xs'));
      fBox.lastChild.style.margin = '4px 0 0';
      fCard.append(fBox);
    }
    const cliDet = el('details', null, 'st-details-box');
    cliDet.append(el('summary', '附录：脚本自动化 CLI 与 .studio-workspace.json 配置参考（日常由智能体代劳，按需展开）'));
    const cliBody = el('div', null, 'st-details-body');
    cliBody.append(el('pre', [
      '# 只读探测当前目录角色与推荐启动参数',
      'npx skill-family-studio inspect-setup --root /absolute/project/path --json',
      '',
      '# 按单仓或关联套组安全生成 .studio-workspace.json',
      'npx skill-family-studio init-workspace --root /absolute/project/path --mode related',
      '',
      '# 幂等守护启动或复用单端口控制台',
      'npx skill-family-studio ensure --root /absolute/project/path --port 57630',
      '',
      '# 离线导出设计态、双向对齐与运行态快照',
      'npx skill-family-studio snapshot --root /absolute/project/path',
    ].join('\n'), 'st-code-block'));
    cliDet.append(cliBody);
    fCard.append(cliDet);
    host.append(fCard);
  }
}

let graphResizeObserver = null;
let graphResizeRafId = 0;

function renderGraphPanel() {
  const host = document.getElementById('st-panel-graph');
  host.replaceChildren();
  if (graphResizeRafId) { cancelAnimationFrame(graphResizeRafId); graphResizeRafId = 0; }
  if (graphResizeObserver) { graphResizeObserver.disconnect(); graphResizeObserver = null; }
  if (!state.snap) { host.append(el('p', '正在加载仓库制品图谱…', 'st-muted-xs')); return; }

  const split = el('div', null, `st-graph-split${state.fullscreenGraph ? ' is-fullscreen' : ''}`);
  const leftCard = el('div', null, 'st-card');
  const toolbar = el('div', null, 'st-graph-toolbar');

  const syncArchifyDefaultDoc = fig => {
    state.archifySelectedNode = null;
    state.selectedAnchor = null;
    if (fig?.docPageId) {
      const docItem = resolveStudioItemByPageId(fig.docPageId);
      if (docItem) state.selectedUid = docItem.uid;
    }
  };

  const modeControls = el('div', null, 'st-graph-controls');
  if ((state.snap.archifyDiagrams || []).length > 0) {
    const dagBtn = el('button', `制品依赖图谱 (${state.snap.nodes.length})`, `st-btn${state.graphMode === 'dag' ? ' is-active' : ''}`);
    dagBtn.type = 'button';
    dagBtn.addEventListener('click', () => {
      state.graphMode = 'dag';
      state.archifySelectedNode = null;
      state.selectedAnchor = null;
      renderGraphPanel();
    });
    const archBtn = el('button', `Archify 业务逻辑图 (${state.snap.archifyDiagrams.length})`, `st-btn${state.graphMode === 'archify' ? ' is-active' : ''}`);
    archBtn.type = 'button';
    archBtn.addEventListener('click', () => {
      state.graphMode = 'archify';
      syncArchifyDefaultDoc(state.snap.archifyDiagrams[state.archifyIdx]);
      renderGraphPanel();
    });
    modeControls.append(dagBtn, archBtn, infoTrigger('graphVsArchify', document));
  }
  const guidedBtn = el('button', '▶ 开始按推荐顺序审阅', 'st-btn st-btn-primary');
  guidedBtn.type = 'button';
  guidedBtn.addEventListener('click', startGuidedReview);
  modeControls.append(guidedBtn);

  const rightCard = el('aside', null, 'st-card st-graph-inspector');
  const floatBar = el('div', null, 'st-archify-float-bar');
  floatBar.hidden = true;
  let fsBtnRef = null;
  let zoomBadgeBtn = null;
  let svgRef = null;
  let currentLayout = null;

  const canvasControls = el('div', null, 'st-graph-controls');
  let paintSvgCanvas = () => {};

  const locatorBar = el('div', null, 'st-graph-locator-bar');
  const locatorLeft = el('div', null, 'st-graph-controls');
  const locatorRight = el('div', null, 'st-graph-controls');
  locatorBar.append(locatorLeft, locatorRight);

  const updateLocatorBar = () => {
    locatorLeft.replaceChildren();
    locatorRight.replaceChildren();
    const curNode = (state.snap.nodes || []).find(n => n.uid === state.selectedUid) || null;
    if (!curNode) {
      locatorLeft.append(el('span', '当前位置：请点击任意图谱节点查看上下游依赖与正文（节点坐标始终保持恒定）', 'st-muted-xs'));
      return;
    }
    const edges = state.snap.edges || [];
    const upEdges = edges.filter(e => e.to === curNode.uid);
    const downEdges = edges.filter(e => e.from === curNode.uid);
    locatorLeft.append(
      el('span', '当前位置：', 'st-muted-xs'),
      el('span', curNode.layerLabel || curNode.layer, 'st-badge st-badge-indigo'),
      infoTrigger(`layer:${curNode.layer}`, document),
      el('strong', `${curNode.code} · ${curNode.title}`),
      el('span', `上游 ${upEdges.length} 项 / 下游 ${downEdges.length} 项`, 'st-muted-xs'),
    );
    const edgeKinds = [...new Set([...upEdges, ...downEdges].map(e => e.kind))].slice(0, 3);
    for (const ek of edgeKinds) {
      if (['implements', 'verifies', 'covers', 'derives-from'].includes(ek)) {
        locatorLeft.append(el('span', ek, 'st-badge st-badge-zinc'), infoTrigger(`edge:${ek}`, document));
      }
    }
    if (state.fullscreenGraph) {
      const openSide = el('button', '退出全屏展开右侧正文对照 →', 'st-btn st-btn-primary');
      openSide.type = 'button';
      openSide.addEventListener('click', () => {
        state.fullscreenGraph = false;
        split.classList.remove('is-fullscreen');
        if (fsBtnRef) { fsBtnRef.classList.remove('is-active'); fsBtnRef.textContent = '全屏画布'; }
        updateLocatorBar();
      });
      locatorRight.append(openSide);
    }
  };

  if (state.graphMode === 'dag') {
    const mkCtrl = (label, active, onClick) => {
      const b = el('button', label, `st-btn${active ? ' is-active' : ''}`);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };
    const applyZoomInPlace = () => {
      if (svgRef && currentLayout) {
        svgRef.style.width = `${Math.round(currentLayout.renderWidth * state.zoom)}px`;
        svgRef.style.height = `${Math.round(currentLayout.height * state.zoom)}px`;
      }
      if (zoomBadgeBtn) zoomBadgeBtn.textContent = `${Math.round(state.zoom * 100)}%`;
    };

    const fitBtn = mkCtrl('适应屏宽', state.fitWidth, () => {
      state.fitWidth = !state.fitWidth;
      fitBtn.classList.toggle('is-active', state.fitWidth);
      paintSvgCanvas();
    });
    const wrapBtn = mkCtrl('自动折行排布', state.wrapGrid, () => {
      state.wrapGrid = !state.wrapGrid;
      wrapBtn.classList.toggle('is-active', state.wrapGrid);
      paintSvgCanvas();
    });
    const subBtn = mkCtrl('仅看上下游关联子图', state.focusSubgraph, () => {
      state.focusSubgraph = !state.focusSubgraph;
      subBtn.classList.toggle('is-active', state.focusSubgraph);
      paintSvgCanvas();
    });
    const zoomOutBtn = mkCtrl('－', false, () => {
      state.zoom = Math.max(0.4, Number((state.zoom - 0.15).toFixed(2)));
      applyZoomInPlace();
    });
    zoomBadgeBtn = mkCtrl(`${Math.round(state.zoom * 100)}%`, false, () => {
      state.zoom = 1;
      applyZoomInPlace();
    });
    const zoomInBtn = mkCtrl('＋', false, () => {
      state.zoom = Math.min(2.4, Number((state.zoom + 0.15).toFixed(2)));
      applyZoomInPlace();
    });
    const resetBtn = mkCtrl('重置视图', false, () => {
      state.zoom = 1; state.panX = 0; state.panY = 0; state.fitWidth = true; state.wrapGrid = true; state.focusSubgraph = false;
      fitBtn.classList.add('is-active');
      wrapBtn.classList.add('is-active');
      subBtn.classList.remove('is-active');
      applyZoomInPlace();
      paintSvgCanvas();
    });
    fsBtnRef = mkCtrl(state.fullscreenGraph ? '退出全屏画布' : '全屏画布', state.fullscreenGraph, () => {
      state.fullscreenGraph = !state.fullscreenGraph;
      split.classList.toggle('is-fullscreen', state.fullscreenGraph);
      fsBtnRef.classList.toggle('is-active', state.fullscreenGraph);
      fsBtnRef.textContent = state.fullscreenGraph ? '退出全屏画布' : '全屏画布';
      updateLocatorBar();
    });
    canvasControls.append(
      fitBtn, infoTrigger('fitWidth', document),
      wrapBtn, infoTrigger('wrapGrid', document),
      subBtn, infoTrigger('subgraphOnly', document),
      zoomOutBtn, zoomBadgeBtn, zoomInBtn, resetBtn, fsBtnRef,
    );
  } else {
    const totalArch = state.snap.archifyDiagrams.length;
    const prevArch = el('button', '◀ 上一张', 'st-btn');
    prevArch.type = 'button';
    prevArch.disabled = totalArch <= 1;
    prevArch.addEventListener('click', () => {
      state.archifyIdx = (state.archifyIdx - 1 + totalArch) % totalArch;
      syncArchifyDefaultDoc(state.snap.archifyDiagrams[state.archifyIdx]);
      renderGraphPanel();
    });
    const sel = el('select', null, 'st-select');
    sel.style.width = 'auto';
    state.snap.archifyDiagrams.forEach((d, idx) => {
      const opt = el('option', `${idx + 1}. ${d.title}`);
      opt.value = String(idx);
      if (idx === state.archifyIdx) opt.selected = true;
      sel.append(opt);
    });
    sel.addEventListener('change', () => {
      state.archifyIdx = Number(sel.value) || 0;
      syncArchifyDefaultDoc(state.snap.archifyDiagrams[state.archifyIdx]);
      renderGraphPanel();
    });
    const nextArch = el('button', '下一张 ▶', 'st-btn');
    nextArch.type = 'button';
    nextArch.disabled = totalArch <= 1;
    nextArch.addEventListener('click', () => {
      state.archifyIdx = (state.archifyIdx + 1) % totalArch;
      syncArchifyDefaultDoc(state.snap.archifyDiagrams[state.archifyIdx]);
      renderGraphPanel();
    });
    fsBtnRef = el('button', state.fullscreenGraph ? '退出全屏展开' : '全屏展开', `st-btn${state.fullscreenGraph ? ' is-active' : ''}`);
    fsBtnRef.type = 'button';
    fsBtnRef.addEventListener('click', () => {
      state.fullscreenGraph = !state.fullscreenGraph;
      split.classList.toggle('is-fullscreen', state.fullscreenGraph);
      fsBtnRef.classList.toggle('is-active', state.fullscreenGraph);
      fsBtnRef.textContent = state.fullscreenGraph ? '退出全屏展开' : '全屏展开';
      if (!state.fullscreenGraph) floatBar.hidden = true;
    });
    canvasControls.append(prevArch, sel, nextArch, fsBtnRef);
  }
  toolbar.append(modeControls, canvasControls);
  leftCard.append(toolbar);
  if (state.graphMode === 'dag') leftCard.append(locatorBar);

  if (state.graphMode === 'archify' && state.snap.archifyDiagrams[state.archifyIdx]) {
    const fig = state.snap.archifyDiagrams[state.archifyIdx];
    const curTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const stage = el('div', null, 'st-archify-stage');
    const iframe = el('iframe', null, 'st-archify-frame');
    iframe.title = fig.title;
    iframe.src = `/api/studio/archify/${encodeURIComponent(state.repoId)}/${fig.htmlPath}?theme=${encodeURIComponent(curTheme)}&present=1`;

    const bindArchifyNodeSelection = (nodeId, nodeLabel) => {
      if (!nodeId) return;
      const allBindings = Array.isArray(fig.bindings) ? fig.bindings : [];
      const matched = allBindings.filter(b => b.nodeId === nodeId);
      const primary = matched.find(b => b.pageId === fig.docPageId) || matched[0] || (fig.docPageId ? { pageId: fig.docPageId, anchor: null } : null);
      const targetItem = resolveStudioItemByPageId(primary?.pageId || fig.docPageId);
      if (!targetItem) return;
      state.archifySelectedNode = { nodeId, label: nodeLabel || nodeId, bindings: matched };
      state.selectedUid = targetItem.uid;
      state.selectedAnchor = primary?.anchor || null;
      mountDocumentReader(rightCard, targetItem, {
        anchorId: state.selectedAnchor,
        archifyContext: state.archifySelectedNode,
      });
      if (state.fullscreenGraph) {
        floatBar.replaceChildren();
        floatBar.append(
          el('span', `已选中图节点「${nodeLabel || nodeId}」，定位至：${targetItem.code || targetItem.title}${primary?.anchor ? ` #${primary.anchor}` : ''}（共 ${matched.length} 处关联）`),
          (() => {
            const openBtn = el('button', '展开右侧说明对照 →', 'st-btn st-btn-primary');
            openBtn.type = 'button';
            openBtn.style.height = '26px';
            openBtn.addEventListener('click', () => {
              state.fullscreenGraph = false;
              split.classList.remove('is-fullscreen');
              if (fsBtnRef) { fsBtnRef.classList.remove('is-active'); fsBtnRef.textContent = '全屏展开'; }
              floatBar.hidden = true;
            });
            return openBtn;
          })(),
        );
        floatBar.hidden = false;
      }
    };

    iframe.addEventListener('load', () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.addEventListener('click', ev => {
          const nodeEl = ev.target?.closest?.('[data-node-id]');
          const outlineEl = ev.target?.closest?.('[data-outline-node]');
          const nodeId = nodeEl?.getAttribute('data-node-id') || outlineEl?.getAttribute('data-outline-node');
          if (!nodeId) return;
          const label = nodeEl?.getAttribute('data-node-label') || outlineEl?.textContent?.trim() || nodeId;
          bindArchifyNodeSelection(nodeId, label);
        }, true);
      } catch {}
    });

    stage.append(floatBar, iframe);
    leftCard.append(stage);
  } else {
    const viewport = el('div', null, 'st-graph-viewport');
    viewport.id = 'st-graph-viewport';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'st-graph-svg');
    svgRef = svg;
    viewport.append(svg);
    leftCard.append(viewport);

    const updateSelectionInPlace = () => {
      svg.querySelectorAll('.st-node-group').forEach(g => {
        g.classList.toggle('is-selected', g.dataset.uid === state.selectedUid);
      });
      svg.querySelectorAll('.st-edge-path').forEach(p => {
        const hi = Boolean(state.selectedUid && (p.dataset.from === state.selectedUid || p.dataset.to === state.selectedUid));
        p.classList.toggle('is-hi', hi);
      });
      updateLocatorBar();
      const nextItem = (state.snap.reviewItems || []).find(i => i.uid === state.selectedUid)
        || (state.snap.nodes || []).find(n => n.uid === state.selectedUid) || null;
      mountDocumentReader(rightCard, nextItem);
    };

    paintSvgCanvas = () => {
      const prevTop = viewport.scrollTop;
      const prevLeft = viewport.scrollLeft;
      const cw = Math.max(640, viewport.clientWidth || window.innerWidth - (state.fullscreenGraph ? 60 : 540));
      const layout = computeAdaptiveGraphLayout(state.snap, {
        containerWidth: cw,
        fitWidth: state.fitWidth,
        wrapGrid: state.wrapGrid,
        focusMode: state.focusSubgraph ? 'subgraph' : 'all',
        selectedUid: state.selectedUid,
      });
      currentLayout = layout;
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
      svg.style.width = `${Math.round(layout.renderWidth * state.zoom)}px`;
      svg.style.height = `${Math.round(layout.height * state.zoom)}px`;
      svg.style.transform = `translate(${state.panX}px, ${state.panY}px)`;

      const svgEl = (tag, attrs) => {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
        return n;
      };
      for (const b of layout.bands) {
        svg.append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, class: 'st-lane-rect' }));
        const lt = svgEl('text', { x: b.x + 14, y: b.y + 23, class: 'st-lane-title' });
        lt.textContent = `${b.label}（${b.total} 项${b.rows > 1 ? ` · 自动折为 ${b.rows} 行` : ''}）`;
        svg.append(lt);
      }
      for (const e of layout.edges) {
        const hi = state.selectedUid && (e.from === state.selectedUid || e.to === state.selectedUid);
        const pEl = svgEl('path', { d: e.path, class: `st-edge-path${hi ? ' is-hi' : ''}` });
        pEl.dataset.from = e.from;
        pEl.dataset.to = e.to;
        svg.append(pEl);
      }
      for (const nd of layout.nodes) {
        const eff = getEffectiveStatus(nd.target || nd.uid);
        const sm = STATUS_META[eff] || STATUS_META.pending;
        const g = svgEl('g', { class: `st-node-group${nd.uid === state.selectedUid ? ' is-selected' : ''}` });
        g.dataset.uid = nd.uid;
        g.append(svgEl('rect', { x: nd.x, y: nd.y, width: nd.w, height: nd.h, rx: 8, class: 'st-node-rect' }));
        const cTxt = svgEl('text', { x: nd.x + 10, y: nd.y + 21, class: 'st-node-code' });
        const rawCodeLine = `${nd.code} · ${nd.typeLabel}`;
        const maxCodeChars = Math.max(8, Math.floor((nd.w - 92) / 7.5));
        cTxt.textContent = rawCodeLine.length > maxCodeChars ? `${rawCodeLine.slice(0, maxCodeChars - 1)}…` : rawCodeLine;
        const sTxt = svgEl('text', { x: nd.x + nd.w - 10, y: nd.y + 21, 'text-anchor': 'end', fill: sm.color, class: 'st-node-status' });
        sTxt.textContent = `${sm.dot} ${sm.label}`;
        const tTxt = svgEl('text', { x: nd.x + 10, y: nd.y + 44, class: 'st-node-title' });
        const maxChars = Math.max(12, Math.floor((nd.w - 20) / 13));
        tTxt.textContent = nd.title.length > maxChars ? `${nd.title.slice(0, maxChars - 1)}…` : nd.title;
        g.append(cTxt, sTxt, tTxt);
        g.addEventListener('click', ev => {
          ev.stopPropagation();
          state.selectedUid = nd.uid;
          if (state.focusSubgraph) {
            paintSvgCanvas();
            updateSelectionInPlace();
          } else {
            // 原地高亮连线与更新阅读器，全图坐标与滚动条 100% 恒定不动且不强退全屏
            updateSelectionInPlace();
          }
        });
        svg.append(g);
      }
      viewport.scrollTop = prevTop;
      viewport.scrollLeft = prevLeft;
    };

    viewport.addEventListener('wheel', ev => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        state.zoom = Math.min(2.4, Math.max(0.4, Number((state.zoom + (ev.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
        if (svgRef && currentLayout) {
          svgRef.style.width = `${Math.round(currentLayout.renderWidth * state.zoom)}px`;
          svgRef.style.height = `${Math.round(currentLayout.height * state.zoom)}px`;
        }
        if (zoomBadgeBtn) zoomBadgeBtn.textContent = `${Math.round(state.zoom * 100)}%`;
      }
    }, { passive: false });

    let dragging = false, sx = 0, sy = 0;
    viewport.addEventListener('mousedown', ev => {
      if (ev.target.closest('.st-node-group')) return;
      dragging = true; sx = ev.clientX - state.panX; sy = ev.clientY - state.panY;
      viewport.classList.add('is-panning');
    });
    window.addEventListener('mousemove', ev => {
      if (!dragging) return;
      state.panX = ev.clientX - sx; state.panY = ev.clientY - sy;
      svg.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
    });
    window.addEventListener('mouseup', () => { dragging = false; viewport.classList.remove('is-panning'); });

    graphResizeObserver = new ResizeObserver(() => {
      if (graphResizeRafId) cancelAnimationFrame(graphResizeRafId);
      graphResizeRafId = requestAnimationFrame(() => {
        graphResizeRafId = 0;
        paintSvgCanvas();
      });
    });
    graphResizeObserver.observe(viewport);
    graphResizeRafId = requestAnimationFrame(() => {
      graphResizeRafId = 0;
      paintSvgCanvas();
    });
    updateLocatorBar();
  }

  const activeItem = (state.snap.reviewItems || []).find(i => i.uid === state.selectedUid)
    || (state.snap.nodes || []).find(n => n.uid === state.selectedUid) || null;
  mountDocumentReader(rightCard, activeItem);

  split.append(leftCard, rightCard);
  host.append(split);
}

function renderAlignmentOverview(host) {
  const wrap = el('div', null, 'st-alignment-panel');
  const al = state.alignment;
  if (!al) {
    wrap.append(el('div', '正在计算三层双向一致性与代码互锁体检…', 'st-card st-guide-section st-muted-xs'));
    host.append(wrap);
    return;
  }

  if (al.portfolio?.present) {
    const pf = al.portfolio;
    const sum = pf.summary || {};
    const card = el('div', null, 'st-card st-guide-section');
    const headRow = el('div', null, 'st-graph-toolbar');
    headRow.style.padding = '0 0 12px 0';
    const leftTitle = el('div');
    leftTitle.append(
      el('h2', pf.title || '高阶需求进展与双向对齐三列一览表', ''),
      el('p', '满足概况完全由下游存在性、摘要互锁与代码/测试双锁机器派生，悬停任意徽章旁的 ⓘ 可查看判定条件；点击下游胶囊直接跨仓跳入子项目详设。', 'st-muted-xs'),
    );
    leftTitle.firstChild.style.margin = '0 0 4px 0';
    leftTitle.lastChild.style.margin = '0';

    const filterGroup = el('div', null, 'st-graph-controls');
    const alertTotal = (sum.driftCount ?? 0) + (sum.missingCount ?? 0) + (sum.unallocated ?? 0);
    for (const [fKey, fLabel] of [
      ['all', `全部 (${sum.total ?? 0})`],
      ['alerts', `🔴 双向告警 (${alertTotal})`],
      ['in_progress', `⏳ 推进/部分 (${(sum.allocatedInProgress ?? 0) + (sum.partiallyAllocated ?? 0)})`],
      ['verified', `🟢 已验证满足 (${sum.verifiedSatisfied ?? 0})`],
      ['not_applicable', `⚪ 按处置不计 (${sum.notApplicable ?? 0})`],
    ]) {
      const b = el('button', fLabel, `st-btn${state.alignFilter === fKey ? ' is-active' : ''}`);
      b.type = 'button';
      b.addEventListener('click', () => { state.alignFilter = fKey; renderReviewPanel(); });
      filterGroup.append(b);
    }
    const qInp = el('input', null, 'st-input');
    qInp.type = 'search';
    qInp.style.width = '220px';
    qInp.placeholder = '按需求编号/目标仓搜索…';
    qInp.value = state.alignQuery;
    headRow.append(leftTitle, filterGroup);

    const searchBar = el('div', null, 'st-graph-controls');
    searchBar.style.margin = '10px 0';
    searchBar.append(qInp);

    const tblWrap = el('div', null, 'st-table-wrap');
    const tbl = el('table', null, 'st-prose-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['高阶需求条目', '业务处置与承接去向', '满足概况（机器派生）', '阶段与双向健康度']) hr.append(el('th', h));
    thead.append(hr);
    const tbody = el('tbody');

    const paintRows = () => {
      tbody.replaceChildren();
      const q = state.alignQuery.trim().toLowerCase();
      const rows = (pf.items || []).filter(item => {
        if (state.alignFilter === 'alerts' && !(item.issues || []).some(i => ['UNALLOCATED_ACTIVE_DEMAND', 'SOURCE_ARTIFACT_MISSING', 'TARGET_MISSING', 'UNRECIPROCATED_ALLOCATION', 'UPSTREAM_DESIGN_CHANGED', 'DOWNSTREAM_DESIGN_EVOLVED'].includes(i.code))) return false;
        if (state.alignFilter === 'in_progress' && !['allocated_in_progress', 'partially_allocated'].includes(item.computedSatisfaction)) return false;
        if (state.alignFilter === 'verified' && item.computedSatisfaction !== 'verified_satisfied') return false;
        if (state.alignFilter === 'not_applicable' && item.computedSatisfaction !== 'not_applicable') return false;
        if (q) {
          const hay = `${item.sourceUid} ${item.title} ${item.dispositionNote} ${(item.allocations || []).map(a => `${a.targetRepoName} ${a.targetUid}`).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      if (!rows.length) {
        const emptyTr = el('tr');
        const td = el('td', '当前筛选条件下无匹配的高阶需求记录。', 'st-muted-xs');
        td.colSpan = 4;
        emptyTr.append(td);
        tbody.append(emptyTr);
        return;
      }
      for (const item of rows) {
        const tr = el('tr');
        const tdSrc = el('td');
        const srcBtn = el('button', item.sourceUid, 'st-inline-jump');
        srcBtn.type = 'button';
        srcBtn.addEventListener('click', () => jumpToRepoAndItem(state.repoId, item.sourceUid, 'review', 'reader'));
        tdSrc.append(srcBtn, el('div', item.title, ''));

        const tdDisp = el('td');
        const allocWrap = el('div', null, 'st-alignment-alloc-list');
        const dispHead = el('div', null, 'st-graph-controls');
        dispHead.append(el('span', item.dispositionLabel, 'st-badge st-badge-zinc'), infoTrigger(`disp:${item.disposition || 'allocated'}`, document));
        if (item.mergedInto) dispHead.append(el('span', `→ ${item.mergedInto}`, 'st-muted-xs'));
        allocWrap.append(dispHead);
        if (item.dispositionNote) allocWrap.append(el('div', item.dispositionNote, 'st-muted-xs'));
        for (const alRowItem of item.allocations || []) {
          const aRow = el('div', null, 'st-alignment-alloc-row');
          if (alRowItem.targetRepoId) {
            const jumpBtn = el('button', `↗ ${alRowItem.targetRepoName} · ${alRowItem.targetUid}`, 'st-jump-pill');
            jumpBtn.type = 'button';
            jumpBtn.addEventListener('click', () => jumpToRepoAndItem(alRowItem.targetRepoId, alRowItem.targetUid, 'review', 'reader'));
            aRow.append(jumpBtn);
          } else {
            aRow.append(el('span', `${alRowItem.targetRepoName} · ${alRowItem.targetUid}`, 'st-badge st-badge-zinc'));
          }
          aRow.append(el('span', alRowItem.codeLocksFresh ? '双锁新鲜' : '待补代码/测试锁', `st-badge ${alRowItem.codeLocksFresh ? 'st-badge-emerald' : 'st-badge-amber'}`));
          allocWrap.append(aRow);
        }
        tdDisp.append(allocWrap);

        const tdSat = el('td');
        const satMeta = item.satisfactionMeta || {};
        const satRow = el('div', null, 'st-graph-controls');
        satRow.append(
          el('span', satMeta.label || item.computedSatisfaction, `st-badge st-badge-${satMeta.tone || 'zinc'}`),
          infoTrigger(`sat:${item.computedSatisfaction}`, document),
        );
        tdSat.append(satRow);
        if (Array.isArray(item.remainingScope) && item.remainingScope.length > 0) {
          const ul = el('ul');
          ul.style.margin = '6px 0 0 16px';
          ul.style.padding = '0';
          for (const rem of item.remainingScope) ul.append(el('li', `剩余范围：${rem}`, 'st-muted-xs'));
          tdSat.append(ul);
        }

        const tdHealth = el('td');
        const h = item.health || {};
        tdHealth.append(el('span', h.label || '未知', `st-badge st-badge-${h.tone || 'zinc'}`));
        for (const iss of item.issues || []) {
          const issLine = el('div', null, 'st-graph-controls');
          issLine.style.marginTop = '4px';
          issLine.append(el('span', `${iss.code}：${iss.message}`, 'st-muted-xs'));
          if (['UNALLOCATED_ACTIVE_DEMAND', 'UPSTREAM_DESIGN_CHANGED', 'DOWNSTREAM_DESIGN_EVOLVED', 'UNRECIPROCATED_ALLOCATION', 'TARGET_MISSING'].includes(iss.code)) {
            issLine.append(infoTrigger(`err:${iss.code}`, document));
          }
          tdHealth.append(issLine);
        }

        tr.append(tdSrc, tdDisp, tdSat, tdHealth);
        tbody.append(tr);
      }
    };
    qInp.addEventListener('input', () => { state.alignQuery = qInp.value; paintRows(); });
    paintRows();
    tbl.append(thead, tbody);
    tblWrap.append(tbl);
    card.append(headRow, searchBar, tblWrap);
    wrap.append(card);
  }

  if (al.upstreamBindings?.present) {
    const up = al.upstreamBindings;
    const upCard = el('div', null, 'st-card st-guide-section');
    upCard.append(
      el('h2', `上游高阶规划绑定（来自 ${up.upstreamRepoName}）`, ''),
      el('p', '核对本仓详细设计与上游高阶规划仓的摘要一致性；点击条目可直接阅读本仓原文或跨仓跳回高阶需求。', 'st-muted-xs'),
    );
    const tbl = el('table', null, 'st-prose-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['本地详设条目', '上游高阶规划来源', '双向互锁健康度']) hr.append(el('th', h));
    thead.append(hr);
    const tbody = el('tbody');
    for (const b of up.bindings || []) {
      const tr = el('tr');
      const tdLocal = el('td');
      const localBtn = el('button', b.localUid, 'st-inline-jump');
      localBtn.type = 'button';
      localBtn.addEventListener('click', () => jumpToRepoAndItem(state.repoId, b.localUid, 'review', 'reader'));
      tdLocal.append(localBtn, el('div', b.localPath, 'st-muted-xs'));

      const tdUp = el('td');
      if (b.upstreamRepoId || up.upstreamRepoId) {
        const upBtn = el('button', `↖ ${up.upstreamRepoName} · ${b.upstreamUid}`, 'st-jump-pill');
        upBtn.type = 'button';
        upBtn.addEventListener('click', () => jumpToRepoAndItem(b.upstreamRepoId || up.upstreamRepoId, b.upstreamUid, 'review', 'reader'));
        tdUp.append(upBtn);
      } else {
        tdUp.append(el('code', b.upstreamUid));
      }
      tdUp.append(el('div', b.upstreamTitle, 'st-muted-xs'));

      const tdHealth = el('td');
      tdHealth.append(el('span', b.health?.label || '已绑定', `st-badge st-badge-${b.health?.tone || 'zinc'}`));
      for (const iss of b.issues || []) {
        const row = el('div', null, 'st-graph-controls');
        row.append(el('span', `${iss.code}：${iss.message}`, 'st-muted-xs'), infoTrigger(`err:${iss.code}`, document));
        tdHealth.append(row);
      }
      tr.append(tdLocal, tdUp, tdHealth);
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    upCard.append(tbl);
    wrap.append(upCard);
  }

  const ic = al.internalCodeLocks || {};
  const codeCard = el('div', null, 'st-card st-guide-section');
  codeCard.append(el('h2', '单仓内部「详设 ↔ 代码与测试」双向互锁体检', ''));
  const kpiRow = el('div', null, 'st-kpi-grid');
  const mkBox = (lbl, val, tone, tipKey) => {
    const c = el('div', null, 'st-card st-kpi-card');
    const top = el('div', null, 'st-graph-controls');
    top.append(el('span', lbl, 'st-muted-xs'), infoTrigger(tipKey, document));
    c.append(top, el('div', val, 'st-kpi-val'), el('span', tone === 'emerald' ? '覆盖正常' : '需关注', `st-badge st-badge-${tone}`));
    kpiRow.append(c);
  };
  mkBox('代码实现锁 (implements)', `${ic.implementsCount ?? 0} 条`, (ic.implementsCount ?? 0) > 0 ? 'emerald' : (ic.requireCodeLocks ? 'rose' : 'zinc'), 'lockCard:implements');
  mkBox('测试验证锁 (verifies)', `${ic.verifiesCount ?? 0} 条`, (ic.verifiesCount ?? 0) > 0 ? 'emerald' : 'zinc', 'lockCard:verifies');
  mkBox('声明式代码/技能入口', `${ic.matchedEntriesCount ?? 0} 个`, (ic.unclaimedEntries?.length ?? 0) === 0 ? 'emerald' : 'amber', 'lockCard:entries');
  mkBox('未认领入口与锁漂移', `${(ic.unclaimedEntries?.length ?? 0) + (ic.drifts?.length ?? 0)} 项`, ic.healthy ? 'emerald' : 'rose', 'lockCard:unclaimed');
  codeCard.append(kpiRow);

  if ((ic.unclaimedEntries || []).length > 0) {
    const warnLine = el('div', null, 'st-graph-controls');
    warnLine.append(
      el('span', '⚠️ 以下入口文件尚未在 traceability-version-lock.json 中被任何 @feature / @scenario 认领 (UNCLAIMED_IMPLEMENTATION_ENTRY)：', 'st-muted-xs'),
      infoTrigger('err:UNCLAIMED_IMPLEMENTATION_ENTRY', document),
    );
    const ul = el('ul');
    for (const p of ic.unclaimedEntries) ul.append(el('li', p, 'st-inline-code'));
    codeCard.append(warnLine, ul);
  }
  if ((ic.drifts || []).length > 0) {
    codeCard.append(el('div', '⚠️ 以下代码/测试锁存在摘要漂移（修改后尚未刷新 version-lock）：', 'st-muted-xs'));
    const ul = el('ul');
    for (const d of ic.drifts) ul.append(el('li', `${d.code} · ${d.path}`, ''));
    codeCard.append(ul);
  }
  if (ic.healthy) {
    codeCard.append(el('p', '🟢 本仓核心源码、SKILL.md 入口与测试文件均已完成双向版本锁绑定且哈希新鲜。', 'st-muted-xs'));
  }
  wrap.append(codeCard);
  host.append(wrap);
}

function renderReviewPanel() {
  const host = document.getElementById('st-panel-review');
  const prevSidebar = host.querySelector('.st-review-sidebar');
  const prevSidebarTop = prevSidebar ? prevSidebar.scrollTop : 0;
  host.replaceChildren();
  if (!state.snap) { host.append(el('p', '正在加载审阅清单…', 'st-muted-xs')); return; }

  const totalAlerts = state.alignment?.totalAlerts ?? 0;
  const banner = el('div', null, 'st-guided-banner');
  const leftControls = el('div', null, 'st-graph-controls');
  const viewSwitch = el('div', null, 'st-view-switch');
  const alignTabBtn = el('button', `📋 需求进展与双向对齐总览${totalAlerts > 0 ? ` (${totalAlerts} 告警)` : ''}`, `st-btn${state.reviewMode === 'alignment' ? ' is-active' : ''}`);
  alignTabBtn.type = 'button';
  alignTabBtn.addEventListener('click', () => { state.reviewMode = 'alignment'; renderReviewPanel(); });
  const readerTabBtn = el('button', '📖 按阅读任务逐篇审阅', `st-btn${state.reviewMode === 'reader' ? ' is-active' : ''}`);
  readerTabBtn.type = 'button';
  readerTabBtn.addEventListener('click', () => { state.reviewMode = 'reader'; renderReviewPanel(); });
  viewSwitch.append(alignTabBtn, readerTabBtn);
  leftControls.append(viewSwitch, el('span', '推荐动线：用户故事 → 需求进展总览 → 场景剧本 → 领域与架构依据', 'st-muted-xs'));

  const nextBtn = el('button', '▶ 跳至下一项待审条目 →', 'st-btn st-btn-primary');
  nextBtn.type = 'button';
  nextBtn.addEventListener('click', () => {
    const nxt = findNextUnreviewed(state.selectedUid);
    if (nxt) { state.selectedUid = nxt.uid; state.reviewMode = 'reader'; renderReviewPanel(); }
  });
  banner.append(leftControls, nextBtn);
  host.append(banner);

  if (state.reviewMode === 'alignment') {
    renderAlignmentOverview(host);
    return;
  }

  const split = el('div', null, 'st-review-split');
  const sidebar = el('aside', null, 'st-card st-review-sidebar');
  const readerCard = el('div', null, 'st-card');

  const searchInp = el('input', null, 'st-input');
  searchInp.type = 'search';
  searchInp.placeholder = '按编号或标题搜索审阅项…';
  searchInp.value = state.reviewQuery;
  searchInp.addEventListener('input', () => {
    state.reviewQuery = searchInp.value;
    paintList();
  });
  sidebar.append(searchInp);

  const catRow = el('div', null, 'st-cat-pills');
  const cats = state.snap.categories || [];
  const allCat = cats.find(c => c.id === 'all');
  if (allCat) {
    const bAll = el('button', `${allCat.label} (${allCat.count})`, `st-btn${state.reviewCategory === 'all' ? ' is-active' : ''}`);
    bAll.type = 'button';
    bAll.addEventListener('click', () => { state.reviewCategory = 'all'; renderReviewPanel(); });
    catRow.append(bAll);
  }
  const addCatGroup = (grpId, titleTxt, tipKey) => {
    const grpCats = cats.filter(c => c.group === grpId);
    if (!grpCats.length) return;
    const hdr = el('div', null, 'st-cat-group-label');
    hdr.append(el('span', titleTxt), infoTrigger(tipKey, document));
    catRow.append(hdr);
    for (const c of grpCats) {
      const b = el('button', `${c.label} (${c.count})`, `st-btn${state.reviewCategory === c.id ? ' is-active' : ''}`);
      b.type = 'button';
      b.addEventListener('click', () => { state.reviewCategory = c.id; renderReviewPanel(); });
      catRow.append(b);
    }
  };
  addCatGroup('primary', '首要阅读（从诉求到进展与行为）', 'catGroup:primary');
  addCatGroup('supporting', '关联依据（领域、架构与测试追溯）', 'catGroup:supporting');
  addCatGroup('contracts', '结构化数据契约 (.json · 供脚本校验)', 'catGroup:contracts');
  sidebar.append(catRow);

  const statusSel = el('select', null, 'st-select');
  for (const [val, txt] of [
    ['all', '状态过滤：全部'],
    ['pending', '⚪ 待审阅'],
    ['reviewing', '🔵 审阅中（含未解决批注）'],
    ['changes_requested', '🟠 需修改'],
    ['approved', '🟢 已通过'],
    ['deferred', '🟣 暂缓'],
  ]) {
    const o = el('option', txt);
    o.value = val;
    if (state.reviewStatusFilter === val) o.selected = true;
    statusSel.append(o);
  }
  statusSel.addEventListener('change', () => { state.reviewStatusFilter = statusSel.value; paintList(); });
  sidebar.append(statusSel);

  const listWrap = el('div');
  listWrap.style.display = 'flex';
  listWrap.style.flexDirection = 'column';
  listWrap.style.gap = '6px';
  sidebar.append(listWrap);

  const paintList = () => {
    listWrap.replaceChildren();
    const q = state.reviewQuery.trim().toLowerCase();
    const items = (state.snap.reviewItems || []).filter(item => {
      if (state.reviewCategory !== 'all' && item.category !== state.reviewCategory) return false;
      const eff = getEffectiveStatus(item.target || item.uid);
      if (state.reviewStatusFilter !== 'all' && eff !== state.reviewStatusFilter) return false;
      if (q && !`${item.code} ${item.title} ${item.typeLabel}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!items.length) {
      listWrap.append(el('p', '当前筛选条件下暂无匹配项。', 'st-muted-xs'));
      return;
    }
    for (const item of items) {
      const eff = getEffectiveStatus(item.target || item.uid);
      const sm = STATUS_META[eff] || STATUS_META.pending;
      const b = el('button', null, `st-review-item-btn${item.uid === state.selectedUid ? ' is-active' : ''}`);
      b.type = 'button';
      b.dataset.uid = item.uid;
      const r1 = el('div', null, 'st-repo-opt-head');
      r1.append(
        el('span', `${item.code} · ${item.typeLabel}${item.isMachineContract ? ' · .json' : ''}`, 'st-muted-xs'),
        el('span', `${sm.dot} ${sm.label}`, sm.badge),
      );
      b.append(r1, el('div', item.title));
      b.addEventListener('click', () => {
        // 原地切换选中高亮并加载右侧正文，绝不销毁重建侧边栏导致滚动跳变
        state.selectedUid = item.uid;
        state.selectedAnchor = null;
        listWrap.querySelectorAll('.st-review-item-btn').forEach(btn => {
          btn.classList.toggle('is-active', btn.dataset.uid === item.uid);
        });
        mountDocumentReader(readerCard, item);
      });
      listWrap.append(b);
    }
  };
  paintList();

  const activeItem = (state.snap.reviewItems || []).find(i => i.uid === state.selectedUid)
    || (state.snap.reviewItems || [])[0] || null;
  mountDocumentReader(readerCard, activeItem);

  split.append(sidebar, readerCard);
  host.append(split);
  if (prevSidebarTop > 0) requestAnimationFrame(() => { sidebar.scrollTop = prevSidebarTop; });
}

export function buildRuntimeTargetsTable(targetsToShow = [], doc = document) {
  const mk = (tag, text, cls) => {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const tbl = mk('table', null, 'st-prose-table');
  const thead = mk('thead');
  const htr = mk('tr');
  for (const h of ['监控目标', '计划进度', '活跃令牌锁', '事件哈希链', '受管子进程']) htr.append(mk('th', h));
  thead.append(htr);
  const tbody = mk('tbody');
  for (const t of targetsToShow) {
    const tr = mk('tr');
    const tdTitle = mk('td');
    tdTitle.append(mk('strong', t.title ?? ''), mk('br'), mk('span', t.badge || '', 'st-muted-xs'));
    const tdProg = mk('td', `${t.taskSummary?.done ?? 0}/${t.taskSummary?.total ?? 0} (${t.taskSummary?.percent ?? 0}%)`);
    const tdLock = mk('td', `${t.activeLockCount ?? 0} 把活跃${(t.locks || []).some(l => l.isStaleWarning) ? ' · ⚠️ 持锁超时' : ''}`);
    const tdChain = mk('td');
    tdChain.append(mk('code', t.chainIntegrity ?? 'NONE'), doc.createTextNode(` (${t.eventCount ?? 0} 条)`));
    const tdProc = mk('td', `${t.processCount ?? 0} 条记录`);
    tr.append(tdTitle, tdProg, tdLock, tdChain, tdProc);
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  return tbl;
}

function openRegisterRuntimeModal(onRegistered) {
  const existing = document.getElementById('st-rt-reg-modal');
  if (existing) existing.remove();

  const backdrop = el('div', null, 'st-modal-backdrop');
  backdrop.id = 'st-rt-reg-modal';
  const modal = el('div', null, 'st-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const head = el('div', null, 'st-repo-opt-head');
  head.append(el('h3', '+ 挂载 Foundation 运行监控源', ''));
  head.firstChild.style.margin = '0';
  const closeBtn = el('button', '✕', 'st-btn');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => backdrop.remove());
  head.append(closeBtn);

  const mkField = (id, label, placeholder, req = false) => {
    const wrap = el('div', null, 'st-form-field');
    const lbl = el('label', label);
    lbl.htmlFor = id;
    const inp = el('input', null, 'st-input');
    inp.id = id;
    inp.placeholder = placeholder;
    if (req) inp.required = true;
    wrap.append(lbl, inp);
    return { wrap, inp };
  };

  const fId = mkField('st-reg-id', '目标 ID（字母/数字/短横线）*', '如 task-wave10-verify', true);
  const fTitle = mkField('st-reg-title', '显示标题', '如 全量门禁执行器');
  const fState = mkField('st-reg-state', 'state-store 状态目录（可选）', '.artifacts/state-store 或绝对路径');
  const fPlan = mkField('st-reg-plan', '执行计划路径（.md / .json / .csv，可选）', 'PLAN.md');
  const fRuns = mkField('st-reg-runs', '子进程监督目录 runsDir（可选）', '.runs');
  const fLocks = mkField('st-reg-locks', '锁路径 lockPaths（逗号分隔，可选）', '.artifacts/locks, artifacts/traceability-version-lock.json');

  const errLine = el('div', '', 'st-muted-xs');
  errLine.style.color = 'var(--st-rose-fg)';

  const foot = el('div', null, 'st-graph-controls');
  foot.style.justifyContent = 'flex-end';
  const cancelBtn = el('button', '取消', 'st-btn');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => backdrop.remove());
  const submitBtn = el('button', '确认挂载并落盘', 'st-btn st-btn-primary');
  submitBtn.type = 'button';
  submitBtn.addEventListener('click', async () => {
    errLine.textContent = '';
    const idVal = fId.inp.value.trim();
    if (!idVal) { errLine.textContent = '请填写目标 ID。'; return; }
    submitBtn.disabled = true;
    try {
      await apiJson('/api/studio/runtime/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: idVal,
          title: fTitle.inp.value.trim() || idVal,
          stateDir: fState.inp.value.trim() || undefined,
          planPath: fPlan.inp.value.trim() || undefined,
          runsDir: fRuns.inp.value.trim() || undefined,
          lockPaths: fLocks.inp.value.split(',').map(s => s.trim()).filter(Boolean),
        }),
      });
      backdrop.remove();
      onRegistered?.();
    } catch (err) {
      errLine.textContent = err.message || '挂载失败';
      submitBtn.disabled = false;
    }
  });
  foot.append(cancelBtn, submitBtn);

  modal.append(head, fId.wrap, fTitle.wrap, fState.wrap, fPlan.wrap, fRuns.wrap, fLocks.wrap, errLine, foot);
  backdrop.append(modal);
  backdrop.addEventListener('click', ev => { if (ev.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
  fId.inp.focus();
}

function renderTaskTreeView(host, scopedTargets) {
  const bannerNote = el('div', '什么时候看这里：当你发起一个跨波次长程任务时，默认看本页确认总体进度、正在执行哪一步以及哪一环被前置依赖阻塞。', 'st-scenario-banner');
  host.append(bannerNote);

  const planTargets = scopedTargets.filter(t => (t.taskSummary?.total ?? 0) > 0 || (t.taskSummary?.tree?.length ?? 0) > 0);
  const allTasks = planTargets.flatMap(t => (t.taskSummary?.tasks || []).map(tk => ({ ...tk, targetTitle: t.title })));
  const total = allTasks.length;
  const done = allTasks.filter(t => t.status === 'done').length;
  const running = allTasks.filter(t => t.status === 'running').length;
  const blocked = allTasks.filter(t => t.status === 'blocked').length;
  const todo = allTasks.filter(t => t.status === 'todo').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const focusTarget = planTargets.find(t => (t.taskSummary?.running ?? 0) > 0 || (t.taskSummary?.blocked ?? 0) > 0) || planTargets[0] || null;
  const focusInfo = focusTarget?.taskSummary?.focusBanner || null;

  const focusBox = el('div', null, 'st-focus-banner');
  const fTop = el('div', null, 'st-repo-opt-head');
  const fLeft = el('div', null, 'st-graph-controls');
  fLeft.append(
    el('strong', '🎯 当前推进焦点'),
    el('span', focusInfo?.activePath?.length ? focusInfo.activePath.join(' › ') : (total > 0 ? '所有步骤均已完成' : '暂无活跃执行计划'), 'st-badge st-badge-indigo'),
    infoTrigger('rt:taskStatus', document),
  );
  fTop.append(fLeft, el('span', `已完成 ${done} · 进行中 ${running} · 阻断 ${blocked} · 待办 ${todo} / 共 ${total} 项 (${pct}%)`, 'st-muted-xs st-tabular'));
  focusBox.append(fTop);

  if (total > 0) {
    const bar = el('div', null, 'st-progress-multi');
    const seg = (cls, cnt) => {
      const d = el('div', null, cls);
      d.style.width = `${((cnt / total) * 100).toFixed(2)}%`;
      return d;
    };
    bar.append(seg('st-prog-seg-done', done), seg('st-prog-seg-running', running), seg('st-prog-seg-blocked', blocked), seg('st-prog-seg-todo', todo));
    focusBox.append(bar);
  }
  host.append(focusBox);

  const card = el('div', null, 'st-card st-guide-section');
  if (total === 0) {
    card.append(el('p', '当前范围内暂无可执行计划（支持含多级标题/缩进复选框的 .md、嵌套 .json 或 .csv）。可点击右上角「▶ 运行隔离沙箱演练」体验 3 层任务树，或「+ 挂载运行源」接入现有计划文件。', 'st-muted-xs'));
    host.append(card);
    return;
  }

  const ctrl = el('div', null, 'st-graph-toolbar');
  ctrl.style.padding = '0 0 12px 0';
  const pills = el('div', null, 'st-graph-controls');
  for (const [fk, fl] of [['all', '全部任务树'], ['incomplete', '仅看未完成'], ['focus', '聚焦当前活跃链路']]) {
    const b = el('button', fl, `st-btn${state.rtTaskFilter === fk ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.rtTaskFilter = fk; paintTree(); });
    pills.append(b);
  }
  const qInp = el('input', null, 'st-input');
  qInp.type = 'search';
  qInp.style.width = '240px';
  qInp.placeholder = '按波次、编号或步骤关键词过滤…';
  qInp.value = state.rtTaskQuery;
  ctrl.append(pills, qInp);
  card.append(ctrl);

  const treeMount = el('div', null, 'st-task-tree-root');
  card.append(treeMount);

  const matchesNodeFilter = (node, q) => {
    const children = node.children || [];
    if (children.length > 0) {
      const childHits = children.some(ch => matchesNodeFilter(ch, q));
      if (!childHits) return false;
      if (state.rtTaskFilter === 'focus' && !['running', 'blocked'].includes(node.status) && !childHits) return false;
      return true;
    }
    if (state.rtTaskFilter === 'incomplete' && node.status === 'done') return false;
    if (state.rtTaskFilter === 'focus' && !['running', 'blocked'].includes(node.status)) return false;
    if (q && !`${node.id} ${node.title} ${node.group || ''} ${node.detail || ''}`.toLowerCase().includes(q)) return false;
    return true;
  };

  const renderNodeBranch = (node, targetId, q) => {
    if (!matchesNodeFilter(node, q)) return null;
    const hasKids = Array.isArray(node.children) && node.children.length > 0;
    const key = `${targetId}::${node.id}`;
    const isCollapsed = state.rtCollapsedTreeIds.has(key);
    const box = el('div', null, 'st-tree-node');

    const row = el('div', null, `st-tree-row${!hasKids && node.status === 'running' ? ' is-active-leaf' : ''}`);
    const left = el('div', null, 'st-graph-controls');
    if (hasKids) {
      const tog = el('button', isCollapsed ? '▸' : '▾', 'st-tree-toggle');
      tog.type = 'button';
      tog.setAttribute('aria-label', '折叠或展开子任务');
      tog.addEventListener('click', () => {
        if (state.rtCollapsedTreeIds.has(key)) state.rtCollapsedTreeIds.delete(key);
        else state.rtCollapsedTreeIds.add(key);
        paintTree();
      });
      left.append(tog);
    }
    const kindLbl = node.kind === 'wave' ? '波次' : (node.kind === 'stage' ? '阶段' : (node.kind === 'task' ? '父任务' : node.id));
    left.append(el('span', kindLbl, 'st-badge st-badge-zinc'), el('strong', node.title));
    if (Array.isArray(node.blockedBy) && node.blockedBy.length > 0) {
      left.append(el('span', `依赖前置：${node.blockedBy.join(', ')}`, 'st-badge st-badge-amber'));
    }

    const right = el('div', null, 'st-graph-controls');
    const stTone = node.status === 'done' ? 'emerald' : (node.status === 'running' ? 'indigo' : (node.status === 'blocked' ? 'rose' : 'zinc'));
    const stTxt = node.status === 'done' ? '🟢 已完成' : (node.status === 'running' ? '🔵 进行中' : (node.status === 'blocked' ? '🔴 阻断' : '⚪ 待办'));
    if (hasKids) {
      right.append(el('span', `${node.done}/${node.total} (${node.percent}%)`, 'st-muted-xs st-tabular'));
    } else if (node.detail) {
      right.append(el('span', node.detail, 'st-muted-xs'));
    }
    right.append(el('span', stTxt, `st-badge st-badge-${stTone}`));
    row.append(left, right);
    box.append(row);

    if (hasKids && !isCollapsed) {
      const chWrap = el('div', null, 'st-tree-children');
      for (const ch of node.children) {
        const chEl = renderNodeBranch(ch, targetId, q);
        if (chEl) chWrap.append(chEl);
      }
      if (chWrap.children.length > 0) box.append(chWrap);
    }
    return box;
  };

  const paintTree = () => {
    ctrl.querySelectorAll('.st-btn').forEach(btn => {
      const m = [['all', '全部任务树'], ['incomplete', '仅看未完成'], ['focus', '聚焦当前活跃链路']].find(x => x[1] === btn.textContent);
      if (m) btn.classList.toggle('is-active', state.rtTaskFilter === m[0]);
    });
    treeMount.replaceChildren();
    const q = state.rtTaskQuery.trim().toLowerCase();
    for (const pt of planTargets) {
      const subHdr = el('div', null, 'st-repo-opt-head');
      subHdr.style.margin = '6px 0 2px';
      subHdr.append(el('strong', pt.title), el('span', `${pt.taskSummary.done}/${pt.taskSummary.total} (${pt.taskSummary.percent}%)`, 'st-badge st-badge-indigo'));
      treeMount.append(subHdr);
      const treeRoots = pt.taskSummary?.tree || [];
      let renderedCount = 0;
      for (const rootNode of treeRoots) {
        const elNode = renderNodeBranch(rootNode, pt.id, q);
        if (elNode) { treeMount.append(elNode); renderedCount += 1; }
      }
      if (renderedCount === 0) treeMount.append(el('p', '该计划在当前筛选下无匹配项。', 'st-muted-xs'));
    }
  };
  qInp.addEventListener('input', () => { state.rtTaskQuery = qInp.value; paintTree(); });
  paintTree();
  host.append(card);
}

function renderLockRadarSubpanel(host, scopedTargets, lockWarnMs) {
  const card = el('div', null, 'st-card st-guide-section');
  const allLocks = scopedTargets.flatMap(t => (t.locks || []).map(l => ({ ...l, targetTitle: t.title })));
  const activeCount = allLocks.filter(l => l.isActive).length;

  const head = el('div', null, 'st-graph-toolbar');
  head.style.padding = '0 0 10px 0';
  const left = el('div', null, 'st-graph-controls');
  left.append(el('h3', '文件锁与并发写集雷达', ''), infoTrigger('rt:tokenLock', document), el('span', `活跃排他锁 ${activeCount} 把 · 总锁记录 ${allLocks.length} 项`, 'st-badge st-badge-indigo'));
  left.firstChild.style.margin = '0';
  const filterBtns = el('div', null, 'st-graph-controls');
  for (const [fk, fl] of [['all', '全部锁（含版本锁）'], ['active', '仅看活跃排他锁']]) {
    const b = el('button', fl, `st-btn${state.rtLockFilter === fk ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.rtLockFilter = fk; renderRuntimePanel(); });
    filterBtns.append(b);
  }
  head.append(left, filterBtns);
  card.append(head);

  const visibleLocks = state.rtLockFilter === 'active' ? allLocks.filter(l => l.isActive) : allLocks;
  if (!visibleLocks.length) {
    card.append(el('p', '当前筛选条件下无文件锁或静态追溯锁记录。', 'st-muted-xs'));
    host.append(card);
    return;
  }

  const grid = el('div', null, 'st-lock-grid');
  for (const lk of visibleLocks) {
    const isWarn = lk.isActive && lk.isStaleWarning;
    const lc = el('div', null, `st-lock-card${lk.isActive ? ' is-active' : ''}${isWarn ? ' is-warn' : ''}`);
    const top = el('div', null, 'st-repo-opt-head');
    top.append(el('strong', lk.name || 'lock'), el('span', lk.lockKind || 'lock', 'st-badge st-badge-zinc'));
    const statusBadge = isWarn
      ? el('span', '⚠️ 持锁超时预警', 'st-badge st-badge-amber')
      : (lk.isActive ? el('span', '🔒 活跃持锁中', 'st-badge st-badge-indigo') : el('span', '📌 静态版本锁', 'st-badge st-badge-emerald'));

    const metaRow = el('div', null, 'st-repo-opt-head');
    metaRow.append(el('span', `持有者：${lk.owner || 'unknown'}`, 'st-muted-xs'), statusBadge);

    const timeRow = el('div', null, 'st-repo-opt-head');
    const durSpan = el('span', lk.isActive ? `已持锁 ${formatDurationMs(lk.ageMs)}` : `更新于 ${formatIsoShort(lk.acquiredAt)}`, 'st-tabular st-muted-xs');
    if (lk.isActive && lk.acquiredAt) {
      durSpan.dataset.lockAcquiredAt = lk.acquiredAt;
      durSpan.dataset.lockWarnMs = String(lockWarnMs);
    }
    timeRow.append(el('span', `获取：${formatIsoShort(lk.acquiredAt)}`, 'st-muted-xs'), durSpan);

    lc.append(top, el('div', lk.displayPath || lk.path || '', 'st-muted-xs st-tabular'), metaRow, timeRow);
    if (lk.summary) lc.append(el('div', lk.summary, 'st-muted-xs'));
    grid.append(lc);
  }
  card.append(grid);
  host.append(card);
}

function renderEventChainSubpanel(host, scopedTargets) {
  const card = el('div', null, 'st-card st-guide-section');
  const stores = scopedTargets.map(t => ({ targetTitle: t.title, store: t.stateStore })).filter(x => x.store?.isStateStore);
  const head = el('div', null, 'st-repo-opt-head');
  const left = el('div', null, 'st-graph-controls');
  left.append(el('h3', 'Foundation 事件溯源哈希链 (state-store)', ''), infoTrigger('rt:stateStore', document));
  left.firstChild.style.margin = '0';
  head.append(left, el('span', `状态库 ${stores.length} 个`, 'st-badge st-badge-indigo'));
  card.append(head);

  if (!stores.length) {
    card.append(el('p', '当前范围内暂无初始化的 state-store 状态目录。', 'st-muted-xs'));
    host.append(card);
    return;
  }

  for (const { targetTitle, store } of stores) {
    const box = el('div', null, 'st-chain-box');
    const stHead = el('div', null, 'st-repo-opt-head');
    const tone = store.integrity === 'VALID' ? 'emerald' : (store.integrity === 'CHAIN_BROKEN' ? 'rose' : (store.integrity === 'STALE_HEAD' ? 'amber' : 'zinc'));
    stHead.append(
      el('div', `${targetTitle} · ${store.displayPath || ''}`, 'st-muted-xs'),
      el('span', `${store.integrity} · #${store.lastSequence} · fencing #${store.fencing ?? 0}`, `st-badge st-badge-${tone}`),
    );
    box.append(stHead);
    if (store.integrityError) box.append(el('p', `⚠️ ${store.integrityError}`, 'st-muted-xs'));

    const events = store.events || [];
    if (events.length === 0) {
      box.append(el('p', '事件日志为空。', 'st-muted-xs'));
    } else {
      const tblWrap = el('div', null, 'st-table-wrap');
      const tbl = el('table', null, 'st-prose-table');
      const thead = el('thead');
      const hr = el('tr');
      for (const h of ['序号', '事件类型 (eventType)', '产生者 (producer)', '时间戳', 'recordDigest 摘要', '链接校验']) hr.append(el('th', h));
      thead.append(hr);
      const tbody = el('tbody');
      for (const ev of [...events].reverse().slice(0, 50)) {
        const tr = el('tr');
        const dig = ev.recordDigest ? `${String(ev.recordDigest).slice(0, 18)}…` : '—';
        const tdVer = el('td');
        tdVer.append(el('span', ev.digestVerified !== false ? '✓ 链校验通过' : '✕ 链断裂', `st-badge ${ev.digestVerified !== false ? 'st-badge-emerald' : 'st-badge-rose'}`));
        tr.append(
          el('td', `#${String(ev.sequence).padStart(6, '0')}`, 'st-tabular'),
          el('td', ev.eventType || '—'),
          el('td', ev.producer || '—'),
          el('td', formatIsoShort(ev.recordedAt), 'st-tabular'),
          el('td', dig, 'st-tabular'),
          tdVer,
        );
        tbody.append(tr);
      }
      tbl.append(thead, tbody);
      tblWrap.append(tbl);
      box.append(tblWrap);
    }
    card.append(box);
  }
  host.append(card);
}

function renderProcessSubpanel(host, scopedTargets) {
  const card = el('div', null, 'st-card st-guide-section');
  const procs = scopedTargets.flatMap(t => (t.processes || []).map(p => ({ ...p, targetTitle: t.title })));
  const head = el('div', null, 'st-repo-opt-head');
  const left = el('div', null, 'st-graph-controls');
  left.append(el('h3', '受管子进程监督轨迹 (supervise-process)', ''), infoTrigger('rt:processStatus', document));
  left.firstChild.style.margin = '0';
  head.append(left, el('span', `共 ${procs.length} 条调用记录`, 'st-badge st-badge-indigo'));
  card.append(head);

  if (!procs.length) {
    card.append(el('p', '当前范围内暂无受管子进程监督记录（invocation.json / *.watchdog.json）。', 'st-muted-xs'));
    host.append(card);
    return;
  }

  const tblWrap = el('div', null, 'st-table-wrap');
  const tbl = el('table', null, 'st-prose-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['运行源 / 文件', 'PID', '命令/脚本', '状态', '退出码', '耗时', '保护标记']) hr.append(el('th', h));
  thead.append(hr);
  const tbody = el('tbody');
  for (const p of procs) {
    const tr = el('tr');
    const tone = p.processStatus === 'RUNNING' ? 'indigo' : (p.processStatus === 'EXITED' && p.ok ? 'emerald' : (p.processStatus === 'TIMED_OUT' ? 'amber' : 'rose'));
    const tdSt = el('td');
    tdSt.append(el('span', p.processStatus, `st-badge st-badge-${tone}`));
    const tdGuard = el('td');
    if (p.timedOut) tdGuard.append(el('span', `⏱️ 超时代杀 (${p.killSignal || 'SIGKILL'})`, 'st-badge st-badge-amber'));
    else tdGuard.append(el('span', p.ok ? '正常受控退出' : '异常退出', 'st-muted-xs'));

    tr.append(
      el('td', `${p.targetTitle} · ${p.label}`, 'st-muted-xs'),
      el('td', p.pid !== null && p.pid !== undefined ? String(p.pid) : '—', 'st-tabular'),
      el('td', p.command || p.label, 'st-tabular'),
      tdSt,
      el('td', p.exitCode !== null && p.exitCode !== undefined ? String(p.exitCode) : '—', 'st-tabular'),
      el('td', formatDurationMs(p.durationMs), 'st-tabular'),
      tdGuard,
    );
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  tblWrap.append(tbl);
  card.append(tblWrap);
  host.append(card);
}

function renderDiagnosticsView(host, scopedTargets, lockWarnMs) {
  const scenarioBanner = el('div', '什么时候看这里：日常看进度与会话协作无需打开本页；仅当任务长时间卡住不动、报排他写锁超时或子进程异常强杀时点开排障。', 'st-scenario-banner');
  host.append(scenarioBanner);

  const allLocks = scopedTargets.flatMap(t => t.locks || []);
  const staleLocks = allLocks.filter(l => l.isActive && l.isStaleWarning);
  const brokenChains = scopedTargets.filter(t => t.stateStore?.integrity === 'CHAIN_BROKEN' || t.stateStore?.integrity === 'STALE_HEAD');
  const timedOutProcs = scopedTargets.flatMap(t => t.processes || []).filter(p => p.processStatus === 'TIMED_OUT');
  const warnTotal = staleLocks.length + brokenChains.length + timedOutProcs.length;

  const healthBar = el('div', null, `st-diag-health-bar${warnTotal > 0 ? ' is-warn' : ''}`);
  healthBar.append(
    el('span', warnTotal === 0
      ? '🟢 底层运行健康：0 把超时排他锁 · 0 条损坏哈希链 · 0 个超时强杀进程'
      : `⚠️ 发现 ${warnTotal} 项底层告警：超时锁 ${staleLocks.length} 把 · 链异常 ${brokenChains.length} 处 · 超时强杀进程 ${timedOutProcs.length} 个`),
    el('span', `监控目标 ${scopedTargets.length} 个`, 'st-muted-xs'),
  );
  host.append(healthBar);

  renderLockRadarSubpanel(host, scopedTargets, lockWarnMs);
  renderEventChainSubpanel(host, scopedTargets);
  renderProcessSubpanel(host, scopedTargets);

  const secCard = el('div', null, 'st-card st-guide-section');
  secCard.append(el('h3', state.rtScope === 'repo' ? '当前项目运行源明细' : '全工作区运行源明细', ''));
  secCard.firstChild.style.marginTop = '0';
  if (!scopedTargets.length) {
    secCard.append(el('p', '当前范围暂无运行源。', 'st-muted-xs'));
  } else {
    secCard.append(buildRuntimeTargetsTable(scopedTargets, document));
  }
  host.append(secCard);
}

async function renderRuntimePanel() {
  stopLockTicker();
  const host = document.getElementById('st-panel-runtime');
  if (!state.runtime) {
    host.replaceChildren(el('p', '正在采集 Foundation 运行态与会话编队快照…', 'st-muted-xs'));
  }
  try {
    const [rtRes, fleetRes] = await Promise.all([
      apiJson(`/api/studio/runtime?repo=${encodeURIComponent(state.repoId || '')}`),
      apiJson('/api/studio/fleet').catch(() => null),
    ]);
    state.runtime = rtRes;
    if (fleetRes) state.fleet = fleetRes;
  } catch (err) {
    host.replaceChildren(el('p', `读取运行态失败：${err.message}`, 'st-muted-xs'));
    return;
  }
  host.replaceChildren();
  const rt = state.runtime;
  const curRepo = state.repos.find(r => r.id === state.repoId);
  const allTargets = rt.targets || [];
  const repoTargets = rt.currentRepoTargets || [];
  const scopeBaseTargets = state.rtScope === 'repo' ? repoTargets : allTargets;
  const scopedTargets = state.rtSelectedTargetId === '__all__'
    ? scopeBaseTargets
    : scopeBaseTargets.filter(t => t.id === state.rtSelectedTargetId);

  // 顶部范围控制与沙箱动作栏
  const bar = el('div', null, 'st-card st-rt-toolbar');
  const leftBar = el('div', null, 'st-graph-controls');
  const scopeSwitch = el('div', null, 'st-view-switch');
  const bRepo = el('button', `聚焦当前项目 (${curRepo?.name || '当前仓'} · ${repoTargets.length})`, `st-btn${state.rtScope === 'repo' ? ' is-active' : ''}`);
  bRepo.type = 'button';
  bRepo.addEventListener('click', () => { state.rtScope = 'repo'; state.rtSelectedTargetId = '__all__'; renderRuntimePanel(); });
  const bAll = el('button', `全工作区监控源聚合 (${allTargets.length} 源)`, `st-btn${state.rtScope === 'workspace' ? ' is-active' : ''}`);
  bAll.type = 'button';
  bAll.addEventListener('click', () => { state.rtScope = 'workspace'; state.rtSelectedTargetId = '__all__'; renderRuntimePanel(); });
  scopeSwitch.append(bRepo, bAll);

  const srcSelect = el('select', null, 'st-select');
  srcSelect.style.width = 'auto';
  const optAll = el('option', `全部范围运行源 (${scopeBaseTargets.length})`);
  optAll.value = '__all__';
  srcSelect.append(optAll);
  for (const t of scopeBaseTargets) {
    const o = el('option', `${t.title} [${t.badge}]`);
    o.value = t.id;
    if (state.rtSelectedTargetId === t.id) o.selected = true;
    srcSelect.append(o);
  }
  srcSelect.addEventListener('change', () => { state.rtSelectedTargetId = srcSelect.value; renderRuntimePanel(); });
  leftBar.append(scopeSwitch, infoTrigger('rt:scope', document), srcSelect);

  const rightBar = el('div', null, 'st-graph-controls');
  const ssePill = el('span', null, 'st-live-pill');
  ssePill.append(el('span', null, 'st-live-dot'), el('span', state.rtSseStatus === 'connected' ? 'SSE 实时同步' : '重连中…'));

  const mountBtn = el('button', '+ 挂载运行源', 'st-btn');
  mountBtn.type = 'button';
  mountBtn.addEventListener('click', () => openRegisterRuntimeModal(() => renderRuntimePanel()));

  const sbxBtn = el('button', '▶ 运行隔离沙箱演练', 'st-btn st-btn-primary');
  sbxBtn.type = 'button';
  sbxBtn.addEventListener('click', async () => {
    sbxBtn.disabled = true;
    sbxBtn.textContent = '演练中…';
    await apiJson('/api/studio/runtime/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    renderRuntimePanel();
  });

  rightBar.append(ssePill, mountBtn, sbxBtn);
  if (rt.hasActiveSandboxLock) {
    const relBtn = el('button', '🔓 释放沙箱锁', 'st-btn st-btn-amber');
    relBtn.type = 'button';
    relBtn.addEventListener('click', async () => {
      relBtn.disabled = true;
      await apiJson('/api/studio/runtime/sandbox/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      renderRuntimePanel();
    });
    rightBar.append(relBtn);
  }
  bar.append(leftBar, rightBar);
  host.append(bar);

  // 场景化三大观测视图切换条（废除旧版 A/B/C/D 平铺）
  const sLocks = scopedTargets.flatMap(t => t.locks || []);
  const sActiveLocks = sLocks.filter(l => l.isActive);
  const sWarnCount = sActiveLocks.filter(l => l.isStaleWarning).length
    + scopedTargets.filter(t => t.stateStore?.integrity === 'CHAIN_BROKEN').length
    + scopedTargets.flatMap(t => t.processes || []).filter(p => p.processStatus === 'TIMED_OUT').length;
  const fleetFamCount = state.fleet?.families?.length ?? 0;

  const subBar = el('div', null, 'st-rt-subtabs');
  for (const [vk, vl, tipKey] of [
    ['tasks', '🌳 任务推进树（默认）', 'rt:view:tasks'],
    ['fleet', `🛰️ 会话与子会话编队 (${fleetFamCount})`, 'rt:view:fleet'],
    ['diag', `🩺 底层排障与健康诊断${sWarnCount > 0 ? ` (⚠️ ${sWarnCount})` : ''}`, 'rt:view:diag'],
  ]) {
    const b = el('button', vl, `st-btn${state.rtView === vk ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.rtView = vk; renderRuntimePanel(); });
    subBar.append(b, infoTrigger(tipKey, document));
  }
  host.append(subBar);

  const viewHost = el('div');
  host.append(viewHost);

  const lockWarnMs = rt.kpi?.lockWarnMs || 30000;
  if (state.rtView === 'tasks') {
    renderTaskTreeView(viewHost, scopedTargets);
  } else if (state.rtView === 'fleet') {
    const paintFleet = () => {
      mountFleetMonitor(viewHost, {
        fleetData: state.fleet,
        state,
        doc: document,
        infoTrigger,
        onStateChange: paintFleet,
        onRefresh: async () => {
          state.fleet = await apiJson('/api/studio/fleet').catch(() => state.fleet);
          paintFleet();
        },
        onRunSandbox: async () => {
          await apiJson('/api/studio/runtime/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          renderRuntimePanel();
        },
      });
    };
    paintFleet();
  } else {
    renderDiagnosticsView(viewHost, scopedTargets, lockWarnMs);
  }

  if (sActiveLocks.length > 0 && state.tab === 'runtime' && state.rtView === 'diag') {
    lockTickTimer = setInterval(() => {
      if (state.tab !== 'runtime' || state.rtView !== 'diag') { stopLockTicker(); return; }
      const nodes = host.querySelectorAll('[data-lock-acquired-at]');
      const now = Date.now();
      for (const n of nodes) {
        const ts = Date.parse(n.dataset.lockAcquiredAt || '');
        if (!Number.isFinite(ts)) continue;
        const ageMs = Math.max(0, now - ts);
        n.textContent = `已持锁 ${formatDurationMs(ageMs)}`;
      }
    }, 1000);
  }
}

function renderActiveTab() {
  if (state.tab === 'guide') renderGuidePanel();
  else if (state.tab === 'graph') renderGraphPanel();
  else if (state.tab === 'review') renderReviewPanel();
  else if (state.tab === 'runtime') renderRuntimePanel();
}

async function selectRepo(repoId, { skipRender = false } = {}) {
  if (!repoId) return;
  state.repoId = repoId;
  state.graphMode = 'dag';
  state.archifyIdx = 0;
  state.archifySelectedNode = null;
  state.selectedAnchor = null;
  state.reviewCategory = 'all';
  state.rtSelectedTargetId = '__all__';
  const u = new URL(location.href);
  u.searchParams.set('repo', repoId);
  if (state.tab) u.searchParams.set('tab', state.tab);
  history.replaceState(null, '', u);
  const [data, alignData] = await Promise.all([
    apiJson(`/api/studio/repo?repo=${encodeURIComponent(repoId)}`),
    apiJson(`/api/studio/alignment?repo=${encodeURIComponent(repoId)}`).catch(() => null),
  ]);
  state.snap = data.snapshot;
  state.alignment = alignData;
  const def = pickDefaultArtifactNode(state.snap.nodes || []) || (state.snap.reviewItems || [])[0] || null;
  state.selectedUid = def ? def.uid : null;
  if (!skipRender) {
    state.reviewMode = state.alignment?.portfolio?.present ? 'alignment' : 'reader';
  }
  updateTopbarSummary();
  if (!skipRender) renderActiveTab();
}

async function openExportDrawer() {
  const backdrop = document.getElementById('st-export-backdrop');
  backdrop.hidden = false;
  const sum = await apiJson('/api/studio/summary');
  document.getElementById('st-export-preview').textContent = sum.markdown || '';
}

async function boot() {
  const savedTheme = localStorage.getItem('st-theme') || 'light';
  document.documentElement.dataset.theme = savedTheme;
  initTooltipManager(document);

  document.getElementById('st-theme-btn').addEventListener('click', () => {
    const nxt = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nxt;
    localStorage.setItem('st-theme', nxt);
    const frame = document.querySelector('.st-archify-frame');
    try { frame?.contentDocument?.documentElement?.setAttribute('data-theme', nxt); } catch {}
  });
  document.getElementById('st-help-btn').addEventListener('click', () => switchTab('guide'));
  document.getElementById('st-progress-capsule').addEventListener('click', openExportDrawer);

  const exportBackdrop = document.getElementById('st-export-backdrop');
  document.getElementById('st-export-close').addEventListener('click', () => { exportBackdrop.hidden = true; });
  exportBackdrop.addEventListener('click', ev => { if (ev.target === exportBackdrop) exportBackdrop.hidden = true; });

  document.getElementById('st-copy-md-btn').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(document.getElementById('st-export-preview').textContent || '');
  });

  const trig = document.getElementById('st-repo-trigger');
  const pop = document.getElementById('st-repo-popover');
  trig.addEventListener('click', ev => {
    ev.stopPropagation();
    const nextOpen = pop.hidden;
    pop.hidden = !nextOpen;
    trig.setAttribute('aria-expanded', String(nextOpen));
    if (nextOpen) { renderRepoPopover(); document.getElementById('st-repo-search').focus(); }
  });
  document.getElementById('st-repo-search').addEventListener('input', renderRepoPopover);
  document.querySelectorAll('.st-tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 点击空白处收起项目切换器；Escape 按优先级依次关闭 5 类浮层/全屏模式
  document.addEventListener('pointerdown', ev => {
    if (!pop.hidden && !pop.contains(ev.target) && !trig.contains(ev.target)) {
      closeRepoPopover();
    }
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (isTooltipOpen(document)) { closeGlobalTooltip(document); return; }
    const rtModal = document.getElementById('st-rt-reg-modal');
    if (rtModal) { rtModal.remove(); return; }
    if (!exportBackdrop.hidden) { exportBackdrop.hidden = true; return; }
    if (!pop.hidden) { closeRepoPopover(); return; }
    if (state.fullscreenGraph) {
      state.fullscreenGraph = false;
      const split = document.querySelector('#st-panel-graph .st-graph-split');
      split?.classList.remove('is-fullscreen');
      if (state.tab === 'graph') renderGraphPanel();
    }
  });

  const init = await apiJson('/api/studio/state');
  state.repos = init.ecosystem?.repos || [];
  state.decisions = init.decisions || {};
  state.annotations = init.annotations || [];
  state.guide = init.guide || null;

  const qs = new URLSearchParams(location.search);
  const visited = localStorage.getItem('st-visited') === '1';
  localStorage.setItem('st-visited', '1');
  const initialTab = qs.get('tab') || init.defaultTab || (visited ? 'graph' : 'guide');
  const initialRepo = qs.get('repo') || init.defaultRepo || init.ecosystem?.primaryRepoId || state.repos[0]?.id;

  if (initialRepo) await selectRepo(initialRepo);
  switchTab(initialTab);

  let rtRefreshTimer = null;
  try {
    const es = new EventSource('/api/studio/events');
    es.addEventListener('connected', () => { state.rtSseStatus = 'connected'; });
    es.addEventListener('review-change', async () => {
      const fresh = await apiJson('/api/studio/state');
      state.decisions = fresh.decisions || {};
      state.annotations = fresh.annotations || [];
      updateTopbarSummary();
    });
    es.addEventListener('runtime-change', () => {
      state.rtSseStatus = 'connected';
      if (state.tab === 'runtime') {
        if (rtRefreshTimer) clearTimeout(rtRefreshTimer);
        rtRefreshTimer = setTimeout(() => { rtRefreshTimer = null; renderRuntimePanel(); }, 200);
      }
    });
    es.onerror = () => { state.rtSseStatus = 'reconnecting'; };
  } catch {}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot();
}
