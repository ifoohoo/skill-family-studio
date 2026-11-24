// @feature STU006
// @feature STU003

import { renderEntityBrief } from './tooltips.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HUE_PALETTE = [
  '#4f46e5', // 0: 主控 indigo
  '#e11d48', // 1: 架构 rose
  '#0d9488', // 2: 前端 teal
  '#d97706', // 3: 文档 amber
  '#7c3aed', // 4: 核验 purple
  '#0284c7', // 5: 审阅 sky
  '#16a34a', // 6: 绿
  '#ea580c', // 7: 橙
];

function hueFor(idx) {
  return HUE_PALETTE[Math.abs(Number(idx) || 0) % HUE_PALETTE.length];
}

function fmtTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${String(rem).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtTimeShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = v => String(v).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDateTimeFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function mk(doc, tag, text, cls) {
  const n = doc.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
}

function svgEl(doc, tag, attrs = {}) {
  const n = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function cleanFleetUiLabel(val) {
  return String(val ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/\*{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeSummaryAgainstTitle(rawSummary, rawTitle) {
  const sum = cleanFleetUiLabel(rawSummary);
  const title = cleanFleetUiLabel(rawTitle).replace(/…$/, '');
  if (!sum) return '';
  if (!title) return sum;
  if (sum === title || title.startsWith(sum)) return '';
  if (sum.startsWith(title)) {
    const rest = sum.slice(title.length).replace(/^[：:，,。；;·\-\s]+/, '').trim();
    return rest.length >= 8 ? rest : '';
  }
  return sum;
}

function appendInlineFormatted(parent, text, doc) {
  const str = String(text ?? '');
  const tokens = str.split(/(`[^`]+`|\*\*[^*]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*))/g);
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length >= 2) {
      parent.append(mk(doc, 'code', tok.slice(1, -1), 'st-inline-code'));
    } else if (tok.startsWith('**') && tok.endsWith('**') && tok.length >= 4) {
      parent.append(mk(doc, 'strong', tok.slice(2, -2)));
    } else if (tok.startsWith('*') && tok.endsWith('*') && tok.length >= 3) {
      parent.append(mk(doc, 'em', tok.slice(1, -1)));
    } else {
      parent.append(doc.createTextNode(tok));
    }
  }
}

export function renderSafeMarkdownToDom(markdown, doc = document) {
  const wrap = mk(doc, 'div', null, 'st-fleet-md-body');
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const parseTableCells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isTableSep = row => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(row.trim());

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      const pre = mk(doc, 'pre', null, 'st-code-block');
      pre.append(mk(doc, 'code', codeLines.join('\n')));
      wrap.append(pre);
      continue;
    }
    if (/^(---|\*\*\*|___)$/.test(trimmed)) {
      wrap.append(mk(doc, 'hr', null, 'st-fleet-md-hr'));
      i++;
      continue;
    }
    const hm = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const h = mk(doc, `h${Math.min(4, hm[1].length + 1)}`, null, 'st-fleet-md-h');
      appendInlineFormatted(h, hm[2], doc);
      wrap.append(h);
      i++;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const bq = mk(doc, 'blockquote', null, 'st-fleet-md-quote');
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        const lineTxt = lines[i].trim().replace(/^>\s?/, '');
        if (lineTxt) {
          const p = mk(doc, 'p', null, 'st-fleet-md-p');
          appendInlineFormatted(p, lineTxt, doc);
          bq.append(p);
        }
        i++;
      }
      if (bq.children.length) wrap.append(bq);
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = parseTableCells(trimmed);
      i += 2;
      const tblWrap = mk(doc, 'div', null, 'st-table-wrap');
      const tbl = mk(doc, 'table', null, 'st-table');
      const thead = mk(doc, 'thead');
      const thr = mk(doc, 'tr');
      for (const hCell of headers) {
        const th = mk(doc, 'th');
        appendInlineFormatted(th, hCell, doc);
        thr.append(th);
      }
      thead.append(thr);
      const tbody = mk(doc, 'tbody');
      while (i < lines.length && lines[i].trim().includes('|') && !lines[i].trim().startsWith('```')) {
        const rowCells = parseTableCells(lines[i]);
        const tr = mk(doc, 'tr');
        for (let c = 0; c < headers.length; c++) {
          const td = mk(doc, 'td');
          appendInlineFormatted(td, rowCells[c] ?? '', doc);
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      tbl.append(thead, tbody);
      tblWrap.append(tbl);
      wrap.append(tblWrap);
      continue;
    }
    const isListStop = ln => {
      const lt = ln.trim();
      return !lt || /^#{1,4}\s/.test(lt) || /^```/.test(lt) || /^(---|\*\*\*|___)$/.test(lt) || /^>\s?/.test(lt) || /^[-*+]\s+/.test(lt) || /^\d+\.\s+/.test(lt);
    };
    if (/^[-*+]\s+/.test(trimmed)) {
      const ul = mk(doc, 'ul', null, 'st-fleet-md-list');
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const parts = [lines[i].trim().replace(/^[-*+]\s+/, '')];
        i++;
        while (i < lines.length && !isListStop(lines[i])) { parts.push(lines[i].trim()); i++; }
        const li = mk(doc, 'li');
        appendInlineFormatted(li, parts.join(' '), doc);
        ul.append(li);
      }
      wrap.append(ul);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const ol = mk(doc, 'ol', null, 'st-fleet-md-list');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const parts = [lines[i].trim().replace(/^\d+\.\s+/, '')];
        i++;
        while (i < lines.length && !isListStop(lines[i])) { parts.push(lines[i].trim()); i++; }
        const li = mk(doc, 'li');
        appendInlineFormatted(li, parts.join(' '), doc);
        ol.append(li);
      }
      wrap.append(ol);
      continue;
    }
    const p = mk(doc, 'p', null, 'st-fleet-md-p');
    appendInlineFormatted(p, trimmed, doc);
    wrap.append(p);
    i++;
  }
  if (!wrap.children.length) wrap.append(mk(doc, 'p', '（暂无文本内容）', 'st-muted-xs'));
  return wrap;
}

function layoutFleetTreeNodes(agents) {
  const byDepth = new Map();
  for (const a of agents) {
    const d = Number.isFinite(a.depth) ? a.depth : (a.parentId ? 1 : 0);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(a);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const cardW = 192;
  const cardH = 82;
  const gapX = 16;
  const gapY = 38;
  const padX = 18;
  const padY = 16;
  const maxCols = Math.max(1, ...depths.map(d => Math.min(4, byDepth.get(d).length)));
  const totalW = Math.max(460, padX * 2 + maxCols * cardW + (maxCols - 1) * gapX);
  const pos = new Map();
  let curY = padY;

  for (const d of depths) {
    const arr = byDepth.get(d);
    const cols = Math.min(4, arr.length);
    const rows = Math.ceil(arr.length / cols);
    for (let r = 0; r < rows; r += 1) {
      const slice = arr.slice(r * cols, (r + 1) * cols);
      const rowW = slice.length * cardW + Math.max(0, slice.length - 1) * gapX;
      const startX = Math.max(padX, Math.round((totalW - rowW) / 2));
      slice.forEach((ag, ci) => {
        pos.set(ag.id, {
          x: startX + ci * (cardW + gapX),
          y: curY,
          w: cardW,
          h: cardH,
          agent: ag,
        });
      });
      curY += cardH + (r + 1 < rows ? 14 : 0);
    }
    curY += gapY;
  }
  const totalH = Math.max(220, curY - gapY + padY);
  return { totalW, totalH, pos };
}

export function mountFleetMonitor(host, {
  fleetData,
  state,
  doc = document,
  infoTrigger = null,
  onStateChange = () => {},
  onRefresh = () => {},
  onRunSandbox = () => {},
} = {}) {
  host.replaceChildren();
  const families = fleetData?.families || [];
  if (!families.length) {
    const emptyCard = mk(doc, 'div', null, 'st-card st-guide-section');
    emptyCard.append(
      mk(doc, 'h3', '🛰️ 暂未探测到包含子会话派生记录的多智能体编队', ''),
      mk(doc, 'p', '已只读扫描 Antigravity、Claude Code、Codex 会话目录及 .skill-family-studio/fleet/。点击下方「▶ 运行隔离沙箱演练」，可生成多智能体协作样板并查看拓扑网络、泳道与事件详情。', 'st-muted-xs'),
    );
    emptyCard.firstChild.style.marginTop = '0';
    const tryBtn = mk(doc, 'button', '▶ 运行隔离沙箱演练', 'st-btn st-btn-primary');
    tryBtn.type = 'button';
    tryBtn.disabled = state.writable === false;
    tryBtn.addEventListener('click', onRunSandbox);
    emptyCard.append(tryBtn);
    host.append(emptyCard);
    return;
  }

  const HOST_ZH = { all: '全部', sandbox: '沙箱演练', antigravity: 'Antigravity', claude: 'Claude', codex: 'Codex', local: '本地快照' };
  const layoutShell = mk(doc, 'div', null, 'st-master-detail');
  const pickerCard = mk(doc, 'aside', null, 'st-card st-md-master st-fleet-picker');
  const detailHost = mk(doc, 'div', null, 'st-md-detail');

  const pickerTop = mk(doc, 'div', null, 'st-repo-opt-head');
  pickerTop.append(mk(doc, 'strong', `🛰️ 会话编队 (${families.length})`));
  const refreshBtn = mk(doc, 'button', '↻ 刷新日志', 'st-btn st-btn-xs');
  refreshBtn.type = 'button';
  refreshBtn.addEventListener('click', onRefresh);
  pickerTop.append(refreshBtn);

  const hostPills = mk(doc, 'div', null, 'st-graph-controls');
  const presentHosts = new Set(families.map(f => f.host));
  const pillKeys = ['all', 'antigravity', 'claude', 'codex'];
  if (presentHosts.has('sandbox')) pillKeys.splice(1, 0, 'sandbox');
  if (presentHosts.has('local')) pillKeys.push('local');

  const pickerSearch = mk(doc, 'input', null, 'st-input');
  pickerSearch.type = 'search';
  pickerSearch.placeholder = '筛选编队标题、摘要或仓库…';
  pickerSearch.value = state.rtFleetPickerQuery || '';

  const pickerList = mk(doc, 'div', null, 'st-md-list');
  pickerCard.append(pickerTop, hostPills, pickerSearch, pickerList);
  layoutShell.append(pickerCard, detailHost);
  host.append(layoutShell);

  const getFilteredFamilies = () => {
    const hf = state.rtFleetHostFilter || 'all';
    const pq = (state.rtFleetPickerQuery || '').trim().toLowerCase();
    return families.filter(f => {
      if (hf !== 'all' && f.host !== hf) return false;
      if (pq && !`${f.title} ${f.briefSummary || ''} ${f.repoHint || ''} ${f.host}`.toLowerCase().includes(pq)) return false;
      return true;
    });
  };

  let renderRightDetail = () => {};

  const paintPicker = () => {
    hostPills.replaceChildren();
    const curHf = state.rtFleetHostFilter || 'all';
    for (const hk of pillKeys) {
      const cnt = hk === 'all' ? families.length : families.filter(f => f.host === hk).length;
      const pb = mk(doc, 'button', `${HOST_ZH[hk] || hk} ${cnt}`, `st-btn st-btn-xs${curHf === hk ? ' is-active' : ''}`);
      pb.type = 'button';
      pb.addEventListener('click', () => {
        state.rtFleetHostFilter = hk;
        paintPicker();
      });
      hostPills.append(pb);
    }

    pickerList.replaceChildren();
    const list = getFilteredFamilies();
    if (!list.length) {
      pickerList.append(mk(doc, 'p', '当前筛选条件下无匹配会话编队。', 'st-muted-xs'));
      const clrBtn = mk(doc, 'button', '🔄 清空筛选条件', 'st-btn');
      clrBtn.type = 'button';
      clrBtn.addEventListener('click', () => {
        state.rtFleetHostFilter = 'all';
        state.rtFleetPickerQuery = '';
        pickerSearch.value = '';
        paintPicker();
      });
      pickerList.append(clrBtn);
      return;
    }

    for (const f of list) {
      const isSel = state.rtFleetFamilyId === f.id;
      const card = mk(doc, 'button', null, `st-fleet-sess-card${isSel ? ' is-selected' : ''}`);
      card.type = 'button';
      card.dataset.familyId = f.id;
      const cardTitle = cleanFleetUiLabel(f.title) || '多智能体会话编队';
      const distinctCardSum = dedupeSummaryAgainstTitle(f.briefSummary, cardTitle);
      card.append(renderEntityBrief(doc, {
        title: cardTitle,
        summary: distinctCardSum,
        code: HOST_ZH[f.host] || String(f.host || '').toUpperCase(),
        typeLabel: f.repoHint || '',
        badge: f.host === 'sandbox' ? '演练样板' : '',
      }, { compact: true, showPath: false, maxSummaryChars: 76 }));

      const foot = mk(doc, 'div', null, 'st-fleet-sess-meta st-tabular');
      foot.append(
        mk(doc, 'span', `${f.summary?.totalAgents ?? f.agents?.length ?? 0} 会话 · ${f.summary?.totalDelegations ?? f.delegations?.length ?? 0} 委派`),
        mk(doc, 'span', `${fmtTokens(f.summary?.totalTokens || 0)} · ${fmtTimeShort(f.updatedAt)}`),
      );
      card.append(foot);
      card.addEventListener('click', () => {
        if (state.rtFleetFamilyId === f.id) return;
        state.rtFleetFamilyId = f.id;
        state.rtFleetSelectedAgent = null;
        state.rtFleetSelectedEventId = null;
        pickerList.querySelectorAll('.st-fleet-sess-card').forEach(btn => {
          btn.classList.toggle('is-selected', btn.dataset.familyId === f.id);
        });
        renderRightDetail(f);
      });
      pickerList.append(card);
    }
  };

  pickerSearch.addEventListener('input', () => {
    state.rtFleetPickerQuery = pickerSearch.value;
    paintPicker();
  });

  renderRightDetail = activeFam => {
    detailHost.replaceChildren();
    if (!activeFam) {
      detailHost.append(mk(doc, 'p', '请在左侧选择一条会话编队查看拓扑网络与交互泳道。', 'st-muted-xs'));
      return;
    }
    const agents = activeFam.agents || [];
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const selectedAgent = state.rtFleetSelectedAgent && agentMap.has(state.rtFleetSelectedAgent)
      ? agentMap.get(state.rtFleetSelectedAgent)
      : null;

    // 1. 顶部编队脉冲摘要卡 + 4 KPI
    const header = mk(doc, 'div', null, 'st-fleet-header');
    const hLeft = mk(doc, 'div', null, 'st-fleet-head-left');
    const headTitle = cleanFleetUiLabel(activeFam.title) || '多智能体会话编队监控';
    const distinctHeadSum = dedupeSummaryAgainstTitle(activeFam.briefSummary, headTitle)
      || `关联宿主：${HOST_ZH[activeFam.host] || activeFam.host} · 点击下方会话节点或泳道事件可按单会话筛选联动。`;
    hLeft.append(renderEntityBrief(doc, {
      title: headTitle,
      summary: distinctHeadSum,
      code: HOST_ZH[activeFam.host] || String(activeFam.host || 'local').toUpperCase(),
      typeLabel: activeFam.repoHint ? `关联目录：${activeFam.repoHint}` : '多智能体编队',
    }, { compact: false, showPath: false, maxSummaryChars: 130 }));
    if (selectedAgent) {
      const selPill = mk(doc, 'button', `已锁定会话：${cleanFleetUiLabel(selectedAgent.name)} ×`, 'st-jump-pill');
      selPill.type = 'button';
      selPill.style.marginTop = '8px';
      selPill.addEventListener('click', () => { state.rtFleetSelectedAgent = null; renderRightDetail(activeFam); });
      hLeft.append(selPill);
    }

    const kpiWrap = mk(doc, 'dl', null, 'st-fleet-stats');
    const sum = activeFam.summary || {};
    for (const [label, val, tone] of [
      ['会话总数', sum.totalAgents ?? agents.length, ''],
      ['运行中', sum.runningAgents ?? agents.filter(a => a.status === 'running').length, 'is-cyan'],
      ['委派工作项', sum.totalDelegations ?? (activeFam.delegations || []).length, ''],
      ['消息 / 回报', sum.totalMessages ?? (activeFam.events || []).length, 'is-indigo'],
    ]) {
      const d = mk(doc, 'div', null, `st-fleet-stat ${tone}`);
      d.append(mk(doc, 'dt', label), mk(doc, 'dd', String(val), 'st-tabular'));
      kpiWrap.append(d);
    }
    header.append(hLeft, kpiWrap);
    detailHost.append(header);

  // 2. 主双列区域：左「Agent 会话网络」 + 右「跨会话协作泳道」&「协作任务」
  const mainGrid = mk(doc, 'div', null, 'st-fleet-main-grid');

  // --- 左列：Agent 会话网络（点击节点坐标恒定不动，只原地更新高亮与联动） ---
  const netCard = mk(doc, 'section', null, 'st-card st-fleet-net-card');
  const netHead = mk(doc, 'div', null, 'st-graph-toolbar');
  const netTitle = mk(doc, 'div', null, 'st-graph-controls');
  netTitle.append(mk(doc, 'strong', '🕸️ Agent 会话网络'));
  if (infoTrigger) netTitle.append(infoTrigger('rt:sessionRole', doc));
  const netSub = mk(doc, 'span', `${agents.length} 个会话 · 上下文合计 ${fmtTokens(sum.totalTokens || 0)} · 点击节点坐标不变且联动右侧`, 'st-muted-xs');
  netHead.append(netTitle, netSub);

  const treeStage = mk(doc, 'div', null, 'st-fleet-tree-stage');
  const treeLayout = layoutFleetTreeNodes(agents);
  const treeCanvas = mk(doc, 'div', null, 'st-fleet-tree-canvas');
  treeCanvas.style.width = `${treeLayout.totalW}px`;
  treeCanvas.style.height = `${treeLayout.totalH}px`;

  const treeSvg = svgEl(doc, 'svg', {
    class: 'st-fleet-tree-svg',
    viewBox: `0 0 ${treeLayout.totalW} ${treeLayout.totalH}`,
    width: treeLayout.totalW,
    height: treeLayout.totalH,
  });

  const relatedSet = new Set();
  if (selectedAgent) {
    relatedSet.add(selectedAgent.id);
    if (selectedAgent.parentId) relatedSet.add(selectedAgent.parentId);
    for (const a of agents) if (a.parentId === selectedAgent.id) relatedSet.add(a.id);
  }

  const edgeNodes = [];
  for (const ag of agents) {
    if (!ag.parentId) continue;
    const pPos = treeLayout.pos.get(ag.parentId);
    const cPos = treeLayout.pos.get(ag.id);
    if (!pPos || !cPos) continue;
    const x1 = pPos.x + pPos.w / 2;
    const y1 = pPos.y + pPos.h;
    const x2 = cPos.x + cPos.w / 2;
    const y2 = cPos.y;
    const ky = Math.min(72, Math.max(20, (y2 - y1) * 0.48));
    const isHi = selectedAgent && (ag.id === selectedAgent.id || ag.parentId === selectedAgent.id);
    const path = svgEl(doc, 'path', {
      d: `M ${x1} ${y1} C ${x1} ${y1 + ky}, ${x2} ${y2 - ky}, ${x2} ${y2}`,
      class: `st-fleet-conn${isHi ? ' is-hi' : ''}`,
      'data-from': ag.parentId,
      'data-to': ag.id,
      stroke: hueFor(ag.hueIndex),
    });
    treeSvg.append(path);
    edgeNodes.push(path);
  }
  treeCanvas.append(treeSvg);

  const cardEls = new Map();
  for (const ag of agents) {
    const p = treeLayout.pos.get(ag.id);
    const hue = hueFor(ag.hueIndex);
    const isSel = selectedAgent?.id === ag.id;
    const isDim = selectedAgent && !relatedSet.has(ag.id);
    const card = mk(doc, 'button', null, `st-fleet-node-card${isSel ? ' is-selected' : ''}${isDim ? ' is-dim' : ''}`);
    card.type = 'button';
    card.dataset.agentId = ag.id;
    card.style.left = `${p.x}px`;
    card.style.top = `${p.y}px`;
    card.style.width = `${p.w}px`;
    card.style.height = `${p.h}px`;
    card.style.setProperty('--st-fleet-hue', hue);

    const r1 = mk(doc, 'div', null, 'st-fleet-node-top');
    const av = mk(doc, 'span', ag.roleShort || '智', 'st-fleet-avatar');
    av.style.setProperty('--st-fleet-hue', hue);
    const dot = mk(doc, 'span', null, `st-fleet-dot st-fleet-dot-${ag.status || 'completed'}`);
    const titleEl = mk(doc, 'span', cleanFleetUiLabel(ag.name) || ag.id, 'st-fleet-node-name');
    r1.append(av, dot, titleEl);

    const r2 = mk(doc, 'div', `${fmtTokens(ag.tokens?.total || 0)} Token · ${ag.model || ''}`, 'st-fleet-node-meta st-tabular');
    const barWrap = mk(doc, 'div', null, 'st-fleet-load-bar');
    const barFill = mk(doc, 'div', null, 'st-fleet-load-fill');
    barFill.style.width = `${Math.min(100, Math.max(4, Number(ag.loadPercent) || 8))}%`;
    barFill.style.background = hue;
    barWrap.append(barFill);

    const r3 = mk(doc, 'div', null, 'st-fleet-node-foot st-tabular');
    r3.append(mk(doc, 'span', `${fmtDur(ag.durationMs)} · ${ag.steps || 0} 步`), mk(doc, 'span', `${ag.loadPercent ?? 0}%`));

    card.append(r1, r2, barWrap, r3);
    card.addEventListener('click', () => {
      state.rtFleetSelectedAgent = state.rtFleetSelectedAgent === ag.id ? null : ag.id;
      renderRightDetail(activeFam);
    });
    cardEls.set(ag.id, card);
    treeCanvas.append(card);
  }
  treeStage.append(treeCanvas);
  netCard.append(netHead, treeStage);

  // --- 右列（上：跨会话协作泳道 + 下：协作任务） ---
  const rightStack = mk(doc, 'div', null, 'st-fleet-right-stack');

  // 2A. 跨会话协作泳道（局部重绘，搜索框绝不失焦）
  const allEvents = activeFam.events || [];
  const scopedEvents = selectedAgent
    ? allEvents.filter(e => e.from === selectedAgent.id || e.to === selectedAgent.id)
    : allEvents;
  if (!state.rtFleetSelectedEventId && (scopedEvents[0] || allEvents[0])) {
    state.rtFleetSelectedEventId = (scopedEvents[0] || allEvents[0]).id;
  }

  let paintLanes = () => {};
  let paintEvents = () => {};
  let paintEventDetail = () => {};

  const laneCard = mk(doc, 'section', null, 'st-card st-fleet-lane-card');
  const laneHead = mk(doc, 'div', null, 'st-graph-toolbar');
  const laneLeftTitle = mk(doc, 'div', null, 'st-graph-controls');
  laneLeftTitle.append(mk(doc, 'strong', '🔀 跨会话协作泳道'), mk(doc, 'span', `${allEvents.length} 条交互 · ${(activeFam.delegations || []).length} 项委派`, 'st-muted-xs'));
  const laneTools = mk(doc, 'div', null, 'st-graph-controls');
  const laneSearch = mk(doc, 'input', null, 'st-input');
  laneSearch.type = 'search';
  laneSearch.style.width = '160px';
  laneSearch.placeholder = '搜索会话…';
  laneSearch.value = state.rtFleetAgentQuery || '';
  const earliestBtn = mk(doc, 'button', '最早', 'st-btn');
  earliestBtn.type = 'button';
  const latestBtn = mk(doc, 'button', '最新', 'st-btn');
  latestBtn.type = 'button';
  laneTools.append(laneSearch, earliestBtn, latestBtn);
  laneHead.append(laneLeftTitle, laneTools);

  const laneBody = mk(doc, 'div', null, 'st-fleet-waterfall');
  const laneLabelsCol = mk(doc, 'div', null, 'st-fleet-lane-labels');
  const laneScroller = mk(doc, 'div', null, 'st-fleet-lane-scroller');
  laneScroller.addEventListener('scroll', () => {
    laneLabelsCol.style.transform = `translateY(${-laneScroller.scrollTop}px)`;
  });
  earliestBtn.addEventListener('click', () => { laneScroller.scrollLeft = 0; });
  latestBtn.addEventListener('click', () => { laneScroller.scrollLeft = laneScroller.scrollWidth; });

  paintLanes = () => {
    const prevLeft = laneScroller.scrollLeft;
    const prevTop = laneScroller.scrollTop;
    laneLabelsCol.replaceChildren();
    laneScroller.replaceChildren();
    const laneQuery = (state.rtFleetAgentQuery || '').trim().toLowerCase();
    const visibleAgents = agents.filter(a => !laneQuery || `${a.name} ${a.model} ${a.duty}`.toLowerCase().includes(laneQuery));
    const laneIdxMap = new Map(visibleAgents.map((a, idx) => [a.id, idx]));
    const shownEvents = scopedEvents.filter(e => laneIdxMap.has(e.from) || laneIdxMap.has(e.to));

    const laneH = 54;
    const pitch = 38;
    const trackPad = 26;
    const trackW = Math.max(360, trackPad * 2 + Math.max(1, shownEvents.length) * pitch);
    const trackH = Math.max(laneH, visibleAgents.length * laneH);

    visibleAgents.forEach(ag => {
      const hue = hueFor(ag.hueIndex);
      const isSel = selectedAgent?.id === ag.id;
      const rowBtn = mk(doc, 'button', null, `st-fleet-lane-label${isSel ? ' is-selected' : ''}`);
      rowBtn.type = 'button';
      rowBtn.style.height = `${laneH}px`;
      const av = mk(doc, 'span', ag.roleShort || '智', 'st-fleet-avatar st-fleet-avatar-sm');
      av.style.setProperty('--st-fleet-hue', hue);
      const info = mk(doc, 'div', null, 'st-fleet-lane-copy');
      info.append(
        mk(doc, 'div', cleanFleetUiLabel(ag.name) || ag.id, 'st-fleet-lane-name'),
        mk(doc, 'div', `${fmtTokens(ag.tokens?.total || 0)} · ${ag.steps || 0} 步`, 'st-fleet-lane-meta st-tabular'),
      );
      rowBtn.append(av, info);
      rowBtn.addEventListener('click', () => {
        state.rtFleetSelectedAgent = state.rtFleetSelectedAgent === ag.id ? null : ag.id;
        renderRightDetail(activeFam);
      });
      laneLabelsCol.append(rowBtn);
    });

    const laneCanvas = mk(doc, 'div', null, 'st-fleet-lane-canvas');
    laneCanvas.style.width = `${trackW}px`;
    laneCanvas.style.height = `${trackH}px`;
    const laneSvg = svgEl(doc, 'svg', {
      class: 'st-fleet-lane-svg',
      viewBox: `0 0 ${trackW} ${trackH}`,
      width: trackW,
      height: trackH,
    });
    for (let li = 0; li < visibleAgents.length; li += 1) {
      const cy = li * laneH + laneH / 2;
      laneSvg.append(svgEl(doc, 'line', { x1: 0, y1: cy, x2: trackW, y2: cy, class: 'st-fleet-lane-baseline' }));
    }
    if (visibleAgents.length === 0) {
      const emptyLaneBox = mk(doc, 'div', null, 'st-empty-actions');
      emptyLaneBox.style.padding = '12px';
      const clearLaneBtn = mk(doc, 'button', '🔄 清空筛选条件', 'st-btn');
      clearLaneBtn.type = 'button';
      clearLaneBtn.addEventListener('click', () => {
        state.rtFleetAgentQuery = '';
        laneSearch.value = '';
        paintLanes();
      });
      emptyLaneBox.append(mk(doc, 'span', '当前搜索条件下无匹配会话。', 'st-muted-xs'), clearLaneBtn);
      laneScroller.append(emptyLaneBox);
      return;
    }
    const activeEvent = allEvents.find(e => e.id === state.rtFleetSelectedEventId) || shownEvents[0] || allEvents[0] || null;
    shownEvents.forEach((ev, idx) => {
      const cx = trackPad + idx * pitch;
      const fromIdx = laneIdxMap.get(ev.from);
      const toIdx = laneIdxMap.get(ev.to);
      const evColor = ev.kind === 'delegation' ? '#4f46e5' : (ev.kind === 'report' ? '#059669' : '#0284c7');
      if (fromIdx !== undefined && toIdx !== undefined && fromIdx !== toIdx) {
        const y1 = fromIdx * laneH + laneH / 2;
        const y2 = toIdx * laneH + laneH / 2;
        laneSvg.append(
          svgEl(doc, 'circle', { cx, cy: y1, r: 4, fill: evColor }),
          svgEl(doc, 'line', {
            x1: cx, y1, x2: cx, y2,
            stroke: evColor,
            'stroke-width': activeEvent?.id === ev.id ? 3 : 2,
            'stroke-opacity': activeEvent?.id === ev.id ? 1 : 0.72,
          }),
        );
      }
      const targetIdx = toIdx !== undefined ? toIdx : (fromIdx ?? 0);
      const cy = targetIdx * laneH + laneH / 2;
      const dotBtn = mk(doc, 'button', ev.kind === 'delegation' ? '+' : (ev.kind === 'report' ? '✓' : '·'), `st-fleet-ev-dot${activeEvent?.id === ev.id ? ' is-selected' : ''}`);
      dotBtn.type = 'button';
      dotBtn.title = `${ev.kindLabel}：${ev.summary || ''}`;
      dotBtn.style.left = `${cx}px`;
      dotBtn.style.top = `${cy}px`;
      dotBtn.style.borderColor = evColor;
      dotBtn.style.color = evColor;
      dotBtn.addEventListener('click', () => {
        state.rtFleetSelectedEventId = ev.id;
        paintLanes();
        paintEvents();
      });
      laneCanvas.append(dotBtn);
    });
    laneCanvas.prepend(laneSvg);
    laneScroller.append(laneCanvas);
    laneScroller.scrollLeft = prevLeft;
    laneScroller.scrollTop = prevTop;
  };
  laneSearch.addEventListener('input', () => { state.rtFleetAgentQuery = laneSearch.value; paintLanes(); });
  paintLanes();

  laneBody.append(laneLabelsCol, laneScroller);
  laneCard.append(laneHead, laneBody);

  // 2B. 协作任务（委派工作项卡片，局部重绘状态过滤）
  const workCard = mk(doc, 'section', null, 'st-card st-fleet-work-card');
  const workHead = mk(doc, 'div', null, 'st-graph-toolbar');
  const delegations = activeFam.delegations || [];
  const scopedDelegations = selectedAgent
    ? delegations.filter(d => d.from === selectedAgent.id || d.to === selectedAgent.id)
    : delegations;
  workHead.append(mk(doc, 'strong', '📋 协作任务'), mk(doc, 'span', `${scopedDelegations.length}/${delegations.length} 个工作项`, 'st-muted-xs'));

  const workFilters = mk(doc, 'div', null, 'st-graph-controls');
  workFilters.style.padding = '8px 12px 4px';
  const phaseCounts = {
    all: scopedDelegations.length,
    in_progress: scopedDelegations.filter(d => d.status === 'in_progress').length,
    pending: scopedDelegations.filter(d => d.status === 'pending').length,
    completed: scopedDelegations.filter(d => d.status === 'completed').length,
  };
  const workList = mk(doc, 'div', null, 'st-fleet-work-list');
  const paintWorkList = () => {
    workFilters.querySelectorAll('.st-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.phase === (state.rtFleetTaskPhase || 'all'));
    });
    workList.replaceChildren();
    const filteredDelegations = scopedDelegations.filter(d => (state.rtFleetTaskPhase || 'all') === 'all' || d.status === state.rtFleetTaskPhase);
    if (!filteredDelegations.length) {
      workList.append(mk(doc, 'p', '当前筛选条件下无委派工作项。', 'st-muted-xs'));
      return;
    }
    for (const d of filteredDelegations) {
      const toAg = agentMap.get(d.to);
      const hue = hueFor(toAg?.hueIndex ?? 1);
      const itemBox = mk(doc, 'div', null, 'st-fleet-work-item');
      itemBox.style.setProperty('--st-fleet-hue', hue);
      const top = mk(doc, 'div', null, 'st-repo-opt-head');
      const leftT = mk(doc, 'div', null, 'st-graph-controls');
      const av = mk(doc, 'span', toAg?.roleShort || '智', 'st-fleet-avatar st-fleet-avatar-sm');
      av.style.setProperty('--st-fleet-hue', hue);
      const workTitle = cleanFleetUiLabel(d.label) || '未命名委派任务';
      const workDistinctSum = dedupeSummaryAgainstTitle(d.prompt || '', workTitle);
      const briefNode = renderEntityBrief(doc, {
        title: workTitle,
        summary: workDistinctSum,
        code: d.mode === 'reviewer' ? '只读复核' : '子会话',
        typeLabel: toAg?.name ? `承接：${cleanFleetUiLabel(toAg.name)}` : '',
      }, { compact: true, showPath: false, maxSummaryChars: 92 });
      leftT.append(av, briefNode);
      const stBadge = mk(
        doc,
        'span',
        d.status === 'in_progress' ? '● 运行中' : (d.status === 'completed' ? '✓ 已完成' : '待处理'),
        `st-badge ${d.status === 'in_progress' ? 'st-badge-indigo' : (d.status === 'completed' ? 'st-badge-emerald' : 'st-badge-zinc')}`,
      );
      top.append(leftT, stBadge);
      itemBox.append(top);
      itemBox.addEventListener('click', () => {
        const hitEv = allEvents.find(e => e.kind === 'delegation' && e.to === d.to && e.from === d.from);
        if (hitEv) {
          state.rtFleetSelectedEventId = hitEv.id;
          paintLanes();
          paintEvents();
        }
      });
      workList.append(itemBox);
    }
  };
  for (const [pk, pl] of [['all', '全部'], ['in_progress', '运行中'], ['pending', '待处理'], ['completed', '已完成']]) {
    const b = mk(doc, 'button', `${pl} ${phaseCounts[pk]}`, `st-btn${(state.rtFleetTaskPhase || 'all') === pk ? ' is-active' : ''}`);
    b.type = 'button';
    b.dataset.phase = pk;
    b.addEventListener('click', () => { state.rtFleetTaskPhase = pk; paintWorkList(); });
    workFilters.append(b);
  }
  paintWorkList();
  workCard.append(workHead, workFilters, workList);

  rightStack.append(laneCard, workCard);

  // 紧凑分段切换条：1440px 笔记本下默认单舞台全宽展开避免四块面板互相挤压截断，超宽屏亦可选双栏同屏
  const defaultStageMode = (typeof window !== 'undefined' && window.innerWidth >= 1960) ? 'split' : 'net';
  const stageBar = mk(doc, 'div', null, 'st-fleet-stage-bar');
  const stageSwitch = mk(doc, 'div', null, 'st-view-switch');
  const applyStageMode = () => {
    const mode = state.rtFleetStageMode || defaultStageMode;
    stageSwitch.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.stageMode === mode);
    });
    mainGrid.classList.toggle('is-segmented', mode !== 'split');
    netCard.hidden = mode !== 'split' && mode !== 'net';
    rightStack.hidden = mode === 'net';
    laneCard.hidden = mode !== 'split' && mode !== 'lane';
    workCard.hidden = mode !== 'split' && mode !== 'work';
  };
  for (const [mKey, mLbl] of [
    ['net', `🕸️ 会话网络 (${agents.length})`],
    ['lane', `🔀 协作泳道 (${allEvents.length})`],
    ['work', `📋 协作任务 (${scopedDelegations.length})`],
    ['split', '⊞ 并排同屏'],
  ]) {
    const b = mk(doc, 'button', mLbl, 'st-btn st-btn-xs');
    b.type = 'button';
    b.dataset.stageMode = mKey;
    b.addEventListener('click', () => {
      state.rtFleetStageMode = mKey;
      applyStageMode();
    });
    stageSwitch.append(b);
  }
  stageBar.append(stageSwitch, mk(doc, 'span', '点选任意节点、泳道圆点或任务均实时联动下方事件检查', 'st-muted-xs'));
  mainGrid.append(netCard, rightStack);
  applyStageMode();
  detailHost.append(stageBar, mainGrid);

  // 3. 底部全宽「事件检查」左右分栏详情器（局部重绘，搜索框绝不失焦）
  const inspCard = mk(doc, 'section', null, 'st-card st-fleet-inspector-card');
  const inspHead = mk(doc, 'div', null, 'st-graph-toolbar');
  const kindCounts = {
    all: scopedEvents.length,
    message: scopedEvents.filter(e => e.kind === 'message').length,
    report: scopedEvents.filter(e => e.kind === 'report').length,
    delegation: scopedEvents.filter(e => e.kind === 'delegation').length,
  };

  const inspLeftHead = mk(doc, 'div', null, 'st-graph-controls');
  const inspCountSpan = mk(doc, 'span', '', 'st-muted-xs');
  inspLeftHead.append(mk(doc, 'strong', '🔎 事件检查'), inspCountSpan);
  const inspTools = mk(doc, 'div', null, 'st-graph-controls');
  for (const [ek, elLbl] of [['all', '全部'], ['message', '消息'], ['report', '回报'], ['delegation', '委派']]) {
    const b = mk(doc, 'button', `${elLbl} ${kindCounts[ek]}`, `st-btn${(state.rtFleetEventKind || 'all') === ek ? ' is-active' : ''}`);
    b.type = 'button';
    b.dataset.evKind = ek;
    b.addEventListener('click', () => { state.rtFleetEventKind = ek; paintEvents(); });
    inspTools.append(b);
  }
  const evSearchInp = mk(doc, 'input', null, 'st-input');
  evSearchInp.type = 'search';
  evSearchInp.style.width = '180px';
  evSearchInp.placeholder = '搜索事件内容…';
  evSearchInp.value = state.rtFleetEventQuery || '';
  inspTools.append(evSearchInp);
  inspHead.append(inspLeftHead, inspTools);

  const inspSplit = mk(doc, 'div', null, 'st-fleet-insp-split');
  const evListCol = mk(doc, 'div', null, 'st-fleet-ev-list');
  const evDetailCol = mk(doc, 'div', null, 'st-fleet-ev-detail');

  paintEventDetail = curEv => {
    evDetailCol.replaceChildren();
    if (!curEv) {
      evDetailCol.append(mk(doc, 'p', '点击左侧任意事件查看完整委派路由与简报内容。', 'st-muted-xs'));
      return;
    }
    const fromAg = agentMap.get(curEv.from);
    const toAg = agentMap.get(curEv.to);
    const dMeta = mk(doc, 'div', null, 'st-repo-opt-head');
    const dMetaLeft = mk(doc, 'div', null, 'st-graph-controls');
    dMetaLeft.append(
      mk(doc, 'span', curEv.kindLabel || curEv.kind, 'st-badge st-badge-amber'),
      mk(doc, 'span', fmtDateTimeFull(curEv.time), 'st-muted-xs st-tabular'),
      mk(doc, 'span', `序号 #${curEv.seq ?? '—'}`, 'st-muted-xs st-tabular'),
    );
    dMeta.append(dMetaLeft);
    evDetailCol.append(dMeta);

    if (curEv.note) {
      evDetailCol.append(mk(doc, 'div', curEv.note, 'st-fleet-ev-note'));
    }
    const route = mk(doc, 'div', null, 'st-fleet-ev-route');
    const mkParty = (ag, fallbackId) => {
      const sp = mk(doc, 'span', null, 'st-graph-controls');
      const av = mk(doc, 'span', ag?.roleShort || '智', 'st-fleet-avatar st-fleet-avatar-sm');
      av.style.setProperty('--st-fleet-hue', hueFor(ag?.hueIndex ?? 0));
      sp.append(av, mk(doc, 'strong', cleanFleetUiLabel(ag?.name) || fallbackId));
      return sp;
    };
    route.append(mkParty(fromAg, curEv.from), mk(doc, 'span', ' → ', 'st-muted-xs'), mkParty(toAg, curEv.to));
    evDetailCol.append(route);

    const cleanDuty = cleanFleetUiLabel(curEv.duty);
    const cleanBody = cleanFleetUiLabel(curEv.body);
    const dutyDuplicatesBody = Boolean(cleanDuty && cleanBody && (cleanBody === cleanDuty || (cleanBody.startsWith(cleanDuty) && cleanBody.length <= cleanDuty.length + 12)));
    const fields = mk(doc, 'div', null, 'st-fleet-ev-fields');
    if (!dutyDuplicatesBody && cleanDuty) {
      fields.append(
        mk(doc, 'div', '委派职责', 'st-muted-xs'),
        mk(doc, 'div', cleanDuty, 'st-fleet-ev-val'),
      );
    }
    fields.append(
      mk(doc, 'div', '执行模式', 'st-muted-xs'),
      mk(doc, 'div', curEv.executionMode || '—', 'st-fleet-ev-val'),
    );
    evDetailCol.append(fields);

    const bodyHead = mk(doc, 'div', null, 'st-repo-opt-head');
    bodyHead.style.marginTop = '10px';
    bodyHead.append(mk(doc, 'span', curEv.kind === 'report' ? '回报正文' : '任务简报', 'st-muted-xs'));
    const modeTools = mk(doc, 'div', null, 'st-graph-controls');
    const isRich = state.rtFleetRichMode !== false;
    const rawBtn = mk(doc, 'button', '原文', `st-btn${!isRich ? ' is-active' : ''}`);
    rawBtn.type = 'button';
    rawBtn.addEventListener('click', () => { state.rtFleetRichMode = false; paintEventDetail(curEv); });
    const mdBtn = mk(doc, 'button', 'Markdown', `st-btn${isRich ? ' is-active' : ''}`);
    mdBtn.type = 'button';
    mdBtn.addEventListener('click', () => { state.rtFleetRichMode = true; paintEventDetail(curEv); });
    const copyBtn = mk(doc, 'button', '📋 复制', 'st-btn');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard?.writeText(curEv.body || '');
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => { copyBtn.textContent = '📋 复制'; }, 1200);
      } catch {
        copyBtn.textContent = '复制受限';
        setTimeout(() => { copyBtn.textContent = '📋 复制'; }, 1500);
      }
    });
    modeTools.append(rawBtn, mdBtn, copyBtn);
    bodyHead.append(modeTools);

    const bodyBox = mk(doc, 'div', null, 'st-fleet-ev-body');
    if (isRich) bodyBox.append(renderSafeMarkdownToDom(curEv.body || '', doc));
    else bodyBox.append(mk(doc, 'pre', curEv.body || '（暂无内容）', 'st-code-block'));
    evDetailCol.append(bodyHead, bodyBox);
  };

  paintEvents = () => {
    const evKind = state.rtFleetEventKind || 'all';
    const evQuery = (state.rtFleetEventQuery || '').trim().toLowerCase();
    inspTools.querySelectorAll('[data-ev-kind]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.evKind === evKind);
    });
    const filteredEvs = scopedEvents.filter(e => {
      if (evKind !== 'all' && e.kind !== evKind) return false;
      if (evQuery && !`${e.summary} ${e.body} ${e.duty} ${agentMap.get(e.from)?.name || ''} ${agentMap.get(e.to)?.name || ''}`.toLowerCase().includes(evQuery)) return false;
      return true;
    });
    inspCountSpan.textContent = `显示 ${filteredEvs.length} / ${scopedEvents.length} 条`;

    const curEv = filteredEvs.find(e => e.id === state.rtFleetSelectedEventId) || filteredEvs[0] || null;
    if (curEv) state.rtFleetSelectedEventId = curEv.id;

    const prevListTop = evListCol.scrollTop;
    evListCol.replaceChildren();
    if (!filteredEvs.length) {
      evListCol.append(mk(doc, 'p', '当前筛选条件下暂无交互事件。', 'st-muted-xs'));
      const clearEvBtn = mk(doc, 'button', '🔄 清空筛选条件', 'st-btn');
      clearEvBtn.type = 'button';
      clearEvBtn.addEventListener('click', () => {
        state.rtFleetEventKind = 'all';
        state.rtFleetEventQuery = '';
        evSearchInp.value = '';
        paintEvents();
      });
      evListCol.append(clearEvBtn);
    } else {
      for (const ev of filteredEvs) {
        const fromAg = agentMap.get(ev.from);
        const toAg = agentMap.get(ev.to);
        const row = mk(doc, 'button', null, `st-fleet-ev-row${curEv?.id === ev.id ? ' is-selected' : ''}`);
        row.type = 'button';
        const rTop = mk(doc, 'div', null, 'st-repo-opt-head');
        rTop.append(
          mk(doc, 'span', `${fmtTimeShort(ev.time)} · ${cleanFleetUiLabel(fromAg?.name) || ev.from} → ${cleanFleetUiLabel(toAg?.name) || ev.to}`, 'st-muted-xs'),
          mk(doc, 'span', ev.kindLabel || ev.kind, `st-badge ${ev.kind === 'report' ? 'st-badge-emerald' : (ev.kind === 'delegation' ? 'st-badge-amber' : 'st-badge-indigo')}`),
        );
        row.append(rTop, mk(doc, 'div', cleanFleetUiLabel(ev.summary || ev.duty) || '—', 'st-fleet-ev-preview'));
        row.addEventListener('click', () => {
          state.rtFleetSelectedEventId = ev.id;
          paintLanes();
          paintEvents();
        });
        evListCol.append(row);
      }
    }
    evListCol.scrollTop = prevListTop;
    paintEventDetail(curEv);
  };

  evSearchInp.addEventListener('input', () => { state.rtFleetEventQuery = evSearchInp.value; paintEvents(); });
  paintEvents();

  inspSplit.append(evListCol, evDetailCol);
  inspCard.append(inspHead, inspSplit);
  detailHost.append(inspCard);
  };

  const initFam = families.find(f => f.id === state.rtFleetFamilyId) || families[0] || null;
  state.rtFleetFamilyId = initFam?.id || null;
  paintPicker();
  renderRightDetail(initFam);
}
