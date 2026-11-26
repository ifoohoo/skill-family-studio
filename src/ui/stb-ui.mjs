// @feature STU003

function domEl(doc, tag, text, cls) {
  const node = doc.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
}

function formatBpPercent(bp) {
  if (typeof bp !== 'number' || !Number.isFinite(bp)) return '不可观测 (null)';
  return `${(bp / 100).toFixed(2)}% (${bp} Bp)`;
}

function shortHex(hex, len = 16) {
  if (typeof hex !== 'string' || !hex) return '—';
  return hex.length > len ? `${hex.slice(0, len)}…` : hex;
}

export function mountStbReconciliationPanel(host, {
  stbData,
  state,
  doc = document,
  writable = true,
  onSelectEntry,
  onRunLiveDemo,
}) {
  host.replaceChildren();
  const root = domEl(doc, 'section', null, 'st-stb-panel');

  if (!stbData || !Array.isArray(stbData.entries) || stbData.entries.length === 0) {
    const emptyCard = domEl(doc, 'div', null, 'st-card st-stb-empty');
    emptyCard.append(
      domEl(doc, 'h3', '🛡️ 尚未检出 SessionTraceBundle 会话追溯包', 'st-stb-title'),
      domEl(doc, 'p', '可通过下方受控无头沙箱演练实时采集 ACP 会话轨迹并调用 skill-failure-auditor 执行反伪造对账。', 'st-muted-xs'),
    );
    if (stbData?.driverAvailable && writable) {
      const btn = domEl(doc, 'button', '🚨 实跑伪造拦截演练（需人工确认）', 'st-btn st-btn-primary');
      btn.type = 'button';
      btn.addEventListener('click', () => onRunLiveDemo?.('fabricated', btn));
      emptyCard.append(btn);
    }
    root.append(emptyCard);
    host.append(root);
    return;
  }

  const entries = stbData.entries;
  if (!state.rtSelectedStbId || !entries.some(e => e.id === state.rtSelectedStbId)) {
    const firstRed = entries.find(e => e.suspectedFabrication);
    state.rtSelectedStbId = (firstRed || entries[0]).id;
  }
  const active = entries.find(e => e.id === state.rtSelectedStbId) || entries[0];
  const kpi = stbData.kpi || {};
  const validSealCount = entries.filter(e => e.sealValid).length;

  // 1. 顶部全宽 KPI 与受控实跑动作栏
  const topCard = domEl(doc, 'div', null, 'st-card st-stb-kpi-card');
  const kpiHead = domEl(doc, 'div', null, 'st-stb-head-row');
  const titleWrap = domEl(doc, 'div', null, 'st-stb-title-wrap');
  titleWrap.append(
    domEl(doc, 'h3', '🛡️ SessionTraceBundle 会话追溯与反伪造对账台', 'st-stb-title'),
    domEl(
      doc,
      'span',
      '客观事实由 execution-driver 采集封存，疑似伪造完成红牌严格由 skill-failure-auditor 对账结论驱动（Studio 零裁判逻辑）',
      'st-muted-xs',
    ),
  );

  const actionWrap = domEl(doc, 'div', null, 'st-graph-controls');
  if (stbData.driverAvailable) {
    const cleanBtn = domEl(doc, 'button', '▶ 实跑净室通过轨迹', 'st-btn');
    cleanBtn.type = 'button';
    cleanBtn.disabled = !writable;
    cleanBtn.addEventListener('click', () => onRunLiveDemo?.('clean', cleanBtn));

    const fabBtn = domEl(doc, 'button', '🚨 实跑伪造拦截演练', 'st-btn st-btn-primary');
    fabBtn.type = 'button';
    fabBtn.disabled = !writable;
    fabBtn.addEventListener('click', () => onRunLiveDemo?.('fabricated', fabBtn));

    actionWrap.append(cleanBtn, fabBtn);
  }
  kpiHead.append(titleWrap, actionWrap);

  const kpiStrip = domEl(doc, 'div', null, 'st-stb-kpi-grid');
  for (const [label, val, tone] of [
    ['已封存追溯包 (STB)', `${kpi.totalBundles ?? entries.length} 份`, 'indigo'],
    ['疑似伪造完成红牌', `${kpi.redCardCount ?? 0} 份`, (kpi.redCardCount ?? 0) > 0 ? 'rose' : 'emerald'],
    ['达 40% 上下文预警轮次', `${kpi.contextWarnCount ?? 0} 轮`, (kpi.contextWarnCount ?? 0) > 0 ? 'amber' : 'emerald'],
    ['State-Event-Envelope 锚定', `${kpi.boundCount ?? 0} 份已绑定 / ${validSealCount} 份密封有效`, 'zinc'],
  ]) {
    const box = domEl(doc, 'div', null, `st-stb-kpi-item is-${tone}`);
    box.append(
      domEl(doc, 'div', label, 'st-muted-xs'),
      domEl(doc, 'div', val, 'st-stb-kpi-val'),
    );
    kpiStrip.append(box);
  }

  // 轨迹切换胶囊条
  const selectorRow = domEl(doc, 'div', null, 'st-stb-selector-row');
  selectorRow.append(domEl(doc, 'span', '选择待检视追溯包：', 'st-muted-xs'));
  for (const item of entries) {
    const isCleanPass = Boolean(item.integrityValid && item.verdict === 'PASS' && !item.suspectedFabrication);
    const tag = item.suspectedFabrication
      ? '🔴 红牌拦截'
      : (isCleanPass ? '🟢 对账通过' : '🟠 受限/待核验');
    const btn = domEl(
      doc,
      'button',
      `${tag} · ${item.bundleId} (${item.sessionCount} 会话)`,
      `st-btn${item.id === active.id ? ' is-active' : ''}`,
    );
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.rtSelectedStbId = item.id;
      onSelectEntry?.(item.id);
    });
    selectorRow.append(btn);
  }

  topCard.append(kpiHead, kpiStrip, selectorRow);
  root.append(topCard);

  // 2. 三态结论横幅（🔴 硬闸红牌 / 🟢 完整密封与对账通过 / 🟠 受限核验、发现风险或密封异常）
  const report = active.reconciliationReport;
  const pc = active.professionalConclusion;
  const providerTag = `${pc?.provider?.id || 'skill-failure-auditor'}@${pc?.provider?.version || 'unknown'}`;

  if (active.suspectedFabrication && report) {
    const redCard = domEl(doc, 'div', null, 'st-card st-stb-redcard');
    redCard.dataset.testid = 'stb-red-card';
    const rcHeader = domEl(doc, 'div', null, 'st-stb-redcard-head');
    rcHeader.append(
      domEl(doc, 'span', '🔴 疑似伪造完成硬闸红牌 (SUSPECTED_FABRICATION)', 'st-stb-redcard-badge'),
      domEl(doc, 'span', `裁决提供方：${providerTag}`, 'st-badge st-badge-rose'),
      domEl(doc, 'span', `STB 密封摘要：sha256:${shortHex(active.bundleDigestSha256, 20)}`, 'st-badge st-badge-zinc'),
      domEl(doc, 'span', `PC 绑定修订：${shortHex(pc?.subject?.revision || '', 27)}`, 'st-badge st-badge-indigo'),
    );
    redCard.append(rcHeader);

    const summaryP = domEl(
      doc,
      'p',
      pc?.outcome?.summary || '检测到模型完成声明与客观工具退出码或文件树快照矛盾，已触发硬闸阻断。',
      'st-stb-redcard-summary',
    );
    redCard.append(summaryP);

    if (Array.isArray(report.redCardReasons) && report.redCardReasons.length > 0) {
      const reasonList = domEl(doc, 'ul', null, 'st-stb-reason-list');
      for (const reason of report.redCardReasons) {
        reasonList.append(domEl(doc, 'li', reason));
      }
      redCard.append(reasonList);
    }

    if (Array.isArray(report.findings) && report.findings.length > 0) {
      const fmRow = domEl(doc, 'div', null, 'st-stb-fm-row');
      for (const f of report.findings) {
        const pill = domEl(
          doc,
          'span',
          `${f.ruleId} [${f.severity}]：${f.summary || f.message || ''}`,
          f.severity === 'critical' || f.severity === 'high' ? 'st-badge st-badge-rose' : 'st-badge st-badge-amber',
        );
        fmRow.append(pill);
      }
      redCard.append(fmRow);
    }
    root.append(redCard);
  } else if (active.integrityValid && active.verdict === 'PASS') {
    const passCard = domEl(doc, 'div', null, 'st-card st-stb-passcard');
    passCard.dataset.testid = 'stb-pass-card';
    passCard.append(
      domEl(doc, 'strong', `🟢 SFA 反伪造对账通过 (PASS · ${providerTag})：`),
      domEl(
        doc,
        'span',
        `全部 ${active.claimCount} 项关键声明均与客观工具退出码及文件树快照哈希一致 · 密封摘要 sha256:${shortHex(active.bundleDigestSha256, 20)}`,
      ),
    );
    root.append(passCard);
  } else {
    const warnCard = domEl(doc, 'div', null, 'st-card st-stb-warncard');
    warnCard.dataset.testid = 'stb-warn-card';
    const warnHeader = domEl(doc, 'div', null, 'st-stb-redcard-head');
    warnHeader.append(
      domEl(doc, 'strong', `🟠 受限核验 / 发现治理问题或密封未闭合 (${active.verdict})`),
      domEl(doc, 'span', `裁决提供方：${providerTag}`, 'st-badge st-badge-amber'),
      domEl(
        doc,
        'span',
        active.sealValid ? `密封有效：sha256:${shortHex(active.bundleDigestSha256, 16)}` : '⚠️ 密封校验失败',
        active.sealValid ? 'st-badge st-badge-zinc' : 'st-badge st-badge-rose',
      ),
    );
    warnCard.append(
      warnHeader,
      domEl(
        doc,
        'p',
        pc?.outcome?.summary || '轨迹存在不可观测字段限制、非伪造类治理发现或尚未完成防篡改对账绑定，不签发绿牌放行。',
        'st-muted-xs',
      ),
    );
    if (Array.isArray(report?.limitations) && report.limitations.length > 0) {
      const limList = domEl(doc, 'ul', null, 'st-stb-reason-list');
      for (const lim of report.limitations) {
        limList.append(domEl(doc, 'li', lim));
      }
      warnCard.append(limList);
    }
    if (Array.isArray(report?.findings) && report.findings.length > 0) {
      const fmRow = domEl(doc, 'div', null, 'st-stb-fm-row');
      for (const f of report.findings) {
        fmRow.append(
          domEl(doc, 'span', `${f.ruleId} [${f.severity}]：${f.summary || ''}`, 'st-badge st-badge-amber'),
        );
      }
      warnCard.append(fmRow);
    }
    root.append(warnCard);
  }

  // 3. 双栏全宽明细：左栏「多会话层级与 40% 上下文水位时间线」+ 右栏「声明对账表与客观工具/写集证据」
  const detailGrid = domEl(doc, 'div', null, 'st-stb-detail-grid');

  // 左栏：多会话树与逐轮上下文占用率进度条
  const sessionCol = domEl(doc, 'div', null, 'st-card st-stb-col');
  sessionCol.append(
    domEl(doc, 'h4', `🧬 多会话拓扑与逐轮上下文水位 (${active.sessionCount} 会话 · 40.00% 预警线)`, 'st-stb-subtitle'),
  );
  for (const sess of active.bundle?.sessions || []) {
    const sessBox = domEl(doc, 'div', null, 'st-stb-session-box');
    const sessHead = domEl(doc, 'div', null, 'st-stb-session-head');
    sessHead.append(
      domEl(doc, 'strong', `${sess.sessionId} (${sess.role})`),
      domEl(doc, 'span', sess.parentSessionId ? `派生自 ${sess.parentSessionId}` : '根会话 (Root)', 'st-badge st-badge-indigo'),
      domEl(doc, 'span', `宿主：${sess.host?.id}@${sess.host?.version}`, 'st-badge st-badge-zinc'),
      domEl(doc, 'span', `观测等级：${sess.observability?.tier}`, 'st-badge st-badge-emerald'),
    );
    sessBox.append(sessHead, domEl(doc, 'div', sess.duty || '', 'st-muted-xs'));

    const warnBp = sess.appliedContextPolicy?.warnRatioBp ?? 4000;
    for (const turn of sess.turns || []) {
      const ratioBp = turn.windowRatioBp;
      const isOverWarn = typeof ratioBp === 'number' && ratioBp >= warnBp;
      const turnRow = domEl(doc, 'div', null, `st-stb-turn-row${isOverWarn ? ' is-warn' : ''}`);
      const turnTop = domEl(doc, 'div', null, 'st-stb-turn-top');
      turnTop.append(
        domEl(doc, 'span', `Turn #${turn.turnIndex} · 占用 ${turn.occupancyTokens ?? 'null'} / ${sess.model?.contextWindowTokens ?? '—'} tokens`),
        domEl(
          doc,
          'span',
          isOverWarn ? `⚠️ 达 40% 膨胀阈值：${formatBpPercent(ratioBp)}` : `正常水位：${formatBpPercent(ratioBp)}`,
          isOverWarn ? 'st-badge st-badge-amber' : 'st-badge st-badge-emerald',
        ),
      );
      const barTrack = domEl(doc, 'div', null, 'st-stb-bar-track');
      const barFill = domEl(doc, 'div', null, `st-stb-bar-fill${isOverWarn ? ' is-warn' : ''}`);
      const pct = typeof ratioBp === 'number' ? Math.min(100, Math.max(1, ratioBp / 100)) : 0;
      barFill.style.width = `${pct}%`;
      const warnMarker = domEl(doc, 'div', null, 'st-stb-bar-marker');
      warnMarker.style.left = `${Math.min(100, warnBp / 100)}%`;
      barTrack.append(barFill, warnMarker);
      turnRow.append(turnTop, barTrack);
      sessBox.append(turnRow);
    }

    const writes = sess.writeScope?.observedWrites || [];
    if (writes.length > 0) {
      const writeInfo = domEl(
        doc,
        'div',
        `📁 文件树快照差分观测写集 (${writes.length})：${writes.map(w => `${w.op}:${w.path}`).join(', ')}`,
        'st-muted-xs',
      );
      sessBox.append(writeInfo);
    }
    sessionCol.append(sessBox);
  }

  // 右栏：关键声明逐项对账表 + 工具调用退出码实录
  const claimCol = domEl(doc, 'div', null, 'st-card st-stb-col');
  claimCol.append(domEl(doc, 'h4', '⚖️ 模型完成声明 vs 客观运行证据逐项对账', 'st-stb-subtitle'));

  const reconciliations = report?.claimReconciliations || [];
  if (reconciliations.length > 0) {
    const tbl = domEl(doc, 'table', null, 'st-stb-table');
    const thead = domEl(doc, 'thead');
    const hr = domEl(doc, 'tr');
    for (const h of ['声明 ID / 会话', '声明类型', '对账状态', 'SFA 核验判据与触发规则']) {
      hr.append(domEl(doc, 'th', h));
    }
    thead.append(hr);
    const tbody = domEl(doc, 'tbody');
    for (const rec of reconciliations) {
      const tr = domEl(doc, 'tr');
      tr.append(
        domEl(doc, 'td', `${rec.claimId} (${rec.sessionId})`),
        domEl(doc, 'td', rec.claimType),
      );
      const statusTd = domEl(doc, 'td');
      const isOk = rec.status === 'verified';
      const isUnverifiable = rec.status === 'unverifiable';
      statusTd.append(
        domEl(
          doc,
          'span',
          isOk ? '✅ 已核实' : (isUnverifiable ? '🟠 证据不足' : `🔴 ${rec.status}`),
          isOk ? 'st-badge st-badge-emerald' : (isUnverifiable ? 'st-badge st-badge-amber' : 'st-badge st-badge-rose'),
        ),
      );
      tr.append(statusTd);
      const rulesTxt = Array.isArray(rec.triggeredRules) && rec.triggeredRules.length > 0
        ? ` [${rec.triggeredRules.join(', ')}] `
        : ' ';
      tr.append(domEl(doc, 'td', `${rec.reason}${rulesTxt}`));
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    claimCol.append(tbl);
  } else {
    claimCol.append(domEl(doc, 'p', '本轨迹无显式关键完成声明。', 'st-muted-xs'));
  }

  claimCol.append(domEl(doc, 'h4', '🔧 客观工具调用与退出码实录', 'st-stb-subtitle'));
  const toolCalls = active.bundle?.toolCalls || [];
  if (toolCalls.length === 0) {
    claimCol.append(domEl(doc, 'p', '本轨迹无工具调用记录。', 'st-muted-xs'));
  } else {
    const tcTbl = domEl(doc, 'table', null, 'st-stb-table');
    const tcHead = domEl(doc, 'thead');
    const tcHr = domEl(doc, 'tr');
    for (const h of ['调用 ID', '工具 / 类别', '脱敏命令或目标', '退出码 / 状态']) {
      tcHr.append(domEl(doc, 'th', h));
    }
    tcHead.append(tcHr);
    const tcBody = domEl(doc, 'tbody');
    for (const tc of toolCalls) {
      const tr = domEl(doc, 'tr');
      tr.append(
        domEl(doc, 'td', tc.callId),
        domEl(doc, 'td', `${tc.toolName} (${tc.category})`),
        domEl(doc, 'td', tc.sanitizedCommandOrTarget || '—'),
      );
      const exitTd = domEl(doc, 'td');
      const exitOk = tc.status === 'succeeded' && tc.exitCode === 0;
      const exitAbsent = tc.status === 'succeeded' && tc.exitCode === null;
      exitTd.append(
        domEl(
          doc,
          'span',
          `exit=${tc.exitCode ?? 'absent'} (${tc.status})`,
          exitOk ? 'st-badge st-badge-emerald' : (exitAbsent ? 'st-badge st-badge-amber' : 'st-badge st-badge-rose'),
        ),
      );
      tr.append(exitTd);
      tcBody.append(tr);
    }
    tcTbl.append(tcHead, tcBody);
    claimCol.append(tcTbl);
  }

  detailGrid.append(sessionCol, claimCol);
  root.append(detailGrid);
  host.append(root);
}
