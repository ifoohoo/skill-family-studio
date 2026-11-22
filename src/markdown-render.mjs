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

function renderInlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code class="st-inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
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
  return out;
}

function renderMermaidOffline(rawLines) {
  const cleanLines = rawLines.map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
  const first = cleanLines[0] || '';
  const kindLabel = /^(?:flowchart|graph)\b/i.test(first) ? '流程图'
    : /^sequenceDiagram\b/i.test(first) ? '时序图'
      : /^stateDiagram(?:-v2)?\b/i.test(first) ? '状态图'
        : /^classDiagram\b/i.test(first) ? '类图'
          : /^erDiagram\b/i.test(first) ? '实体关系图' : '结构图';

  const nodeLabels = new Map();
  const regNode = token => {
    const t = String(token ?? '').trim();
    if (!t) return '';
    if (t === '[*]') return '起点/终点';
    const m = /^([A-Za-z0-9_.-]+)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\)|\(([^)]+)\)|\{([^}]+)\})?$/.exec(t);
    if (!m) return t.replace(/^["']|["']$/g, '');
    const id = m[1];
    const lbl = (m[2] || m[3] || m[4] || m[5] || m[6] || '').trim().replace(/^["']|["']$/g, '');
    if (lbl) nodeLabels.set(id, lbl);
    return nodeLabels.get(id) || id;
  };

  const steps = [];
  for (const line of cleanLines.slice(1)) {
    if (/^(?:subgraph|end|direction|style|classDef|class|click)\b/i.test(line)) continue;
    const seq = /^([^\s:-]+)\s*(?:-+>>?|--+>>?|\.+>>?|-+\))\s*([^\s:]+)\s*:\s*(.+)$/.exec(line);
    if (seq) { steps.push({ from: regNode(seq[1]), to: regNode(seq[2]), rel: seq[3].trim() }); continue; }
    const pipe = /^(.+?)\s*(?:--+>|==+>|\.-+>)\s*\|([^|]+)\|\s*(.+)$/.exec(line);
    if (pipe) { steps.push({ from: regNode(pipe[1]), to: regNode(pipe[3]), rel: pipe[2].trim() }); continue; }
    const plain = /^(.+?)\s*(?:--+>|==+>|\.-+>)\s*(.+?)(?:\s*:\s*(.+))?$/.exec(line);
    if (plain) { steps.push({ from: regNode(plain[1]), to: regNode(plain[2]), rel: (plain[3] || '').trim() }); continue; }
    regNode(line);
  }

  const stepsHtml = steps.length
    ? `<ol class="st-mermaid-steps">${steps.slice(0, 40).map(s => `<li><span class="st-chip">${escapeHtml(s.from)}</span><span class="st-mermaid-rel">${escapeHtml(s.rel || '→')}</span><span class="st-chip">${escapeHtml(s.to)}</span></li>`).join('')}</ol>`
    : '';
  const codeHtml = `<pre class="st-code-block" data-lang="mermaid"><code>${rawLines.map(escapeHtml).join('\n')}</code></pre>`;
  return `<div class="st-mermaid-card"><div class="st-mermaid-head"><span class="st-badge st-badge-indigo">Mermaid ${escapeHtml(kindLabel)}（离线结构化解析）</span><span class="st-muted-xs">${steps.length ? `共 ${steps.length} 条流转边` : '源码预览'}</span></div>${stepsHtml}${steps.length ? `<details class="st-mermaid-raw"><summary class="st-muted-xs">展开 Mermaid 源码</summary>${codeHtml}</details>` : codeHtml}</div>`;
}

export function renderMarkdownToHtml(markdown, { idPrefix = 'sec', stripNavLine = false } = {}) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  const blocks = [];
  let i = 0;
  let seq = 0;
  let title = '';

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith('# ')) {
      if (!title) title = trimmed.slice(2).trim();
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
    const hMatch = /^(#{2,4})\s+(.+?)(?:\s*\{#([A-Za-z0-9_-]+)\})?$/.exec(trimmed);
    if (hMatch) {
      seq++;
      const level = hMatch[1].length;
      const rawTitle = hMatch[2].trim();
      const plain = rawTitle.replace(/[*`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
      const id = hMatch[3] || `${idPrefix}-${seq}`;
      headings.push({ id, level, title: plain });
      blocks.push(`<h${level} id="${escapeHtml(id)}" class="st-prose-heading">${renderInlineMarkdown(rawTitle)}<button type="button" class="st-heading-anchor" data-anchor-id="${escapeHtml(id)}">#章节批注</button></h${level}>`);
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
      blocks.push(`<blockquote><p>${renderInlineMarkdown(q.join(' '))}</p></blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(`<li>${renderInlineMarkdown(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`); i++; }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { items.push(`<li>${renderInlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`); i++; }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(?:#|```|>|\||[-*]\s+|\d+\.\s+)/.test(lines[i].trim())) {
      p.push(lines[i].trim());
      i++;
    }
    blocks.push(`<p>${renderInlineMarkdown(p.join(' '))}</p>`);
  }
  return { title, headings, html: blocks.join('\n') };
}
