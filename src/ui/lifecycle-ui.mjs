// @feature STU004
// @feature STU005

const ROLE_LABELS = Object.freeze({
  lead: { label: '主导', tone: 'indigo' },
  'co-owner': { label: '共建', tone: 'emerald' },
  gate: { label: '门禁', tone: 'amber' },
  evidence: { label: '证据', tone: 'purple' },
  'slot-provider': { label: '方法槽位', tone: 'emerald' },
});

const MATURITY_META = Object.freeze({
  implemented: { label: '已落地', dot: '🟢', tone: 'emerald' },
  partial: { label: '部分就绪', dot: '🔵', tone: 'indigo' },
  planned: { label: '规划待建', dot: '⚪', tone: 'zinc' },
  risk_drift: { label: '断代/环路风险', dot: '🔴', tone: 'rose' },
});

const PLANE_LABELS = Object.freeze({
  asset_evidence_plane: '资产与证据平面',
  execution_plane: '执行平面',
  governance_security_plane: '治理与安全平面',
  collaboration_plane: '协作平面',
});

const CAP_STATUS_META = Object.freeze({
  implemented: { label: '✅ 已落地', tone: 'emerald' },
  partial: { label: '🔵 部分就绪', tone: 'indigo' },
  gap: { label: '🟠 能力缺口', tone: 'amber' },
});

const FLOW_STATUS_META = Object.freeze({
  active: { label: '🟢 已贯通单向契约', tone: 'emerald' },
  risk_cycle: { label: '🔴 双向耦合环（待剪断）', tone: 'rose' },
  version_drift: { label: '🟠 底座版本断代漂移', tone: 'amber' },
  planned: { label: '⚪ 规划待落地契约', tone: 'zinc' },
});

function createDomHelpers(doc) {
  const mk = (tag, text, cls) => {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const badge = (text, tone = 'zinc', extraCls = '') => mk(
    'span',
    text,
    `st-badge st-badge-${tone}${extraCls ? ` ${extraCls}` : ''}`,
  );
  const probeLine = (sourceText, prefix = 'ⓘ 机器探针来源：') => {
    const line = mk('div', `${prefix}${sourceText || '注册表声明'}`, 'st-lc-probe-source st-tabular');
    return line;
  };
  return { mk, badge, probeLine };
}

function renderMatrixDetailPanel(doc, data, state, { onSelectRepo }) {
  const { mk, badge, probeLine } = createDomHelpers(doc);
  const phases = data.phases || [];
  const planes = data.crossCuttingPlanes || [];
  const allSwimlaneRepos = [
    ...(data.swimlane?.coreRows || []),
    ...(data.swimlane?.methodRows || []),
  ];
  const repoById = new Map();
  for (const r of data.repositories || []) {
    repoById.set(r.id, r);
    repoById.set(r.name, r);
    repoById.set(r.publicName, r);
  }

  const sel = state.lcSelectedDetail || { kind: 'phase', phaseId: phases[0]?.id || 'P1' };
  const panel = mk('aside', null, 'st-card st-lc-detail-panel');
  panel.dataset.role = 'matrix-detail-panel';

  if (sel.kind === 'plane') {
    const plane = planes.find(p => p.id === sel.planeId) || planes[0];
    if (!plane) return panel;
    const head = mk('div', null, 'st-repo-opt-head');
    const titleWrap = mk('div', null, 'st-graph-controls');
    titleWrap.append(badge('常驻横切平面 · P1→P8', 'indigo'), mk('h3', plane.title, 'st-lc-detail-title'));
    head.append(titleWrap);
    panel.append(head, mk('p', plane.summary, 'st-muted-xs'));

    const metaRow = mk('div', null, 'st-lc-pill-row');
    metaRow.append(mk('span', '核心支柱：', 'st-muted-xs'));
    for (const pil of plane.pillars || []) metaRow.append(badge(pil, 'purple'));
    panel.append(metaRow);

    const compareGrid = mk('div', null, 'st-lc-dual-state-grid');
    const idealBox = mk('div', null, 'st-lc-state-box is-ideal');
    idealBox.append(badge('理想态', 'indigo'), mk('p', plane.idealState, ''));
    const curBox = mk('div', null, 'st-lc-state-box is-current');
    curBox.append(badge('现状', 'amber'), mk('p', plane.currentState, ''));
    compareGrid.append(idealBox, curBox);
    panel.append(compareGrid);

    const probeBox = mk('div', null, 'st-lc-probe-box');
    probeBox.append(mk('strong', '🔍 承载组件实时机器探针核验'));
    for (const ownerKey of plane.ownerRepos || []) {
      const r = repoById.get(ownerKey);
      if (!r) continue;
      const row = mk('div', null, 'st-lc-owner-probe-row');
      const left = mk('div', null, 'st-graph-controls');
      left.append(
        mk('strong', r.publicName),
        badge(r.ringBadge?.label || '内环核心', r.ringBadge?.tone || 'indigo'),
        badge(`v${r.live?.sourceVersion?.version || '—'}`, 'zinc'),
        badge(`底座 ${r.live?.foundation?.foundationTrackActual || '—'}`, r.live?.foundation?.hasLegacy022 ? 'rose' : 'emerald'),
        badge(r.live?.locksAndReceipt?.badgeLabel || '未建锁', r.live?.locksAndReceipt?.badgeTone || 'zinc'),
      );
      if (r.studioRepoId && typeof onSelectRepo === 'function') {
        const jb = mk('button', '↗ 在工作台打开', 'st-jump-pill');
        jb.type = 'button';
        jb.addEventListener('click', () => onSelectRepo(r.studioRepoId));
        left.append(jb);
      }
      row.append(
        left,
        probeLine(`${r.live?.sourceVersion?.probeSource || ''} · ${r.live?.foundation?.probeSource || ''} · ${r.live?.locksAndReceipt?.probeSource || ''}`),
      );
      probeBox.append(row);
    }
    panel.append(probeBox);
    return panel;
  }

  const phase = phases.find(p => p.id === sel.phaseId) || phases[0];
  if (!phase) return panel;
  const cellRepo = sel.kind === 'cell' ? allSwimlaneRepos.find(r => r.id === sel.repoId) : null;
  const cellData = cellRepo?.phaseCells?.[phase.id] || null;

  const head = mk('div', null, 'st-repo-opt-head');
  const titleWrap = mk('div', null, 'st-graph-controls');
  titleWrap.append(
    badge(phase.id, 'indigo'),
    mk('h3', cellRepo ? `${phase.title} × ${cellRepo.publicName}` : phase.title, 'st-lc-detail-title'),
  );
  if (cellRepo) {
    titleWrap.append(badge(cellRepo.ringBadge?.label || '内环核心', cellRepo.ringBadge?.tone || 'indigo'));
    if (cellData) {
      const rm = ROLE_LABELS[cellData.role] || { label: cellData.role, tone: 'zinc' };
      const mm = MATURITY_META[cellData.maturity] || MATURITY_META.planned;
      titleWrap.append(badge(`职责：${rm.label}`, rm.tone), badge(`${mm.dot} ${mm.label}`, mm.tone));
    }
  }
  const gateBadge = badge(`准出门禁：${phase.gateAuthority}`, 'amber');
  head.append(titleWrap, gateBadge);
  panel.append(head, mk('p', phase.summary, 'st-muted-xs'));

  if (cellRepo && cellData) {
    const cellDual = mk('div', null, 'st-lc-dual-state-grid');
    const cIdeal = mk('div', null, 'st-lc-state-box is-ideal');
    cIdeal.append(badge(`${cellRepo.publicName} · 理想态职责`, 'indigo'), mk('p', cellData.ideal, ''));
    const cCur = mk('div', null, 'st-lc-state-box is-current');
    cCur.append(badge(`${cellRepo.publicName} · 现状落位`, cellData.maturity === 'risk_drift' ? 'rose' : 'amber'), mk('p', cellData.current, ''));
    cellDual.append(cIdeal, cCur);
    panel.append(cellDual);
  }

  const phaseDual = mk('div', null, 'st-lc-dual-state-grid');
  const pIdeal = mk('div', null, 'st-lc-state-box is-ideal');
  pIdeal.append(badge(`${phase.id} 阶段整体理想态`, 'indigo'), mk('p', phase.idealState, ''));
  const pCur = mk('div', null, 'st-lc-state-box is-current');
  pCur.append(badge(`${phase.id} 阶段整体现状`, 'amber'), mk('p', phase.currentState, ''));
  phaseDual.append(pIdeal, pCur);
  panel.append(phaseDual);

  const ioGrid = mk('div', null, 'st-lc-io-grid');
  const inBox = mk('div', null, 'st-lc-io-card');
  inBox.append(mk('strong', '📥 阶段输入契约 (inputContracts)'));
  const inPills = mk('div', null, 'st-lc-pill-row');
  for (const ic of phase.inputContracts || []) inPills.append(badge(ic, 'zinc'));
  inBox.append(inPills);

  const outBox = mk('div', null, 'st-lc-io-card');
  outBox.append(mk('strong', '📤 阶段输出契约与证据 (outputContracts)'));
  const outPills = mk('div', null, 'st-lc-pill-row');
  for (const oc of phase.outputContracts || []) outPills.append(badge(oc, 'emerald'));
  outBox.append(outPills);
  ioGrid.append(inBox, outBox);
  panel.append(ioGrid);

  const capBox = mk('div', null, 'st-lc-io-card');
  capBox.append(mk('strong', `🧩 本阶段核心能力清单 (${(phase.capabilities || []).length} 项)`));
  const capUl = mk('ul', null, 'st-lc-cap-list');
  for (const c of phase.capabilities || []) capUl.append(mk('li', c));
  capBox.append(capUl);
  panel.append(capBox);

  const probeTargets = cellRepo
    ? [cellRepo]
    : (phase.ownerRepos || []).map(k => repoById.get(k)).filter(Boolean);
  if (probeTargets.length > 0) {
    const probeBox = mk('div', null, 'st-lc-probe-box');
    probeBox.append(mk('strong', '🔍 阶段责任仓实时机器探针与来源核验'));
    for (const r of probeTargets) {
      const row = mk('div', null, 'st-lc-owner-probe-row');
      const top = mk('div', null, 'st-graph-controls');
      top.append(
        mk('strong', r.publicName),
        badge(r.ringBadge?.label || '内环核心', r.ringBadge?.tone || 'indigo'),
        badge(`版本 ${r.live?.sourceVersion?.version || '未检出'}`, 'zinc'),
        badge(
          `Foundation ${r.live?.foundation?.foundationTrackActual || '—'} (期望 ${r.expectedFoundationTrack})`,
          r.live?.foundation?.hasLegacy022 ? 'rose' : (r.live?.foundation?.alignedWithExpected ? 'emerald' : 'amber'),
        ),
        badge(r.live?.locksAndReceipt?.badgeLabel || '未建锁', r.live?.locksAndReceipt?.badgeTone || 'zinc'),
      );
      if (r.live?.git?.latestGitTag) {
        top.append(badge(`Tag ${r.live.git.latestGitTag}${r.live.git.aheadCommits ? ` +${r.live.git.aheadCommits}` : ''}`, 'zinc'));
      }
      if (r.studioRepoId && typeof onSelectRepo === 'function') {
        const jb = mk('button', `↗ 切换至 ${r.publicName}`, 'st-jump-pill');
        jb.type = 'button';
        jb.addEventListener('click', () => onSelectRepo(r.studioRepoId));
        top.append(jb);
      }
      const sourcesJoined = [
        r.live?.sourceVersion?.probeSource,
        r.live?.foundation?.probeSource,
        r.live?.locksAndReceipt?.probeSource,
        r.live?.git?.tagProbeSource,
      ].filter(Boolean).join(' · ');
      row.append(top, probeLine(sourcesJoined));
      probeBox.append(row);
    }
    panel.append(probeBox);
  }
  return panel;
}

function renderMatrixSubView(doc, data, state, callbacks) {
  const { mk, badge } = createDomHelpers(doc);
  const { onStateChange, onSelectRepo } = callbacks;
  const isIdeal = state.lcStateMode === 'ideal';
  const phases = data.phases || [];
  // 严格边界：仅允许 ring === 'core' 进入主泳道行，ring === 'method' 进入中环折叠聚合行，严禁任何 consumer / retired / external-tool 混入！
  const coreRows = (data.swimlane?.coreRows || (data.repositories || []).filter(r => r.ring === 'core'))
    .filter(r => r && r.ring === 'core');
  const methodRows = (data.swimlane?.methodRows || (data.repositories || []).filter(r => r.ring === 'method'))
    .filter(r => r && r.ring === 'method');
  const excl = data.swimlane?.excludedSummary || { consumerCount: 0, retiredCount: 0, externalToolCount: 0 };

  const wrap = mk('div', null, 'st-lc-section-stack');

  // 顶部显著双态分段切换器：理想态 | 现状
  const toolbar = mk('div', null, 'st-card st-lc-matrix-toolbar');
  const leftBar = mk('div', null, 'st-graph-controls');
  const segWrap = mk('div', null, 'st-lc-state-seg');
  segWrap.setAttribute('role', 'tablist');
  segWrap.setAttribute('aria-label', '理想态与现状视图切换');
  for (const [modeKey, modeLbl] of [['ideal', '✨ 理想态（目标蓝图）'], ['current', '🔍 现状（机器探针实测）']]) {
    const b = mk('button', modeLbl, `st-lc-seg-btn${state.lcStateMode === modeKey ? ' is-active' : ''}`);
    b.type = 'button';
    b.dataset.stateMode = modeKey;
    b.setAttribute('aria-selected', String(state.lcStateMode === modeKey));
    b.addEventListener('click', () => {
      state.lcStateMode = modeKey;
      onStateChange();
    });
    segWrap.append(b);
  }
  leftBar.append(
    segWrap,
    badge(`内环核心组件 ${coreRows.length} 个`, 'indigo'),
    badge(`中环 AMR 可插拔方法 ${methodRows.length} 个`, 'emerald'),
  );

  const rightBar = mk('div', null, 'st-graph-controls');
  rightBar.append(
    mk('span', '点击任意阶段表头、泳道单元格或横切平面带可展开契约明细与 ⓘ 机器探针来源', 'st-muted-xs'),
  );
  toolbar.append(leftBar, rightBar);
  wrap.append(toolbar);

  // 八阶段 × 三环泳道矩阵表
  const matrixCard = mk('div', null, 'st-card st-lc-matrix-card');
  const tblWrap = mk('div', null, 'st-lc-matrix-scroll');
  const tbl = mk('table', null, 'st-lc-matrix-table');
  tbl.dataset.role = 'lifecycle-swimlane-matrix';

  const thead = mk('thead');
  const headTr = mk('tr');
  const cornerTh = mk('th', '三环边界 / 承载组件', 'st-lc-sticky-col');
  headTr.append(cornerTh);

  const sel = state.lcSelectedDetail || { kind: 'phase', phaseId: phases[0]?.id || 'P1' };
  for (const ph of phases) {
    const th = mk('th', null, `st-lc-phase-th${sel.kind === 'phase' && sel.phaseId === ph.id ? ' is-selected' : ''}`);
    const thBtn = mk('button', null, 'st-lc-phase-hdr-btn');
    thBtn.type = 'button';
    thBtn.dataset.phaseId = ph.id;
    const topLine = mk('div', null, 'st-repo-opt-head');
    topLine.append(badge(ph.id, 'indigo'), mk('span', `${(ph.capabilities || []).length} 项能力`, 'st-muted-xs'));
    const titleLine = mk('div', ph.shortTitle || ph.title, 'st-lc-phase-short');
    const statePreview = mk(
      'div',
      isIdeal ? ph.idealState : ph.currentState,
      'st-lc-phase-snippet',
    );
    thBtn.append(topLine, titleLine, statePreview);
    thBtn.addEventListener('click', () => {
      state.lcSelectedDetail = { kind: 'phase', phaseId: ph.id };
      onStateChange();
    });
    th.append(thBtn);
    headTr.append(th);
  }
  thead.append(headTr);

  const tbody = mk('tbody');

  const appendRepoRow = (repo, rowKind = 'core') => {
    const tr = mk('tr', null, `st-lc-swimlane-row is-${rowKind}`);
    tr.dataset.swimlaneRing = repo.ring;
    tr.dataset.repoId = repo.id;

    const rowHeadTd = mk('td', null, 'st-lc-sticky-col st-lc-repo-cell');
    const nameRow = mk('div', null, 'st-graph-controls');
    nameRow.append(
      mk('strong', repo.publicName),
      badge(repo.ringBadge?.label || (rowKind === 'core' ? '内环核心' : '可插拔方法'), repo.ringBadge?.tone || (rowKind === 'core' ? 'indigo' : 'emerald')),
    );
    if (repo.studioRepoId && typeof onSelectRepo === 'function') {
      const jumpBtn = mk('button', '↗', 'st-btn st-btn-xs');
      jumpBtn.type = 'button';
      jumpBtn.title = `切换当前工作台仓库至 ${repo.publicName}`;
      jumpBtn.addEventListener('click', () => onSelectRepo(repo.studioRepoId));
      nameRow.append(jumpBtn);
    }
    const subRow = mk('div', null, 'st-lc-pill-row');
    subRow.append(mk('span', repo.layer, 'st-muted-xs'));
    if (repo.live?.sourceVersion?.version) {
      subRow.append(badge(`v${repo.live.sourceVersion.version}`, 'zinc'));
    }
    if (!isIdeal && repo.live?.foundation?.hasLegacy022) {
      subRow.append(badge('⚠️ 0.22.0', 'rose'));
    }
    rowHeadTd.append(nameRow, subRow);
    tr.append(rowHeadTd);

    for (const ph of phases) {
      const cell = repo.phaseCells?.[ph.id] || null;
      const isCellSelected = sel.kind === 'cell' && sel.repoId === repo.id && sel.phaseId === ph.id;
      const td = mk('td', null, `st-lc-matrix-td${cell ? ' has-slot' : ' is-empty'}${isCellSelected ? ' is-selected' : ''}`);
      if (!cell) {
        td.append(mk('span', '—', 'st-lc-empty-dash'));
      } else {
        const rm = ROLE_LABELS[cell.role] || { label: cell.role, tone: 'zinc' };
        const mm = MATURITY_META[cell.maturity] || MATURITY_META.planned;
        const cellBtn = mk('button', null, `st-lc-cell-btn tone-${isIdeal ? rm.tone : mm.tone}`);
        cellBtn.type = 'button';
        cellBtn.dataset.cellKey = `${repo.id}:${ph.id}`;
        const cHead = mk('div', null, 'st-repo-opt-head');
        cHead.append(
          badge(rm.label, rm.tone),
          mk('span', isIdeal ? '目标职责' : `${mm.dot} ${mm.label}`, 'st-lc-cell-maturity'),
        );
        const cText = mk('div', isIdeal ? cell.ideal : cell.current, 'st-lc-cell-text');
        cellBtn.append(cHead, cText);
        cellBtn.addEventListener('click', () => {
          state.lcSelectedDetail = { kind: 'cell', repoId: repo.id, phaseId: ph.id };
          onStateChange();
        });
        td.append(cellBtn);
      }
      tr.append(td);
    }
    tbody.append(tr);
  };

  for (const repo of coreRows) {
    appendRepoRow(repo, 'core');
  }

  // 中环可插拔方法聚合折叠行（AMR 挂载）
  const methodGroupTr = mk('tr', null, 'st-lc-swimlane-row is-method-group');
  methodGroupTr.dataset.swimlaneRing = 'method-group';
  const mgHeadTd = mk('td', null, 'st-lc-sticky-col st-lc-repo-cell');
  const mgBtn = mk(
    'button',
    `${state.lcMethodExpanded ? '▾' : '▸'} 中环可插拔方法 · AMR 挂载 (${methodRows.length} 个提供方)`,
    'st-lc-method-toggle-btn',
  );
  mgBtn.type = 'button';
  mgBtn.dataset.action = 'toggle-method-ring';
  mgBtn.setAttribute('aria-expanded', String(Boolean(state.lcMethodExpanded)));
  mgBtn.addEventListener('click', () => {
    state.lcMethodExpanded = !state.lcMethodExpanded;
    onStateChange();
  });
  mgHeadTd.append(
    mgBtn,
    mk('div', state.lcMethodExpanded ? '已展开独立方法提供方泳道（经 AMR 按槽位契约解耦挂载）' : '点击展开查看各方法提供方在阶段槽位的挂载明细', 'st-muted-xs'),
  );
  methodGroupTr.append(mgHeadTd);

  for (const ph of phases) {
    const activeMethods = methodRows.filter(m => Boolean(m.phaseCells?.[ph.id]));
    const td = mk('td', null, `st-lc-matrix-td${activeMethods.length > 0 ? ' has-slot' : ' is-empty'}`);
    if (activeMethods.length === 0) {
      td.append(mk('span', '—', 'st-lc-empty-dash'));
    } else {
      const slotBtn = mk('button', null, 'st-lc-cell-btn tone-emerald');
      slotBtn.type = 'button';
      slotBtn.append(
        badge(`AMR 槽位 ×${activeMethods.length}`, 'emerald'),
        mk('div', activeMethods.map(m => m.publicName).join(' · '), 'st-lc-cell-text'),
      );
      slotBtn.addEventListener('click', () => {
        state.lcMethodExpanded = true;
        state.lcSelectedDetail = { kind: 'cell', repoId: activeMethods[0].id, phaseId: ph.id };
        onStateChange();
      });
      td.append(slotBtn);
    }
    methodGroupTr.append(td);
  }
  tbody.append(methodGroupTr);

  if (state.lcMethodExpanded) {
    for (const mRepo of methodRows) {
      appendRepoRow(mRepo, 'method');
    }
  }

  tbl.append(thead, tbody);
  tblWrap.append(tbl);
  matrixCard.append(tblWrap);

  // 底部 4 条横切平面常驻带（贯穿 P1..P8）
  const planesBox = mk('div', null, 'st-lc-planes-section');
  planesBox.append(mk('div', '常驻四横切平面带（从 P1 立项起全程贯穿至 P8 运维治理）', 'st-lc-subhead'));
  const planesStack = mk('div', null, 'st-lc-planes-stack');
  for (const pl of data.crossCuttingPlanes || []) {
    const isPlSel = sel.kind === 'plane' && sel.planeId === pl.id;
    const band = mk('button', null, `st-lc-plane-band${isPlSel ? ' is-selected' : ''}`);
    band.type = 'button';
    band.dataset.planeId = pl.id;
    const bTop = mk('div', null, 'st-repo-opt-head');
    const bLeft = mk('div', null, 'st-graph-controls');
    bLeft.append(badge('P1 ──▶ P8 横切平面', 'purple'), mk('strong', pl.title));
    const bRight = mk('div', null, 'st-lc-pill-row');
    for (const p of (pl.pillars || []).slice(0, 4)) bRight.append(badge(p, 'zinc'));
    bTop.append(bLeft, bRight);
    const bBody = mk('div', isIdeal ? pl.idealState : pl.currentState, 'st-lc-plane-desc');
    band.append(bTop, bBody);
    band.addEventListener('click', () => {
      state.lcSelectedDetail = { kind: 'plane', planeId: pl.id };
      onStateChange();
    });
    planesStack.append(band);
  }
  planesBox.append(planesStack);
  matrixCard.append(planesBox);

  // 3 条显式受控回流闭环呼出卡（FB-1..FB-3）
  const fbSection = mk('div', null, 'st-lc-planes-section');
  fbSection.append(mk('div', '显式受控回流闭环（防黑箱死循环护栏）', 'st-lc-subhead'));
  const fbGrid = mk('div', null, 'st-lc-feedback-grid');
  for (const fb of data.feedbackLoops || []) {
    const card = mk('div', null, 'st-lc-feedback-card');
    const fHead = mk('div', null, 'st-repo-opt-head');
    fHead.append(
      badge(fb.id, 'amber'),
      badge(`${(fb.fromPhases || []).join('/')} ↺ ${(fb.toPhases || []).join('/')}`, 'indigo'),
    );
    card.append(
      fHead,
      mk('strong', fb.title),
      mk('div', `触发条件：${fb.trigger}`, 'st-muted-xs'),
      mk('div', `受控动作：${fb.action}`, 'st-muted-xs'),
      mk('div', `防失控护栏：${fb.guardrail}`, 'st-lc-guardrail-line'),
    );
    fbGrid.append(card);
  }
  fbSection.append(fbGrid);
  matrixCard.append(fbSection);

  // 紧凑页脚边界摘要条（绝不将下游消费样本渲染为泳道行！）
  const footerStrip = mk('div', null, 'st-lc-boundary-footer');
  footerStrip.dataset.role = 'swimlane-boundary-footer';
  footerStrip.append(
    badge('🛡️ 三环泳道边界隔离', 'zinc'),
    mk(
      'span',
      `外环「下游消费样本」共 ${excl.consumerCount} 个仓、「已退役归并」共 ${excl.retiredCount} 个仓、「外部工具依赖」共 ${excl.externalToolCount} 项已按边界规则严格排除在元生命周期泳道之外（下游承接进度请见「📝 审阅与对齐」）。`,
      'st-muted-xs',
    ),
  );
  matrixCard.append(footerStrip);

  wrap.append(matrixCard);
  wrap.append(renderMatrixDetailPanel(doc, data, state, { onSelectRepo }));
  return wrap;
}

function renderContractsSubView(doc, data, state, callbacks) {
  const { mk, badge, probeLine } = createDomHelpers(doc);
  const { onStateChange, onSelectRepo } = callbacks;
  const wrap = mk('div', null, 'st-lc-section-stack');

  // 1. 实时架构风险与断代漂移体检卡片
  const riskCard = mk('div', null, 'st-card st-guide-section');
  const riskHead = mk('div', null, 'st-repo-opt-head');
  const activeRisks = (data.architecturalRisks || []).filter(r => r.detected);
  riskHead.append(
    mk('h3', '一、架构体检：实时检出结构风险与断代漂移', 'st-lc-sec-title'),
    badge(
      activeRisks.length > 0 ? `🔴 实时检出 ${activeRisks.length} 项活跃风险` : '🟢 0 项活跃风险',
      activeRisks.length > 0 ? 'rose' : 'emerald',
    ),
  );
  riskCard.append(riskHead, mk('p', '以下结论 100% 由服务端实时只读探针扫描各仓库配置、版本钉扎与方法定义动态计算：', 'st-muted-xs'));

  const riskGrid = mk('div', null, 'st-lc-risk-grid');
  for (const risk of data.architecturalRisks || []) {
    const box = mk('div', null, `st-lc-risk-card${risk.detected ? ' is-detected' : ' is-resolved'}`);
    const top = mk('div', null, 'st-repo-opt-head');
    const left = mk('div', null, 'st-graph-controls');
    left.append(
      badge(risk.liveBadgeLabel, risk.liveBadgeTone),
      badge(`探针：${risk.probeKind}`, 'zinc'),
    );
    const stageJump = mk('button', `↪ 收敛阶段：${risk.targetStageId}`, 'st-jump-pill');
    stageJump.type = 'button';
    stageJump.addEventListener('click', () => {
      state.lcSubView = 'roadmap';
      onStateChange();
    });
    top.append(left, stageJump);

    const repoPills = mk('div', null, 'st-lc-pill-row');
    repoPills.append(mk('span', '涉及组件：', 'st-muted-xs'));
    for (const ar of risk.affectedRepos || []) {
      const matched = (data.repositories || []).find(r => r.id === ar || r.name === ar || r.publicName === ar);
      if (matched?.studioRepoId && typeof onSelectRepo === 'function') {
        const b = mk('button', `↗ ${matched.publicName}`, 'st-jump-pill');
        b.type = 'button';
        b.addEventListener('click', () => onSelectRepo(matched.studioRepoId));
        repoPills.append(b);
      } else {
        repoPills.append(badge(matched?.publicName || ar, 'zinc'));
      }
    }

    const liveBox = mk('div', null, 'st-lc-probe-box');
    liveBox.append(
      mk('div', `🔍 机器探针实测：${risk.liveEvidence}`, 'st-lc-live-evidence'),
      probeLine(risk.probeSource),
    );

    box.append(
      top,
      mk('h4', risk.title, 'st-lc-card-h4'),
      repoPills,
      mk('div', `现状缺口：${risk.currentGap}`, 'st-muted-xs'),
      mk('div', `理想态收敛目标：${risk.remediationTarget}`, 'st-lc-ideal-target-line'),
      liveBox,
    );
    riskGrid.append(box);
  }
  riskCard.append(riskGrid);
  wrap.append(riskCard);

  // 2. 有向契约流与控制边
  const flowCard = mk('div', null, 'st-card st-guide-section');
  const flowHead = mk('div', null, 'st-repo-opt-head');
  flowHead.append(
    mk('h3', '二、组件间有向契约流与控制门禁', 'st-lc-sec-title'),
    badge(`共 ${(data.contractFlows || []).length} 条核心契约边`, 'indigo'),
  );
  flowCard.append(flowHead, mk('p', '明确上下游单向契约载荷与门禁边界，重点高亮待剪断的反向调用环路与版本断代边：', 'st-muted-xs'));

  const flowStack = mk('div', null, 'st-lc-flow-stack');
  for (const cf of data.contractFlows || []) {
    const fm = FLOW_STATUS_META[cf.status] || FLOW_STATUS_META.active;
    const isCycle = cf.direction === 'cycle_to_sever' || cf.status === 'risk_cycle';
    const row = mk('div', null, `st-lc-flow-card${isCycle ? ' is-cycle' : ''}`);
    const top = mk('div', null, 'st-repo-opt-head');
    const route = mk('div', null, 'st-lc-flow-route');
    route.append(
      badge(cf.fromRepo, 'indigo'),
      mk('span', isCycle ? ' ⇄ [待剪断环路] ' : ' ──▶ ', 'st-lc-flow-arrow'),
      mk('strong', cf.contractName),
      mk('code', cf.protocolOrSchema, 'st-inline-code'),
      mk('span', ' ──▶ ', 'st-lc-flow-arrow'),
      badge(cf.toRepo, isCycle ? 'rose' : 'emerald'),
    );
    const rightMeta = mk('div', null, 'st-graph-controls');
    for (const p of cf.phases || []) rightMeta.append(badge(p, 'zinc'));
    rightMeta.append(badge(fm.label, fm.tone));
    top.append(route, rightMeta);

    const dual = mk('div', null, 'st-lc-dual-state-grid');
    const idBox = mk('div', null, 'st-lc-state-box is-ideal');
    idBox.append(badge('理想态流向', 'indigo'), mk('p', cf.idealFlow, ''));
    const curBox = mk('div', null, 'st-lc-state-box is-current');
    curBox.append(badge('现状流向', isCycle ? 'rose' : 'amber'), mk('p', cf.currentFlow, ''));
    dual.append(idBox, curBox);

    row.append(top, dual);
    flowStack.append(row);
  }
  flowCard.append(flowStack);
  wrap.append(flowCard);

  // 3. 跨组件关键机制职责切分约定
  const divCard = mk('div', null, 'st-card st-guide-section');
  divCard.append(
    mk('h3', '三、跨组件重叠机制唯一权威切分（防重复造轮）', 'st-lc-sec-title'),
    mk('p', '针对防泄漏扫描三方协同与反伪造双核判定等跨仓衔接处，锁定唯一职责归属与越界红线：', 'st-muted-xs'),
  );
  const divStack = mk('div', null, 'st-lc-section-stack');
  for (const dl of data.divisionOfLabor || []) {
    const box = mk('div', null, 'st-lc-div-card');
    box.append(mk('h4', dl.topic, 'st-lc-card-h4'), mk('p', `总则：${dl.rule}`, 'st-muted-xs'));
    const partGrid = mk('div', null, 'st-lc-part-grid');
    for (const pt of dl.participants || []) {
      const pc = mk('div', null, 'st-lc-part-item');
      pc.append(
        badge(pt.repoId, 'indigo'),
        mk('div', `权威职责：${pt.duty}`, 'st-lc-part-duty'),
        mk('div', `边界红线：${pt.boundary}`, 'st-muted-xs'),
      );
      partGrid.append(pc);
    }
    box.append(partGrid);
    divStack.append(box);
  }
  divCard.append(divStack);
  wrap.append(divCard);

  return wrap;
}

function renderCatalogSubView(doc, data, state, callbacks) {
  const { mk, badge, probeLine } = createDomHelpers(doc);
  const { onStateChange, onSelectRepo } = callbacks;
  const wrap = mk('div', null, 'st-lc-section-stack');

  // 上表：内环核心与中环方法仓实时机器探针台账（严格仅含 core + method）
  const ledgerRepos = (data.ledgerRepos || (data.repositories || []).filter(r => r.ring === 'core' || r.ring === 'method'))
    .filter(r => r && (r.ring === 'core' || r.ring === 'method'));

  const ledgerCard = mk('div', null, 'st-card st-guide-section');
  const lHead = mk('div', null, 'st-graph-toolbar');
  lHead.append(
    mk('h3', `一、内环核心与中环方法仓实时机器探针台账 (${ledgerRepos.length} 仓)`, 'st-lc-sec-title'),
  );
  const ringFilterRow = mk('div', null, 'st-graph-controls');
  for (const [rk, rl] of [
    ['all', `全部 (${ledgerRepos.length})`],
    ['core', `内环核心 (${ledgerRepos.filter(r => r.ring === 'core').length})`],
    ['method', `可插拔方法 (${ledgerRepos.filter(r => r.ring === 'method').length})`],
    ['drift', '⚠️ 底座或收据待对齐'],
  ]) {
    const b = mk('button', rl, `st-btn st-btn-xs${(state.lcLedgerFilter || 'all') === rk ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.lcLedgerFilter = rk;
      onStateChange();
    });
    ringFilterRow.append(b);
  }
  lHead.append(ringFilterRow);
  ledgerCard.append(lHead, mk('p', '每一格采用现状均附带明确机器探针来源（package.json、profile.json、Git Tag、traceability-version-lock.json、sft-runs.json SHA-256、public-release.json）：', 'st-muted-xs'));

  const filteredLedger = ledgerRepos.filter(r => {
    const f = state.lcLedgerFilter || 'all';
    if (f === 'core') return r.ring === 'core';
    if (f === 'method') return r.ring === 'method';
    if (f === 'drift') {
      return Boolean(
        r.live?.foundation?.hasLegacy022
        || !r.live?.foundation?.alignedWithExpected
        || (r.ring === 'core' && r.repoRef !== '.' && !r.live?.locksAndReceipt?.receiptPassed),
      );
    }
    return true;
  });

  const tblWrap1 = mk('div', null, 'st-table-wrap');
  const tbl1 = mk('table', null, 'st-prose-table st-lc-ledger-table');
  const thead1 = mk('thead');
  const htr1 = mk('tr');
  for (const colName of [
    '组件名称与三环归属',
    '源码版本 & Git Tag',
    'Foundation 底座轨道（现状 vs 理想态）',
    '追溯版本锁 & SHA-256 sft 收据',
    '独立 -site (0.7.0) & Hub 状态',
  ]) {
    htr1.append(mk('th', colName));
  }
  thead1.append(htr1);
  const tbody1 = mk('tbody');

  for (const repo of filteredLedger) {
    const tr = mk('tr');
    tr.dataset.ledgerRepo = repo.id;

    // 列 1：组件与环属 + 切换仓库
    const td1 = mk('td');
    const c1Top = mk('div', null, 'st-graph-controls');
    c1Top.append(
      mk('strong', repo.publicName),
      badge(repo.ringBadge?.label || '内环核心', repo.ringBadge?.tone || 'indigo'),
    );
    if (repo.studioRepoId && typeof onSelectRepo === 'function') {
      const swBtn = mk('button', '↗ 切换至此仓', 'st-jump-pill');
      swBtn.type = 'button';
      swBtn.addEventListener('click', () => onSelectRepo(repo.studioRepoId));
      c1Top.append(swBtn);
    }
    const c1Phases = mk('div', null, 'st-lc-pill-row');
    c1Phases.append(mk('span', repo.layer, 'st-muted-xs'));
    for (const p of repo.primaryPhases || []) c1Phases.append(badge(p, 'zinc'));
    td1.append(c1Top, c1Phases);

    // 列 2：版本 + Git Tag + 工作树洁净度
    const td2 = mk('td');
    const verStr = repo.live?.sourceVersion?.version ? `v${repo.live.sourceVersion.version}` : '未声明';
    const git = repo.live?.git || {};
    const tagStr = git.latestGitTag
      ? `${git.latestGitTag}${git.aheadCommits ? ` (+${git.aheadCommits})` : ' (对齐 Tag)'}`
      : '无本地 Tag';
    const cleanStr = git.worktreeClean === true ? '工作树洁净' : (git.worktreeClean === false ? '含未提交改动' : '—');
    const c2Badges = mk('div', null, 'st-lc-pill-row');
    c2Badges.append(
      badge(verStr, 'indigo'),
      badge(tagStr, 'zinc'),
      badge(cleanStr, git.worktreeClean === false ? 'amber' : 'emerald'),
    );
    td2.append(
      c2Badges,
      probeLine(`${repo.live?.sourceVersion?.probeSource || ''} · ${git.tagProbeSource || ''}`),
    );

    // 列 3：Foundation 轨道对比
    const td3 = mk('td');
    const fnd = repo.live?.foundation || {};
    const fndTone = fnd.hasLegacy022 ? 'rose' : (fnd.alignedWithExpected ? 'emerald' : 'amber');
    const c3Top = mk('div', null, 'st-lc-pill-row');
    c3Top.append(
      badge(`现状：${fnd.foundationTrackActual || '—'}`, fndTone),
      badge(`期望：${repo.expectedFoundationTrack}`, 'zinc'),
    );
    td3.append(
      c3Top,
      mk('div', fnd.foundationPinDetail || '', 'st-muted-xs'),
      probeLine(fnd.probeSource),
    );

    // 列 4：追溯锁 & SHA-256 sft 实测收据
    const td4 = mk('td');
    const lr = repo.live?.locksAndReceipt || {};
    td4.append(
      badge(lr.badgeLabel || '未建锁', lr.badgeTone || 'zinc'),
      probeLine(lr.probeSource),
    );

    // 列 5：独立 -site 0.7.0 & Hub 状态
    const td5 = mk('td');
    const ds = repo.live?.docSite || {};
    const c5Row = mk('div', null, 'st-lc-pill-row');
    c5Row.append(badge(ds.label || '不适用', ds.isIndependentSite ? 'emerald' : (ds.alignedWithExpected ? 'zinc' : 'amber')));
    if (ds.pagesUrl) {
      const link = mk('a', '🌐 Pages 站点 ↗', 'st-jump-pill');
      link.href = ds.pagesUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      c5Row.append(link);
    }
    const hubEntries = repo.live?.hubEntries || [];
    const hubTxt = hubEntries.length > 0
      ? `Hub: ${hubEntries[0].marketplaceStatus || hubEntries[0].lifecycleState} (${hubEntries.length} 槽位)`
      : `Hub 期望: ${repo.expectedHubPresence}`;
    c5Row.append(badge(hubTxt, hubEntries.length > 0 ? 'indigo' : 'zinc'));
    td5.append(c5Row, probeLine(ds.probeSource));

    tr.append(td1, td2, td3, td4, td5);
    tbody1.append(tr);
  }
  tbl1.append(thead1, tbody1);
  tblWrap1.append(tbl1);
  ledgerCard.append(tblWrap1);
  wrap.append(ledgerCard);

  // 下表：全谱系能力清单（按阶段 / 横切平面 / 状态 / 核验方式多维过滤，严格区分机器探针实测 vs 架构声明）
  const capList = data.capabilityCatalog || [];
  const capCard = mk('div', null, 'st-card st-guide-section');
  capCard.append(
    mk('h3', `二、八阶段 × 四横切平面全谱系能力清单 (${capList.length} 项)`, 'st-lc-sec-title'),
    mk('p', '严格区分「🔍 机器探针实测」与「📋 架构声明」，杜绝将未配置自动探针的人工架构盘点伪装成机器验证结论：', 'st-muted-xs'),
  );

  const filterBar = mk('div', null, 'st-lc-cap-filters');
  const phasePills = mk('div', null, 'st-graph-controls');
  for (const phKey of ['all', ...(data.phases || []).map(p => p.id)]) {
    const lbl = phKey === 'all' ? '全部阶段' : phKey;
    const b = mk('button', lbl, `st-btn st-btn-xs${(state.lcCapPhase || 'all') === phKey ? ' is-active' : ''}`);
    b.type = 'button';
    b.dataset.capPhase = phKey;
    b.addEventListener('click', () => { state.lcCapPhase = phKey; onStateChange(); });
    phasePills.append(b);
  }

  const secondaryFilters = mk('div', null, 'st-graph-controls');
  for (const [pk, pl] of [
    ['all', '全部平面'],
    ['asset_evidence_plane', '资产与证据'],
    ['execution_plane', '执行平面'],
    ['governance_security_plane', '治理与安全'],
    ['collaboration_plane', '协作平面'],
  ]) {
    const b = mk('button', pl, `st-btn st-btn-xs${(state.lcCapPlane || 'all') === pk ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.lcCapPlane = pk; onStateChange(); });
    secondaryFilters.append(b);
  }

  const statusAndModeRow = mk('div', null, 'st-graph-controls');
  for (const [sk, sl] of [
    ['all', '全部状态'],
    ['implemented', '✅ 已落地'],
    ['partial', '🔵 部分就绪'],
    ['gap', '🟠 能力缺口'],
  ]) {
    const b = mk('button', sl, `st-btn st-btn-xs${(state.lcCapStatus || 'all') === sk ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.lcCapStatus = sk; onStateChange(); });
    statusAndModeRow.append(b);
  }
  for (const [mkKey, mkLbl] of [
    ['all', '全部核验来源'],
    ['machine_probe', '🔍 仅看机器探针实测'],
    ['declared_assessment', '📋 仅看架构声明'],
  ]) {
    const b = mk('button', mkLbl, `st-btn st-btn-xs${(state.lcCapVerifyMode || 'all') === mkKey ? ' is-active' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { state.lcCapVerifyMode = mkKey; onStateChange(); });
    statusAndModeRow.append(b);
  }

  const searchInp = mk('input', null, 'st-input');
  searchInp.type = 'search';
  searchInp.id = 'st-lc-cap-search';
  searchInp.style.maxWidth = '260px';
  searchInp.placeholder = '按能力名称、规格或责任仓过滤…';
  searchInp.value = state.lcCapQuery || '';
  searchInp.addEventListener('input', () => {
    state.lcCapQuery = searchInp.value;
    onStateChange();
  });
  statusAndModeRow.append(searchInp);

  filterBar.append(phasePills, secondaryFilters, statusAndModeRow);
  capCard.append(filterBar);

  const q = String(state.lcCapQuery || '').trim().toLowerCase();
  const filteredCaps = capList.filter(c => {
    if (state.lcCapPhase && state.lcCapPhase !== 'all' && c.phaseId !== state.lcCapPhase) return false;
    if (state.lcCapPlane && state.lcCapPlane !== 'all' && c.planeId !== state.lcCapPlane) return false;
    if (state.lcCapStatus && state.lcCapStatus !== 'all' && c.currentStatus !== state.lcCapStatus) return false;
    if (state.lcCapVerifyMode && state.lcCapVerifyMode !== 'all' && c.verificationMode !== state.lcCapVerifyMode) return false;
    if (q) {
      const hay = `${c.id} ${c.title} ${c.idealSpec} ${c.gapAction} ${(c.ownerRepos || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tblWrap2 = mk('div', null, 'st-table-wrap');
  const tbl2 = mk('table', null, 'st-prose-table');
  const thead2 = mk('thead');
  const htr2 = mk('tr');
  for (const h of ['能力项与优先级', '阶段 × 横切平面 & 责任仓', '理想态规格', '采用现状 & 核验来源', '迁移补齐路线']) {
    htr2.append(mk('th', h));
  }
  thead2.append(htr2);
  const tbody2 = mk('tbody');

  if (filteredCaps.length === 0) {
    const trEmpty = mk('tr');
    const tdEmpty = mk('td', '当前筛选条件下暂无匹配能力项。', 'st-muted-xs');
    tdEmpty.colSpan = 5;
    trEmpty.append(tdEmpty);
    tbody2.append(trEmpty);
  } else {
    for (const c of filteredCaps) {
      const tr = mk('tr');
      const tdTitle = mk('td');
      const pTone = c.priority === 'P0' ? 'rose' : (c.priority === 'P1' ? 'indigo' : 'zinc');
      const tTop = mk('div', null, 'st-lc-pill-row');
      tTop.append(mk('code', c.id, 'st-inline-code'), badge(c.priority, pTone));
      tdTitle.append(tTop, mk('strong', c.title));

      const tdScope = mk('td');
      const sRow = mk('div', null, 'st-lc-pill-row');
      sRow.append(badge(c.phaseId, 'indigo'), badge(PLANE_LABELS[c.planeId] || c.planeId, 'purple'));
      const oRow = mk('div', null, 'st-lc-pill-row');
      for (const o of c.ownerRepos || []) oRow.append(badge(o, 'zinc'));
      tdScope.append(sRow, oRow);

      const tdIdeal = mk('td', c.idealSpec, 'st-lc-prose-cell');

      const tdVer = mk('td');
      const csm = CAP_STATUS_META[c.currentStatus] || CAP_STATUS_META.partial;
      const vRow = mk('div', null, 'st-lc-pill-row');
      vRow.append(
        badge(csm.label, csm.tone),
        badge(c.verificationBadge || (c.verificationMode === 'machine_probe' ? '🔍 机器探针实测' : '📋 架构声明'), c.verificationTone || 'zinc'),
      );
      tdVer.append(
        vRow,
        mk('div', c.liveProbeDetail || '', 'st-muted-xs'),
        probeLine(c.probeSource),
      );

      const tdGap = mk('td', c.gapAction, 'st-lc-prose-cell st-muted-xs');
      tr.append(tdTitle, tdScope, tdIdeal, tdVer, tdGap);
      tbody2.append(tr);
    }
  }
  tbl2.append(thead2, tbody2);
  tblWrap2.append(tbl2);
  capCard.append(tblWrap2);
  wrap.append(capCard);

  return wrap;
}

function renderRoadmapSubView(doc, data, state, callbacks) {
  const { mk, badge, probeLine } = createDomHelpers(doc);
  const { onSelectRepo } = callbacks;
  const wrap = mk('div', null, 'st-lc-section-stack');

  // 1. 四阶段迁移路线（现状 → 理想态）
  const rmCard = mk('div', null, 'st-card st-guide-section');
  rmCard.append(
    mk('h3', '一、分阶段迁移路线（现状 → 理想态 · Stage 0 至 Stage 3）', 'st-lc-sec-title'),
    mk('p', '每项里程碑均绑定实时机器探针核验状态（probeCheck），随底层代码、契约与文档站点落地自动点亮：', 'st-muted-xs'),
  );

  const stageStack = mk('div', null, 'st-lc-section-stack');
  for (const stg of data.roadmap || []) {
    const box = mk('div', null, 'st-lc-stage-card');
    box.dataset.stageId = stg.id;
    const sHead = mk('div', null, 'st-repo-opt-head');
    const sLeft = mk('div', null, 'st-graph-controls');
    sLeft.append(
      badge(stg.id.toUpperCase(), 'indigo'),
      badge(stg.window, 'purple'),
      mk('h4', stg.title, 'st-lc-card-h4'),
    );
    const sTone = stg.completionPercent === 100 ? 'emerald' : (stg.passedCount > 0 ? 'indigo' : 'zinc');
    sHead.append(
      sLeft,
      badge(`探针达成 ${stg.passedCount}/${stg.totalCount} (${stg.completionPercent}%)`, sTone),
    );
    box.append(sHead, mk('p', `阶段主旨：${stg.theme}`, 'st-muted-xs'));

    const msGrid = mk('div', null, 'st-lc-ms-grid');
    for (const ms of stg.milestones || []) {
      const mc = mk('div', null, `st-lc-ms-card is-${ms.liveStatus || 'planned'}`);
      mc.dataset.milestoneId = ms.id;
      const mTop = mk('div', null, 'st-repo-opt-head');
      mTop.append(
        mk('code', ms.id, 'st-inline-code'),
        badge(ms.liveBadgeLabel || '⏳ 待建设', ms.liveBadgeTone || 'zinc'),
      );

      const ownerRow = mk('div', null, 'st-lc-pill-row');
      for (const ow of ms.ownerRepos || []) {
        const matched = (data.repositories || []).find(r => r.id === ow || r.name === ow || r.publicName === ow);
        if (matched?.studioRepoId && typeof onSelectRepo === 'function') {
          const jb = mk('button', `↗ ${matched.publicName}`, 'st-jump-pill');
          jb.type = 'button';
          jb.addEventListener('click', () => onSelectRepo(matched.studioRepoId));
          ownerRow.append(jb);
        } else {
          ownerRow.append(badge(matched?.publicName || ow, 'zinc'));
        }
      }

      const dual = mk('div', null, 'st-lc-dual-state-grid');
      const curB = mk('div', null, 'st-lc-state-box is-current');
      curB.append(badge('现状缺口', 'amber'), mk('p', ms.currentGap, ''));
      const idB = mk('div', null, 'st-lc-state-box is-ideal');
      idB.append(badge('理想态目标', 'indigo'), mk('p', ms.idealTarget, ''));
      dual.append(curB, idB);

      const pFoot = mk('div', null, 'st-lc-probe-box');
      pFoot.append(
        mk('div', `🔍 探针实测 (${ms.probeCheck})：${ms.liveDetail || ''}`, 'st-lc-live-evidence'),
        probeLine(ms.probeSource),
      );

      mc.append(mTop, mk('strong', ms.title), ownerRow, dual, pFoot);
      msGrid.append(mc);
    }
    box.append(msGrid);
    stageStack.append(box);
  }
  rmCard.append(stageStack);
  wrap.append(rmCard);

  // 2. 已审阅锁定核心架构裁决
  const adrCard = mk('div', null, 'st-card st-guide-section');
  adrCard.append(
    mk('h3', `二、已审阅锁定的核心架构裁决 (${(data.architectureDecisions || []).length} 项)`, 'st-lc-sec-title'),
    mk('p', '围绕执行驱动接缝、三环边界、双支柱客观计分卡与分阶段落地的权威锁定裁决：', 'st-muted-xs'),
  );
  const adrGrid = mk('div', null, 'st-lc-risk-grid');
  for (const adr of data.architectureDecisions || []) {
    const ac = mk('div', null, 'st-lc-adr-card');
    const aTop = mk('div', null, 'st-repo-opt-head');
    aTop.append(
      badge(adr.id, 'indigo'),
      badge(`🔒 已锁定 (${adr.decidedAt})`, 'emerald'),
    );
    const impRow = mk('div', null, 'st-lc-pill-row');
    impRow.append(mk('span', '影响范围：', 'st-muted-xs'));
    for (const ir of adr.impactedRepos || []) impRow.append(badge(ir, 'zinc'));
    ac.append(
      aTop,
      mk('h4', adr.title, 'st-lc-card-h4'),
      mk('p', adr.summary, ''),
      mk('div', `裁决依据：${adr.rationale}`, 'st-muted-xs'),
      impRow,
    );
    adrGrid.append(ac);
  }
  adrCard.append(adrGrid);
  wrap.append(adrCard);

  return wrap;
}

export function mountLifecyclePanel(host, {
  data,
  state,
  doc = document,
  onStateChange = () => {},
  onRefresh = null,
  onSelectRepo = null,
  onOpenDoc = null,
} = {}) {
  const { mk, badge } = createDomHelpers(doc);
  host.replaceChildren();

  if (!data || !data.available) {
    const empty = mk('div', null, 'st-card st-guide-section');
    empty.append(
      mk('h3', '当前工作区未配置全周期协同模型注册表', 'st-lc-sec-title'),
      mk('p', '当高阶规划工作区声明 lifecycle-collaboration-model 集合或存在 lifecycle-ecosystem.registry.json 时，本驾驶舱将自动激活。', 'st-muted-xs'),
    );
    host.append(empty);
    return;
  }

  if (!state.lcSubView) state.lcSubView = 'matrix';
  if (!state.lcStateMode) state.lcStateMode = 'ideal';

  const kpi = data.kpi || {};
  const docs = data.documents || {};

  // 顶层横幅（主体身份 + 配套架构/路线规格直达阅读按钮 + 实时重测探针）
  const banner = mk('div', null, 'st-card st-lc-hero-banner');
  const bLeft = mk('div');
  const bTitleRow = mk('div', null, 'st-graph-controls');
  bTitleRow.append(
    badge(kpi.subjectKind === 'ecosystem' ? '全生态元平台视角' : '单技能族项目视角', 'indigo'),
    mk('h2', kpi.subjectTitle || data.subject?.title || '技能族全生命周期协同驾驶舱', 'st-lc-hero-title'),
    badge(`修订 ${data.updatedAt || '—'}`, 'zinc'),
  );
  bLeft.append(
    bTitleRow,
    mk('p', data.subject?.parameterizationNote || '基于唯一注册表契约与实时只读机器探针驱动，严守三环边界，支持单技能族项目无缝复用。', 'st-muted-xs'),
  );

  const bRight = mk('div', null, 'st-graph-controls');
  if (docs.architectureDocPath && typeof onOpenDoc === 'function') {
    const archBtn = mk('button', '📖 阅读协同架构总纲', 'st-btn');
    archBtn.type = 'button';
    archBtn.addEventListener('click', () => onOpenDoc(data.hostRepoId, docs.architectureDocPath));
    bRight.append(archBtn);
  }
  if (docs.roadmapSpecPath && typeof onOpenDoc === 'function') {
    const specBtn = mk('button', '🗺️ 阅读迁移路线规格', 'st-btn');
    specBtn.type = 'button';
    specBtn.addEventListener('click', () => onOpenDoc(data.hostRepoId, docs.roadmapSpecPath));
    bRight.append(specBtn);
  }
  if (typeof onRefresh === 'function') {
    const refBtn = mk('button', '🔄 重跑实时探针', 'st-btn st-btn-primary');
    refBtn.type = 'button';
    refBtn.addEventListener('click', () => onRefresh(refBtn));
    bRight.append(refBtn);
  }
  banner.append(bLeft, bRight);
  host.append(banner);

  // 顶部 5 项核心 KPI 指标条
  const kpiStrip = mk('div', null, 'st-lc-kpi-strip');
  const addKpi = (label, value, subBadgeText, subTone = 'indigo') => {
    const c = mk('div', null, 'st-card st-lc-kpi-card');
    c.append(
      mk('div', label, 'st-muted-xs'),
      mk('div', value, 'st-lc-kpi-val st-tabular'),
      badge(subBadgeText, subTone),
    );
    kpiStrip.append(c);
  };
  addKpi(
    '建模主体 (subject.title)',
    kpi.subjectTitle || '技能族生态',
    kpi.reusableForSingleFamily ? '✓ 支持单技能族参数化复用' : '全域生态模型',
    'indigo',
  );
  addKpi(
    '生命周期主干拓扑',
    `${kpi.phasesCount ?? 8} 大生命周期阶段 × ${kpi.planesCount ?? 4} 横切平面`,
    `含 ${kpi.feedbackLoopsCount ?? 3} 条受控回流闭环`,
    'purple',
  );
  addKpi(
    '内环核心仓就绪 / 实测收据数',
    `${kpi.coreWithReceipt ?? 0}/${kpi.coreTotal ?? 0} 收据 · ${kpi.coreWithLock ?? 0}/${kpi.coreTotal ?? 0} 追溯锁`,
    `高阶需求 ${kpi.portfolioVerifiedSatisfied ?? 0}/${kpi.portfolioAllocatedTotal ?? 0} 已验证满足`,
    'emerald',
  );
  addKpi(
    '实时检出架构风险数',
    `${kpi.activeRiskCount ?? 0} 项活跃风险`,
    `共监控 ${kpi.totalRiskCount ?? 0} 类断代与环路探针`,
    (kpi.activeRiskCount ?? 0) > 0 ? 'rose' : 'emerald',
  );
  addKpi(
    '阶段 0 里程碑达成率',
    `${kpi.stage0Passed ?? 0}/${kpi.stage0Total ?? 0} (${kpi.stage0Percent ?? 0}%)`,
    kpi.stage0Window || '阶段 0 止血与边界锁定',
    (kpi.stage0Percent ?? 0) === 100 ? 'emerald' : 'indigo',
  );
  host.append(kpiStrip);

  // 四大子视图切换栏
  const subNav = mk('div', null, 'st-card st-lc-subnav');
  const subBtns = mk('div', null, 'st-graph-controls');
  for (const [svKey, svLabel] of [
    ['matrix', '① 阶段 × 三环矩阵'],
    ['contracts', '② 契约流与架构体检'],
    ['catalog', '③ 全谱系能力与采用现状'],
    ['roadmap', '④ 迁移路线与架构裁决（现状 → 理想态）'],
  ]) {
    const b = mk('button', svLabel, `st-btn${state.lcSubView === svKey ? ' is-active' : ''}`);
    b.type = 'button';
    b.dataset.subview = svKey;
    b.addEventListener('click', () => {
      state.lcSubView = svKey;
      onStateChange();
    });
    subBtns.append(b);
  }
  const rightHint = mk('div', null, 'st-graph-controls');
  if (data.modelSummary) {
    rightHint.append(badge(`${data.modelSummary.id} · ${data.modelSummary.objectsCount} 实体对象`, 'zinc'));
  }
  rightHint.append(badge('🔒 100% 零写入只读探针', 'emerald'));
  subNav.append(subBtns, rightHint);
  host.append(subNav);

  const subMount = mk('div', null, 'st-lc-subview-mount');
  const callbacks = { onStateChange, onSelectRepo, onOpenDoc };
  if (state.lcSubView === 'contracts') {
    subMount.append(renderContractsSubView(doc, data, state, callbacks));
  } else if (state.lcSubView === 'catalog') {
    subMount.append(renderCatalogSubView(doc, data, state, callbacks));
  } else if (state.lcSubView === 'roadmap') {
    subMount.append(renderRoadmapSubView(doc, data, state, callbacks));
  } else {
    subMount.append(renderMatrixSubView(doc, data, state, callbacks));
  }
  host.append(subMount);
}
