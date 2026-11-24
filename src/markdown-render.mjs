// @feature STU001
// @feature STU002

import { homedir } from 'node:os';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[ch]));

export function sanitizePublicText(value) {
  let out = String(value ?? '');
  const home = homedir();
  if (home && home.length > 1) out = out.replaceAll(home, '<USER_HOME>');
  return out
    .replace(/\/Users\/[^/"'\s]+\/\.local\/share\/fnm\/node-versions\/[^/"'\s]+\/installation\/bin/g, '<NODE_BIN>')
    .replace(/\/Volumes\/[^/\n"']+\/source/g, '<SOURCE_ROOT>')
    .replace(/\/Volumes\/[^/\n"']+/g, '<VOLUME_ROOT>')
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, '<USER_HOME>');
}

export function cleanInlinePlain(text) {
  return sanitizePublicText(String(text ?? ''))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\*{2,}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripYamlFrontmatter(rawText) {
  const normalized = String(rawText ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  const match = /^(?:[ \t]*\n)*---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n([\s\S]*)|$)/.exec(normalized);
  if (!match) return { frontmatterRaw: '', body: normalized, hasFrontmatter: false };
  const fmRaw = match[1] || '';
  if (fmRaw.trim() && !/^(?:#[^\n]*|[A-Za-z0-9_.-]+\s*:)/m.test(fmRaw.trimStart())) {
    return { frontmatterRaw: '', body: normalized, hasFrontmatter: false };
  }
  return {
    frontmatterRaw: fmRaw,
    body: match[2] ?? '',
    hasFrontmatter: true,
  };
}

export function extractArtifactBrief({
  rawText = '',
  frontmatter = null,
  fallbackTitle = '',
  code = '',
  typeLabel = '',
  path = '',
} = {}) {
  const sanitized = sanitizePublicText(String(rawText ?? ''));
  const stripped = stripYamlFrontmatter(sanitized);
  const body = stripped.body;
  const fmParsed = { ...(frontmatter && typeof frontmatter === 'object' ? frontmatter : {}) };
  if (stripped.hasFrontmatter && !frontmatter && stripped.frontmatterRaw) {
    for (const line of stripped.frontmatterRaw.split('\n')) {
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line.trim());
      if (!kv) continue;
      const k = kv[1];
      if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
      const v = kv[2].trim().replace(/^["']|["']$/g, '');
      if (v && !fmParsed[k]) fmParsed[k] = v;
    }
  }

  let h1Title = '';
  const bodyLines = body.split('\n');
  const proseSnippets = [];
  let inCodeFence = false;
  for (const rawLine of bodyLines) {
    const t = rawLine.trim();
    if (/^```/.test(t)) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence || !t) continue;
    if (t.startsWith('# ') && !h1Title) {
      h1Title = cleanInlinePlain(t.slice(2));
      continue;
    }
    if (/^#{2,6}\s/.test(t) || /^<!--/.test(t) || /^---+$/.test(t) || /^<details|^<\/details>|^<summary/i.test(t)) continue;
    if (/^\[阅读目录\]/.test(t) || /^故事编号\s+LC-\d+$/i.test(t) || /^\|/.test(t)) continue;
    if (/^[-*]\s+\*\*(?:related_|parent_|scenarios|design_docs|depends_on|所属|编号|状态)/i.test(t)) continue;
    if (/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.test(t)) continue;
    const stripped = cleanInlinePlain(t.replace(/^>\s*/, '').replace(/^[-*]\s+/, ''));
    if (stripped.length >= 10 && !/^[A-Za-z0-9_.:/-]+$/.test(stripped)) {
      proseSnippets.push(stripped);
      if (proseSnippets.join(' ').length >= 110) break;
    }
  }

  const fileFallback = path ? String(path).split('/').pop().replace(/\.[^.]+$/, '') : '';
  const rawTitle = cleanInlinePlain(fmParsed.title || h1Title || fallbackTitle || code || fileFallback || '未命名制品');
  const title = rawTitle || cleanInlinePlain(code || fileFallback || '未命名制品');

  const isJsonPath = /\.json$/i.test(String(path || ''));
  const isCsvPath = /\.csv$/i.test(String(path || ''));
  let summary = cleanInlinePlain(fmParsed.summary || fmParsed.description || fmParsed.purpose || '');
  if (summary.length < 10 && isJsonPath) {
    try {
      const parsedJson = JSON.parse(sanitized);
      if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
        const strSum = parsedJson.summary || parsedJson.description || parsedJson.reason || parsedJson.title || '';
        if (typeof strSum === 'string' && cleanInlinePlain(strSum).length >= 10 && cleanInlinePlain(strSum) !== title) {
          summary = cleanInlinePlain(strSum);
        } else {
          const topKeys = Object.keys(parsedJson).filter(k => !k.startsWith('_')).slice(0, 5);
          if (topKeys.length > 0) {
            summary = `JSON 结构化数据与状态记录（包含字段：${topKeys.join('、')}）。`;
          }
        }
      }
    } catch {}
  } else if (summary.length < 10 && isCsvPath) {
    const nonEmptyRows = sanitized.split('\n').map(l => l.trim()).filter(Boolean);
    const cols = (nonEmptyRows[0] || '').split(',').map(c => c.trim()).filter(Boolean).slice(0, 5);
    const dataCount = Math.max(0, nonEmptyRows.length - 1);
    summary = cols.length > 0
      ? `CSV 表格数据记录（共 ${dataCount} 行，列：${cols.join('、')}）。`
      : `CSV 表格数据记录（${title}）。`;
  }
  if (summary.length < 10 && !isJsonPath && !isCsvPath) {
    summary = cleanInlinePlain(proseSnippets.join(' '));
  }
  if (summary.length < 10) {
    summary = (isJsonPath || isCsvPath)
      ? `结构化数据与状态证据文件（${title}）。`
      : `查看${typeLabel ? `「${typeLabel}」` : '制品'}「${title}」的业务范围、边界约定与验收细则。`;
  }
  if (summary.length > 105) {
    const cutWindow = summary.slice(48, 104);
    const punctOffset = Math.max(cutWindow.lastIndexOf('。'), cutWindow.lastIndexOf('；'), cutWindow.lastIndexOf('！'));
    summary = punctOffset >= 0 ? summary.slice(0, 48 + punctOffset + 1) : `${summary.slice(0, 98).trim()}…`;
  }

  return { title, summary };
}

function renderDocHeroHtml({ title, summary, code, typeLabel, path, status, frontmatter } = {}) {
  const badges = [];
  if (typeLabel) badges.push(`<span class="st-badge st-badge-indigo">${escapeHtml(typeLabel)}</span>`);
  if (code) badges.push(`<span class="st-badge st-badge-zinc">${escapeHtml(code)}</span>`);
  const stVal = status || frontmatter?.status;
  if (stVal) badges.push(`<span class="st-badge st-badge-emerald">状态：${escapeHtml(String(stVal))}</span>`);
  const extraKeys = [];
  if (frontmatter && typeof frontmatter === 'object') {
    for (const [fk, fv] of Object.entries(frontmatter)) {
      if (['id', 'title', 'summary', 'description', 'status', '__proto__', 'constructor', 'prototype'].includes(fk)) continue;
      if (Array.isArray(fv) && fv.length > 0) extraKeys.push(`${fk}: ${fv.slice(0, 3).join(', ')}${fv.length > 3 ? ` +${fv.length - 3}` : ''}`);
      else if ((typeof fv === 'string' || typeof fv === 'number') && String(fv).trim()) extraKeys.push(`${fk}: ${fv}`);
    }
  }
  const metaChips = extraKeys.slice(0, 4).map(m => `<span class="st-doc-hero-chip">${escapeHtml(m)}</span>`).join('');
  return [
    '<header class="st-doc-hero">',
    `<div class="st-doc-hero-top"><div class="st-graph-controls">${badges.join('')}</div>${path ? `<span class="st-doc-hero-path">${escapeHtml(path)}</span>` : ''}</div>`,
    `<h1 class="st-doc-hero-title">${escapeHtml(title || '制品文档')}</h1>`,
    summary ? `<p class="st-doc-hero-summary">${escapeHtml(summary)}</p>` : '',
    metaChips ? `<div class="st-doc-hero-meta">${metaChips}</div>` : '',
    '</header>',
  ].join('');
}

export function renderInlineMarkdown(text) {
  const codeSpans = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, inner) => {
    const idx = codeSpans.push(`<code class="st-inline-code">${inner}</code>`) - 1;
    return `\u0000CODE_${idx}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const expMatch = /(?:^|\/)(\d{2})\.md(?:#.*)?$/.exec(href.trim());
    if (expMatch) {
      const lcId = `lifecycle:LC-${expMatch[1]}`;
      return `<button type="button" class="st-inline-jump" data-jump-target="${escapeHtml(lcId)}">${label}</button>`;
    }
    if (/^US-\d{3}/i.test(label)) {
      const usCode = (label.match(/US-\d{3}/i) || [])[0].toUpperCase();
      return `<button type="button" class="st-inline-jump" data-jump-target="lifecycle_story:${escapeHtml(usCode)}">${label}</button>`;
    }
    return `<span class="st-inline-ref">${label}</span>`;
  });
  return out.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] || '');
}

export function renderMermaidOffline(rawLines) {
  const cleanLines = rawLines.map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
  const first = cleanLines[0] || '';
  const kindLabel = /^(?:flowchart|graph)\b/i.test(first) ? '流程图'
    : /^sequenceDiagram\b/i.test(first) ? '时序图'
      : /^stateDiagram(?:-v2)?\b/i.test(first) ? '状态流转图'
        : /^classDiagram\b/i.test(first) ? '类图'
          : /^erDiagram\b/i.test(first) ? '实体关系图' : '结构图';

  const nodeLabels = new Map();
  const nodeOrder = [];
  const ensureNode = (id, label) => {
    if (!id) return '';
    if (!nodeLabels.has(id)) {
      nodeLabels.set(id, label || id);
      nodeOrder.push(id);
    } else if (label && label !== id && nodeLabels.get(id) === id) {
      nodeLabels.set(id, label);
    }
    return id;
  };
  const regNode = token => {
    const t = String(token ?? '').trim();
    if (!t) return '';
    if (t === '[*]') return ensureNode('__start_end__', '起点 / 终点');
    const m = /^([A-Za-z0-9_.-]+)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\)|\(([^)]+)\)|\{([^}]+)\})?$/.exec(t);
    if (!m) {
      const clean = t.replace(/^["']|["']$/g, '');
      return ensureNode(clean, clean);
    }
    const id = m[1];
    const lbl = (m[2] || m[3] || m[4] || m[5] || m[6] || '').trim().replace(/^["']|["']$/g, '');
    return ensureNode(id, lbl || id);
  };

  const steps = [];
  for (const line of cleanLines.slice(1)) {
    if (/^(?:subgraph|end|direction|style|classDef|class|click|participant|actor)\b/i.test(line)) {
      const pMatch = /^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
      if (pMatch) ensureNode(pMatch[1], (pMatch[2] || pMatch[1]).trim());
      continue;
    }
    const stateDesc = /^([A-Za-z0-9_.-]+)\s*:\s*([^>-].*)$/.exec(line);
    if (stateDesc && !line.includes('-->')) {
      ensureNode(stateDesc[1], stateDesc[2].trim());
      continue;
    }
    const seq = /^([^\s:-]+)\s*(?:-+>>?|--+>>?|\.+>>?|-+\))\s*([^\s:]+)\s*:\s*(.+)$/.exec(line);
    if (seq) { steps.push({ from: regNode(seq[1]), to: regNode(seq[2]), rel: seq[3].trim() }); continue; }
    const pipe = /^(.+?)\s*(?:--+>|==+>|\.-+>|<--+>)\s*\|([^|]+)\|\s*(.+)$/.exec(line);
    if (pipe) { steps.push({ from: regNode(pipe[1]), to: regNode(pipe[3]), rel: pipe[2].trim() }); continue; }
    const plain = /^(.+?)\s*(?:--+>|==+>|\.-+>|<--+>)\s*(.+?)(?:\s*:\s*(.+))?$/.exec(line);
    if (plain) { steps.push({ from: regNode(plain[1]), to: regNode(plain[2]), rel: (plain[3] || '').trim() }); continue; }
  }

  let svgHtml = '';
  if (nodeOrder.length > 0 && steps.length > 0) {
    const inDeg = new Map(nodeOrder.map(id => [id, 0]));
    const adj = new Map(nodeOrder.map(id => [id, []]));
    for (const s of steps) {
      if (s.from !== s.to) {
        adj.get(s.from)?.push(s.to);
        inDeg.set(s.to, (inDeg.get(s.to) || 0) + 1);
      }
    }
    const depth = new Map();
    const queue = nodeOrder.filter(id => (inDeg.get(id) || 0) === 0);
    if (queue.length === 0) queue.push(nodeOrder[0]);
    for (const r of queue) depth.set(r, 0);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = depth.get(cur) || 0;
      for (const nxt of adj.get(cur) || []) {
        if (!depth.has(nxt) && d < 8) {
          depth.set(nxt, d + 1);
          queue.push(nxt);
        }
      }
    }
    for (const id of nodeOrder) if (!depth.has(id)) depth.set(id, 0);
    const cols = new Map();
    for (const id of nodeOrder) {
      const c = depth.get(id) || 0;
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push(id);
    }
    const colKeys = [...cols.keys()].sort((a, b) => a - b);
    const boxW = 174;
    const boxH = 44;
    const colGap = 54;
    const rowGap = 24;
    const padX = 20;
    const padY = 18;
    const maxRows = Math.max(1, ...[...cols.values()].map(arr => arr.length));
    const totalW = padX * 2 + colKeys.length * boxW + Math.max(0, colKeys.length - 1) * colGap;
    const totalH = padY * 2 + maxRows * boxH + Math.max(0, maxRows - 1) * rowGap;
    const pos = new Map();
    colKeys.forEach((ck, ci) => {
      const arr = cols.get(ck);
      const colSpanH = arr.length * boxH + Math.max(0, arr.length - 1) * rowGap;
      const offsetY = padY + Math.round((totalH - padY * 2 - colSpanH) / 2);
      arr.forEach((id, ri) => {
        pos.set(id, {
          x: padX + ci * (boxW + colGap),
          y: offsetY + ri * (boxH + rowGap),
          label: nodeLabels.get(id) || id,
        });
      });
    });

    const arrowId = `mmd-arrow-${rawLines.length}-${nodeOrder.length}`;
    const edgeParts = [];
    for (const s of steps.slice(0, 40)) {
      const p1 = pos.get(s.from);
      const p2 = pos.get(s.to);
      if (!p1 || !p2) continue;
      let pathD = '';
      let lx = 0;
      let ly = 0;
      if (p1.x === p2.x && p1.y === p2.y) {
        const cx = p1.x + boxW / 2;
        const cy = p1.y;
        pathD = `M ${cx - 18} ${cy} C ${cx - 18} ${cy - 26}, ${cx + 18} ${cy - 26}, ${cx + 18} ${cy}`;
        lx = cx;
        ly = cy - 22;
      } else if (p2.x > p1.x) {
        const x1 = p1.x + boxW;
        const y1 = p1.y + boxH / 2;
        const x2 = p2.x;
        const y2 = p2.y + boxH / 2;
        const mx = (x1 + x2) / 2;
        pathD = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
        lx = mx;
        ly = (y1 + y2) / 2 - 6;
      } else {
        const x1 = p1.x + boxW / 2;
        const y1 = p1.y + boxH;
        const x2 = p2.x + boxW / 2;
        const y2 = p2.y + boxH;
        const bow = Math.max(y1, y2) + 22;
        pathD = `M ${x1} ${y1} C ${x1} ${bow}, ${x2} ${bow}, ${x2} ${y2}`;
        lx = (x1 + x2) / 2;
        ly = bow - 4;
      }
      edgeParts.push(`<path d="${pathD}" fill="none" stroke="var(--st-accent)" stroke-width="1.6" stroke-opacity="0.82" marker-end="url(#${arrowId})" />`);
      if (s.rel) {
        const cleanRel = s.rel.length > 18 ? `${s.rel.slice(0, 17)}…` : s.rel;
        edgeParts.push(`<text x="${lx}" y="${ly}" text-anchor="middle" fill="var(--st-fg-muted)" font-size="10.5">${escapeHtml(cleanRel)}</text>`);
      }
    }
    const nodeParts = [];
    for (const id of nodeOrder) {
      const p = pos.get(id);
      const lbl = p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label;
      nodeParts.push(`<g><rect x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="8" fill="var(--st-surface)" stroke="var(--st-border-strong)" stroke-width="1.4" /><text x="${p.x + boxW / 2}" y="${p.y + 26}" text-anchor="middle" fill="var(--st-fg)" font-size="12" font-weight="600">${escapeHtml(lbl)}</text></g>`);
    }
    svgHtml = `<div class="st-mermaid-svg-wrap"><svg class="st-mermaid-svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" role="img" aria-label="${escapeHtml(kindLabel)}"><defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--st-accent)" /></marker></defs>${edgeParts.join('')}${nodeParts.join('')}</svg></div>`;
  }

  const stepsHtml = steps.length
    ? `<ol class="st-mermaid-steps">${steps.slice(0, 40).map(s => `<li><span class="st-chip">${escapeHtml(nodeLabels.get(s.from) || s.from)}</span><span class="st-mermaid-rel">${escapeHtml(s.rel || '→')}</span><span class="st-chip">${escapeHtml(nodeLabels.get(s.to) || s.to)}</span></li>`).join('')}</ol>`
    : '';
  const codeHtml = `<pre class="st-code-block" data-lang="mermaid"><code>${rawLines.map(escapeHtml).join('\n')}</code></pre>`;
  return `<div class="st-mermaid-card"><div class="st-mermaid-head"><span class="st-badge st-badge-indigo">Mermaid ${escapeHtml(kindLabel)}（离线可视化图）</span><span class="st-muted-xs">${steps.length ? `共 ${nodeOrder.length} 个节点 · ${steps.length} 条流转边` : '源码预览'}</span></div>${svgHtml}${steps.length ? `<details class="st-mermaid-raw"><summary class="st-muted-xs">展开关系明细与 Mermaid 源码</summary>${stepsHtml}${codeHtml}</details>` : codeHtml}</div>`;
}

export function renderMarkdownToHtml(markdown, { idPrefix = 'sec', stripNavLine = false, heroMeta = null } = {}) {
  const { body: bodyWithoutFm } = stripYamlFrontmatter(markdown);
  const lines = bodyWithoutFm.split('\n');
  const headings = [];
  const blocks = [];
  let i = 0;
  let seq = 0;
  let title = '';

  const CALLOUT_LABELS = {
    NOTE: ['note', '💡 备注说明'],
    TIP: ['tip', '✨ 实用建议'],
    IMPORTANT: ['important', '📌 核心要求'],
    WARNING: ['warning', '⚠️ 边界预警'],
    CAUTION: ['caution', '🚨 风险红线'],
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith('# ')) {
      if (!title) title = trimmed.slice(2).trim();
      i++;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push('<hr class="st-prose-hr" />');
      i++;
      continue;
    }
    if (stripNavLine && (/^\[阅读目录\]/.test(trimmed) || /^故事编号\s+LC-\d+$/i.test(trimmed))) {
      i++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim().split(/\s+/)[0].toLowerCase();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push(lang === 'mermaid'
        ? renderMermaidOffline(codeLines)
        : `<pre class="st-code-block"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${codeLines.map(escapeHtml).join('\n')}</code></pre>`);
      continue;
    }
    if (/^<details(?:\s+open)?>$/i.test(trimmed)) {
      const inner = [];
      let sumText = '展开详细内容';
      i++;
      if (i < lines.length) {
        const sm = /^<summary>([\s\S]*?)<\/summary>$/i.exec(lines[i].trim());
        if (sm) { sumText = sm[1].trim(); i++; }
      }
      while (i < lines.length && !/^<\/details>$/i.test(lines[i].trim())) {
        inner.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const sub = renderMarkdownToHtml(inner.join('\n'), { idPrefix: `${idPrefix}-d${++seq}` });
      blocks.push(`<details class="st-details-box"><summary>${escapeHtml(sumText)}</summary><div class="st-details-body">${sub.html}</div></details>`);
      continue;
    }
    const hMatch = /^(#{2,4})\s+(.+?)(?:\s*\{#([A-Za-z0-9_-]+)\})?$/.exec(trimmed);
    if (hMatch) {
      seq++;
      const level = hMatch[1].length;
      const rawTitle = hMatch[2].trim();
      const plain = rawTitle.replace(/[*`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
      const id = hMatch[3] || `${idPrefix}-${seq}`;
      headings.push({ id, level, title: plain });
      const hCls = level === 2 ? 'st-prose-heading st-prose-h2' : 'st-prose-heading st-prose-h3';
      blocks.push(`<h${level} id="${escapeHtml(id)}" class="${hCls}">${renderInlineMarkdown(rawTitle)}<button type="button" class="st-heading-anchor" data-anchor-id="${escapeHtml(id)}">#章节批注</button></h${level}>`);
      i++;
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|\s*[-:]+/.test(lines[i + 1].trim())) {
      const cellsOf = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = cellsOf(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cellsOf(lines[i])); i++; }
      blocks.push(`<div class="st-table-wrap"><table class="st-prose-table"><thead><tr>${headers.map(c => `<th>${renderInlineMarkdown(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${renderInlineMarkdown(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) { q.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      const firstLine = q[0] || '';
      const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(firstLine);
      if (alertMatch) {
        const [kindCls, badgeLabel] = CALLOUT_LABELS[alertMatch[1].toUpperCase()] || ['note', '💡 提示'];
        const rest = [alertMatch[2], ...q.slice(1)].filter(Boolean).join(' ');
        blocks.push(`<div class="st-callout st-callout-${kindCls}"><div class="st-callout-title">${badgeLabel}</div><div class="st-callout-body"><p>${renderInlineMarkdown(rest || '说明')}</p></div></div>`);
      } else {
        blocks.push(`<blockquote class="st-callout st-callout-quote"><p>${renderInlineMarkdown(q.join(' '))}</p></blockquote>`);
      }
      continue;
    }
    const isListContinuationStop = ln => {
      const lt = ln.trim();
      return !lt
        || /^#{1,6}\s/.test(lt)
        || /^```/.test(lt)
        || /^(?:-{3,}|\*{3,}|_{3,})$/.test(lt)
        || /^>/.test(lt)
        || /^\|/.test(lt)
        || /^<\/?(?:details|summary)\b/i.test(lt)
        || /^[-*+]\s+/.test(lt)
        || /^\d+\.\s+/.test(lt);
    };
    const joinSoftLines = parts => {
      let acc = '';
      for (const seg of parts) {
        const s = seg.trim();
        if (!s) continue;
        if (!acc) { acc = s; continue; }
        const cjkEnd = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]$/.test(acc);
        const cjkStart = /^[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(s);
        acc += (cjkEnd && cjkStart) ? s : ` ${s}`;
      }
      return acc;
    };
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const parts = [lines[i].trim().replace(/^[-*+]\s+/, '')];
        i++;
        while (i < lines.length && !isListContinuationStop(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        const lineBody = joinSoftLines(parts);
        const kvMatch = /^\*\*([^*：:]{1,28})\*\*\s*[：:]\s*(.+)$/.exec(lineBody);
        if (kvMatch) {
          items.push(`<li class="st-kv-item"><span class="st-kv-key">${escapeHtml(kvMatch[1].trim())}</span><span class="st-kv-val">${renderInlineMarkdown(kvMatch[2].trim())}</span></li>`);
        } else {
          items.push(`<li>${renderInlineMarkdown(lineBody)}</li>`);
        }
      }
      blocks.push(`<ul class="st-prose-list">${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const parts = [lines[i].trim().replace(/^\d+\.\s+/, '')];
        i++;
        while (i < lines.length && !isListContinuationStop(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        items.push(`<li>${renderInlineMarkdown(joinSoftLines(parts))}</li>`);
      }
      blocks.push(`<ol class="st-prose-list">${items.join('')}</ol>`);
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(?:#|```|>|\||[-*+]\s+|\d+\.\s+)/.test(lines[i].trim())) {
      p.push(lines[i].trim());
      i++;
    }
    const paraText = p.join(' ');
    const hasExplicitFmSummary = Boolean(
      heroMeta?.frontmatter && typeof heroMeta.frontmatter === 'object'
      && (heroMeta.frontmatter.summary || heroMeta.frontmatter.description || heroMeta.frontmatter.purpose),
    );
    const hasMoreLinesAfter = lines.slice(i).some(l => {
      const lt = l.trim();
      return lt && !lt.startsWith('# ');
    });
    const isHeroDuplicateLead = Boolean(
      heroMeta?.summary
      && !hasExplicitFmSummary
      && blocks.length === 0
      && hasMoreLinesAfter
      && cleanInlinePlain(paraText) === cleanInlinePlain(heroMeta.summary),
    );
    if (isHeroDuplicateLead) continue;
    if (/^(?:\*\*)?(?:作为|作为一名)[^。]{2,}(?:我希望|我想|需要)[^。]+/.test(paraText)) {
      blocks.push(`<div class="st-story-card"><span class="st-story-pill">👤 用户故事诉求</span><p>${renderInlineMarkdown(paraText)}</p></div>`);
    } else if (/^(?:\*\*)?(?:前提条件|触发动作|预期结果|验收标准|场景[一二三四五六七八九十0-9]+)[：:\s\*]/.test(paraText)) {
      blocks.push(`<div class="st-scenario-step"><p>${renderInlineMarkdown(paraText)}</p></div>`);
    } else {
      blocks.push(`<p>${renderInlineMarkdown(paraText)}</p>`);
    }
  }
  const heroHtml = heroMeta
    ? renderDocHeroHtml({
      title: heroMeta.title || title,
      summary: heroMeta.summary,
      code: heroMeta.code,
      typeLabel: heroMeta.typeLabel,
      path: heroMeta.path,
      status: heroMeta.status,
      frontmatter: heroMeta.frontmatter,
    })
    : '';
  return { title, headings, html: heroHtml + blocks.join('\n') };
}
