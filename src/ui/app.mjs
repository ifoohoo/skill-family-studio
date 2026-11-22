import { computeAdaptiveGraphLayout, pickDefaultArtifactNode } from '../graph-layout.mjs';

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
  runtime: null,
  selectedUid: null,
  reviewCategory: 'all',
  reviewStatusFilter: 'all',
  reviewQuery: '',
  proseWidth: typeof localStorage !== 'undefined' && localStorage.getItem('st-prose-width') === 'full' ? 'full' : 'comfort',
  graphMode: 'dag',
  archifyIdx: 0,
  fitWidth: true,
  wrapGrid: true,
  zoom: 1,
  panX: 0,
  panY: 0,
  fullscreenGraph: false,
  selectedAnchor: null,
  archifySelectedNode: null,
  docCache: new Map(),
};

function resolveStudioItemByPageId(pageId) {
  if (!pageId || !state.snap) return null;
  const items = [...(state.snap.reviewItems || []), ...(state.snap.nodes || [])];
  const raw = String(pageId).trim();
  const exactArticle = items.find(i => i.uid === `business_article:${raw}`);
  if (exactArticle) return exactArticle;
  const normalized = raw.replace(/^story-/i, '').toUpperCase();
  return items.find(i =>
    String(i.code || '').toUpperCase() === raw.toUpperCase()
    || String(i.code || '').toUpperCase() === normalized
    || String(i.uid || '').toLowerCase().endsWith(`:${raw.toLowerCase()}`),
  ) || null;
}

const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
};

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

function updateTopbarSummary() {
  const curRepo = state.repos.find(r => r.id === state.repoId);
  document.getElementById('st-current-repo-name').textContent = curRepo ? curRepo.name : '未发现仓库';
  const lockBadge = document.getElementById('st-repo-lock-badge');
  if (state.snap?.versionLock) {
    lockBadge.textContent = state.snap.versionLock.badgeLabel;
    lockBadge.className = `st-badge st-badge-${state.snap.versionLock.badgeTone || 'zinc'}`;
  } else if (curRepo) {
    lockBadge.textContent = curRepo.versionLockLabel || '待核实';
    lockBadge.className = 'st-badge st-badge-zinc';
  }
  if (curRepo) {
    const p = countRepoProgress(curRepo);
    document.getElementById('st-progress-text').textContent =
      `审阅进度：已通过 ${p.approved} · 审阅中 ${p.reviewing} · 需修改 ${p.changes} / 共 ${p.total} 项`;
  }
}

function renderRepoPopover() {
  const host = document.getElementById('st-repo-groups');
  const q = (document.getElementById('st-repo-search').value || '').trim().toLowerCase();
  host.replaceChildren();
  const filtered = state.repos.filter(r => !q || `${r.name} ${r.groupLabel} ${r.description}`.toLowerCase().includes(q));
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
      head.append(el('span', r.name), el('span', `已审 ${p.decided}/${p.total}`, 'st-badge st-badge-indigo'));
      const metrics = el('div', null, 'st-repo-opt-metrics');
      metrics.append(
        el('span', `制品节点 ${r.nodeCount ?? 0}`),
        el('span', `· ${r.versionLockLabel}`),
        el('span', `· 审阅中 ${p.reviewing}`),
        el('span', `· ${r.runtimeLabel}`),
      );
      btn.append(head, metrics);
      btn.addEventListener('click', () => {
        document.getElementById('st-repo-popover').hidden = true;
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

function switchTab(nextTab) {
  nextTab = normalizeUiTab(nextTab);
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

function findNextUnreviewed(currentUid = state.selectedUid) {
  const list = state.snap?.reviewItems ?? [];
  if (!list.length) return null;
  const idx = currentUid ? list.findIndex(i => i.uid === currentUid) : -1;
  const ordered = idx >= 0 ? [...list.slice(idx + 1), ...list.slice(0, idx + 1)] : list;
  for (const item of ordered) {
    if (item.uid === currentUid && list.length > 1) continue;
    const eff = getEffectiveStatus(item.target || item.uid);
    if (eff === 'pending' || eff === 'reviewing') return item;
  }
  return ordered[0] ?? null;
}

function startGuidedReview() {
  const first = findNextUnreviewed(null);
  if (first) state.selectedUid = first.uid;
  switchTab('review');
}

async function submitDecision(rawTarget, status, note, andAdvance = false) {
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
}

async function mutateAnnotation(payload) {
  const res = await apiJson('/api/studio/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: state.repoId, ...payload }),
  });
  state.annotations = res.annotations || [];
  if (res.decisions) state.decisions = res.decisions;
  updateTopbarSummary();
  renderActiveTab();
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
    el('span', `${meta.dot} ${meta.label}`, meta.badge),
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
    statusGroup.append(b);
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

  if (anchorId) {
    const hitHeading = bodyDiv.querySelector(`#${CSS.escape(anchorId)}`)
      || [...bodyDiv.querySelectorAll('.st-prose-heading')].find(h => String(h.id || '').endsWith(`-${anchorId}`));
    if (hitHeading) {
      hitHeading.classList.add('is-anchor-hit');
      hitHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
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
  const startBtn = el('button', '▶ 开始按推荐顺序审阅（需求总纲 → 用户故事 → 架构设计 → 场景测试）', 'st-btn st-btn-primary');
  startBtn.type = 'button';
  startBtn.addEventListener('click', startGuidedReview);
  banner.append(bLeft, startBtn);
  host.append(banner);

  const whyCard = el('div', null, 'st-card');
  whyCard.style.padding = '16px 20px';
  whyCard.append(el('h2', '一、为什么需要统一控制台', ''));
  whyCard.firstChild.style.marginTop = '0';
  for (const p of g.whyItExists || []) whyCard.append(el('p', p));
  host.append(whyCard);

  const stepGrid = el('div', null, 'st-guide-grid');
  for (const s of g.fiveSteps || []) {
    const card = el('div', null, 'st-card st-guide-step');
    const top = el('div');
    top.append(
      el('span', `第 ${s.step} 步`, 'st-badge st-badge-indigo'),
      el('h3', s.title, ''),
      el('p', s.whenAndWhat, 'st-muted-xs'),
    );
    const act = el('button', s.actionLabel, 'st-btn st-btn-primary');
    act.type = 'button';
    act.addEventListener('click', () => {
      if (s.actionId === 'open-repo-switcher') {
        document.getElementById('st-repo-popover').hidden = false;
        renderRepoPopover();
      } else if (s.actionId === 'go-tab-graph') switchTab('graph');
      else if (s.actionId === 'start-guided-review') startGuidedReview();
      else if (s.actionId === 'go-tab-review') switchTab('review');
      else if (s.actionId === 'open-export-drawer') openExportDrawer();
    });
    card.append(top, act);
    stepGrid.append(card);
  }
  host.append(stepGrid);

  const rulesCard = el('div', null, 'st-card');
  rulesCard.style.padding = '16px 20px';
  rulesCard.append(el('h2', '二、四种审阅状态流转规则', ''));
  rulesCard.firstChild.style.marginTop = '0';
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
  rulesCard.append(tbl);
  host.append(rulesCard);
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
    modeControls.append(dagBtn, archBtn);
  }
  const guidedBtn = el('button', '▶ 开始按推荐顺序审阅', 'st-btn st-btn-primary');
  guidedBtn.type = 'button';
  guidedBtn.addEventListener('click', startGuidedReview);
  modeControls.append(guidedBtn);

  const rightCard = el('aside', null, 'st-card st-graph-inspector');
  const floatBar = el('div', null, 'st-archify-float-bar');
  floatBar.hidden = true;
  let fsBtnRef = null;

  const canvasControls = el('div', null, 'st-graph-controls');
  if (state.graphMode === 'dag') {
    const mkCtrl = (label, active, onClick) => {
      const b = el('button', label, `st-btn${active ? ' is-active' : ''}`);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };
    canvasControls.append(
      mkCtrl('适应屏宽', state.fitWidth, () => { state.fitWidth = !state.fitWidth; paintSvgCanvas(); renderGraphPanel(); }),
      mkCtrl('自动折行排布', state.wrapGrid, () => { state.wrapGrid = !state.wrapGrid; paintSvgCanvas(); renderGraphPanel(); }),
      mkCtrl('－', false, () => { state.zoom = Math.max(0.4, Number((state.zoom - 0.15).toFixed(2))); renderGraphPanel(); }),
      mkCtrl(`${Math.round(state.zoom * 100)}%`, false, () => { state.zoom = 1; renderGraphPanel(); }),
      mkCtrl('＋', false, () => { state.zoom = Math.min(2.4, Number((state.zoom + 0.15).toFixed(2))); renderGraphPanel(); }),
      mkCtrl('重置视图', false, () => { state.zoom = 1; state.panX = 0; state.panY = 0; state.fitWidth = true; state.wrapGrid = true; renderGraphPanel(); }),
      mkCtrl(state.fullscreenGraph ? '退出全屏画布' : '全屏画布', state.fullscreenGraph, () => { state.fullscreenGraph = !state.fullscreenGraph; renderGraphPanel(); }),
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

  let paintSvgCanvas = () => {};
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
              if (fsBtnRef) {
                fsBtnRef.classList.remove('is-active');
                fsBtnRef.textContent = '全屏展开';
              }
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
    viewport.append(svg);
    leftCard.append(viewport);

    paintSvgCanvas = () => {
      const cw = Math.max(640, viewport.clientWidth || window.innerWidth - (state.fullscreenGraph ? 60 : 540));
      const layout = computeAdaptiveGraphLayout(state.snap, {
        containerWidth: cw,
        fitWidth: state.fitWidth,
        wrapGrid: state.wrapGrid,
        selectedUid: state.selectedUid,
      });
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
        svg.append(svgEl('path', { d: e.path, class: `st-edge-path${hi ? ' is-hi' : ''}` }));
      }
      for (const nd of layout.nodes) {
        const eff = getEffectiveStatus(nd.target || nd.uid);
        const sm = STATUS_META[eff] || STATUS_META.pending;
        const g = svgEl('g', { class: `st-node-group${nd.uid === state.selectedUid ? ' is-selected' : ''}` });
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
          if (state.fullscreenGraph) state.fullscreenGraph = false;
          renderGraphPanel();
        });
        svg.append(g);
      }
    };

    viewport.addEventListener('wheel', ev => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        state.zoom = Math.min(2.4, Math.max(0.4, Number((state.zoom + (ev.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
        paintSvgCanvas();
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
  }

  const activeItem = (state.snap.reviewItems || []).find(i => i.uid === state.selectedUid)
    || (state.snap.nodes || []).find(n => n.uid === state.selectedUid) || null;
  mountDocumentReader(rightCard, activeItem);

  split.append(leftCard, rightCard);
  host.append(split);
}

function renderReviewPanel() {
  const host = document.getElementById('st-panel-review');
  host.replaceChildren();
  if (!state.snap) { host.append(el('p', '正在加载审阅清单…', 'st-muted-xs')); return; }

  const banner = el('div', null, 'st-guided-banner');
  banner.append(
    el('span', '推荐阅读与签收顺序：需求总纲 → 用户故事 → 领域与架构设计 → 场景剧本与验收测试'),
    (() => {
      const b = el('button', '▶ 跳至下一项待审条目 →', 'st-btn st-btn-primary');
      b.type = 'button';
      b.addEventListener('click', () => {
        const nxt = findNextUnreviewed(state.selectedUid);
        if (nxt) { state.selectedUid = nxt.uid; renderReviewPanel(); }
      });
      return b;
    })(),
  );
  host.append(banner);

  const split = el('div', null, 'st-review-split');
  const sidebar = el('aside', null, 'st-card st-review-sidebar');

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
  for (const c of state.snap.categories || []) {
    const b = el('button', `${c.label} (${c.count})`, `st-btn${state.reviewCategory === c.id ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.reviewCategory = c.id; renderReviewPanel(); });
    catRow.append(b);
  }
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
      const r1 = el('div', null, 'st-repo-opt-head');
      r1.append(el('span', `${item.code} · ${item.typeLabel}`, 'st-muted-xs'), el('span', `${sm.dot} ${sm.label}`, sm.badge));
      b.append(r1, el('div', item.title));
      b.addEventListener('click', () => { state.selectedUid = item.uid; renderReviewPanel(); });
      listWrap.append(b);
    }
  };
  paintList();

  const readerCard = el('div', null, 'st-card');
  const activeItem = (state.snap.reviewItems || []).find(i => i.uid === state.selectedUid)
    || (state.snap.reviewItems || [])[0] || null;
  mountDocumentReader(readerCard, activeItem);

  split.append(sidebar, readerCard);
  host.append(split);
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

async function renderRuntimePanel() {
  const host = document.getElementById('st-panel-runtime');
  host.replaceChildren(el('p', '正在采集 Foundation 运行态监控快照…', 'st-muted-xs'));
  try {
    state.runtime = await apiJson(`/api/studio/runtime?repo=${encodeURIComponent(state.repoId || '')}`);
  } catch (err) {
    host.replaceChildren(el('p', `读取运行态失败：${err.message}`, 'st-muted-xs'));
    return;
  }
  host.replaceChildren();
  const rt = state.runtime;
  const kpi = rt.kpi || {};

  const kpiGrid = el('div', null, 'st-kpi-grid');
  const addKpi = (title, val, sub, badgeCls = 'st-badge-indigo') => {
    const c = el('div', null, 'st-card st-kpi-card');
    c.append(el('div', title, 'st-muted-xs'), el('div', val, 'st-kpi-val'), el('span', sub, `st-badge ${badgeCls}`));
    kpiGrid.append(c);
  };
  addKpi('全生态监控源', `${kpi.targetsCount ?? 0} 个`, `Foundation v${rt.foundationVersion || '0.39.0'}`);
  addKpi('活跃令牌锁 (token-lock)', `${kpi.locks?.activeCount ?? 0} 把`, `超时预警 ${kpi.locks?.staleWarnCount ?? 0} 把`, (kpi.locks?.staleWarnCount ?? 0) > 0 ? 'st-badge-amber' : 'st-badge-emerald');
  addKpi('事件哈希链 (state-store)', kpi.eventChain?.integrity || 'NO_STORE', `共 ${kpi.eventChain?.totalEvents ?? 0} 条事件`, kpi.eventChain?.integrity === 'CHAIN_BROKEN' ? 'st-badge-rose' : 'st-badge-emerald');
  addKpi('受管子进程 (supervise-process)', `${kpi.processes?.total ?? 0} 条`, `运行中 ${kpi.processes?.counts?.RUNNING ?? 0} · 超时 ${kpi.processes?.counts?.TIMED_OUT ?? 0}`);
  host.append(kpiGrid);

  if (!rt.currentRepoHasRuntime) {
    const emptyCard = el('div', null, 'st-card');
    emptyCard.style.padding = '18px 20px';
    emptyCard.style.marginBottom = '16px';
    emptyCard.append(
      el('h3', '当前仓库暂无正在运行的任务记录', ''),
      el('p', '当长程任务或脚本通过 skill-family-studio ensure 与 skill-family-kit monitor register 挂载执行计划、令牌锁或状态目录后，此处将实时显示锁读秒与事件哈希链。你也可以立即触发一次隔离沙箱演练体验真实运行态。', 'st-muted-xs'),
      el('pre', 'npx skill-family-studio ensure --root . --port 57630 --tab runtime\nnpx skill-family-kit monitor register --id task-01 --title "长程验证任务" --state-dir .runs/state --plan PLAN.md', 'st-code-block'),
    );
    emptyCard.firstChild.style.marginTop = '0';
    const sbxBtn = el('button', '▶ 运行隔离沙箱演练（体验真实 token-lock 与 state-store 事件链）', 'st-btn st-btn-primary');
    sbxBtn.type = 'button';
    sbxBtn.addEventListener('click', async () => {
      sbxBtn.disabled = true;
      sbxBtn.textContent = '正在执行沙箱演练…';
      await apiJson('/api/studio/runtime/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      renderRuntimePanel();
    });
    emptyCard.append(sbxBtn);
    host.append(emptyCard);
  }

  const targetsToShow = rt.currentRepoHasRuntime ? rt.currentRepoTargets : rt.ecosystemActiveTargets;
  const secCard = el('div', null, 'st-card');
  secCard.style.padding = '16px 20px';
  secCard.append(el('h3', rt.currentRepoHasRuntime ? '当前仓库运行态详情' : '全生态活跃运行态总览', ''));
  secCard.firstChild.style.marginTop = '0';

  if (!targetsToShow || !targetsToShow.length) {
    secCard.append(el('p', '全生态当前静默，无活跃令牌锁或未完成子进程。', 'st-muted-xs'));
  } else {
    secCard.append(buildRuntimeTargetsTable(targetsToShow, document));
  }
  host.append(secCard);
}

function renderActiveTab() {
  if (state.tab === 'guide') renderGuidePanel();
  else if (state.tab === 'graph') renderGraphPanel();
  else if (state.tab === 'review') renderReviewPanel();
  else if (state.tab === 'runtime') renderRuntimePanel();
}

async function selectRepo(repoId) {
  if (!repoId) return;
  state.repoId = repoId;
  state.graphMode = 'dag';
  state.archifyIdx = 0;
  state.archifySelectedNode = null;
  state.selectedAnchor = null;
  state.reviewCategory = 'all';
  const u = new URL(location.href);
  u.searchParams.set('repo', repoId);
  if (state.tab) u.searchParams.set('tab', state.tab);
  history.replaceState(null, '', u);
  const data = await apiJson(`/api/studio/repo?repo=${encodeURIComponent(repoId)}`);
  state.snap = data.snapshot;
  const def = pickDefaultArtifactNode(state.snap.nodes || []) || (state.snap.reviewItems || [])[0] || null;
  state.selectedUid = def ? def.uid : null;
  updateTopbarSummary();
  renderActiveTab();
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

  document.getElementById('st-theme-btn').addEventListener('click', () => {
    const nxt = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nxt;
    localStorage.setItem('st-theme', nxt);
    const frame = document.querySelector('.st-archify-frame');
    try { frame?.contentDocument?.documentElement?.setAttribute('data-theme', nxt); } catch {}
  });
  document.getElementById('st-help-btn').addEventListener('click', () => switchTab('guide'));
  document.getElementById('st-progress-capsule').addEventListener('click', openExportDrawer);
  document.getElementById('st-export-close').addEventListener('click', () => { document.getElementById('st-export-backdrop').hidden = true; });
  document.getElementById('st-copy-md-btn').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(document.getElementById('st-export-preview').textContent || '');
  });

  const trig = document.getElementById('st-repo-trigger');
  const pop = document.getElementById('st-repo-popover');
  trig.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { renderRepoPopover(); document.getElementById('st-repo-search').focus(); }
  });
  document.getElementById('st-repo-search').addEventListener('input', renderRepoPopover);
  document.querySelectorAll('.st-tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

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

  try {
    const es = new EventSource('/api/studio/events');
    es.addEventListener('review-change', async () => {
      const fresh = await apiJson('/api/studio/state');
      state.decisions = fresh.decisions || {};
      state.annotations = fresh.annotations || [];
      updateTopbarSummary();
    });
  } catch {}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot();
}
