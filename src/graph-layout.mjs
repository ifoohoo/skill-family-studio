export const DEFAULT_LAYERS = Object.freeze([
  { id: 'requirements', order: 0, label: '需求与规格' },
  { id: 'product', order: 1, label: '产品与故事' },
  { id: 'domain', order: 2, label: '领域与决策' },
  { id: 'architecture', order: 3, label: '架构与契约' },
  { id: 'scenarios', order: 4, label: '场景剧本' },
  { id: 'verification', order: 5, label: '测试与验证' },
]);

export function computeEdgePath(src, dst) {
  if (!src || !dst) return '';
  const sameRow = Math.abs(src.y - dst.y) < 12;
  if (sameRow) {
    const x1 = src.x + src.w / 2;
    const y1 = src.y;
    const x2 = dst.x + dst.w / 2;
    const y2 = dst.y;
    const arc = Math.min(64, Math.max(26, Math.abs(x2 - x1) * 0.16));
    return `M ${x1} ${y1} C ${x1} ${y1 - arc}, ${x2} ${y2 - arc}, ${x2} ${y2}`;
  }
  const downward = dst.y >= src.y;
  const x1 = src.x + src.w / 2;
  const y1 = downward ? src.y + src.h : src.y;
  const x2 = dst.x + dst.w / 2;
  const y2 = downward ? dst.y : dst.y + dst.h;
  const dy = Math.max(28, Math.abs(y2 - y1) * 0.45);
  return `M ${x1} ${y1} C ${x1} ${y1 + (downward ? dy : -dy)}, ${x2} ${y2 + (downward ? -dy : dy)}, ${x2} ${y2}`;
}

/**
 * 响应式宽屏自适应 + 同层多行自动折行（Wrap Grid）DAG 布局引擎。
 * 保证在 1920px、2560px（2K）与 3440px（21:9 带鱼屏）自动铺满容器宽度：
 * 多节点层自动折成多行网格并均匀铺满横向视口，少节点层适度放宽卡片并居中排布（避免孤岛撕裂），
 * 同时确保有效字号始终不低于可读阈值（>= 11px）。
 */
export function computeAdaptiveGraphLayout(
  snapshot,
  {
    containerWidth = 1600,
    fitWidth = true,
    wrapGrid = true,
    scopeMode = 'design',
    focusMode = 'all',
    selectedUid = null,
    baseFontPx = 12.5,
    minReadableFontPx = 11,
  } = {},
) {
  const allNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const allEdges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
  const layerDefs = Array.isArray(snapshot?.layers) && snapshot.layers.length ? snapshot.layers : DEFAULT_LAYERS;

  const hasDesign = allNodes.some(n => n.isDesignNode !== false);
  const baseNodes = scopeMode === 'design' && hasDesign
    ? allNodes.filter(n => n.isDesignNode !== false || n.uid === selectedUid)
    : allNodes;

  const baseSet = new Set(baseNodes.map(n => n.uid));
  let activeSet = baseSet;
  if (focusMode === 'subgraph' && selectedUid && baseSet.has(selectedUid)) {
    const sub = new Set([selectedUid]);
    for (let hop = 0; hop < 2; hop += 1) {
      const frontier = [...sub];
      for (const e of allEdges) {
        if (frontier.includes(e.from) && baseSet.has(e.to)) sub.add(e.to);
        if (frontier.includes(e.to) && baseSet.has(e.from)) sub.add(e.from);
      }
    }
    activeSet = sub;
  }

  const buckets = new Map(layerDefs.map(l => [l.id, { ...l, nodes: [] }]));
  for (const nd of baseNodes) {
    if (!activeSet.has(nd.uid)) continue;
    const key = buckets.has(nd.layer) ? nd.layer : layerDefs[0].id;
    buckets.get(key).nodes.push(nd);
  }
  const activeLayers = [...buckets.values()]
    .filter(b => b.nodes.length > 0)
    .sort((a, b) => a.order - b.order);

  const safeContainerW = Math.max(640, Math.round(Number(containerWidth) || 1600));
  const padX = 24;
  const padY = 20;
  const bandPadX = 16;
  const bandHeadH = 36;
  const bandPadBottom = 16;
  const bandGapY = 26;
  const isUltrawide = safeContainerW >= 3000;
  const is2K = safeContainerW >= 2200;
  const minCardW = isUltrawide ? 260 : (is2K ? 240 : 204);
  const maxCardW = isUltrawide ? 460 : (is2K ? 420 : 360);
  const cardH = 62;
  const gapX = is2K ? 18 : 16;
  const gapY = 14;

  const innerAvailW = Math.max(minCardW, safeContainerW - padX * 2 - bandPadX * 2);
  const maxColsPerRow = wrapGrid
    ? Math.max(1, Math.floor((innerAvailW + gapX) / (minCardW + gapX)))
    : Math.max(1, ...activeLayers.map(l => l.nodes.length));

  const bands = [];
  const positionedNodes = [];
  const posByUid = new Map();
  let cursorY = padY;
  let naturalMaxW = safeContainerW;
  let wrappedLayerCount = 0;

  for (const layer of activeLayers) {
    const sorted = [...layer.nodes].sort((a, b) => {
      if (a.uid === selectedUid) return -1;
      if (b.uid === selectedUid) return 1;
      const degDiff = ((b.inDegree ?? 0) + (b.outDegree ?? 0)) - ((a.inDegree ?? 0) + (a.outDegree ?? 0));
      if (degDiff !== 0) return degDiff;
      return String(a.code ?? a.uid).localeCompare(String(b.code ?? b.uid), 'zh-CN', { numeric: true });
    });

    const cols = wrapGrid ? Math.min(sorted.length, maxColsPerRow) : sorted.length;
    const rows = Math.max(1, Math.ceil(sorted.length / cols));
    if (rows > 1) wrappedLayerCount += 1;

    let cardW = minCardW;
    let startX = padX + bandPadX;
    let stepX = minCardW + gapX;

    if (wrapGrid && fitWidth) {
      cardW = Math.max(minCardW, Math.min(maxCardW, Math.floor((innerAvailW - (cols - 1) * gapX) / cols)));
      const occupiedW = cols * cardW + (cols - 1) * gapX;
      const leftover = Math.max(0, innerAvailW - occupiedW);
      if (cols === 1) {
        startX = padX + bandPadX + Math.round(leftover / 2);
        stepX = cardW + gapX;
      } else {
        const maxComfortableGap = 56;
        const rawExtra = Math.floor(leftover / (cols - 1));
        const extraGap = sorted.length >= maxColsPerRow
          ? rawExtra
          : Math.min(maxComfortableGap - gapX, rawExtra);
        stepX = cardW + gapX + Math.max(0, extraGap);
        const totalSpan = cardW + (cols - 1) * stepX;
        startX = padX + bandPadX + Math.max(0, Math.round((innerAvailW - totalSpan) / 2));
      }
    } else if (!wrapGrid) {
      const rowNeedW = padX * 2 + bandPadX * 2 + cols * minCardW + Math.max(0, cols - 1) * gapX;
      naturalMaxW = Math.max(naturalMaxW, rowNeedW);
      if (fitWidth && rowNeedW <= safeContainerW) {
        cardW = Math.max(minCardW, Math.min(maxCardW, Math.floor((innerAvailW - Math.max(0, cols - 1) * gapX) / Math.max(1, cols))));
        stepX = cardW + gapX;
      }
    }

    sorted.forEach((nd, idx) => {
      const rowIndex = Math.floor(idx / cols);
      const colIndex = idx % cols;
      const x = startX + colIndex * stepX;
      const y = cursorY + bandHeadH + rowIndex * (cardH + gapY);
      const item = { ...nd, x, y, w: cardW, h: cardH, rowIndex, colIndex };
      positionedNodes.push(item);
      posByUid.set(nd.uid, item);
    });

    const bandH = bandHeadH + rows * cardH + Math.max(0, rows - 1) * gapY + bandPadBottom;
    const bandW = (wrapGrid ? safeContainerW : Math.max(safeContainerW, naturalMaxW)) - padX * 2;
    bands.push({
      id: layer.id,
      label: layer.label,
      total: sorted.length,
      cols,
      rows,
      x: padX,
      y: cursorY,
      w: bandW,
      h: bandH,
    });
    cursorY += bandH + bandGapY;
  }

  const viewBoxWidth = wrapGrid ? safeContainerW : naturalMaxW;
  const viewBoxHeight = Math.max(240, cursorY - (bands.length ? bandGapY : 0) + padY);
  let renderWidth = viewBoxWidth;
  let effectiveFontPx = baseFontPx;
  let autoWrapRecommended = false;

  if (!wrapGrid && fitWidth && viewBoxWidth > safeContainerW) {
    const candidateScale = safeContainerW / viewBoxWidth;
    if (baseFontPx * candidateScale >= minReadableFontPx) {
      renderWidth = safeContainerW;
      effectiveFontPx = Number((baseFontPx * candidateScale).toFixed(2));
    } else {
      const minScale = minReadableFontPx / baseFontPx;
      renderWidth = Math.ceil(viewBoxWidth * minScale);
      effectiveFontPx = minReadableFontPx;
      autoWrapRecommended = true;
    }
  } else if (fitWidth) {
    renderWidth = safeContainerW;
  }

  const edges = allEdges
    .map(e => {
      const src = posByUid.get(e.from);
      const dst = posByUid.get(e.to);
      if (!src || !dst || src.uid === dst.uid) return null;
      return { ...e, src, dst, path: computeEdgePath(src, dst) };
    })
    .filter(Boolean);

  return {
    width: viewBoxWidth,
    height: viewBoxHeight,
    renderWidth,
    containerWidth: safeContainerW,
    fitWidth,
    wrapGrid,
    maxColsPerRow,
    wrappedLayerCount,
    effectiveFontPx,
    minReadableFontPx,
    hasHorizontalOverflow: renderWidth > safeContainerW,
    autoWrapRecommended,
    bands,
    columns: bands,
    nodes: positionedNodes,
    edges,
  };
}

export function pickDefaultArtifactNode(nodes = []) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const INACTIVE_RE = /^(?:deprecated|superseded|abandoned|rejected|archived|retired|history|obsolete|done)$/i;
  const ACTIVE_RE = /^(?:active|accepted|approved|current|implemented|verified|released|captured|open)$/i;
  const TYPE_TIER = {
    prd: 100,
    requirement: 96,
    spec: 90,
    user_story: 84,
    story: 84,
    lifecycle: 82,
    feature: 80,
    domain_model: 74,
    design: 70,
    decision: 64,
    scenario: 58,
  };
  const designPool = nodes.filter(n => n.isDesignNode !== false);
  const pool = designPool.length > 0 ? designPool : nodes;
  const score = nd => {
    const s = String(nd.status ?? '').trim();
    const stScore = INACTIVE_RE.test(s) ? -200 : (ACTIVE_RE.test(s) ? 30 : 10);
    const tier = TYPE_TIER[nd.type] ?? (nd.isDesignNode !== false ? 50 : 10);
    const rootBonus = /^(?:[A-Z]+-)?(?:PRD|REQ|R|OVERVIEW|MAIN)[-_]?0*1$/i.test(String(nd.code ?? ''))
      || /总纲|总体|全景|架构|overview/i.test(String(nd.title ?? '')) ? 8 : 0;
    return stScore + tier + rootBonus;
  };
  return [...pool].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return ((b.inDegree ?? 0) + (b.outDegree ?? 0)) - ((a.inDegree ?? 0) + (a.outDegree ?? 0));
  })[0] ?? null;
}
