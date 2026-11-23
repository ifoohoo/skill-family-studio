// @feature STU002
// @feature STU005

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(doc, tag, attrs = {}, text = null) {
  const n = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    n.setAttribute(k, String(v));
  }
  if (text !== null && text !== undefined) n.textContent = String(text);
  return n;
}

function addArrowMarker(doc, defs, id, color) {
  const marker = svgNode(doc, 'marker', {
    id,
    viewBox: '0 0 10 10',
    refX: '8.5',
    refY: '5',
    markerWidth: '6.5',
    markerHeight: '6.5',
    orient: 'auto-start-reverse',
  });
  marker.append(svgNode(doc, 'path', { d: 'M 0 1.2 L 10 5 L 0 8.8 z', fill: color }));
  defs.append(marker);
}

export function buildReviewStatusFlowSvg(doc = document) {
  const svg = svgNode(doc, 'svg', {
    viewBox: '0 0 920 265',
    class: 'st-guide-svg',
    role: 'img',
    'aria-label': '审阅状态四态自动与手动流转图',
  });
  const defs = svgNode(doc, 'defs');
  addArrowMarker(doc, defs, 'st-flow-arrow-indigo', 'var(--st-indigo-fg)');
  addArrowMarker(doc, defs, 'st-flow-arrow-emerald', 'var(--st-emerald-fg)');
  addArrowMarker(doc, defs, 'st-flow-arrow-amber', 'var(--st-amber-fg)');
  addArrowMarker(doc, defs, 'st-flow-arrow-purple', 'var(--st-purple-fg)');
  addArrowMarker(doc, defs, 'st-flow-arrow-zinc', 'var(--st-zinc-fg)');
  svg.append(defs);

  const drawBox = ({ x, y, w, h, title, sub, fill, stroke, fg }) => {
    const g = svgNode(doc, 'g');
    g.append(
      svgNode(doc, 'rect', { x, y, width: w, height: h, rx: 12, fill, stroke, 'stroke-width': 2 }),
      svgNode(doc, 'text', { x: x + w / 2, y: y + 29, 'text-anchor': 'middle', fill: fg, 'font-size': 15, 'font-weight': 700 }, title),
      svgNode(doc, 'text', { x: x + w / 2, y: y + 51, 'text-anchor': 'middle', fill: 'var(--st-fg-sec)', 'font-size': 11.5 }, sub),
    );
    svg.append(g);
  };

  drawBox({
    x: 34, y: 84, w: 190, h: 72,
    title: '⚪ 待审阅 (pending)', sub: '初始队列 · 无未解决批注',
    fill: 'var(--st-zinc-bg)', stroke: 'var(--st-zinc-bd)', fg: 'var(--st-zinc-fg)',
  });
  drawBox({
    x: 342, y: 84, w: 206, h: 72,
    title: '🔵 审阅中 (reviewing)', sub: '含未解决批注（自动感知）',
    fill: 'var(--st-indigo-bg)', stroke: 'var(--st-indigo-bd)', fg: 'var(--st-indigo-fg)',
  });
  drawBox({
    x: 682, y: 18, w: 208, h: 66,
    title: '🟢 已通过 (approved)', sub: '确认合格并签收（跳过待审）',
    fill: 'var(--st-emerald-bg)', stroke: 'var(--st-emerald-bd)', fg: 'var(--st-emerald-fg)',
  });
  drawBox({
    x: 682, y: 98, w: 208, h: 66,
    title: '🟠 需修改 (changes)', sub: '退回作者按批注返工整改',
    fill: 'var(--st-amber-bg)', stroke: 'var(--st-amber-bd)', fg: 'var(--st-amber-fg)',
  });
  drawBox({
    x: 682, y: 178, w: 208, h: 66,
    title: '🟣 暂缓 (deferred)', sub: '留待后续波次处理',
    fill: 'var(--st-purple-bg)', stroke: 'var(--st-purple-bd)', fg: 'var(--st-purple-fg)',
  });

  // pending <-> reviewing 自动感知双向弧线
  svg.append(
    svgNode(doc, 'path', {
      d: 'M 224 104 C 266 64, 300 64, 342 104',
      fill: 'none', stroke: 'var(--st-indigo-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-flow-arrow-indigo)',
    }),
    svgNode(doc, 'text', { x: 283, y: 66, 'text-anchor': 'middle', fill: 'var(--st-indigo-fg)', 'font-size': 11.5, 'font-weight': 600 }, '+1 条未解决批注'),
    svgNode(doc, 'path', {
      d: 'M 342 138 C 300 178, 266 178, 224 138',
      fill: 'none', stroke: 'var(--st-zinc-fg)', 'stroke-width': 2, 'stroke-dasharray': '5 3', 'marker-end': 'url(#st-flow-arrow-zinc)',
    }),
    svgNode(doc, 'text', { x: 283, y: 186, 'text-anchor': 'middle', fill: 'var(--st-fg-muted)', 'font-size': 11.5 }, '批注清零 / 全解决'),
  );

  // reviewing / pending -> 三个终态
  svg.append(
    svgNode(doc, 'path', {
      d: 'M 548 102 C 600 102, 622 50, 682 50',
      fill: 'none', stroke: 'var(--st-emerald-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-flow-arrow-emerald)',
    }),
    svgNode(doc, 'text', { x: 612, y: 54, 'text-anchor': 'middle', fill: 'var(--st-emerald-fg)', 'font-size': 11.5, 'font-weight': 600 }, '点「已通过」'),
    svgNode(doc, 'path', {
      d: 'M 548 122 L 682 130',
      fill: 'none', stroke: 'var(--st-amber-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-flow-arrow-amber)',
    }),
    svgNode(doc, 'text', { x: 614, y: 118, 'text-anchor': 'middle', fill: 'var(--st-amber-fg)', 'font-size': 11.5, 'font-weight': 600 }, '点「需修改」'),
    svgNode(doc, 'path', {
      d: 'M 548 142 C 600 156, 622 212, 682 212',
      fill: 'none', stroke: 'var(--st-purple-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-flow-arrow-purple)',
    }),
    svgNode(doc, 'text', { x: 612, y: 204, 'text-anchor': 'middle', fill: 'var(--st-purple-fg)', 'font-size': 11.5, 'font-weight': 600 }, '点「暂缓」'),
    svgNode(doc, 'path', {
      d: 'M 129 84 C 129 14, 595 14, 682 32',
      fill: 'none', stroke: 'var(--st-emerald-fg)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', 'marker-end': 'url(#st-flow-arrow-emerald)',
    }),
    svgNode(doc, 'text', { x: 400, y: 26, 'text-anchor': 'middle', fill: 'var(--st-fg-muted)', 'font-size': 11 }, '亦可直接签收通过（无批注快速过稿）'),
  );

  return svg;
}

export function buildTriLayerLockSvg(doc = document) {
  const svg = svgNode(doc, 'svg', {
    viewBox: '0 0 920 270',
    class: 'st-guide-svg',
    role: 'img',
    'aria-label': '高阶规划、详细设计与代码测试锁三层双向互锁图',
  });
  const defs = svgNode(doc, 'defs');
  addArrowMarker(doc, defs, 'st-tri-indigo', 'var(--st-indigo-fg)');
  addArrowMarker(doc, defs, 'st-tri-emerald', 'var(--st-emerald-fg)');
  addArrowMarker(doc, defs, 'st-tri-amber', 'var(--st-amber-fg)');
  svg.append(defs);

  const drawTier = ({ x, y, w, h, tag, title, file, sub, fill, stroke, fg }) => {
    const g = svgNode(doc, 'g');
    g.append(
      svgNode(doc, 'rect', { x, y, width: w, height: h, rx: 12, fill, stroke, 'stroke-width': 2 }),
      svgNode(doc, 'text', { x: x + 16, y: y + 24, fill: fg, 'font-size': 11.5, 'font-weight': 700 }, tag),
      svgNode(doc, 'text', { x: x + 16, y: y + 48, fill: 'var(--st-fg)', 'font-size': 15.5, 'font-weight': 700 }, title),
      svgNode(doc, 'text', { x: x + 16, y: y + 72, fill: fg, 'font-size': 12, 'font-family': 'ui-monospace, Menlo, monospace' }, file),
      svgNode(doc, 'text', { x: x + 16, y: y + 96, fill: 'var(--st-fg-sec)', 'font-size': 11.5 }, sub),
    );
    svg.append(g);
  };

  drawTier({
    x: 24, y: 34, w: 248, h: 120,
    tag: '第 1 层 · 全局拆分与处置',
    title: '高阶规划仓',
    file: 'portfolio-allocations.json',
    sub: '登记拆分去向 · sourceDigest',
    fill: 'var(--st-amber-bg)', stroke: 'var(--st-amber-bd)', fg: 'var(--st-amber-fg)',
  });
  drawTier({
    x: 336, y: 34, w: 248, h: 120,
    tag: '第 2 层 · 子项目落地设计',
    title: '子仓详细设计',
    file: 'upstream-bindings.json',
    sub: '回指上游摘要 · REQ / STU / S',
    fill: 'var(--st-indigo-bg)', stroke: 'var(--st-indigo-bd)', fg: 'var(--st-indigo-fg)',
  });
  drawTier({
    x: 648, y: 34, w: 248, h: 120,
    tag: '第 3 层 · 源码与验证证据',
    title: '真实源码与测试',
    file: 'traceability-version-lock.json',
    sub: 'implements + verifies 双锁齐备',
    fill: 'var(--st-emerald-bg)', stroke: 'var(--st-emerald-bd)', fg: 'var(--st-emerald-fg)',
  });

  // Layer 1 <-> Layer 2 双向校验箭头
  svg.append(
    svgNode(doc, 'path', {
      d: 'M 272 72 L 336 72',
      fill: 'none', stroke: 'var(--st-amber-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-tri-amber)',
    }),
    svgNode(doc, 'text', { x: 304, y: 61, 'text-anchor': 'middle', fill: 'var(--st-amber-fg)', 'font-size': 11, 'font-weight': 600 }, '拆派核对'),
    svgNode(doc, 'path', {
      d: 'M 336 116 L 272 116',
      fill: 'none', stroke: 'var(--st-indigo-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-tri-indigo)',
    }),
    svgNode(doc, 'text', { x: 304, y: 134, 'text-anchor': 'middle', fill: 'var(--st-indigo-fg)', 'font-size': 11, 'font-weight': 600 }, '回指互认'),
  );

  // Layer 2 <-> Layer 3 双向校验箭头
  svg.append(
    svgNode(doc, 'path', {
      d: 'M 584 72 L 648 72',
      fill: 'none', stroke: 'var(--st-indigo-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-tri-indigo)',
    }),
    svgNode(doc, 'text', { x: 616, y: 61, 'text-anchor': 'middle', fill: 'var(--st-indigo-fg)', 'font-size': 11, 'font-weight': 600 }, '入口认领'),
    svgNode(doc, 'path', {
      d: 'M 648 116 L 584 116',
      fill: 'none', stroke: 'var(--st-emerald-fg)', 'stroke-width': 2.2, 'marker-end': 'url(#st-tri-emerald)',
    }),
    svgNode(doc, 'text', { x: 616, y: 134, 'text-anchor': 'middle', fill: 'var(--st-emerald-fg)', 'font-size': 11, 'font-weight': 600 }, '双锁新鲜'),
  );

  // 底部严格判定汇总条
  svg.append(
    svgNode(doc, 'rect', {
      x: 24, y: 184, width: 872, height: 64, rx: 10,
      fill: 'var(--st-subtle)', stroke: 'var(--st-border-strong)', 'stroke-width': 1.4,
    }),
    svgNode(doc, 'text', { x: 460, y: 209, 'text-anchor': 'middle', fill: 'var(--st-fg)', 'font-size': 13, 'font-weight': 700 },
      '🟢 只有三层同时满足「目标文件存在 + 上下游摘要双向无漂移 + 同时具备新鲜的 implements 与 verifies 锁」，才机械派生为「已验证满足」'),
    svgNode(doc, 'text', { x: 460, y: 232, 'text-anchor': 'middle', fill: 'var(--st-fg-muted)', 'font-size': 11.5 },
      '高阶改动 → UPSTREAM_DESIGN_CHANGED · 详设演进 → DOWNSTREAM_DESIGN_EVOLVED · 漏加 @feature 注解 → UNCLAIMED_IMPLEMENTATION_ENTRY'),
  );

  return svg;
}
