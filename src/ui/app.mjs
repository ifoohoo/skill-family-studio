// @feature STU001
// @feature STU002
// @feature STU003
// @feature STU005
// @feature STU006

import { computeAdaptiveGraphLayout, pickDefaultArtifactNode } from '../graph-layout.mjs';
import { buildReviewStatusFlowSvg, buildTriLayerLockSvg } from './diagram-svg.mjs';
import { mountFleetMonitor, renderSafeMarkdownToDom } from './fleet-ui.mjs';
import { closeGlobalTooltip, GLOSSARY, infoTrigger, initTooltipManager, isTooltipOpen, renderEntityBrief, thWithInfo } from './tooltips.mjs';

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
  reviewStatusFilter: 'all',
  reviewQuery: '',
  reviewManualToggles: new Map(),
  docViewMode: 'summary', // 'summary' | 'raw'
  graphMode: 'dag',
  archifyIdx: 0,
  focusSubgraph: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  fullscreenGraph: false,
  selectedAnchor: null,
  archifySelectedNode: null,
  docCache: new Map(),
  repoCountsCache: new Map(),
  drafts: new Map(),
  writable: true,
  rtScope: 'repo', // 'repo' | 'workspace'
  rtSelectedTargetId: '__all__',
  rtView: 'tasks', // 'tasks' | 'fleet' | 'diag'
  rtSelectedPlanId: null,
  rtPlanFilter: 'all', // 'all' | 'in_progress' | 'completed'
  rtPlanQuery: '',
  rtTaskFilter: 'all', // 'all' | 'incomplete' | 'focus'
  rtTaskQuery: '',
  rtCollapsedTreeIds: new Set(),
  rtFleetFamilyId: null,
  rtFleetHostFilter: 'all',
  rtFleetPickerQuery: '',
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
  const cached = state.repoCountsCache?.get(repo.id);
  const total = state.snap?.repoId === repo.id
    ? (state.snap.reviewItems?.length || repo.reviewableCount || targets.size)
    : (cached?.reviewableCount ?? Math.max(repo.reviewableCount || 0, targets.size));
  return { approved, reviewing, changes, deferred, decided: approved + changes + deferred, total };
}

async function apiJson(url, options = {}) {
  const opts = { ...options };
  const method = String(opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers || {});
  if (method === 'POST' || method === 'DELETE') {
    headers.set('X-Studio-Request', '1');
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  opts.headers = headers;
  const res = await fetch(url, opts);
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

let toastTimer = null;
function showStudioToast(message, { tone = 'emerald', actionLabel = null, onAction = null, durationMs = 6000 } = {}) {
  const host = document.getElementById('st-toast-host');
  if (!host) return;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  host.replaceChildren();
  const bar = el('div', null, `st-toast-bar${tone === 'warn' ? ' is-warn' : (tone === 'error' ? ' is-error' : '')}`);
  const left = el('div', null, 'st-graph-controls');
  left.append(el('span', message));
  if (actionLabel && typeof onAction === 'function') {
    const act = el('button', actionLabel, 'st-btn');
    act.type = 'button';
    act.addEventListener('click', async () => {
      host.replaceChildren();
      await onAction();
    });
    left.append(act);
  }
  const closeBtn = el('button', '✕', 'st-btn');
  closeBtn.type = 'button';
  closeBtn.style.height = '26px';
  closeBtn.addEventListener('click', () => host.replaceChildren());
  bar.append(left, closeBtn);
  host.append(bar);
  if (durationMs > 0) {
    toastTimer = setTimeout(() => { host.replaceChildren(); toastTimer = null; }, durationMs);
  }
}

function renderTopContextBars() {
  const roBar = document.getElementById('st-readonly-bar');
  if (!roBar) return;
  if (!state.writable) {
    roBar.replaceChildren(el('span', '🔒 当前工作台处于只读浏览模式（--readonly）：审批签收、批注写入与挂载运行源操作已禁用，可正常浏览图谱、检索与查看汇总。'));
    roBar.hidden = false;
  } else {
    roBar.hidden = true;
  }
}

function updateTopbarSummary() {
  const curRepo = state.repos.find(r => r.id === state.repoId);
  document.getElementById('st-current-repo-name').textContent = curRepo ? (curRepo.displayName || curRepo.name) : '未发现受管仓库';

  const editMetaBtn = document.getElementById('st-edit-repo-meta-btn');
  if (editMetaBtn) editMetaBtn.hidden = !curRepo;

  const rolePair = document.getElementById('st-role-pair');
  const roleBadge = document.getElementById('st-repo-role-badge');
  const roleInfoSlot = document.getElementById('st-role-info-slot');
  if (rolePair && roleBadge && curRepo) {
    const rRole = curRepo.repoRole || 'standalone';
    roleBadge.textContent = curRepo.repoRoleLabel || '单项目仓';
    roleBadge.className = `st-badge ${rRole === 'portfolio' ? 'st-badge-amber' : (rRole === 'subproject' ? 'st-badge-emerald' : 'st-badge-zinc')}`;
    if (roleInfoSlot) roleInfoSlot.replaceChildren(infoTrigger(`role:${rRole}`, document));
    rolePair.hidden = false;
  } else if (rolePair) {
    rolePair.hidden = true;
  }

  const lockBadge = document.getElementById('st-repo-lock-badge');
  const lockInfoSlot = document.getElementById('st-lock-info-slot');
  if (state.repos.length === 0) {
    lockBadge.textContent = '空工作区';
    lockBadge.className = 'st-badge st-badge-zinc';
  } else if (state.snap?.versionLock) {
    lockBadge.textContent = state.snap.versionLock.badgeLabel;
    lockBadge.className = `st-badge st-badge-${state.snap.versionLock.badgeTone || 'zinc'}`;
  } else if (curRepo) {
    lockBadge.textContent = curRepo.versionLockLabel || '待核实';
    lockBadge.className = 'st-badge st-badge-zinc';
  }
  if (lockInfoSlot && state.repos.length > 0) {
    lockInfoSlot.replaceChildren(infoTrigger('versionLock', document));
  } else if (lockInfoSlot) {
    lockInfoSlot.replaceChildren();
  }

  const pText = document.getElementById('st-progress-text');
  if (curRepo) {
    const p = countRepoProgress(curRepo);
    pText.textContent =
      `审阅进度：已通过 ${p.approved} · 审阅中 ${p.reviewing} · 需修改 ${p.changes} · 暂缓 ${p.deferred} / 共 ${p.total} 项`;
  } else {
    pText.textContent = '审阅进度：已通过 0 · 审阅中 0 · 需修改 0 · 暂缓 0 / 共 0 项';
  }
  const progInfoSlot = document.getElementById('st-progress-info-slot');
  if (progInfoSlot && !progInfoSlot.childElementCount) {
    progInfoSlot.append(infoTrigger('progressCapsule', document));
  }
}

async function applyEcosystemUpdate(nextEco, preferRepoId = null) {
  state.repos = nextEco?.repos || [];
  const keepId = preferRepoId && state.repos.some(r => r.id === preferRepoId)
    ? preferRepoId
    : (state.repos.some(r => r.id === state.repoId) ? state.repoId : (nextEco?.primaryRepoId || state.repos[0]?.id || null));
  if (keepId) await selectRepo(keepId, { skipRender: true });
  else {
    state.repoId = null;
    state.snap = null;
    state.alignment = null;
    updateTopbarSummary();
  }
  renderActiveTab();
}

function openAddRepoModal() {
  if (!state.writable) {
    showStudioToast('当前处于只读模式（--readonly），无法添加本地项目。', { tone: 'warn' });
    return;
  }
  closeRepoPopover();
  document.getElementById('st-repo-modal')?.remove();
  const backdrop = el('div', null, 'st-modal-backdrop');
  backdrop.id = 'st-repo-modal';
  const modal = el('div', null, 'st-card st-modal');
  const head = el('div', null, 'st-repo-opt-head');
  head.append(el('h3', '＋ 添加受管本地项目', ''), (() => {
    const x = el('button', '✕', 'st-btn');
    x.type = 'button';
    x.addEventListener('click', () => backdrop.remove());
    return x;
  })());
  head.firstChild.style.margin = '0';

  const desc = el('p', '输入包含 artifact-graph.config.yaml 的本地仓库目录路径（相对当前启动目录或绝对路径均可）。所有登记仅保存在当前工作区配置文件中，不修改目标项目。', 'st-muted-xs');
  const mkField = (lbl, ph, val = '', req = false) => {
    const box = el('label', null, 'st-field');
    box.append(el('span', lbl, 'st-field-label'));
    const inp = el('input', null, 'st-input');
    inp.value = val;
    inp.placeholder = ph;
    inp.required = req;
    box.append(inp);
    return { box, inp };
  };
  const fPath = mkField('本地仓库路径 *', '例如：../another-skill-repo 或本地绝对路径', '', true);
  const fTitle = mkField('自定义显示名称（可选）', '留空则自动采用 package.json / .studio-workspace.json 名称', '');
  const fGroup = mkField('所属分组标签（可选）', '例如：我的技能域（留空则自动按父目录分组）', '');
  const fDesc = mkField('自定义项目说明（可选）', '留空则自动读取 package.json#description 或 README.md 首段', '');
  const errEl = el('div', '', 'st-guard-error');
  errEl.hidden = true;

  const actions = el('div', null, 'st-graph-controls');
  actions.style.justifyContent = 'flex-end';
  const cancelBtn = el('button', '取消', 'st-btn');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => backdrop.remove());
  const submitBtn = el('button', '✓ 确认添加并接入工作台', 'st-btn st-btn-primary');
  submitBtn.type = 'button';
  submitBtn.addEventListener('click', async () => {
    errEl.hidden = true;
    if (!fPath.inp.value.trim()) {
      errEl.textContent = '请填写要接入的本地仓库目录路径。';
      errEl.hidden = false;
      fPath.inp.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '接入中…';
    try {
      const res = await apiJson('/api/studio/repos/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: fPath.inp.value.trim(),
          title: fTitle.inp.value.trim(),
          groupLabel: fGroup.inp.value.trim(),
          description: fDesc.inp.value.trim(),
        }),
      });
      backdrop.remove();
      await applyEcosystemUpdate(res.ecosystem, res.addedRepoId);
      showStudioToast(`✓ 已接入本地项目（配置写入 ${res.storagePath}）`, { tone: 'emerald' });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = '✓ 确认添加并接入工作台';
    }
  });
  actions.append(cancelBtn, submitBtn);
  modal.append(head, desc, fPath.box, fTitle.box, fGroup.box, fDesc.box, errEl, actions);
  backdrop.append(modal);
  backdrop.addEventListener('click', ev => { if (ev.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
  fPath.inp.focus();
}

function openRepoMetaModal(repo) {
  if (!repo) return;
  closeRepoPopover();
  document.getElementById('st-repo-modal')?.remove();
  const backdrop = el('div', null, 'st-modal-backdrop');
  backdrop.id = 'st-repo-modal';
  const modal = el('div', null, 'st-card st-modal');
  const head = el('div', null, 'st-repo-opt-head');
  const leftHead = el('div', null, 'st-graph-controls');
  leftHead.append(el('h3', `✎ 项目说明与来源：${repo.displayName || repo.name}`, ''), infoTrigger('repo:provenance', document));
  leftHead.firstChild.style.margin = '0';
  const closeX = el('button', '✕', 'st-btn');
  closeX.type = 'button';
  closeX.addEventListener('click', () => backdrop.remove());
  head.append(leftHead, closeX);

  const srcBox = el('div', null, 'st-provenance-list');
  const sources = repo.metaSources || [];
  if (sources.length) {
    for (const s of sources) {
      const row = el('div', null, 'st-provenance-card');
      row.append(
        el('span', `${s.field}：${s.sourceFile}`, 'st-tabular'),
        el('span', s.active ? '✓ 当前生效' : '备选来源', `st-badge ${s.active ? 'st-badge-emerald' : 'st-badge-zinc'}`),
      );
      srcBox.append(row);
    }
  } else {
    srcBox.append(el('p', '当前使用仓库目录默认名称，可在下方补全中文说明。', 'st-muted-xs'));
  }

  const mkField = (lbl, val, ph) => {
    const box = el('label', null, 'st-field');
    box.append(el('span', lbl, 'st-field-label'));
    const inp = el('input', null, 'st-input');
    inp.value = val || '';
    inp.placeholder = ph;
    inp.disabled = !state.writable;
    box.append(inp);
    return { box, inp };
  };
  const fTitle = mkField('显示名称（自定义覆写）', repo.hasCustomMeta ? repo.displayName : '', `默认：${repo.originalName || repo.name}`);
  const fGroup = mkField('所属分组标签', repo.hasCustomMeta ? repo.groupLabel : '', `默认：${repo.originalGroupLabel || repo.groupLabel}`);
  const fDesc = mkField('项目一句话说明', repo.description || '', repo.originalDescription || '填写中文项目定位或职责说明…');
  const errEl = el('div', '', 'st-guard-error');
  errEl.hidden = true;

  const actions = el('div', null, 'st-repo-opt-head');
  const leftOps = el('div', null, 'st-graph-controls');
  if (state.repos.length > 1) {
    let confirmPending = false;
    const rmBtn = el('button', '从列表移除该项目', 'st-btn');
    rmBtn.type = 'button';
    rmBtn.disabled = !state.writable;
    rmBtn.addEventListener('click', async () => {
      if (!confirmPending) {
        confirmPending = true;
        rmBtn.textContent = '⚠️ 再次点击确认移除';
        rmBtn.classList.add('st-btn-amber');
        setTimeout(() => {
          confirmPending = false;
          rmBtn.textContent = '从列表移除该项目';
          rmBtn.classList.remove('st-btn-amber');
        }, 4000);
        return;
      }
      try {
        const res = await apiJson('/api/studio/repos/unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: repo.id }),
        });
        backdrop.remove();
        await applyEcosystemUpdate(res.ecosystem);
        showStudioToast(`✓ 已从当前工作台视图移除「${repo.name}」（未删除磁盘文件）`, { tone: 'emerald' });
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
    leftOps.append(rmBtn);
  }
  const rightOps = el('div', null, 'st-graph-controls');
  if (repo.hasCustomMeta) {
    const resetBtn = el('button', '恢复默认来源', 'st-btn');
    resetBtn.type = 'button';
    resetBtn.disabled = !state.writable;
    resetBtn.addEventListener('click', async () => {
      const res = await apiJson('/api/studio/repos/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repo.id, reset: true }),
      });
      backdrop.remove();
      await applyEcosystemUpdate(res.ecosystem, repo.id);
      showStudioToast('✓ 已恢复读取仓库原始名称与说明', { tone: 'emerald' });
    });
    rightOps.append(resetBtn);
  }
  const saveBtn = el('button', '💾 保存自定义说明', 'st-btn st-btn-primary');
  saveBtn.type = 'button';
  saveBtn.disabled = !state.writable;
  saveBtn.addEventListener('click', async () => {
    errEl.hidden = true;
    try {
      const res = await apiJson('/api/studio/repos/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoId: repo.id,
          title: fTitle.inp.value.trim(),
          groupLabel: fGroup.inp.value.trim(),
          description: fDesc.inp.value.trim(),
        }),
      });
      backdrop.remove();
      await applyEcosystemUpdate(res.ecosystem, repo.id);
      showStudioToast(`✓ 已保存自定义说明至 ${res.storagePath}`, { tone: 'emerald' });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
  rightOps.append(saveBtn);
  actions.append(leftOps, rightOps);
  modal.append(head, el('div', '以下信息来源由服务端真实探测生成，不修改受审仓库源码：', 'st-muted-xs'), srcBox, fTitle.box, fGroup.box, fDesc.box, errEl, actions);
  backdrop.append(modal);
  backdrop.addEventListener('click', ev => { if (ev.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

function renderRepoPopover() {
  const host = document.getElementById('st-repo-groups');
  const q = (document.getElementById('st-repo-search').value || '').trim().toLowerCase();
  host.replaceChildren();
  const filtered = state.repos.filter(r => !q || `${r.name} ${r.displayName || ''} ${r.groupLabel} ${r.repoRoleLabel || ''} ${r.description}`.toLowerCase().includes(q));
  const byGroup = new Map();
  for (const r of filtered) {
    if (!byGroup.has(r.groupLabel)) byGroup.set(r.groupLabel, []);
    byGroup.get(r.groupLabel).push(r);
  }
  if (!filtered.length) {
    host.append(el('p', '当前搜索条件下暂无匹配项目，可点右上角「＋ 添加本地项目」接入新仓库。', 'st-muted-xs'));
    return;
  }
  for (const [gLabel, list] of byGroup.entries()) {
    host.append(el('div', `${gLabel} (${list.length})`, 'st-repo-group-title'));
    for (const r of list) {
      const p = countRepoProgress(r);
      const row = el('div', null, `st-repo-item-row${r.id === state.repoId ? ' is-selected' : ''}`);
      const btn = el('button', null, 'st-repo-item-btn');
      btn.type = 'button';
      const head = el('div', null, 'st-repo-opt-head');
      const roleTone = r.repoRole === 'portfolio' ? 'st-badge-amber' : (r.repoRole === 'subproject' ? 'st-badge-emerald' : 'st-badge-zinc');
      const briefNode = renderEntityBrief(document, {
        title: r.displayName || r.name,
        summary: r.description,
        code: r.name !== (r.displayName || r.name) ? r.name : '',
        typeLabel: r.isExtraRepo ? '已手动接入' : '',
      }, { compact: true, showPath: false, maxSummaryChars: 86 });
      const badges = el('div', null, 'st-graph-controls');
      badges.append(el('span', r.repoRoleLabel || '单项目仓', `st-badge ${roleTone}`), el('span', `已审 ${p.decided}/${p.total}`, 'st-badge st-badge-indigo'));
      head.append(briefNode, badges);

      const foot = el('div', null, 'st-repo-opt-head');
      const metrics = el('div', null, 'st-repo-opt-metrics');
      const cachedCounts = state.repoCountsCache?.get(r.id);
      const graphNodes = cachedCounts?.nodeCount ?? r.nodeCount ?? 0;
      metrics.append(
        el('span', `图节点 ${graphNodes}`),
        el('span', `· ${r.versionLockLabel}`),
        el('span', `· ${r.runtimeLabel}`),
      );
      const ops = el('div', null, 'st-repo-actions');
      const editBtn = el('button', '✎ 说明与来源', 'st-btn st-btn-xs');
      editBtn.type = 'button';
      editBtn.addEventListener('click', ev => { ev.stopPropagation(); openRepoMetaModal(r); });
      ops.append(editBtn);
      btn.append(head);
      btn.addEventListener('click', () => {
        closeRepoPopover();
        selectRepo(r.id);
      });
      foot.append(metrics, ops);
      row.append(btn, foot);
      host.append(row);
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
let graphAbortCtrl = null;
function stopLockTicker() {
  if (lockTickTimer) {
    clearInterval(lockTickTimer);
    lockTickTimer = null;
  }
}

function getDraftKey(uid, repoId = state.repoId) {
  return uid ? `${repoId || ''}::${uid}` : '';
}

function hasSavedDraft(uid, repoId = state.repoId) {
  const d = state.drafts.get(getDraftKey(uid, repoId));
  return Boolean(d && (d.ann?.trim() || d.note?.trim()));
}

function switchTab(nextTab) {
  nextTab = normalizeUiTab(nextTab);
  closeRepoPopover();
  if (nextTab !== 'runtime') stopLockTicker();
  if (nextTab !== 'graph' && graphAbortCtrl) {
    graphAbortCtrl.abort();
    graphAbortCtrl = null;
  }
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
  if (typeof window !== 'undefined') window.scrollTo(0, 0);
  renderTopContextBars();
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
  state.reviewStatusFilter = 'all';
  state.reviewQuery = '';
  state.selectedAnchor = null;
  state.reviewMode = nextReviewMode;
  if (typeof window !== 'undefined') window.scrollTo(0, 0);
  switchTab(nextTab);
}

function findNextPendingHumanItem(currentUid = state.selectedUid) {
  const list = state.snap?.reviewItems ?? [];
  if (!list.length) return { item: null, allCompleted: false };
  const humanOnly = list.filter(i => !i.isMachineContract);
  const pool = humanOnly.length > 0 ? humanOnly : list;
  const idx = currentUid ? pool.findIndex(i => i.uid === currentUid) : -1;
  const ordered = idx >= 0 ? [...pool.slice(idx + 1), ...pool.slice(0, idx + 1)] : pool;
  for (const item of ordered) {
    if (item.uid === currentUid && pool.length > 1) continue;
    const eff = getEffectiveStatus(item.target || item.uid);
    if (eff === 'pending' || eff === 'reviewing') return { item, allCompleted: false };
  }
  const curItem = pool.find(i => i.uid === currentUid);
  const curEff = curItem ? getEffectiveStatus(curItem.target || curItem.uid) : null;
  if (curItem && (curEff === 'pending' || curEff === 'reviewing')) {
    return { item: curItem, allCompleted: false };
  }
  return { item: null, allCompleted: true };
}

function startGuidedReview() {
  const { item, allCompleted } = findNextPendingHumanItem(null);
  if (item) state.selectedUid = item.uid;
  else if (allCompleted) showStudioToast('🎉 当前仓库人读审阅项已全部签收完成', { tone: 'emerald' });
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

async function submitDecision(rawTarget, status, note, andAdvance = false, undoContext = null) {
  if (!state.writable) {
    showStudioToast('当前处于只读模式（--readonly），无法写入审阅结论。', { tone: 'warn' });
    return;
  }
  const scrollSnap = andAdvance ? null : captureReviewScroll();
  const payload = { repo: state.repoId, target: rawTarget, status };
  if (note !== undefined) payload.note = note;
  try {
    const res = await apiJson('/api/studio/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.decisions = res.decisions || {};
    if (undoContext?.prevUid) {
      const dk = getDraftKey(undoContext.prevUid);
      const prevD = state.drafts.get(dk);
      if (prevD) {
        if (prevD.ann?.trim() || prevD.anchor) state.drafts.set(dk, { ...prevD, note: '' });
        else state.drafts.delete(dk);
      }
    }
    let finishedAll = false;
    if (andAdvance) {
      const { item: nextItem, allCompleted } = findNextPendingHumanItem(state.selectedUid);
      if (nextItem) state.selectedUid = nextItem.uid;
      else finishedAll = allCompleted;
    }
    updateTopbarSummary();
    renderActiveTab();
    restoreReviewScroll(scrollSnap);

    const unresolvedCount = getTargetAnnotations(rawTarget).filter(a => !a.resolved).length;
    if (status === 'pending' && unresolvedCount > 0) {
      showStudioToast(`已清除终态结论；因当前仍有 ${unresolvedCount} 条未解决批注，状态保持为「🔵 审阅中」`, {
        tone: 'warn',
        durationMs: 5500,
      });
    } else if (undoContext) {
      const stLbl = (STATUS_META[status] || STATUS_META.pending).label;
      const suffix = andAdvance && finishedAll ? ' · 🎉 当前仓库人读审阅项已全部签收完成，可点「③ 导出验收结论」' : '';
      showStudioToast(`✓ 已将「${undoContext.code}」更新为「${stLbl}」${suffix}`, {
        tone: 'emerald',
        durationMs: 5500,
        actionLabel: andAdvance ? '撤销并回到该篇' : '撤销刚才操作',
        onAction: async () => {
          await apiJson('/api/studio/decisions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repo: undoContext.repoId,
              target: undoContext.prevRawTarget,
              status: undoContext.prevStatus,
              note: undoContext.prevNote,
            }),
          });
          await jumpToRepoAndItem(undoContext.repoId, undoContext.prevUid, state.tab === 'graph' ? 'graph' : 'review', 'reader');
          const fresh = await apiJson('/api/studio/state');
          state.decisions = fresh.decisions || {};
          updateTopbarSummary();
          renderActiveTab();
        },
      });
    }
  } catch (err) {
    showStudioToast(`保存审阅结论失败：${err.message}`, { tone: 'error' });
  }
}

async function mutateAnnotation(payload, { silentRender = false } = {}) {
  if (!state.writable) {
    showStudioToast('当前处于只读模式（--readonly），无法增改批注。', { tone: 'warn' });
    return false;
  }
  const scrollSnap = captureReviewScroll();
  try {
    const res = await apiJson('/api/studio/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: state.repoId, ...payload }),
    });
    state.annotations = res.annotations || [];
    if (res.decisions) state.decisions = res.decisions;
    updateTopbarSummary();
    if (!silentRender) {
      renderActiveTab();
      restoreReviewScroll(scrollSnap);
    }
    return true;
  } catch (err) {
    showStudioToast(`保存批注失败：${err.message}`, { tone: 'error' });
    return false;
  }
}

function resolveCompanionItem(item) {
  if (!item || !state.snap) return null;
  const list = [...(state.snap.reviewItems || []), ...(state.snap.nodes || [])];
  if (item.pairedUid) {
    const hit = list.find(x => x.uid === item.pairedUid);
    if (hit) return hit;
  }
  if (item.pairedPath) {
    const byPath = list.find(x => x.path === item.pairedPath);
    if (byPath) return byPath;
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
  );
  const rightBtns = el('div', null, 'st-graph-controls');
  const approveNextBtn = el('button', '✓ 通过并审下一项 →', 'st-btn st-btn-emerald');
  approveNextBtn.type = 'button';
  approveNextBtn.disabled = !state.writable;

  rightBtns.append(approveNextBtn);
  actionBar.append(leftInfo, rightBtns);
  container.append(actionBar);

  // 同源 Markdown <-> JSON 数据契约互跳条
  const companion = resolveCompanionItem(item);
  if (companion || item.isMachineContract) {
    const pairBar = el('div', null, 'st-contract-pair-bar');
    const pairLeft = el('div', null, 'st-graph-controls');
    if (companion) {
      const jumpLabel = item.isMachineContract
        ? `📖 切换到对应的人读版 Markdown 文档（${companion.title || companion.code}）→`
        : `🗂️ 查看对应的结构化数据契约（${companion.title || companion.code}）→`;
      const jumpBtn = el('button', jumpLabel, 'st-jump-pill');
      jumpBtn.type = 'button';
      jumpBtn.title = companion.path || '';
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
      const upLabel = b.upstreamTitle && b.upstreamTitle !== b.upstreamUid
        ? `${b.upstreamTitle} (${b.upstreamCode || b.upstreamUid})`
        : b.upstreamUid;
      const pill = el('button', `${upInfo.upstreamRepoName} · ${upLabel}`, 'st-jump-pill');
      pill.type = 'button';
      pill.title = b.upstreamSummary || b.upstreamTitle || b.upstreamUid;
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
      const labelTxt = `${targetItem?.title || b.pageId}${b.anchor ? ` #${b.anchor}` : ''}`;
      const isCur = targetItem?.uid === item.uid && (b.anchor || null) === anchorId;
      const chipBtn = el('button', labelTxt, `st-btn${isCur ? ' is-active' : ''}`);
      chipBtn.type = 'button';
      chipBtn.title = `${targetItem?.code || b.pageId}${targetItem?.path ? ` · ${targetItem.path}` : ''}`;
      chipBtn.style.height = '26px';
      chipBtn.style.fontSize = '11.5px';
      chipBtn.addEventListener('click', () => {
        if (!targetItem) return;
        state.selectedUid = targetItem.uid;
        state.selectedAnchor = b.anchor || null;
        mountDocumentReader(container, targetItem, { ...options, anchorId: state.selectedAnchor, archifyContext });
      });
      bindBar.append(chipBtn);
    }
    container.append(bindBar);
  }

  const readerLayout = el('div', null, 'st-reader-layout');
  const mainCol = el('div', null, 'st-reader-main');
  const dockCol = el('div', null, 'st-reader-dock');

  const draftKey = getDraftKey(item.uid);
  const savedDraft = state.drafts.get(draftKey) || null;
  let pendingAnchorId = savedDraft?.anchor ?? null;
  const anchorPillBtn = el('button', '', 'st-anchor-pill');
  anchorPillBtn.type = 'button';
  anchorPillBtn.hidden = true;
  const syncAnchorPill = () => {
    if (pendingAnchorId) {
      anchorPillBtn.textContent = `批注定位章节：#${pendingAnchorId} ×`;
      anchorPillBtn.hidden = false;
    } else {
      anchorPillBtn.hidden = true;
    }
  };
  syncAnchorPill();

  const guardErrEl = el('div', '', 'st-guard-error');
  guardErrEl.hidden = true;
  const showDockError = msg => {
    guardErrEl.textContent = msg;
    guardErrEl.hidden = !msg;
  };

  const quickStatusRow = el('div', null, 'st-graph-toolbar');
  const statusGroup = el('div', null, 'st-graph-controls');
  const noteInput = el('input', null, 'st-input');
  noteInput.style.maxWidth = '320px';
  noteInput.placeholder = '审阅结论备注（可选，回车或点状态保存）…';
  noteInput.value = savedDraft?.note !== undefined ? savedDraft.note : (curDec.note || '');
  noteInput.disabled = !state.writable;

  const annBox = el('div', null, 'st-ann-box');
  annBox.append(el('div', `审阅批注（共 ${anns.length} 条，添加未解决批注即自动点亮「🔵 审阅中」；全部解决或清空且未给结论时自动回到「⚪ 待审阅」）`, 'st-muted-xs'));
  const annInput = el('textarea', null, 'st-textarea');
  annInput.style.marginTop = '8px';
  annInput.placeholder = '记录本篇具体修改意见或疑问，点击下方「＋ 添加批注（自动转入审阅中）」立即落盘…';
  annInput.value = savedDraft?.ann || '';
  annInput.disabled = !state.writable;

  const syncDraftStore = () => {
    if (!draftKey) return;
    const annVal = annInput.value;
    const noteVal = noteInput.value;
    const noteModified = noteVal !== (curDec.note || '');
    if (annVal.trim() || pendingAnchorId || noteModified) {
      state.drafts.set(draftKey, {
        ann: annVal,
        note: noteModified ? noteVal : undefined,
        anchor: pendingAnchorId,
      });
    } else {
      state.drafts.delete(draftKey);
    }
    const curBtn = document.querySelector(`#st-panel-review .st-review-item-btn[data-uid="${CSS.escape(item.uid)}"]`);
    if (curBtn) {
      let badge = curBtn.querySelector('.st-draft-tag');
      const hasD = Boolean(annVal.trim() || (noteModified && noteVal.trim()));
      if (hasD && !badge) {
        badge = el('span', '📝 草稿', 'st-draft-tag');
        curBtn.querySelector('.st-repo-opt-head')?.append(badge);
      } else if (!hasD && badge) {
        badge.remove();
      }
    }
  };

  anchorPillBtn.addEventListener('click', () => {
    pendingAnchorId = null;
    syncAnchorPill();
    syncDraftStore();
  });
  annInput.addEventListener('input', syncDraftStore);
  noteInput.addEventListener('input', syncDraftStore);

  const flushPendingDraftIfNeeded = async () => {
    const draft = annInput.value.trim();
    if (!draft) return false;
    const saved = await mutateAnnotation(
      { action: 'create', target: rawTarget, body: draft, ...(pendingAnchorId ? { anchor: pendingAnchorId } : {}) },
      { silentRender: true },
    );
    if (saved) {
      annInput.value = '';
      pendingAnchorId = null;
      syncAnchorPill();
      syncDraftStore();
      showStudioToast('已自动保存未提交的批注草稿并更新状态', { tone: 'emerald' });
    }
    return saved;
  };

  const handleStatusCommit = async (stKey, andAdvance = false) => {
    if (!state.writable) {
      showStudioToast('当前处于只读模式（--readonly），无法写入审阅结论。', { tone: 'warn' });
      return;
    }
    showDockError('');
    if (stKey === 'changes_requested') {
      const hasUnresolved = getTargetAnnotations(rawTarget).some(a => !a.resolved);
      if (!hasUnresolved && !noteInput.value.trim() && !annInput.value.trim()) {
        showDockError('请先写至少一条批注或在上方填写修改原因，再标为「需修改」');
        annInput.focus();
        return;
      }
    }
    await flushPendingDraftIfNeeded();
    const undoContext = {
      repoId: state.repoId,
      prevUid: item.uid,
      prevRawTarget: rawTarget,
      prevStatus: curDec.status || 'pending',
      prevNote: curDec.note || '',
      code: item.code || item.uid,
    };
    if (stKey === 'pending') {
      noteInput.value = '';
      state.drafts.delete(draftKey);
      await submitDecision(rawTarget, 'pending', '', false, undoContext);
      return;
    }
    await submitDecision(rawTarget, stKey, noteInput.value, andAdvance, undoContext);
  };

  approveNextBtn.addEventListener('click', () => handleStatusCommit('approved', true));

  statusGroup.append(el('span', '审阅签收', 'st-muted-xs'), infoTrigger('review:statusRules', document));
  for (const [stKey, label, btnTitle] of [
    ['approved', '🟢 标为已通过', '确认内容准确并签收通过'],
    ['reviewing', '🔵 标为审阅中', '作为阅读书签暂时搁置或标为正在梳理意见（写批注也会自动点亮）'],
    ['changes_requested', '🟠 需修改', '退回作者根据批注整改（需填写批注或说明）'],
    ['deferred', '🟣 暂缓', '本轮不阻断，留待后续波次处理'],
    ['pending', '⚪ 重置待审', '清除终态结论与备注，重置回待审状态'],
  ]) {
    const b = el('button', label, `st-btn${eff === stKey ? ' is-active' : ''}`);
    b.type = 'button';
    b.title = btnTitle;
    b.disabled = !state.writable;
    b.addEventListener('click', () => handleStatusCommit(stKey, false));
    statusGroup.append(b);
  }
  noteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleStatusCommit(curDec.status || eff, false);
  });
  quickStatusRow.append(statusGroup, noteInput);

  const jumpDockBar = el('div', null, 'st-jump-dock-bar');
  const jumpDockBtn = el('button', '↓ 跳至批注签收区', 'st-btn');
  jumpDockBtn.type = 'button';
  jumpDockBtn.addEventListener('click', () => dockCol.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  jumpDockBar.append(el('span', '正在长文阅读模式', 'st-muted-xs'), jumpDockBtn);

  const proseWrap = el('article', null, 'st-prose-container');
  proseWrap.append(el('p', '正在加载制品正文…', 'st-muted-xs'));

  const addAnnBtn = el('button', '＋ 添加批注（自动转入审阅中）', 'st-btn st-btn-primary');
  addAnnBtn.type = 'button';
  addAnnBtn.style.marginTop = '8px';
  addAnnBtn.disabled = !state.writable;
  addAnnBtn.addEventListener('click', async () => {
    showDockError('');
    const val = annInput.value.trim();
    if (!val) {
      showDockError('请先填写批注内容后再提交。');
      annInput.focus();
      return;
    }
    const ok = await mutateAnnotation({
      action: 'create',
      target: rawTarget,
      body: val,
      ...(pendingAnchorId ? { anchor: pendingAnchorId } : {}),
    });
    if (ok) {
      annInput.value = '';
      pendingAnchorId = null;
      syncAnchorPill();
      syncDraftStore();
    }
  });
  annBox.append(anchorPillBtn, annInput, guardErrEl, addAnnBtn);

  let bodyDivRef = null;
  for (const a of anns) {
    const row = el('div', null, `st-ann-item${a.resolved ? ' is-resolved' : ''}`);
    const head = el('div', null, 'st-repo-opt-head');
    const headLeft = el('div', null, 'st-graph-controls');
    headLeft.append(el('span', `${a.resolved ? '✓ 已解决' : '● 待解决'} ·`, 'st-muted-xs'));
    if (a.anchor) {
      const ancBtn = el('button', `#${a.anchor}`, 'st-ann-anchor-btn');
      ancBtn.type = 'button';
      ancBtn.addEventListener('click', () => {
        if (!bodyDivRef) return;
        const targetHeading = bodyDivRef.querySelector(`#${CSS.escape(a.anchor)}`)
          || [...bodyDivRef.querySelectorAll('.st-prose-heading')].find(h => String(h.id || '').endsWith(`-${a.anchor}`));
        if (targetHeading) {
          bodyDivRef.querySelectorAll('.is-anchor-hit').forEach(x => x.classList.remove('is-anchor-hit'));
          targetHeading.classList.add('is-anchor-hit');
          targetHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      headLeft.append(ancBtn);
    } else {
      headLeft.append(el('span', '全文批注', 'st-muted-xs'));
    }
    head.append(
      headLeft,
      (() => {
        const g = el('div', null, 'st-graph-controls');
        const tBtn = el('button', a.resolved ? '重新打开' : '标为已解决', 'st-btn');
        tBtn.type = 'button';
        tBtn.disabled = !state.writable;
        tBtn.addEventListener('click', () => mutateAnnotation({ action: 'toggle', id: a.id }));
        const dBtn = el('button', '删除', 'st-btn');
        dBtn.type = 'button';
        dBtn.disabled = !state.writable;
        dBtn.addEventListener('click', () => mutateAnnotation({ action: 'delete', id: a.id }));
        g.append(tBtn, dBtn);
        return g;
      })(),
    );
    row.append(head, el('div', a.body, ''));
    annBox.append(row);
  }

  mainCol.append(jumpDockBar, proseWrap);
  dockCol.append(quickStatusRow, annBox);
  readerLayout.append(mainCol, dockCol);
  container.append(readerLayout);

  const activeRepoId = state.snap?.repoId || state.repoId;
  const cacheKey = `${activeRepoId}::${item.uid}::${item.path}`;
  let doc = state.docCache.get(cacheKey);
  if (!doc) {
    try {
      const q = new URLSearchParams({ repo: activeRepoId || '', path: item.path || '', uid: item.uid || '' });
      doc = await apiJson(`/api/studio/doc?${q}`);
      state.docCache.set(cacheKey, doc);
    } catch (err) {
      proseWrap.replaceChildren(el('p', `读取原件失败：${err.message}`, 'st-muted-xs'));
      return;
    }
  }
  proseWrap.replaceChildren();
  const hasHero = String(doc.html || '').includes('st-doc-hero');
  const bodyDiv = el('div');
  bodyDivRef = bodyDiv;
  bodyDiv.innerHTML = doc.html || '';
  if (doc.isMachineContract && state.docViewMode === 'raw') {
    bodyDiv.hidden = true;
    const h1 = el('h1', doc.title || item.title);
    h1.style.marginTop = '0';
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
        pendingAnchorId = anc.dataset.anchorId || null;
        syncAnchorPill();
        syncDraftStore();
        annInput.focus();
      }
    });
    if (hasHero) {
      proseWrap.append(bodyDiv);
    } else {
      const h1 = el('h1', doc.title || item.title);
      h1.style.marginTop = '0';
      proseWrap.append(h1, bodyDiv);
    }
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
    document.getElementById('st-repo-search')?.focus();
  } else if (actionId === 'go-tab-graph') switchTab('graph');
  else if (actionId === 'go-tab-alignment') { state.reviewMode = 'alignment'; switchTab('review'); }
  else if (actionId === 'start-guided-review') startGuidedReview();
  else if (actionId === 'go-tab-cross-doc') {
    const upBinding = (state.alignment?.upstreamBindings?.bindings || [])[0];
    const pfDrift = (state.alignment?.portfolio?.items || []).find(i => (i.issues || []).length > 0);
    if (upBinding) {
      jumpToRepoAndItem(state.repoId, upBinding.localUid, 'review', 'reader');
    } else if (pfDrift?.allocations?.[0]?.targetRepoId) {
      jumpToRepoAndItem(pfDrift.allocations[0].targetRepoId, pfDrift.allocations[0].targetUid, 'review', 'reader');
    } else {
      state.reviewMode = 'reader';
      switchTab('review');
    }
  } else if (actionId === 'go-tab-review') { state.reviewMode = 'reader'; switchTab('review'); }
  else if (actionId === 'open-export-drawer') openExportDrawer();
  else if (actionId === 'go-tab-runtime') { state.rtView = 'tasks'; switchTab('runtime'); }
  else if (actionId === 'go-tab-fleet') { state.rtView = 'fleet'; switchTab('runtime'); }
  else if (actionId === 'go-tab-diag') { state.rtView = 'diag'; switchTab('runtime'); }
}

function wrapProseTable(tbl) {
  const wrap = el('div', null, 'st-table-wrap');
  wrap.append(tbl);
  return wrap;
}

function renderGuidePanel() {
  const host = document.getElementById('st-panel-guide');
  host.replaceChildren();
  const g = state.guide;
  if (!g) return;

  const noRepos = state.repos.length === 0;
  const repoActionIds = new Set(['open-repo-switcher', 'go-tab-graph', 'go-tab-alignment', 'start-guided-review', 'go-tab-cross-doc', 'go-tab-review', 'open-export-drawer']);

  const banner = el('div', null, 'st-guided-banner');
  const bLeft = el('div');
  bLeft.append(el('h1', g.title, ''), el('p', g.subtitle, 'st-muted-xs'));
  bLeft.firstChild.style.margin = '0 0 4px 0';
  bLeft.lastChild.style.margin = '0';
  if (noRepos) {
    bLeft.append(el('p', '提示：当前工作区尚未发现受管仓库，涉及具体仓库审阅与图谱的直达按钮已置灰；你仍可前往「⚡ 运行监控」查看本机智能体会话或运行沙箱演练。', 'st-guard-error'));
  }
  const bRight = el('div', null, 'st-graph-controls');
  const alignQuickBtn = el('button', '📋 查看需求进展与双向对齐总览', 'st-btn');
  alignQuickBtn.type = 'button';
  alignQuickBtn.disabled = noRepos;
  if (noRepos) alignQuickBtn.title = '当前工作区未发现受管仓库';
  alignQuickBtn.addEventListener('click', () => triggerGuideAction('go-tab-alignment'));
  const startBtn = el('button', '▶ 开始按推荐顺序审阅（故事 → 需求 → 场景）', 'st-btn st-btn-primary');
  startBtn.type = 'button';
  startBtn.disabled = noRepos;
  if (noRepos) startBtn.title = '当前工作区未发现受管仓库';
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
    csCard.append(wrapProseTable(tbl), ul);

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
        if (noRepos && repoActionIds.has(s.actionId)) {
          act.disabled = true;
          act.title = '当前工作区未发现受管仓库';
        }
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
      box.style.display = 'flex';
      box.style.flexDirection = 'column';
      box.style.justifyContent = 'space-between';
      const inner = el('div');
      inner.append(el('h3', page.page, ''), el('p', `何时看这里：${page.when}`, 'st-muted-xs'));
      inner.firstChild.style.margin = '0 0 4px 0';
      const ul = el('ul');
      for (const a of page.areas || []) ul.append(el('li', a));
      inner.append(ul);
      box.append(inner);
      if (page.actionId && page.actionLabel) {
        const goBtn = el('button', page.actionLabel, 'st-btn st-btn-primary');
        goBtn.type = 'button';
        goBtn.style.alignSelf = 'flex-start';
        goBtn.style.marginTop = '8px';
        if (noRepos && repoActionIds.has(page.actionId)) {
          goBtn.disabled = true;
          goBtn.title = '当前工作区未发现受管仓库';
        }
        goBtn.addEventListener('click', () => triggerGuideAction(page.actionId));
        box.append(goBtn);
      }
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
  diagCard.append(wrapProseTable(tbl));

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
    const driftWrap = wrapProseTable(driftTbl);
    driftWrap.style.marginTop = '12px';
    diagCard.append(wrapProseTable(satTbl), driftWrap);
  }
  if (Array.isArray(g.shortcutsAndGuards) && g.shortcutsAndGuards.length > 0) {
    diagCard.append(el('h3', '3. 常用操作防呆与快捷键速查', ''));
    const scTbl = el('table', null, 'st-prose-table');
    const scHead = el('thead');
    const scHr = el('tr');
    scHr.append(el('th', '快捷键 / 触发行为'), el('th', '精确结果与防呆保护'));
    scHead.append(scHr);
    const scBody = el('tbody');
    for (const row of g.shortcutsAndGuards) {
      const tr = el('tr');
      const td1 = el('td');
      td1.append(el('code', row.key));
      tr.append(td1, el('td', row.desc));
      scBody.append(tr);
    }
    scTbl.append(scHead, scBody);
    diagCard.append(wrapProseTable(scTbl));
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
      '# 只读探测当前仓库角色（单仓 / 高阶仓 / 详设子仓）与推荐启动参数',
      'npx skill-family-studio inspect-setup --root /absolute/project/path --json',
      '',
      '# 按单仓或关联套组安全生成 .studio-workspace.json',
      'npx skill-family-studio init-workspace --root /absolute/project/path --mode related',
      '',
      '# 幂等守护启动或复用单端口控制台（若已有实例未收录当前仓，会自动隔离分配空闲端口）',
      'npx skill-family-studio ensure --root /absolute/project/path --port 57630',
      '',
      '# 离线导出设计态、双向对齐与运行态快照',
      'npx skill-family-studio snapshot --root /absolute/project/path',
      '',
      '# 核验本地 Node.js 版本、离线前端资产与仓库发现状态',
      'npx skill-family-studio doctor --root /absolute/project/path',
    ].join('\n'), 'st-code-block'));
    cliBody.append(
      el('p', '声明式多仓配置 .studio-workspace.json 示例（可放在高阶规划仓根目录，或等价写入 artifact-graph.config.yaml 顶层 studio 节）：', 'st-muted-xs'),
      el('pre', [
        '{',
        '  "schemaVersion": "1.0",',
        '  "role": "portfolio",',
        '  "title": "我的业务域规划工作区",',
        '  "scanRoots": ["..", "../sub-skills"],',
        '  "groupLabels": { "my-domain": "业务域技能族" },',
        '  "collections": [',
        '    { "id": "domain-stories", "kind": "lifecycle-story-pack", "storiesJson": "artifacts/stories/stories.json", "explanationsDir": "artifacts/stories/explanations" },',
        '    { "id": "business-diagrams", "kind": "archify-model-scenes", "manifestJson": "artifacts/diagrams/model-and-scenes.json" }',
        '  ]',
        '}',
      ].join('\n'), 'st-code-block'),
    );
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
  if (graphAbortCtrl) { graphAbortCtrl.abort(); graphAbortCtrl = null; }
  if (graphResizeRafId) { cancelAnimationFrame(graphResizeRafId); graphResizeRafId = 0; }
  if (graphResizeObserver) { graphResizeObserver.disconnect(); graphResizeObserver = null; }
  if (state.repos.length === 0) {
    const empty = el('div', null, 'st-card st-guide-section');
    empty.append(
      el('h3', '当前工作区未发现受管仓库', ''),
      el('p', '请从包含 artifact-graph.config.yaml 的技能族目录启动，或直接点击下方按钮添加本地项目仓库。', 'st-muted-xs'),
    );
    empty.firstChild.style.marginTop = '0';
    const addBtn = el('button', '＋ 添加本地项目', 'st-btn st-btn-primary');
    addBtn.type = 'button';
    addBtn.disabled = !state.writable;
    addBtn.addEventListener('click', openAddRepoModal);
    empty.append(addBtn);
    host.append(empty);
    return;
  }
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
      const nonDagItem = (state.snap.reviewItems || []).find(i => i.uid === state.selectedUid);
      if (nonDagItem) {
        locatorLeft.append(
          el('span', '当前位置：', 'st-muted-xs'),
          el('span', '非图谱附属文稿', 'st-badge st-badge-zinc'),
          el('strong', nonDagItem.title || nonDagItem.code || nonDagItem.uid),
          el('span', `(${nonDagItem.code || nonDagItem.uid} · 可在右侧继续阅读签收)`, 'st-muted-xs'),
        );
      } else {
        locatorLeft.append(el('span', '当前位置：请点击任意图谱节点查看上下游依赖与正文（节点坐标始终保持恒定）', 'st-muted-xs'));
      }
      if (state.fullscreenGraph) {
        const openSide = el('button', '退出全屏对照右侧正文 →', 'st-btn st-btn-primary');
        openSide.type = 'button';
        openSide.addEventListener('click', () => {
          state.fullscreenGraph = false;
          split.classList.remove('is-fullscreen');
          if (fsBtnRef) { fsBtnRef.classList.remove('is-active'); fsBtnRef.textContent = '全屏画布'; }
          updateLocatorBar();
        });
        locatorRight.append(openSide);
      }
      return;
    }
    const edges = state.snap.edges || [];
    const upEdges = edges.filter(e => e.to === curNode.uid);
    const downEdges = edges.filter(e => e.from === curNode.uid);
    locatorLeft.append(
      el('span', '当前位置：', 'st-muted-xs'),
      el('span', curNode.layerLabel || curNode.layer, 'st-badge st-badge-indigo'),
      infoTrigger(`layer:${curNode.layer}`, document),
      el('strong', curNode.title || curNode.code),
      ...(curNode.code && curNode.code !== curNode.title ? [el('span', curNode.code, 'st-badge st-badge-zinc')] : []),
      el('span', `上游 ${upEdges.length} 项 / 下游 ${downEdges.length} 项`, 'st-muted-xs'),
    );
    if (state.focusSubgraph && upEdges.length === 0 && downEdges.length === 0) {
      locatorLeft.append(el('span', '当前节点暂无上下游连线', 'st-badge st-badge-amber'));
    }
    const edgeKinds = [...new Set([...upEdges, ...downEdges].map(e => e.kind))].slice(0, 3);
    for (const ek of edgeKinds) {
      if (['implements', 'verifies', 'covers', 'derives-from'].includes(ek)) {
        locatorLeft.append(el('span', ek, 'st-badge st-badge-zinc'), infoTrigger(`edge:${ek}`, document));
      }
    }
    if (state.fullscreenGraph) {
      const openSide = el('button', '退出全屏对照右侧正文 →', 'st-btn st-btn-primary');
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

    const subBtn = mkCtrl('仅看上下游关联子图', state.focusSubgraph, () => {
      state.focusSubgraph = !state.focusSubgraph;
      subBtn.classList.toggle('is-active', state.focusSubgraph);
      updateLocatorBar();
      paintSvgCanvas();
    });
    const zoomOutBtn = mkCtrl('－', false, () => {
      state.zoom = Math.max(0.4, Number((state.zoom - 0.15).toFixed(2)));
      applyZoomInPlace();
    });
    zoomBadgeBtn = el('span', `${Math.round(state.zoom * 100)}%`, 'st-zoom-readout');
    const zoomInBtn = mkCtrl('＋', false, () => {
      state.zoom = Math.min(2.4, Number((state.zoom + 0.15).toFixed(2)));
      applyZoomInPlace();
    });
    const resetBtn = mkCtrl('重置视角', false, () => {
      state.zoom = 1; state.panX = 0; state.panY = 0; state.focusSubgraph = false;
      subBtn.classList.remove('is-active');
      applyZoomInPlace();
      updateLocatorBar();
      paintSvgCanvas();
    });
    fsBtnRef = mkCtrl(state.fullscreenGraph ? '退出全屏' : '全屏画布', state.fullscreenGraph, () => {
      state.fullscreenGraph = !state.fullscreenGraph;
      split.classList.toggle('is-fullscreen', state.fullscreenGraph);
      fsBtnRef.classList.toggle('is-active', state.fullscreenGraph);
      fsBtnRef.textContent = state.fullscreenGraph ? '退出全屏' : '全屏画布';
      updateLocatorBar();
    });
    canvasControls.append(
      subBtn, infoTrigger('subgraphOnly', document),
      zoomOutBtn, zoomBadgeBtn, zoomInBtn, resetBtn, fsBtnRef,
    );
  } else {
    const totalArch = state.snap.archifyDiagrams.length;
    const curFig = state.snap.archifyDiagrams[state.archifyIdx];
    const docMatch = curFig?.docPageId ? resolveStudioItemByPageId(curFig.docPageId) : null;
    if (totalArch > 1) {
      const prevArch = el('button', '◀ 上一张', 'st-btn');
      prevArch.type = 'button';
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
      nextArch.addEventListener('click', () => {
        state.archifyIdx = (state.archifyIdx + 1) % totalArch;
        syncArchifyDefaultDoc(state.snap.archifyDiagrams[state.archifyIdx]);
        renderGraphPanel();
      });
      canvasControls.append(prevArch, sel, nextArch);
    } else if (curFig) {
      canvasControls.append(el('span', `当前业务图：${curFig.title}`, 'st-badge st-badge-indigo'));
    }
    if (docMatch) {
      canvasControls.append(el('span', `关联正文：${docMatch.code || docMatch.title}`, 'st-badge st-badge-zinc'));
    }
    canvasControls.append(el('span', '点击节点联动右侧章节', 'st-muted-xs'));
    fsBtnRef = el('button', state.fullscreenGraph ? '退出全屏' : '全屏画布', `st-btn${state.fullscreenGraph ? ' is-active' : ''}`);
    fsBtnRef.type = 'button';
    fsBtnRef.addEventListener('click', () => {
      state.fullscreenGraph = !state.fullscreenGraph;
      split.classList.toggle('is-fullscreen', state.fullscreenGraph);
      fsBtnRef.classList.toggle('is-active', state.fullscreenGraph);
      fsBtnRef.textContent = state.fullscreenGraph ? '退出全屏' : '全屏画布';
      if (!state.fullscreenGraph) floatBar.hidden = true;
    });
    canvasControls.append(fsBtnRef);
  }
  toolbar.append(modeControls, canvasControls);
  leftCard.append(toolbar);
  if (state.graphMode === 'dag') leftCard.append(locatorBar);

  if (state.graphMode === 'archify' && state.snap.archifyDiagrams[state.archifyIdx]) {
    const fig = state.snap.archifyDiagrams[state.archifyIdx];
    const curTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const stage = el('div', null, 'st-archify-stage');
    const iframe = el('iframe', null, 'st-archify-frame');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.title = fig.title;
    iframe.src = `/api/studio/archify/${encodeURIComponent(state.repoId)}/${fig.htmlPath}?theme=${encodeURIComponent(curTheme)}&embed=1`;

    const bindArchifyNodeSelection = (nodeId, nodeLabel) => {
      if (!nodeId) return;
      const allBindings = Array.isArray(fig.bindings) ? fig.bindings : [];
      const matched = allBindings.filter(b => b.nodeId === nodeId);
      const primary = matched.find(b => b.pageId === fig.docPageId) || matched[0] || (fig.docPageId ? { pageId: fig.docPageId, anchor: null } : null);
      const targetItem = resolveStudioItemByPageId(primary?.pageId || fig.docPageId);
      if (!targetItem) {
        showStudioToast(`图节点「${nodeLabel || nodeId}」暂无绑定的正文文档`, { tone: 'warn', durationMs: 3500 });
        return;
      }
      state.archifySelectedNode = { nodeId, label: nodeLabel || nodeId, bindings: matched };
      state.selectedUid = targetItem.uid;
      state.selectedAnchor = primary?.anchor || null;
      mountDocumentReader(rightCard, targetItem, {
        anchorId: state.selectedAnchor,
        archifyContext: state.archifySelectedNode,
        inGraphInspector: true,
      });
      if (state.fullscreenGraph) {
        floatBar.replaceChildren();
        floatBar.append(
          el('span', `已选中图节点「${nodeLabel || nodeId}」，定位至：${targetItem.code || targetItem.title}${primary?.anchor ? ` #${primary.anchor}` : ''}（共 ${matched.length} 处关联）`),
          (() => {
            const openBtn = el('button', '退出全屏对照右侧正文 →', 'st-btn st-btn-primary');
            openBtn.type = 'button';
            openBtn.style.height = '26px';
            openBtn.addEventListener('click', () => {
              state.fullscreenGraph = false;
              split.classList.remove('is-fullscreen');
              if (fsBtnRef) { fsBtnRef.classList.remove('is-active'); fsBtnRef.textContent = '全屏画布'; }
              floatBar.hidden = true;
            });
            return openBtn;
          })(),
        );
        floatBar.hidden = false;
      }
    };

    graphAbortCtrl = new AbortController();
    window.addEventListener('message', ev => {
      if (ev.source !== iframe.contentWindow) return;
      const msg = ev.data;
      if (!msg || msg.__studioArchify !== true) return;
      if (msg.type === 'node-click' && msg.nodeId) {
        bindArchifyNodeSelection(String(msg.nodeId), String(msg.label || msg.nodeId));
      } else if (msg.type === 'focus-search') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
      } else if (msg.type === 'escape' && state.fullscreenGraph) {
        state.fullscreenGraph = false;
        split.classList.remove('is-fullscreen');
        if (fsBtnRef) { fsBtnRef.classList.remove('is-active'); fsBtnRef.textContent = '全屏画布'; }
        floatBar.hidden = true;
      }
    }, { signal: graphAbortCtrl.signal });

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
      mountDocumentReader(rightCard, nextItem, { inGraphInspector: true });
    };

    paintSvgCanvas = () => {
      const prevTop = viewport.scrollTop;
      const prevLeft = viewport.scrollLeft;
      const cw = Math.max(640, viewport.clientWidth || window.innerWidth - (state.fullscreenGraph ? 60 : 540));
      const layout = computeAdaptiveGraphLayout(state.snap, {
        containerWidth: cw,
        fitWidth: true,
        wrapGrid: true,
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
        const tTxt = svgEl('text', { x: nd.x + 10, y: nd.y + 21, class: 'st-node-title' });
        const maxTitleChars = Math.max(8, Math.floor((nd.w - 94) / 13));
        const rawTitle = nd.title || nd.code;
        tTxt.textContent = rawTitle.length > maxTitleChars ? `${rawTitle.slice(0, maxTitleChars - 1)}…` : rawTitle;
        const sTxt = svgEl('text', { x: nd.x + nd.w - 10, y: nd.y + 21, 'text-anchor': 'end', fill: sm.color, class: 'st-node-status' });
        sTxt.textContent = `${sm.dot} ${sm.label}`;
        const cTxt = svgEl('text', { x: nd.x + 10, y: nd.y + 44, class: 'st-node-code' });
        const rawCodeLine = `${nd.code} · ${nd.typeLabel}`;
        const maxCodeChars = Math.max(12, Math.floor((nd.w - 20) / 7.5));
        cTxt.textContent = rawCodeLine.length > maxCodeChars ? `${rawCodeLine.slice(0, maxCodeChars - 1)}…` : rawCodeLine;
        g.append(tTxt, sTxt, cTxt);
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
    graphAbortCtrl = new AbortController();
    viewport.addEventListener('mousedown', ev => {
      if (ev.target.closest('.st-node-group')) return;
      dragging = true; sx = ev.clientX - state.panX; sy = ev.clientY - state.panY;
      viewport.classList.add('is-panning');
    });
    window.addEventListener('mousemove', ev => {
      if (!dragging) return;
      state.panX = ev.clientX - sx; state.panY = ev.clientY - sy;
      svg.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
    }, { signal: graphAbortCtrl.signal });
    window.addEventListener('mouseup', () => {
      dragging = false;
      viewport.classList.remove('is-panning');
    }, { signal: graphAbortCtrl.signal });

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
  mountDocumentReader(rightCard, activeItem, { inGraphInspector: true });

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
      el('h2', pf.title || '高阶需求进展与双向对齐总览表', ''),
      el('p', '满足概况由下游存在性、摘要互锁与代码/测试双锁自动派生；表头 ⓘ 提供列口径与全部枚举规则，点击条目或下游胶囊可直接阅读原文或跨仓跳入详设。', 'st-muted-xs'),
    );
    leftTitle.firstChild.style.margin = '0 0 4px 0';
    leftTitle.lastChild.style.margin = '0';

    const filterGroup = el('div', null, 'st-graph-controls');
    const stepNextBtn = el('button', '下一步：开始逐篇审阅正文 →', 'st-btn st-btn-primary');
    stepNextBtn.type = 'button';
    stepNextBtn.addEventListener('click', startGuidedReview);
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
    filterGroup.append(stepNextBtn);
    const qInp = el('input', null, 'st-input');
    qInp.id = 'st-align-search';
    qInp.type = 'search';
    qInp.style.width = '240px';
    qInp.placeholder = '按需求标题、摘要、编号或目标仓搜索…';
    qInp.value = state.alignQuery;
    headRow.append(leftTitle, filterGroup);

    const searchBar = el('div', null, 'st-graph-controls');
    searchBar.style.margin = '10px 0';
    searchBar.append(qInp);

    const tblWrap = el('div', null, 'st-table-wrap');
    const tbl = el('table', null, 'st-prose-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const [hLbl, tipKey] of [
      ['需求标题与摘要', 'col:alignItem'],
      ['业务处置与承接去向', 'col:alignDisposition'],
      ['实际满足度（机器派生）', 'col:alignSatisfaction'],
      ['双向对齐结论', 'col:alignHealth'],
    ]) {
      hr.append(thWithInfo(document, hLbl, tipKey));
    }
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
          const hay = `${item.sourceUid} ${item.sourceCode || ''} ${item.title} ${item.sourceSummary || ''} ${item.dispositionNote} ${(item.allocations || []).map(a => `${a.targetRepoName} ${a.targetUid} ${a.targetTitle || ''} ${a.targetSummary || ''}`).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      if (!rows.length) {
        const emptyTr = el('tr');
        const td = el('td');
        td.colSpan = 4;
        const emptyBox = el('div', null, 'st-empty-actions');
        emptyBox.style.marginTop = '0';
        const clrBtn = el('button', '🔄 清空筛选条件', 'st-btn');
        clrBtn.type = 'button';
        clrBtn.addEventListener('click', () => {
          state.alignFilter = 'all';
          state.alignQuery = '';
          renderReviewPanel();
        });
        emptyBox.append(el('span', '当前筛选条件下无匹配的高阶需求记录。', 'st-muted-xs'), clrBtn);
        td.append(emptyBox);
        emptyTr.append(td);
        tbody.append(emptyTr);
        return;
      }
      for (const item of rows) {
        const tr = el('tr');
        const tdSrc = el('td');
        const srcBtn = el('button', null, 'st-repo-item-btn');
        srcBtn.type = 'button';
        srcBtn.append(renderEntityBrief(document, {
          title: item.title,
          summary: item.sourceSummary,
          code: item.sourceCode || item.sourceUid,
          typeLabel: item.sourceTypeLabel || '高阶需求',
          path: item.sourcePath,
        }));
        srcBtn.addEventListener('click', () => jumpToRepoAndItem(state.repoId, item.sourceUid, 'review', 'reader'));
        tdSrc.append(srcBtn);

        const tdDisp = el('td');
        const allocWrap = el('div', null, 'st-alignment-alloc-list');
        const dispHead = el('div', null, 'st-graph-controls');
        dispHead.append(el('span', item.dispositionLabel, 'st-badge st-badge-zinc'));
        if (item.mergedInto) dispHead.append(el('span', `→ ${item.mergedInto}`, 'st-muted-xs'));
        allocWrap.append(dispHead);
        if (item.dispositionNote) allocWrap.append(el('div', item.dispositionNote, 'st-muted-xs'));
        for (const alRowItem of item.allocations || []) {
          const aRow = el('div', null, 'st-alignment-alloc-row');
          const allocHead = el('div', null, 'st-graph-controls');
          const jumpLbl = `↗ ${alRowItem.targetRepoName} · ${alRowItem.targetTitle || alRowItem.targetCode || alRowItem.targetUid}`;
          if (alRowItem.targetRepoId) {
            const jumpBtn = el('button', jumpLbl, 'st-jump-pill');
            jumpBtn.type = 'button';
            jumpBtn.addEventListener('click', () => jumpToRepoAndItem(alRowItem.targetRepoId, alRowItem.targetUid, 'review', 'reader'));
            allocHead.append(jumpBtn);
          } else {
            allocHead.append(el('span', `${alRowItem.targetRepoName} · ${alRowItem.targetTitle || alRowItem.targetUid}`, 'st-badge st-badge-zinc'));
          }
          allocHead.append(el('span', alRowItem.codeLocksFresh ? '双锁新鲜' : '待补代码/测试锁', `st-badge ${alRowItem.codeLocksFresh ? 'st-badge-emerald' : 'st-badge-amber'}`));
          aRow.append(allocHead);
          if (alRowItem.targetSummary) {
            aRow.append(renderEntityBrief(document, {
              title: '',
              summary: alRowItem.targetSummary,
              code: alRowItem.targetCode || alRowItem.targetUid,
              path: alRowItem.targetPath,
            }, { compact: true, showPath: true, maxSummaryChars: 88 }));
          }
          allocWrap.append(aRow);
        }
        tdDisp.append(allocWrap);

        const tdSat = el('td');
        const satMeta = item.satisfactionMeta || {};
        tdSat.append(el('span', satMeta.label || item.computedSatisfaction, `st-badge st-badge-${satMeta.tone || 'zinc'}`));
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
          if (GLOSSARY[`err:${iss.code}`]) issLine.append(infoTrigger(`err:${iss.code}`, document));
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
    for (const [hLbl, tipKey] of [
      ['本仓详设条目', 'col:upstreamLocal'],
      ['对应高阶规划来源', 'col:upstreamSource'],
      ['双向互锁健康度', 'col:upstreamHealth'],
    ]) {
      hr.append(thWithInfo(document, hLbl, tipKey));
    }
    thead.append(hr);
    const tbody = el('tbody');
    for (const b of up.bindings || []) {
      const tr = el('tr');
      const tdLocal = el('td');
      const localBtn = el('button', null, 'st-repo-item-btn');
      localBtn.type = 'button';
      localBtn.append(renderEntityBrief(document, {
        title: b.localTitle || b.localUid,
        summary: b.localSummary,
        code: b.localCode || b.localUid,
        typeLabel: b.localTypeLabel || '本仓详设',
        path: b.localPath,
      }));
      localBtn.addEventListener('click', () => jumpToRepoAndItem(state.repoId, b.localUid, 'review', 'reader'));
      tdLocal.append(localBtn);

      const tdUp = el('td');
      if (b.upstreamRepoId || up.upstreamRepoId) {
        const upBtn = el('button', `↖ ${up.upstreamRepoName} · ${b.upstreamTitle || b.upstreamCode || b.upstreamUid}`, 'st-jump-pill');
        upBtn.type = 'button';
        upBtn.addEventListener('click', () => jumpToRepoAndItem(b.upstreamRepoId || up.upstreamRepoId, b.upstreamUid, 'review', 'reader'));
        tdUp.append(upBtn);
      }
      tdUp.append(renderEntityBrief(document, {
        title: b.upstreamTitle || b.upstreamUid,
        summary: b.upstreamSummary,
        code: b.upstreamCode || b.upstreamUid,
        typeLabel: b.upstreamTypeLabel || '上游高阶',
        path: b.upstreamPath,
      }, { compact: true }));

      const tdHealth = el('td');
      tdHealth.append(el('span', b.health?.label || '已绑定', `st-badge st-badge-${b.health?.tone || 'zinc'}`));
      for (const iss of b.issues || []) {
        const row = el('div', null, 'st-graph-controls');
        row.append(el('span', `${iss.code}：${iss.message}`, 'st-muted-xs'));
        if (GLOSSARY[`err:${iss.code}`]) row.append(infoTrigger(`err:${iss.code}`, document));
        tdHealth.append(row);
      }
      tr.append(tdLocal, tdUp, tdHealth);
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    upCard.append(wrapProseTable(tbl));
    wrap.append(upCard);
  }

  const ic = al.internalCodeLocks || {};
  const isPortfolioNoCode = Boolean(
    al.portfolio?.present
    && !ic.requireCodeLocks
    && (ic.implementsCount ?? 0) === 0
    && (ic.verifiesCount ?? 0) === 0
    && (ic.matchedEntriesCount ?? 0) === 0
  );
  const codeCard = el('div', null, 'st-card st-guide-section');
  const codeHead = el('div', null, 'st-repo-opt-head');
  codeHead.style.marginBottom = '10px';
  codeHead.append(el('h2', '单仓内部「详设 ↔ 代码与测试」双向互锁体检', ''));
  codeHead.firstChild.style.margin = '0';
  if (!al.portfolio?.present) {
    const stepNextBtn = el('button', '下一步：开始逐篇审阅正文 →', 'st-btn st-btn-primary');
    stepNextBtn.type = 'button';
    stepNextBtn.addEventListener('click', startGuidedReview);
    codeHead.append(stepNextBtn);
  }
  codeCard.append(codeHead);
  const kpiRow = el('div', null, 'st-kpi-grid');
  const mkBox = (lbl, val, tone, tipKey, statusLabel = null) => {
    const c = el('div', null, 'st-card st-kpi-card');
    const top = el('div', null, 'st-graph-controls');
    top.append(el('span', lbl, 'st-muted-xs'), infoTrigger(tipKey, document));
    const badgeTxt = statusLabel || (tone === 'emerald' ? '覆盖正常' : (tone === 'zinc' ? '无需代码锁' : '需关注'));
    c.append(top, el('div', val, 'st-kpi-val'), el('span', badgeTxt, `st-badge st-badge-${tone}`));
    kpiRow.append(c);
  };
  mkBox('代码实现锁 (implements)', `${ic.implementsCount ?? 0} 条`, (ic.implementsCount ?? 0) > 0 ? 'emerald' : (ic.requireCodeLocks ? 'rose' : 'zinc'), 'lockCard:implements', isPortfolioNoCode ? '高阶规划仓豁免' : null);
  mkBox('测试验证锁 (verifies)', `${ic.verifiesCount ?? 0} 条`, (ic.verifiesCount ?? 0) > 0 ? 'emerald' : 'zinc', 'lockCard:verifies', isPortfolioNoCode ? '高阶规划仓豁免' : null);
  mkBox('声明式代码/技能入口', `${ic.matchedEntriesCount ?? 0} 个`, isPortfolioNoCode ? 'zinc' : ((ic.unclaimedEntries?.length ?? 0) === 0 ? 'emerald' : 'amber'), 'lockCard:entries', isPortfolioNoCode ? '仅含高阶规划' : null);
  mkBox('未认领入口与锁漂移', `${(ic.unclaimedEntries?.length ?? 0) + (ic.drifts?.length ?? 0)} 项`, ic.healthy ? 'emerald' : 'rose', 'lockCard:unclaimed', isPortfolioNoCode && ic.healthy ? '零漂移' : null);
  codeCard.append(kpiRow);

  const unclaimedDetails = ic.unclaimedEntryDetails || (ic.unclaimedEntries || []).map(p => ({ path: p, title: p, typeLabel: '源码入口' }));
  if (unclaimedDetails.length > 0) {
    const warnLine = el('div', null, 'st-graph-controls');
    warnLine.append(
      el('span', '⚠️ 以下入口文件尚未在 traceability-version-lock.json 中被任何 @feature / @scenario 认领 (UNCLAIMED_IMPLEMENTATION_ENTRY)：', 'st-muted-xs'),
      infoTrigger('err:UNCLAIMED_IMPLEMENTATION_ENTRY', document),
    );
    const list = el('div', null, 'st-md-list');
    for (const det of unclaimedDetails) list.append(renderEntityBrief(document, det, { compact: true }));
    codeCard.append(warnLine, list);
  }
  const driftDetails = ic.driftDetails || ic.drifts || [];
  if (driftDetails.length > 0) {
    codeCard.append(el('div', '⚠️ 以下代码/测试锁存在摘要漂移（修改后尚未刷新 version-lock）：', 'st-muted-xs'));
    const list = el('div', null, 'st-md-list');
    for (const d of driftDetails) {
      list.append(renderEntityBrief(document, {
        title: d.title || d.path || d.code,
        summary: d.summary,
        code: d.code,
        typeLabel: d.typeLabel || '锁漂移',
        path: d.path,
      }, { compact: true }));
    }
    codeCard.append(list);
  }
  if (isPortfolioNoCode && ic.healthy) {
    codeCard.append(el('p', 'ℹ️ 高阶规划仓不直接承载业务代码锁（通过上方跨仓分配总账互锁）。', 'st-muted-xs'));
  } else if (ic.healthy) {
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
  if (state.repos.length === 0) {
    const empty = el('div', null, 'st-card st-guide-section');
    empty.append(
      el('h3', '当前工作区未发现受管仓库', ''),
      el('p', '请从包含 artifact-graph.config.yaml 的技能族目录启动控制台，或直接点击下方按钮接入本地项目。', 'st-muted-xs'),
    );
    empty.firstChild.style.marginTop = '0';
    const addBtn = el('button', '＋ 添加本地项目', 'st-btn st-btn-primary');
    addBtn.type = 'button';
    addBtn.disabled = !state.writable;
    addBtn.addEventListener('click', openAddRepoModal);
    empty.append(addBtn);
    host.append(empty);
    return;
  }
  if (!state.snap) { host.append(el('p', '正在加载审阅清单…', 'st-muted-xs')); return; }

  const totalAlerts = state.alignment?.totalAlerts ?? 0;
  const curRepo = state.repos.find(r => r.id === state.repoId) || null;
  const prog = curRepo ? countRepoProgress(curRepo) : { decided: 0, total: state.snap.reviewItems?.length || 0 };
  const banner = el('div', null, 'st-guided-banner');
  const leftControls = el('div', null, 'st-graph-controls');
  const stepFlow = el('div', null, 'st-step-flow');
  const step1Btn = el('button', `① 核对需求与代码对齐${totalAlerts > 0 ? ` (${totalAlerts} 告警)` : ''}`, `st-step-btn${state.reviewMode === 'alignment' ? ' is-active' : ''}`);
  step1Btn.type = 'button';
  step1Btn.addEventListener('click', () => { state.reviewMode = 'alignment'; renderReviewPanel(); });
  const step2Btn = el('button', `② 按顺序逐篇审阅 (已审 ${prog.decided}/${prog.total})`, `st-step-btn${state.reviewMode === 'reader' ? ' is-active' : ''}`);
  step2Btn.type = 'button';
  step2Btn.addEventListener('click', () => { state.reviewMode = 'reader'; renderReviewPanel(); });
  const step3Btn = el('button', '③ 导出验收结论', 'st-step-btn');
  step3Btn.type = 'button';
  step3Btn.addEventListener('click', openExportDrawer);
  stepFlow.append(step1Btn, el('span', '──▶', 'st-step-arrow'), step2Btn, el('span', '──▶', 'st-step-arrow'), step3Btn);
  leftControls.append(stepFlow);

  const nextBtn = el('button', '▶ 跳至下一项待审条目 →', 'st-btn st-btn-primary');
  nextBtn.type = 'button';
  nextBtn.addEventListener('click', () => {
    const { item: nxt, allCompleted } = findNextPendingHumanItem(state.selectedUid);
    if (nxt) {
      state.selectedUid = nxt.uid;
      state.selectedAnchor = null;
      state.reviewMode = 'reader';
      renderReviewPanel();
    } else if (allCompleted) {
      showStudioToast('🎉 当前仓库人读审阅项已全部签收完成，请点击「③ 导出验收结论」生成验收单', {
        tone: 'emerald',
        actionLabel: '打开 ③ 导出验收结论',
        onAction: openExportDrawer,
      });
    }
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
  searchInp.id = 'st-review-search';
  searchInp.type = 'search';
  searchInp.placeholder = '搜索标题、摘要或编号…';
  searchInp.value = state.reviewQuery;
  sidebar.append(searchInp);

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
  sidebar.append(statusSel);

  const listWrap = el('div', null, 'st-acc-tree');
  sidebar.append(listWrap);

  const FOLDER_DEFS = [
    { id: 'f1_stories', label: '① 用户故事', cats: new Set(['stories', 'us_stories', 'gap_resolutions']), defaultOpen: true },
    { id: 'f2_lifecycle', label: '② 生命周期讲解', cats: new Set(['lc_explanations']) },
    { id: 'f3_reqs', label: '③ 需求总纲', cats: new Set(['requirements']) },
    { id: 'f4_scenarios', label: '④ 场景剧本', cats: new Set(['scenarios']) },
    { id: 'f5_arch', label: '⑤ 领域模型与架构设计', cats: new Set(['domain', 'business_articles', 'architecture', 'verification']) },
    { id: 'f6_contracts', label: '附：机器数据契约 (.json/.yaml · 自动跳过)', cats: new Set(['contracts']), isContracts: true },
  ];

  const resetReviewFilters = () => {
    state.reviewStatusFilter = 'all';
    state.reviewQuery = '';
    renderReviewPanel();
  };

  const getFilteredReviewItems = () => {
    const q = state.reviewQuery.trim().toLowerCase();
    const allItems = state.snap.reviewItems || [];
    return allItems.filter(item => {
      const eff = getEffectiveStatus(item.target || item.uid);
      if (state.reviewStatusFilter !== 'all' && eff !== state.reviewStatusFilter) return false;
      if (q && !`${item.code} ${item.title} ${item.summary || ''} ${item.typeLabel}`.toLowerCase().includes(q)) return false;
      return true;
    });
  };

  const syncReaderToFiltered = filteredItems => {
    if (!filteredItems.length) {
      readerCard.replaceChildren();
      const emptyWrap = el('div', null, 'st-prose-container');
      emptyWrap.append(el('p', '当前筛选或搜索条件下暂无匹配的可审阅条目。', 'st-muted-xs'));
      const clrRightBtn = el('button', '🔄 清空筛选条件', 'st-btn');
      clrRightBtn.type = 'button';
      clrRightBtn.addEventListener('click', resetReviewFilters);
      emptyWrap.append(clrRightBtn);
      readerCard.append(emptyWrap);
      return;
    }
    const targetItem = filteredItems.find(i => i.uid === state.selectedUid) || filteredItems[0];
    if (targetItem.uid !== state.selectedUid) {
      state.selectedUid = targetItem.uid;
      state.selectedAnchor = null;
    }
    mountDocumentReader(readerCard, targetItem);
  };

  const paintList = (matchedInput = null) => {
    listWrap.replaceChildren();
    const q = state.reviewQuery.trim().toLowerCase();
    const hasFilter = Boolean(q || state.reviewStatusFilter !== 'all');
    const allItems = state.snap.reviewItems || [];
    const matchedItems = Array.isArray(matchedInput) ? matchedInput : getFilteredReviewItems();
    if (!matchedItems.length) {
      listWrap.append(el('p', '当前筛选条件下暂无匹配项。', 'st-muted-xs'));
      const clrBtn = el('button', '🔄 清空筛选条件', 'st-btn');
      clrBtn.type = 'button';
      clrBtn.addEventListener('click', resetReviewFilters);
      listWrap.append(clrBtn);
      return matchedItems;
    }

    const bucketed = new Map(FOLDER_DEFS.map(f => [f.id, { def: f, visible: [], totalAll: [] }]));
    for (const item of allItems) {
      const targetDef = FOLDER_DEFS.find(f => f.cats.has(item.category)) || FOLDER_DEFS[4];
      bucketed.get(targetDef.id).totalAll.push(item);
    }
    for (const item of matchedItems) {
      const targetDef = FOLDER_DEFS.find(f => f.cats.has(item.category)) || FOLDER_DEFS[4];
      bucketed.get(targetDef.id).visible.push(item);
    }

    for (const { def, visible, totalAll } of bucketed.values()) {
      if (!visible.length) continue;
      const toggleKey = `${state.repoId}:${def.id}`;
      const manual = state.reviewManualToggles?.get(toggleKey);
      const containsSelected = visible.some(i => i.uid === state.selectedUid);
      const isOpen = hasFilter
        ? true
        : (containsSelected ? (manual !== 'closed') : (manual ? manual === 'open' : Boolean(def.defaultOpen)));

      const decidedCnt = totalAll.filter(i => {
        const eff = getEffectiveStatus(i.target || i.uid);
        return eff && eff !== 'pending';
      }).length;

      const folderEl = el('div', null, `st-acc-folder${def.isContracts ? ' is-contracts' : ''}`);
      const hdrBtn = el('button', null, 'st-acc-folder-hdr');
      hdrBtn.type = 'button';
      hdrBtn.setAttribute('aria-expanded', String(isOpen));
      const hLeft = el('span', null, 'st-acc-folder-hdr-left');
      hLeft.append(el('span', isOpen ? '▾' : '▸'), el('span', def.label));
      if (def.isContracts) hLeft.append(infoTrigger('catGroup:contracts', document));
      const cntLbl = hasFilter
        ? `命中 ${visible.length}/${totalAll.length}`
        : `已审 ${decidedCnt}/${totalAll.length}`;
      hdrBtn.append(hLeft, el('span', cntLbl, 'st-badge st-badge-zinc'));
      hdrBtn.addEventListener('click', ev => {
        if (ev.target?.closest?.('.st-info-btn')) return;
        state.reviewManualToggles?.set(toggleKey, isOpen ? 'closed' : 'open');
        paintList();
      });
      folderEl.append(hdrBtn);

      if (isOpen) {
        const bodyEl = el('div', null, 'st-acc-folder-body');
        for (const item of visible) {
          const eff = getEffectiveStatus(item.target || item.uid);
          const sm = STATUS_META[eff] || STATUS_META.pending;
          const b = el('button', null, `st-review-item-btn${item.uid === state.selectedUid ? ' is-active' : ''}`);
          b.type = 'button';
          b.dataset.uid = item.uid;
          const contractExt = item.isMachineContract
            ? (/\.ya?ml$/i.test(String(item.path || '')) ? ' · .yaml' : ' · .json')
            : '';
          const r1 = el('div', null, 'st-repo-opt-head');
          const r1Right = el('div', null, 'st-graph-controls');
          if (hasSavedDraft(item.uid)) r1Right.append(el('span', '📝 草稿', 'st-draft-tag'));
          r1Right.append(el('span', `${sm.dot} ${sm.label}`, sm.badge));
          r1.append(el('span', `${item.code || ''} · ${item.typeLabel}${contractExt}`, 'st-muted-xs'), r1Right);
          b.append(
            r1,
            renderEntityBrief(document, {
              title: item.title,
              summary: item.summary,
              code: '',
              typeLabel: '',
            }, { compact: true, showPath: false, maxSummaryChars: 68 }),
          );
          b.addEventListener('click', () => {
            state.selectedUid = item.uid;
            state.selectedAnchor = null;
            listWrap.querySelectorAll('.st-review-item-btn').forEach(btn => {
              btn.classList.toggle('is-active', btn.dataset.uid === item.uid);
            });
            mountDocumentReader(readerCard, item);
          });
          bodyEl.append(b);
        }
        folderEl.append(bodyEl);
      }
      listWrap.append(folderEl);
    }
    return matchedItems;
  };
  const renderSidebarAndReader = (forceSyncReader = true) => {
    const matched = getFilteredReviewItems();
    const selValid = matched.some(i => i.uid === state.selectedUid);
    if (matched.length > 0 && !selValid) {
      state.selectedUid = matched[0].uid;
      state.selectedAnchor = null;
    }
    paintList(matched);
    if (forceSyncReader || !selValid || !matched.length) {
      syncReaderToFiltered(matched);
    }
  };
  statusSel.addEventListener('change', () => {
    state.reviewStatusFilter = statusSel.value;
    renderSidebarAndReader(true);
  });
  searchInp.addEventListener('input', () => {
    state.reviewQuery = searchInp.value;
    renderSidebarAndReader(false);
  });
  renderSidebarAndReader(true);

  split.append(sidebar, readerCard);
  host.append(split);
  if (prevSidebarTop > 0) requestAnimationFrame(() => { sidebar.scrollTop = prevSidebarTop; });
}

export function buildRuntimeTargetsTable(targetsToShow = [], doc = document, options = {}) {
  const mk = (tag, text, cls) => {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const showActions = typeof options.onEdit === 'function' || typeof options.onRemove === 'function';
  const tbl = mk('table', null, 'st-prose-table');
  const thead = mk('thead');
  const htr = mk('tr');
  const cols = showActions
    ? [
      ['监控目标', 'col:runtimeTargets'],
      ['计划进度', null],
      ['活跃令牌锁', 'rt:tokenLock'],
      ['事件哈希链', 'rt:stateStore'],
      ['受管子进程', 'rt:processStatus'],
      ['操作', null],
    ]
    : [
      ['监控目标', 'col:runtimeTargets'],
      ['计划进度', null],
      ['活跃令牌锁', 'rt:tokenLock'],
      ['事件哈希链', 'rt:stateStore'],
      ['受管子进程', 'rt:processStatus'],
    ];
  const hasRealDom = typeof doc?.getElementById === 'function';
  for (const [h, tipKey] of cols) {
    htr.append(hasRealDom && tipKey ? thWithInfo(doc, h, tipKey) : mk('th', h));
  }
  thead.append(htr);
  const tbody = mk('tbody');
  for (const t of targetsToShow) {
    const tr = mk('tr');
    const tdTitle = mk('td');
    const titleChildren = [mk('strong', t.title ?? '')];
    if (t.summary) titleChildren.push(mk('div', t.summary, 'st-entity-summary'));
    titleChildren.push(mk('div', [t.repoName, t.badge].filter(Boolean).join(' · '), 'st-muted-xs'));
    tdTitle.append(...titleChildren);
    const tdProg = mk('td', `${t.taskSummary?.done ?? 0}/${t.taskSummary?.total ?? 0} (${t.taskSummary?.percent ?? 0}%)`);
    const tdLock = mk('td', `${t.activeLockCount ?? 0} 把活跃${(t.locks || []).some(l => l.isStaleWarning) ? ' · ⚠️ 持锁超时' : ''}`);
    const tdChain = mk('td');
    tdChain.append(mk('code', t.chainIntegrity ?? 'NONE'), doc.createTextNode(` (${t.eventCount ?? 0} 条)`));
    const tdProc = mk('td', `${t.processCount ?? 0} 条记录`);
    tr.append(tdTitle, tdProg, tdLock, tdChain, tdProc);
    if (showActions) {
      const tdOp = mk('td');
      if (t.isUserRegistered) {
        const g = mk('div', null, 'st-graph-controls');
        if (typeof options.onEdit === 'function') {
          const edBtn = mk('button', '✏️ 编辑', 'st-btn');
          edBtn.type = 'button';
          edBtn.disabled = options.writable === false;
          edBtn.addEventListener('click', () => options.onEdit(t));
          g.append(edBtn);
        }
        if (typeof options.onRemove === 'function') {
          const rmBtn = mk('button', '🗑️ 移除', 'st-btn');
          rmBtn.type = 'button';
          rmBtn.disabled = options.writable === false;
          rmBtn.addEventListener('click', () => options.onRemove(t));
          g.append(rmBtn);
        }
        tdOp.append(g);
      } else {
        tdOp.append(mk('span', t.isSandbox ? '沙箱演练' : '自动发现', 'st-muted-xs'));
      }
      tr.append(tdOp);
    }
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  return tbl;
}

function openRegisterRuntimeModal(onRegistered, editTarget = null) {
  const existing = document.getElementById('st-rt-reg-modal');
  if (existing) existing.remove();

  const isEdit = Boolean(editTarget);
  const cfg = editTarget?.editConfig || editTarget || {};

  const backdrop = el('div', null, 'st-modal-backdrop');
  backdrop.id = 'st-rt-reg-modal';
  const modal = el('div', null, 'st-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const head = el('div', null, 'st-repo-opt-head');
  head.append(el('h3', isEdit ? '✏️ 编辑已挂载运行源' : '+ 挂载 Foundation 运行监控源', ''));
  head.firstChild.style.margin = '0';
  const closeBtn = el('button', '✕', 'st-btn');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => backdrop.remove());
  head.append(closeBtn);

  const mkField = (id, label, placeholder, req = false, val = '') => {
    const wrap = el('div', null, 'st-form-field');
    const lbl = el('label', label);
    lbl.htmlFor = id;
    const inp = el('input', null, 'st-input');
    inp.id = id;
    inp.placeholder = placeholder;
    if (val) inp.value = val;
    if (req) inp.required = true;
    wrap.append(lbl, inp);
    return { wrap, inp };
  };

  const fId = mkField('st-reg-id', '目标 ID（字母/数字/短横线）*', '如 task-wave10-verify', true, cfg.id || '');
  if (isEdit) fId.inp.readOnly = true;
  const fTitle = mkField('st-reg-title', '显示标题', '如 全量门禁执行器', false, cfg.title || '');
  const fState = mkField('st-reg-state', 'state-store 状态目录（可选）', '.artifacts/state-store 或绝对路径', false, cfg.stateDir || '');
  const fPlan = mkField('st-reg-plan', '执行计划路径（.md / .json / .csv，可选）', 'PLAN.md', false, cfg.planPath || '');
  const fRuns = mkField('st-reg-runs', '子进程监督目录 runsDir（可选）', '.runs', false, cfg.runsDir || '');
  const lockInit = Array.isArray(cfg.lockPaths) ? cfg.lockPaths.join(', ') : '';
  const fLocks = mkField('st-reg-locks', '排他写锁路径 lockPaths（逗号分隔，可选）', '.artifacts/locks, .artifacts/state-store/writer.lock', false, lockInit);

  const errLine = el('div', '', 'st-muted-xs');
  errLine.style.color = 'var(--st-rose-fg)';

  const foot = el('div', null, 'st-graph-controls');
  foot.style.justifyContent = 'flex-end';
  const cancelBtn = el('button', '取消', 'st-btn');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => backdrop.remove());
  const submitBtn = el('button', isEdit ? '保存修改' : '确认挂载并落盘', 'st-btn st-btn-primary');
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
      showStudioToast(isEdit ? `✓ 已更新自定义运行源「${idVal}」` : `✓ 已挂载自定义运行源「${idVal}」`, { tone: 'emerald' });
      onRegistered?.();
    } catch (err) {
      errLine.textContent = err.message || (isEdit ? '保存失败' : '挂载失败');
      submitBtn.disabled = false;
    }
  });
  foot.append(cancelBtn, submitBtn);

  modal.append(head, fId.wrap, fTitle.wrap, fState.wrap, fPlan.wrap, fRuns.wrap, fLocks.wrap, errLine, foot);
  backdrop.append(modal);
  backdrop.addEventListener('click', ev => { if (ev.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
  (isEdit ? fTitle.inp : fId.inp).focus();
}

function renderTaskTreeView(host, scopedTargets, { plans = [], fleetFamCount = 0, onGoFleet = null, onRunSandbox = null, onMountSource = null, onScopeWorkspace = null } = {}) {
  const bannerNote = el('div', '什么时候看这里：不仅跟踪实时沙箱与当前挂载的活跃执行计划，也聚合工作区近期进行中与已完成的历史执行计划与规划总览，点击左侧任意计划卡右侧即刻展开任务树与摘要。', 'st-scenario-banner');
  host.append(bannerNote);

  const scopedPlans = plans.filter(p => {
    if (state.rtSelectedTargetId !== '__all__' && p.targetId !== state.rtSelectedTargetId) return false;
    if (state.rtScope === 'repo' && p.repoId !== state.repoId && !p.isSandbox) return false;
    return true;
  });

  if (scopedPlans.length === 0) {
    const emptyCard = el('div', null, 'st-card st-guide-section');
    emptyCard.append(
      el('h3', '当前范围内暂无活跃或历史执行计划文件', ''),
      el('p', '支持多级标题/缩进复选框的 .md、嵌套 .json 或 .csv；若你正在观测本机已运行的多智能体协作会话，或想查看工作区及相邻目录历史规划，可直接点下方按钮切换，或体验沙箱演练 / 挂载计划文件。', 'st-muted-xs'),
    );
    emptyCard.firstChild.style.marginTop = '0';
    const actRow = el('div', null, 'st-empty-actions');
    if (state.rtScope === 'repo' && plans.length > 0) {
      const wsPlansBtn = el('button', `🌐 查看全工作区历史与规划 (${plans.length})`, 'st-btn st-btn-primary');
      wsPlansBtn.type = 'button';
      wsPlansBtn.addEventListener('click', () => {
        state.rtScope = 'workspace';
        state.rtSelectedTargetId = '__all__';
        if (typeof onScopeWorkspace === 'function') onScopeWorkspace();
        else renderRuntimePanel();
      });
      actRow.append(wsPlansBtn);
    }
    if (fleetFamCount > 0 && typeof onGoFleet === 'function') {
      const fleetBtn = el('button', `🛰️ 查看本机 ${fleetFamCount} 组智能体会话 →`, `st-btn${state.rtScope === 'repo' && plans.length > 0 ? '' : ' st-btn-primary'}`);
      fleetBtn.type = 'button';
      fleetBtn.addEventListener('click', onGoFleet);
      actRow.append(fleetBtn);
    }
    const sbxEmptyBtn = el('button', '▶ 运行隔离沙箱演练', `st-btn${fleetFamCount > 0 || (state.rtScope === 'repo' && plans.length > 0) ? '' : ' st-btn-primary'}`);
    sbxEmptyBtn.type = 'button';
    sbxEmptyBtn.disabled = !state.writable;
    sbxEmptyBtn.addEventListener('click', () => onRunSandbox?.(sbxEmptyBtn));
    const mntEmptyBtn = el('button', '＋ 挂载运行源', 'st-btn');
    mntEmptyBtn.type = 'button';
    mntEmptyBtn.disabled = !state.writable;
    mntEmptyBtn.addEventListener('click', () => onMountSource?.());
    actRow.append(sbxEmptyBtn, mntEmptyBtn);
    emptyCard.append(actRow);
    host.append(emptyCard);
    return;
  }

  const shell = el('div', null, 'st-master-detail');
  const masterCard = el('aside', null, 'st-card st-md-master');
  const detailCol = el('div', null, 'st-md-detail');

  const mTop = el('div', null, 'st-repo-opt-head');
  mTop.append(el('strong', `🌳 执行计划清单 (${scopedPlans.length})`));
  const mntBtn = el('button', '＋ 挂载', 'st-btn st-btn-xs');
  mntBtn.type = 'button';
  mntBtn.disabled = !state.writable;
  mntBtn.addEventListener('click', () => onMountSource?.());
  mTop.append(mntBtn);

  const filterRow = el('div', null, 'st-graph-controls');
  const planSearch = el('input', null, 'st-input');
  planSearch.id = 'st-plan-search';
  planSearch.type = 'search';
  planSearch.placeholder = '搜索计划标题、摘要或仓库…';
  planSearch.value = state.rtPlanQuery || '';

  const planList = el('div', null, 'st-md-list');
  masterCard.append(mTop, filterRow, planSearch, planList);
  shell.append(masterCard, detailCol);
  host.append(shell);

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

  const renderNodeBranch = (node, targetId, q, onRepaint) => {
    if (!matchesNodeFilter(node, q)) return null;
    const hasKids = Array.isArray(node.children) && node.children.length > 0;
    const key = `${targetId}::${node.id}`;
    const isCollapsed = !q && state.rtCollapsedTreeIds.has(key);
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
        onRepaint();
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
    if (hasKids) right.append(el('span', `${node.done}/${node.total} (${node.percent}%)`, 'st-muted-xs st-tabular'));
    else if (node.detail) right.append(el('span', node.detail, 'st-muted-xs'));
    right.append(el('span', stTxt, `st-badge st-badge-${stTone}`));
    row.append(left, right);
    box.append(row);
    if (hasKids && !isCollapsed) {
      const chWrap = el('div', null, 'st-tree-children');
      for (const ch of node.children) {
        const chEl = renderNodeBranch(ch, targetId, q, onRepaint);
        if (chEl) chWrap.append(chEl);
      }
      if (chWrap.children.length > 0) box.append(chWrap);
    }
    return box;
  };

  const renderPlanDetail = plan => {
    detailCol.replaceChildren();
    if (!plan) {
      detailCol.append(el('p', '请从左侧选择一条运行计划或历史规划查看任务树详情。', 'st-muted-xs'));
      return;
    }
    const ts = plan.taskSummary || { total: 0, done: 0, running: 0, blocked: 0, todo: 0, percent: plan.percent || 0, tree: [] };
    const focusBox = el('div', null, 'st-focus-banner');
    const fTop = el('div', null, 'st-repo-opt-head');
    fTop.append(
      renderEntityBrief(document, {
        title: plan.title,
        summary: plan.summary,
        code: plan.statusLabel,
        typeLabel: plan.repoName,
        badge: plan.badge,
        path: plan.planPath,
      }),
      el('div', null, 'st-graph-controls'),
    );
    const toneCls = plan.status === 'completed' ? 'st-badge-emerald' : (plan.status === 'in_progress' ? 'st-badge-indigo' : 'st-badge-zinc');
    fTop.lastChild.append(
      el('span', `${plan.statusLabel} · ${plan.percent ?? ts.percent ?? 0}%`, `st-badge ${toneCls}`),
      infoTrigger('rt:taskStatus', document),
    );
    focusBox.append(fTop);

    const total = ts.total || 0;
    if (total > 0) {
      const bar = el('div', null, 'st-progress-multi');
      const seg = (cls, cnt) => { const d = el('div', null, cls); d.style.width = `${((cnt / total) * 100).toFixed(2)}%`; return d; };
      bar.append(seg('st-prog-seg-done', ts.done), seg('st-prog-seg-running', ts.running), seg('st-prog-seg-blocked', ts.blocked), seg('st-prog-seg-todo', ts.todo));
      const focusLine = el('div', `已完成 ${ts.done} · 进行中 ${ts.running} · 阻断 ${ts.blocked} · 待办 ${ts.todo} / 共 ${total} 项 (${ts.percent}%)`, 'st-muted-xs st-tabular');
      focusLine.style.marginTop = '8px';
      focusBox.append(bar, focusLine);
    } else if (plan.updatedAt) {
      focusBox.append(el('div', `最近更新：${formatIsoShort(plan.updatedAt)}${plan.isHistorical ? ' · 已归档历史规划' : ''}`, 'st-muted-xs'));
    }
    detailCol.append(focusBox);

    const card = el('div', null, 'st-card st-guide-section');
    const treeRoots = ts.tree || [];
    if (!treeRoots.length) {
      if (plan.markdownText) {
        card.append(
          el('h3', '规划 / 规格完整正文', ''),
          el('p', `该文档以自然章节描述阶段目标（当前含 ${total} 条复选框步骤），已直接呈现完整格式化 Markdown 正文。`, 'st-muted-xs'),
        );
        card.firstChild.style.marginTop = '0';
        const proseBox = el('div', null, 'st-prose-container');
        proseBox.append(renderSafeMarkdownToDom(plan.markdownText, document));
        card.append(proseBox);
      } else {
        card.append(
          el('h3', '文档型历史规划 / 规格说明摘要', ''),
          el('p', `该文档以自然章节描述波次目标（当前含 ${total} 条复选框步骤），已展示中文标题、摘要与最新更新时间；如需进入实时 6 节点编队或 3 层复选框演练，可运行沙箱演练或切换到编队视图。`, 'st-muted-xs'),
        );
        card.firstChild.style.marginTop = '0';
      }
      const quickRow = el('div', null, 'st-empty-actions');
      quickRow.style.marginTop = '12px';
      if (fleetFamCount > 0 && typeof onGoFleet === 'function') {
        const fb = el('button', `🛰️ 查看本机 ${fleetFamCount} 组智能体会话 →`, 'st-btn st-btn-primary');
        fb.type = 'button';
        fb.addEventListener('click', onGoFleet);
        quickRow.append(fb);
      }
      const sb = el('button', '▶ 运行隔离沙箱演练', 'st-btn');
      sb.type = 'button';
      sb.disabled = !state.writable;
      sb.addEventListener('click', () => onRunSandbox?.(sb));
      quickRow.append(sb);
      card.append(quickRow);
      detailCol.append(card);
      return;
    }

    const ctrl = el('div', null, 'st-graph-toolbar');
    ctrl.style.padding = '0 0 12px 0';
    const pills = el('div', null, 'st-graph-controls');
    const qInp = el('input', null, 'st-input');
    qInp.id = 'st-align-search';
    qInp.type = 'search';
    qInp.style.width = '240px';
    qInp.placeholder = '按波次、编号或步骤关键词过滤…';
    qInp.value = state.rtTaskQuery;
    ctrl.append(pills, qInp);
    const treeMount = el('div', null, 'st-task-tree-root');
    card.append(ctrl, treeMount);
    detailCol.append(card);

    const paintTree = () => {
      pills.replaceChildren();
      for (const [fk, fl] of [['all', '全部任务树'], ['incomplete', '仅看未完成'], ['focus', '聚焦当前活跃链路']]) {
        const b = el('button', fl, `st-btn${state.rtTaskFilter === fk ? ' is-active' : ''}`);
        b.type = 'button';
        b.addEventListener('click', () => { state.rtTaskFilter = fk; paintTree(); });
        pills.append(b);
      }
      treeMount.replaceChildren();
      const q = state.rtTaskQuery.trim().toLowerCase();
      let renderedCount = 0;
      for (const rootNode of treeRoots) {
        const elNode = renderNodeBranch(rootNode, plan.id, q, paintTree);
        if (elNode) { treeMount.append(elNode); renderedCount += 1; }
      }
      if (renderedCount === 0) {
        const emptyRow = el('div', null, 'st-empty-actions');
        const clrTreeBtn = el('button', '🔄 清空筛选条件', 'st-btn');
        clrTreeBtn.type = 'button';
        clrTreeBtn.addEventListener('click', () => { state.rtTaskFilter = 'all'; state.rtTaskQuery = ''; qInp.value = ''; paintTree(); });
        emptyRow.append(el('span', '该计划在当前筛选下无匹配项。', 'st-muted-xs'), clrTreeBtn);
        treeMount.append(emptyRow);
      }
    };
    qInp.addEventListener('input', () => { state.rtTaskQuery = qInp.value; paintTree(); });
    paintTree();
  };

  const paintMaster = () => {
    filterRow.replaceChildren();
    const counts = {
      all: scopedPlans.length,
      in_progress: scopedPlans.filter(p => p.status === 'in_progress' || p.status === 'pending').length,
      completed: scopedPlans.filter(p => p.status === 'completed').length,
    };
    for (const [fk, fl] of [['all', `全部 ${counts.all}`], ['in_progress', `进行中 ${counts.in_progress}`], ['completed', `已完成 ${counts.completed}`]]) {
      const b = el('button', fl, `st-btn st-btn-xs${state.rtPlanFilter === fk ? ' is-active' : ''}`);
      b.type = 'button';
      b.addEventListener('click', () => { state.rtPlanFilter = fk; paintMaster(); });
      filterRow.append(b);
    }

    const pq = (state.rtPlanQuery || '').trim().toLowerCase();
    const visiblePlans = scopedPlans.filter(p => {
      if (state.rtPlanFilter === 'in_progress' && p.status === 'completed') return false;
      if (state.rtPlanFilter === 'completed' && p.status !== 'completed') return false;
      if (pq && !`${p.title} ${p.summary} ${p.repoName} ${p.planPath}`.toLowerCase().includes(pq)) return false;
      return true;
    });

    planList.replaceChildren();
    if (!visiblePlans.length) {
      planList.append(el('p', '当前筛选条件下无匹配计划。', 'st-muted-xs'));
      const clr = el('button', '🔄 清空筛选条件', 'st-btn');
      clr.type = 'button';
      clr.addEventListener('click', () => { state.rtPlanFilter = 'all'; state.rtPlanQuery = ''; planSearch.value = ''; paintMaster(); });
      planList.append(clr);
      return visiblePlans;
    }
    if (!visiblePlans.some(p => p.id === state.rtSelectedPlanId)) {
      state.rtSelectedPlanId = visiblePlans[0].id;
    }

    for (const p of visiblePlans) {
      const card = el('button', null, `st-task-card${p.id === state.rtSelectedPlanId ? ' is-selected' : ''}`);
      card.type = 'button';
      card.dataset.planId = p.id;
      card.append(renderEntityBrief(document, {
        title: p.title,
        summary: p.summary,
        code: p.statusLabel,
        typeLabel: p.repoName,
        badge: p.badge,
        path: p.planPath,
      }, { compact: true, showPath: true, maxSummaryChars: 74 }));
      const foot = el('div', null, 'st-task-card-meta st-tabular');
      foot.append(
        el('span', p.totalSteps > 0 ? `步骤 ${p.completedSteps}/${p.totalSteps} (${p.percent}%)` : p.statusLabel),
        el('span', formatIsoShort(p.updatedAt)),
      );
      card.append(foot);
      card.addEventListener('click', () => {
        state.rtSelectedPlanId = p.id;
        planList.querySelectorAll('.st-task-card').forEach(c => c.classList.toggle('is-selected', c.dataset.planId === p.id));
        renderPlanDetail(p);
      });
      planList.append(card);
    }
    return visiblePlans;
  };

  planSearch.addEventListener('input', () => { state.rtPlanQuery = planSearch.value; paintMaster(); });
  const initList = paintMaster();
  renderPlanDetail(initList.find(p => p.id === state.rtSelectedPlanId) || initList[0] || null);
}

function collectUniqueScopedLocks(scopedTargets) {
  const byKey = new Map();
  for (const t of scopedTargets || []) {
    for (const l of t.locks || []) {
      const key = l.path || l.id || `${t.id}:${l.name}`;
      if (!byKey.has(key)) {
        byKey.set(key, { ...l, targetTitles: t.title ? [t.title] : [] });
      } else {
        const prev = byKey.get(key);
        if (t.title && !prev.targetTitles.includes(t.title)) prev.targetTitles.push(t.title);
      }
    }
  }
  return [...byKey.values()];
}

function renderLockRadarSubpanel(host, scopedTargets, lockWarnMs) {
  const card = el('div', null, 'st-card st-guide-section');
  const allLocks = collectUniqueScopedLocks(scopedTargets);
  const activeCount = allLocks.filter(l => l.isActive).length;

  const head = el('div', null, 'st-graph-toolbar');
  head.style.padding = '0 0 10px 0';
  const left = el('div', null, 'st-graph-controls');
  left.append(el('h3', '活跃排他文件锁雷达', ''), infoTrigger('rt:tokenLock', document), el('span', `活跃排他锁 ${activeCount} 把`, 'st-badge st-badge-indigo'));
  left.firstChild.style.margin = '0';
  head.append(left);
  card.append(head);
  card.append(el('p', '说明：本雷达仅观测运行时并发写集排他锁（静态 traceability-version-lock.json 请见「📝 审阅与对齐」）。演练沙箱锁可在右上角释放，真实项目磁盘锁仅供只读监测预警。', 'st-muted-xs'));

  if (!allLocks.length) {
    card.append(el('p', '当前范围内暂无活跃排他文件锁，说明没有并发智能体写锁阻塞。', 'st-muted-xs'));
    host.append(card);
    return;
  }

  const grid = el('div', null, 'st-lock-grid');
  for (const lk of allLocks) {
    const isWarn = lk.isActive && lk.isStaleWarning;
    const lc = el('div', null, `st-lock-card${lk.isActive ? ' is-active' : ''}${isWarn ? ' is-warn' : ''}`);
    const top = el('div', null, 'st-repo-opt-head');
    top.append(el('strong', lk.name || 'lock'), el('span', lk.lockKind || 'lock', 'st-badge st-badge-zinc'));
    const statusBadge = isWarn
      ? el('span', '⚠️ 持锁超时预警', 'st-badge st-badge-amber')
      : el('span', '🔒 活跃持锁中', 'st-badge st-badge-indigo');

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
    if (lk.targetTitles?.length > 1) lc.append(el('div', `关联监控源：${lk.targetTitles.join(' · ')}`, 'st-muted-xs'));
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
      for (const [h, tip] of [['序号', null], ['事件类型 (eventType)', null], ['产生者 (producer)', null], ['时间戳', null], ['recordDigest 摘要', null], ['链接校验', 'col:chainVer']]) {
        hr.append(tip ? thWithInfo(document, h, tip) : el('th', h));
      }
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
  for (const [h, tip] of [['运行源 / 文件', null], ['PID', null], ['命令/脚本', null], ['状态', 'rt:processStatus'], ['退出码', null], ['耗时', null], ['保护标记', 'col:procGuard']]) {
    hr.append(tip ? thWithInfo(document, h, tip) : el('th', h));
  }
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

function renderDiagnosticsView(host, scopedTargets, lockWarnMs, { onEditTarget = null, onRemoveTarget = null } = {}) {
  const scenarioBanner = el('div', '什么时候看这里：日常看进度与会话协作无需打开本页；仅当任务长时间卡住不动、报排他写锁超时或子进程异常强杀时点开排障。', 'st-scenario-banner');
  host.append(scenarioBanner);

  const allLocks = collectUniqueScopedLocks(scopedTargets);
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
    secCard.append(wrapProseTable(buildRuntimeTargetsTable(scopedTargets, document, {
      writable: state.writable,
      onEdit: onEditTarget,
      onRemove: onRemoveTarget,
    })));
  }
  host.append(secCard);
}

function renderRuntimeScopeToolbar(targetHost, { curRepo, repoTargets, allTargets, scopeBaseTargets, onEditTarget, onRemoveTarget, onPaintSync, onMountSync }) {
  const bar = el('div', null, 'st-card st-rt-toolbar');
  const leftBar = el('div', null, 'st-graph-controls');
  const scopeSwitch = el('div', null, 'st-view-switch');
  const bRepo = el('button', `聚焦当前项目 (${curRepo?.name || '当前仓'} · ${repoTargets.length})`, `st-btn${state.rtScope === 'repo' ? ' is-active' : ''}`);
  bRepo.type = 'button';
  bRepo.addEventListener('click', () => {
    state.rtScope = 'repo';
    state.rtSelectedTargetId = '__all__';
    if (typeof onPaintSync === 'function') onPaintSync();
    else renderRuntimePanel({ forceRefresh: false });
  });
  const bAll = el('button', `全工作区监控源聚合 (${allTargets.length} 源)`, `st-btn${state.rtScope === 'workspace' ? ' is-active' : ''}`);
  bAll.type = 'button';
  bAll.addEventListener('click', () => {
    state.rtScope = 'workspace';
    state.rtSelectedTargetId = '__all__';
    if (typeof onPaintSync === 'function') onPaintSync();
    else renderRuntimePanel({ forceRefresh: false });
  });
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
  srcSelect.addEventListener('change', () => {
    state.rtSelectedTargetId = srcSelect.value;
    if (typeof onPaintSync === 'function') onPaintSync();
    else renderRuntimePanel({ forceRefresh: false });
  });
  leftBar.append(scopeSwitch, infoTrigger('rt:scope', document), srcSelect);

  const rightBar = el('div', null, 'st-graph-controls');
  const mountBtn = el('button', '+ 挂载运行源', 'st-btn');
  mountBtn.type = 'button';
  mountBtn.disabled = !state.writable;
  mountBtn.addEventListener('click', () => openRegisterRuntimeModal(() => (onMountSync ? onMountSync() : renderRuntimePanel({ forceRefresh: true }))));
  rightBar.append(mountBtn);

  bar.append(leftBar, rightBar);
  targetHost.append(bar);

  const customTargets = scopeBaseTargets.filter(t => t.isUserRegistered);
  if (customTargets.length > 0) {
    const customBar = el('div', null, 'st-upstream-capsule-bar');
    const customList = el('div', null, 'st-graph-controls');
    customList.append(el('span', `已挂载自定义运行源 (${customTargets.length})：`, 'st-muted-xs'));
    for (const ct of customTargets) {
      customList.append(el('span', `${ct.title} (${ct.id})`, 'st-badge st-badge-zinc'));
      const edBtn = el('button', '✏️ 编辑', 'st-btn');
      edBtn.type = 'button';
      edBtn.style.height = '26px';
      edBtn.disabled = !state.writable;
      edBtn.addEventListener('click', () => onEditTarget?.(ct));
      const rmBtn = el('button', '🗑️ 移除', 'st-btn');
      rmBtn.type = 'button';
      rmBtn.style.height = '26px';
      rmBtn.disabled = !state.writable;
      rmBtn.addEventListener('click', () => onRemoveTarget?.(ct));
      customList.append(edBtn, rmBtn);
    }
    customBar.append(customList);
    targetHost.append(customBar);
  }
}

let runtimeLoadSeq = 0;

async function renderRuntimePanel({ forceRefresh = true } = {}) {
  stopLockTicker();
  const host = document.getElementById('st-panel-runtime');
  const mySeq = ++runtimeLoadSeq;
  if (!state.runtime) {
    host.replaceChildren(el('p', '正在采集 Foundation 运行态与会话编队快照…', 'st-muted-xs'));
  }
  if (forceRefresh || !state.runtime || state.runtimeRepoId !== state.repoId) {
    try {
      const [rtRes, fleetRes] = await Promise.all([
        apiJson(`/api/studio/runtime?repo=${encodeURIComponent(state.repoId || '')}`),
        apiJson('/api/studio/fleet').catch(() => null),
      ]);
      if (mySeq !== runtimeLoadSeq) return;
      state.runtime = rtRes;
      state.runtimeRepoId = state.repoId;
      if (fleetRes) state.fleet = fleetRes;
    } catch (err) {
      if (mySeq !== runtimeLoadSeq) return;
      host.replaceChildren(el('p', `读取运行态失败：${err.message}`, 'st-muted-xs'));
      return;
    }
  }

  const paintRuntimeView = () => {
    stopLockTicker();
    host.replaceChildren();
    const rt = state.runtime;
    if (!rt) return;
    const curRepo = state.repos.find(r => r.id === state.repoId);
    const allTargets = rt.targets || [];
    const repoTargets = state.repoId
      ? allTargets.filter(t => t.repoId === state.repoId || t.isSandbox)
      : allTargets;
    const scopeBaseTargets = state.rtScope === 'repo' ? repoTargets : allTargets;
    if (state.rtSelectedTargetId !== '__all__' && !scopeBaseTargets.some(t => t.id === state.rtSelectedTargetId)) {
      state.rtSelectedTargetId = '__all__';
    }
    const scopedTargets = state.rtSelectedTargetId === '__all__'
      ? scopeBaseTargets
      : scopeBaseTargets.filter(t => t.id === state.rtSelectedTargetId);

    const sLocks = collectUniqueScopedLocks(scopedTargets);
    const sActiveLocks = sLocks.filter(l => l.isActive);
    const sWarnCount = sActiveLocks.filter(l => l.isStaleWarning).length
      + scopedTargets.filter(t => t.stateStore?.integrity === 'CHAIN_BROKEN').length
      + scopedTargets.flatMap(t => t.processes || []).filter(p => p.processStatus === 'TIMED_OUT').length;
    const fleetFamCount = state.fleet?.families?.length ?? 0;

    const runSandboxWithGuard = async triggerBtn => {
      const prevTxt = triggerBtn?.textContent;
      if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = '演练中…'; }
      try {
        await apiJson('/api/studio/runtime/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        showStudioToast('✓ 已生成隔离沙箱演练数据（含 3 层任务树、6 节点编队与排他写锁）', { tone: 'emerald' });
        renderRuntimePanel({ forceRefresh: true });
      } catch (err) {
        showStudioToast(`启动沙箱演练失败：${err.message}`, { tone: 'error' });
      } finally {
        if (triggerBtn) { triggerBtn.disabled = !state.writable; triggerBtn.textContent = prevTxt || '▶ 运行隔离沙箱演练'; }
      }
    };

    const releaseSandboxWithGuard = async triggerBtn => {
      if (triggerBtn) triggerBtn.disabled = true;
      try {
        await apiJson('/api/studio/runtime/sandbox/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        showStudioToast('🔓 已释放沙箱排他写锁', { tone: 'emerald' });
        renderRuntimePanel({ forceRefresh: true });
      } catch (err) {
        showStudioToast(`释放沙箱锁失败：${err.message}`, { tone: 'error' });
      } finally {
        if (triggerBtn) triggerBtn.disabled = !state.writable;
      }
    };

    const handleEditTarget = target => {
      if (!state.writable) {
        showStudioToast('当前处于只读模式（--readonly），无法编辑挂载运行源。', { tone: 'warn' });
        return;
      }
      openRegisterRuntimeModal(() => renderRuntimePanel({ forceRefresh: true }), target);
    };

    const handleRemoveTarget = async target => {
      if (!state.writable) {
        showStudioToast('当前处于只读模式（--readonly），无法移除运行源。', { tone: 'warn' });
        return;
      }
      try {
        await apiJson('/api/studio/runtime/unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: target.id }),
        });
        if (state.rtSelectedTargetId === target.id) state.rtSelectedTargetId = '__all__';
        showStudioToast(`✓ 已移除自定义运行源「${target.id}」`, { tone: 'emerald' });
        renderRuntimePanel({ forceRefresh: true });
      } catch (err) {
        showStudioToast(`移除运行源失败：${err.message}`, { tone: 'error' });
      }
    };

    // 一级子视图导航栏（顶层只放子视图切换 + SSE + 沙箱演练/释放）
    const topNavCard = el('div', null, 'st-card st-rt-subtabs-head');
    const subBar = el('div', null, 'st-graph-controls');
    for (const [vk, vl, tipKey] of [
      ['tasks', '🌳 任务推进树', 'rt:view:tasks'],
      ['fleet', `🛰️ 智能体会话编队 (${fleetFamCount})`, 'rt:view:fleet'],
      ['diag', `🩺 异常排障 (${sWarnCount > 0 ? `⚠️ ${sWarnCount} 告警` : '🟢 无卡死'})`, 'rt:view:diag'],
    ]) {
      const b = el('button', vl, `st-btn${state.rtView === vk ? ' is-active' : ''}`);
      b.type = 'button';
      b.addEventListener('click', () => { state.rtView = vk; paintRuntimeView(); });
      subBar.append(b, infoTrigger(tipKey, document));
    }

    const rightBar = el('div', null, 'st-graph-controls');
    const ssePill = el('span', null, 'st-live-pill');
    ssePill.append(el('span', null, 'st-live-dot'), el('span', state.rtSseStatus === 'connected' ? 'SSE 实时同步' : '重连中…'));

    const sbxBtn = el('button', '▶ 运行隔离沙箱演练', 'st-btn st-btn-primary');
    sbxBtn.type = 'button';
    sbxBtn.disabled = !state.writable;
    sbxBtn.addEventListener('click', () => runSandboxWithGuard(sbxBtn));

    rightBar.append(ssePill, sbxBtn);
    if (rt.hasActiveSandboxLock) {
      const relBtn = el('button', '🔓 释放沙箱锁', 'st-btn st-btn-amber');
      relBtn.type = 'button';
      relBtn.disabled = !state.writable;
      relBtn.addEventListener('click', () => releaseSandboxWithGuard(relBtn));
      rightBar.append(relBtn);
    }
    topNavCard.append(subBar, rightBar);
    host.append(topNavCard);

    const viewHost = el('div');
    host.append(viewHost);

    const lockWarnMs = rt.kpi?.lockWarnMs || 30000;
    if (state.rtView === 'tasks') {
      renderRuntimeScopeToolbar(viewHost, {
        curRepo,
        repoTargets,
        allTargets,
        scopeBaseTargets,
        onEditTarget: handleEditTarget,
        onRemoveTarget: handleRemoveTarget,
        onPaintSync: paintRuntimeView,
        onMountSync: () => renderRuntimePanel({ forceRefresh: true }),
      });
      renderTaskTreeView(viewHost, scopedTargets, {
        plans: rt.plans || [],
        fleetFamCount,
        onGoFleet: () => { state.rtView = 'fleet'; paintRuntimeView(); },
        onScopeWorkspace: paintRuntimeView,
        onRunSandbox: runSandboxWithGuard,
        onMountSource: () => openRegisterRuntimeModal(() => renderRuntimePanel({ forceRefresh: true })),
      });
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
          onRunSandbox: () => runSandboxWithGuard(sbxBtn),
        });
      };
      paintFleet();
    } else {
      renderRuntimeScopeToolbar(viewHost, {
        curRepo,
        repoTargets,
        allTargets,
        scopeBaseTargets,
        onEditTarget: handleEditTarget,
        onRemoveTarget: handleRemoveTarget,
        onPaintSync: paintRuntimeView,
        onMountSync: () => renderRuntimePanel({ forceRefresh: true }),
      });
      renderDiagnosticsView(viewHost, scopedTargets, lockWarnMs, {
        onEditTarget: handleEditTarget,
        onRemoveTarget: handleRemoveTarget,
      });
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
  };

  paintRuntimeView();
}

function renderActiveTab() {
  if (state.tab === 'guide') renderGuidePanel();
  else if (state.tab === 'graph') renderGraphPanel();
  else if (state.tab === 'review') renderReviewPanel();
  else if (state.tab === 'runtime') renderRuntimePanel({ forceRefresh: !state.runtime || state.runtimeRepoId !== state.repoId });
}

let selectRepoSeq = 0;
let selectRepoAbort = null;

async function selectRepo(repoId, { skipRender = false } = {}) {
  if (!repoId) return;
  const mySeq = ++selectRepoSeq;
  if (selectRepoAbort) selectRepoAbort.abort();
  selectRepoAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = selectRepoAbort?.signal;
  state.repoId = repoId;
  state.snap = null;
  state.alignment = null;
  state.selectedUid = null;
  state.graphMode = 'dag';
  state.archifyIdx = 0;
  state.archifySelectedNode = null;
  state.selectedAnchor = null;
  state.rtSelectedTargetId = '__all__';
  updateTopbarSummary();
  renderTopContextBars();
  if (!skipRender) renderActiveTab();
  const u = new URL(location.href);
  u.searchParams.set('repo', repoId);
  if (state.tab) u.searchParams.set('tab', state.tab);
  history.replaceState(null, '', u);
  let data;
  let alignData;
  try {
    [data, alignData] = await Promise.all([
      apiJson(`/api/studio/repo?repo=${encodeURIComponent(repoId)}`, signal ? { signal } : {}),
      apiJson(`/api/studio/alignment?repo=${encodeURIComponent(repoId)}`, signal ? { signal } : {}).catch(() => null),
    ]);
  } catch (err) {
    if (err?.name === 'AbortError' || mySeq !== selectRepoSeq) return;
    throw err;
  }
  if (mySeq !== selectRepoSeq) return;
  state.snap = data.snapshot;
  state.alignment = alignData;
  state.repoCountsCache?.set(repoId, {
    reviewableCount: state.snap.reviewItems?.length ?? 0,
    nodeCount: state.snap.nodes?.length ?? 0,
  });
  const def = pickDefaultArtifactNode(state.snap.nodes || []) || (state.snap.reviewItems || [])[0] || null;
  state.selectedUid = def ? def.uid : null;
  if (!skipRender) {
    state.reviewMode = (state.alignment?.portfolio?.present || state.alignment?.upstreamBindings?.present) ? 'alignment' : 'reader';
  }
  updateTopbarSummary();
  renderTopContextBars();
  if (!skipRender) renderActiveTab();
}

async function openExportDrawer() {
  const backdrop = document.getElementById('st-export-backdrop');
  const preview = document.getElementById('st-export-preview');
  backdrop.hidden = false;
  preview.textContent = '正在汇总当前工作区全部受管仓库审阅台账…';
  try {
    const sum = await apiJson('/api/studio/summary');
    const md = sum.markdown || '';
    const hasAny = Object.keys(state.decisions || {}).length > 0 || (state.annotations || []).length > 0;
    preview.textContent = hasAny
      ? md
      : `（提示：当前各受管仓库尚未写入审阅结论或批注，以下为初始汇总模板；完成第 ② 步「按顺序逐篇审阅」后会自动填充正文清单）\n\n${md}`;
  } catch (err) {
    preview.textContent = `加载汇总台账失败：${err.message}`;
  }
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
    if (frame?.src) {
      try {
        const u = new URL(frame.src, location.href);
        u.searchParams.set('theme', nxt);
        frame.src = u.toString();
      } catch {}
    }
  });
  document.getElementById('st-progress-capsule').addEventListener('click', openExportDrawer);

  const exportBackdrop = document.getElementById('st-export-backdrop');
  document.getElementById('st-export-close').addEventListener('click', () => { exportBackdrop.hidden = true; });
  exportBackdrop.addEventListener('click', ev => { if (ev.target === exportBackdrop) exportBackdrop.hidden = true; });

  const copyMdBtn = document.getElementById('st-copy-md-btn');
  copyMdBtn.addEventListener('click', async () => {
    const orig = '📋 一键复制 Markdown 验收单';
    try {
      await navigator.clipboard?.writeText(document.getElementById('st-export-preview').textContent || '');
      copyMdBtn.textContent = '✓ 已复制';
      setTimeout(() => { copyMdBtn.textContent = orig; }, 1500);
    } catch {
      copyMdBtn.textContent = '复制受限，请用下方下载';
      setTimeout(() => { copyMdBtn.textContent = orig; }, 2000);
    }
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
  document.getElementById('st-add-repo-btn')?.addEventListener('click', openAddRepoModal);
  document.getElementById('st-edit-repo-meta-btn')?.addEventListener('click', () => {
    const cur = state.repos.find(r => r.id === state.repoId);
    if (cur) openRepoMetaModal(cur);
  });
  document.querySelectorAll('.st-tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 点击空白处收起项目切换器；Escape 按优先级依次关闭浮层/全屏模式
  document.addEventListener('pointerdown', ev => {
    if (!pop.hidden && !pop.contains(ev.target) && !trig.contains(ev.target)) {
      closeRepoPopover();
    }
  });
  document.addEventListener('keydown', ev => {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      if (!pop.hidden) {
        const rs = document.getElementById('st-repo-search');
        rs?.focus();
        rs?.select?.();
        return;
      }
      if (state.tab === 'review') {
        const targetSearch = state.reviewMode === 'alignment'
          ? (document.getElementById('st-align-search') || document.getElementById('st-review-search'))
          : (document.getElementById('st-review-search') || document.getElementById('st-align-search'));
        if (targetSearch) {
          targetSearch.focus();
          targetSearch.select?.();
          return;
        }
      } else if (state.tab === 'runtime') {
        const rtSearch = document.getElementById('st-plan-search')
          || document.querySelector('#st-panel-runtime .st-md-master input[type="search"], #st-panel-runtime input[type="search"]');
        if (rtSearch) {
          rtSearch.focus();
          rtSearch.select?.();
          return;
        }
      }
      pop.hidden = false;
      trig.setAttribute('aria-expanded', 'true');
      renderRepoPopover();
      const rs = document.getElementById('st-repo-search');
      rs?.focus();
      rs?.select?.();
      return;
    }
    if (ev.key !== 'Escape') return;
    if (isTooltipOpen(document)) { closeGlobalTooltip(document); return; }
    const repoModal = document.getElementById('st-repo-modal');
    if (repoModal) { repoModal.remove(); return; }
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
  state.writable = init.writable !== false;
  state.repos = init.ecosystem?.repos || [];
  state.decisions = init.decisions || {};
  state.annotations = init.annotations || [];
  state.guide = init.guide || null;

  const qs = new URLSearchParams(location.search);
  const initialRepo = qs.get('repo') || init.defaultRepo || init.ecosystem?.primaryRepoId || state.repos[0]?.id;
  const initRole = state.repos.find(r => r.id === initialRepo)?.repoRole || 'standalone';
  const fallbackTab = state.repos.length === 0
    ? 'guide'
    : ((initRole === 'portfolio' || initRole === 'subproject') ? 'review' : 'graph');
  const initialTab = qs.get('tab') || init.defaultTab || fallbackTab;

  if (initialRepo) await selectRepo(initialRepo);
  else updateTopbarSummary();
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
    es.addEventListener('catalog-change', async () => {
      const fresh = await apiJson('/api/studio/state?refresh=1');
      await applyEcosystemUpdate(fresh.ecosystem);
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
