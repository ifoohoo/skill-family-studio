// @feature STU004
// @feature STU005

/**
 * Studio 多会话编排蓝图画布与契约受限编辑器（Wave 4D-3 / M2-1）：
 * 1. 全程采用标准 DOM createElement / textContent 构建（零 innerHTML）；
 * 2. 下拉选择框严格锁定 skill-family-contracts@0.39.2 OrchestrationBlueprint 枚举集，消除手工拼写摩擦；
 * 3. 内置起步蓝图模板（分诊-校验-异构独立复核-HITL 门禁 / 只读合规扫描-单向结论）；
 * 4. 实时执行图连通性、独立复核防自审与外部副作用 HITL 门禁支配检查，并同步计算规范化 JSON SHA-256 摘要（blueprintRef）。
 */

export const BLUEPRINT_ENUMS = Object.freeze({
  executor: Object.freeze(['llm_session', 'deterministic_script', 'mcp_tool', 'human_task']),
  role: Object.freeze(['coordinator', 'worker', 'reviewer', 'approver']),
  decisionAuthority: Object.freeze(['none', 'recommend', 'final_veto']),
  modelTier: Object.freeze([
    'flagship_reasoning',
    'balanced_coding',
    'fast_lightweight',
    'deterministic_no_llm',
  ]),
  sideEffectCeiling: Object.freeze(['read_only', 'workspace_write', 'external_side_effect']),
  workspaceMode: Object.freeze(['inherit', 'share', 'branch', 'fresh_readonly']),
  mergeBack: Object.freeze(['none', 'coordinator_merge', 'patch_submission']),
  contextMode: Object.freeze(['fresh', 'forked', 'summary_handoff']),
  toolKind: Object.freeze(['script', 'mcp', 'host_builtin']),
  exitMeaning: Object.freeze(['success', 'retryable', 'fatal', 'needs_input']),
  edgeKind: Object.freeze([
    'delegate_spawn',
    'sequential_handoff',
    'review_submission',
    'rework_feedback',
  ]),
  handoffContract: Object.freeze([
    'task-handoff-envelope',
    'continuation-package',
    'professional-conclusion',
    'artifact_bundle',
  ]),
  hitlPlacement: Object.freeze(['before_node', 'after_node', 'on_edge']),
  hitlTimeout: Object.freeze(['block_and_wait', 'abort_run']),
});

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function computeSha256HexSync(text) {
  const bytes = new TextEncoder().encode(String(text));
  const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000);
  const bitLenLo = (bytes.length * 8) >>> 0;
  const padLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, bitLenHi, false);
  dv.setUint32(padLen - 4, bitLenLo, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      W[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  return Array.from(H)
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

function canonicalJson(val) {
  if (val === undefined) {
    throw new TypeError('OrchestrationBlueprint cannot serialize undefined values');
  }
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(val[k])}`).join(',')}}`;
}

export function computeBlueprintDigestSync(blueprint) {
  return computeSha256HexSync(canonicalJson(blueprint));
}

export const CANVAS_STARTER_PRESETS = Object.freeze({
  'triage-validate-review-hitl': () => ({
    schemaVersion: 1,
    kind: 'skill-family.orchestration-blueprint',
    blueprintId: 'bp-domain-triage-validate-review-v1',
    skillFamilyId: 'example-domain-family',
    version: '0.1.0',
    title: '分诊路由、受限工作区校验、异构独立复核与 HITL 门禁蓝图',
    summary: '只读分诊协调器委派受限写集执行节点，经异构模型只读独立复核后，在 plan_approve_digest 门禁保护下执行外部受控落盘。',
    entryNodeId: 'n-triage',
    terminalNodeIds: ['n-reviewer', 'n-apply'],
    toolContracts: [
      {
        toolId: 'tool-triage',
        kind: 'script',
        inputSchemaRef: null,
        outputSchemaRef: null,
        sideEffectClass: 'read_only',
        deterministic: true,
        timeoutPolicyRef: null,
        exitSemantics: [
          { code: 0, meaning: 'success' },
          { code: 2, meaning: 'needs_input' },
        ],
      },
      {
        toolId: 'tool-validate',
        kind: 'script',
        inputSchemaRef: null,
        outputSchemaRef: 'schemas/validation-report.schema.json',
        sideEffectClass: 'workspace_write',
        deterministic: true,
        timeoutPolicyRef: null,
        exitSemantics: [
          { code: 0, meaning: 'success' },
          { code: 1, meaning: 'fatal' },
          { code: 2, meaning: 'needs_input' },
        ],
      },
      {
        toolId: 'tool-read-ref',
        kind: 'host_builtin',
        inputSchemaRef: null,
        outputSchemaRef: null,
        sideEffectClass: 'read_only',
        deterministic: true,
        timeoutPolicyRef: null,
        exitSemantics: [{ code: 0, meaning: 'success' }],
      },
      {
        toolId: 'tool-apply',
        kind: 'script',
        inputSchemaRef: null,
        outputSchemaRef: 'schemas/apply-receipt.schema.json',
        sideEffectClass: 'external_side_effect',
        deterministic: true,
        timeoutPolicyRef: null,
        exitSemantics: [
          { code: 0, meaning: 'success' },
          { code: 2, meaning: 'needs_input' },
        ],
      },
    ],
    nodes: [
      {
        nodeId: 'n-triage',
        executor: 'llm_session',
        role: 'coordinator',
        decisionAuthority: 'recommend',
        title: '一句话需求分诊协调节点',
        responsibility: '只读解析用户意图并拦截越界请求。',
        modelTier: 'flagship_reasoning',
        allowedHosts: ['deepseek-harness', 'claude-code', 'codex'],
        sideEffectCeiling: 'read_only',
        allowedWriteSet: [],
        allowedTools: ['tool-triage', 'tool-read-ref'],
        skillBindings: [],
        isolation: { workspaceMode: 'fresh_readonly', mergeBack: 'none', contextMode: 'fresh' },
        onFailure: { route: 'abort', maxRetries: 0 },
        hostRequirements: { requiredCapabilities: ['subagent_spawn'] },
        hostFallbackPolicy: [],
        completionCriteria: [],
      },
      {
        nodeId: 'n-worker',
        executor: 'llm_session',
        role: 'worker',
        decisionAuthority: 'none',
        title: '受限写集确定性校验节点',
        responsibility: '在 work/** 写集内运行确定性校验脚本并产出结构化报告。',
        modelTier: 'balanced_coding',
        allowedHosts: ['deepseek-harness', 'claude-code', 'codex'],
        sideEffectCeiling: 'workspace_write',
        allowedWriteSet: ['work/**'],
        allowedTools: ['tool-validate', 'tool-read-ref'],
        skillBindings: [],
        isolation: { workspaceMode: 'share', mergeBack: 'coordinator_merge', contextMode: 'fresh' },
        onFailure: { route: 'n-triage', maxRetries: 1 },
        hostRequirements: { requiredCapabilities: ['os_sandbox', 'fs_snapshot'] },
        hostFallbackPolicy: [],
        completionCriteria: [{ evidenceKey: 'ev-report' }],
      },
      {
        nodeId: 'n-reviewer',
        executor: 'llm_session',
        role: 'reviewer',
        decisionAuthority: 'final_veto',
        title: '异构模型认知独立复核员',
        responsibility: '在全新只读上下文与异构模型家族下核验业务语义与证据闭环。',
        modelTier: 'flagship_reasoning',
        allowedHosts: ['claude-code', 'codex'],
        sideEffectCeiling: 'read_only',
        allowedWriteSet: [],
        allowedTools: ['tool-read-ref'],
        skillBindings: [],
        isolation: { workspaceMode: 'fresh_readonly', mergeBack: 'none', contextMode: 'fresh' },
        independence: {
          reviewsNodes: ['n-worker'],
          requireFreshContext: true,
          requireDistinctModelFamily: true,
          forbidWriteTools: true,
        },
        onFailure: { route: 'n-triage', maxRetries: 0 },
        hostRequirements: { requiredCapabilities: [] },
        hostFallbackPolicy: [],
        completionCriteria: [],
      },
      {
        nodeId: 'n-apply',
        executor: 'deterministic_script',
        role: 'worker',
        decisionAuthority: 'none',
        title: '受控外部落盘节点',
        responsibility: '经人工摘要审批放行后调用确定性脚本完成落盘。',
        modelTier: 'deterministic_no_llm',
        allowedHosts: ['deepseek-harness', 'claude-code', 'codex'],
        sideEffectCeiling: 'external_side_effect',
        allowedWriteSet: [],
        allowedTools: ['tool-apply'],
        skillBindings: [],
        isolation: { workspaceMode: 'inherit', mergeBack: 'none', contextMode: 'fresh' },
        onFailure: { route: 'n-triage', maxRetries: 0 },
        hostRequirements: { requiredCapabilities: ['hitl_prompt'] },
        hostFallbackPolicy: [],
        completionCriteria: [],
      },
    ],
    edges: [
      {
        edgeId: 'e-triage-worker',
        fromNodeId: 'n-triage',
        toNodeId: 'n-worker',
        edgeKind: 'delegate_spawn',
        condition: 'route == validate',
        handoff: {
          contract: 'task-handoff-envelope',
          freeTextOnlyForbidden: true,
          requiredUpstreamEvidence: [],
        },
      },
      {
        edgeId: 'e-worker-reviewer',
        fromNodeId: 'n-worker',
        toNodeId: 'n-reviewer',
        edgeKind: 'review_submission',
        condition: null,
        handoff: {
          contract: 'artifact_bundle',
          freeTextOnlyForbidden: true,
          requiredUpstreamEvidence: ['ev-report'],
        },
      },
      {
        edgeId: 'e-reviewer-apply',
        fromNodeId: 'n-reviewer',
        toNodeId: 'n-apply',
        edgeKind: 'sequential_handoff',
        condition: 'approved_and_apply_requested',
        handoff: {
          contract: 'professional-conclusion',
          freeTextOnlyForbidden: true,
          requiredUpstreamEvidence: ['ev-report'],
        },
      },
    ],
    expectedEvidence: [
      {
        evidenceKey: 'ev-report',
        kind: 'artifact',
        pathPattern: 'work/report.md',
        schemaRef: 'schemas/validation-report.schema.json',
        producedBy: 'n-worker',
        verifiedBy: 'n-reviewer',
        critical: true,
      },
    ],
    hitlGates: [
      {
        gateId: 'gate-apply',
        placement: 'before_node',
        attachToNodeId: 'n-apply',
        edgeId: null,
        protocol: 'plan_approve_digest',
        coversSideEffects: ['external_side_effect'],
        approverRole: 'domain_owner',
        triggerReason: '触发外部写入前必须经领域负责人摘要审批',
        timeoutSeconds: 600,
        onTimeout: 'block_and_wait',
        onReject: { route: 'n-triage' },
      },
    ],
    budgetAndSafetyPolicy: {
      contextPolicy: {
        warnRatioBp: 4000,
        hardStopRatioBp: 8500,
        onWarn: 'warn_and_handoff',
      },
      maxTotalTokens: 240000,
      maxCostMicroUsd: 1200000,
      maxWallClockSeconds: 900,
      onBudgetExceeded: 'pause_for_hitl',
      sandboxPolicy: {
        requireOsSandbox: true,
        networkAccess: 'none',
      },
    },
  }),
  'deterministic-audit-gate': () => ({
    schemaVersion: 1,
    kind: 'skill-family.orchestration-blueprint',
    blueprintId: 'tpl-readonly-audit-conclusion-v1',
    skillFamilyId: 'example-audit-family',
    version: '0.1.0',
    title: '只读合规扫描与单向专业结论独立复核蓝图',
    summary: '只读扫描目标工作区并将机器报告落入 .runs/**，经认知独立复核节点核验后签发单向 professional-conclusion。',
    entryNodeId: 'n-scan',
    terminalNodeIds: ['n-review'],
    toolContracts: [
      {
        toolId: 'tool-scan',
        kind: 'script',
        inputSchemaRef: null,
        outputSchemaRef: 'schemas/scan-report.schema.json',
        sideEffectClass: 'workspace_write',
        deterministic: true,
        timeoutPolicyRef: null,
        exitSemantics: [
          { code: 0, meaning: 'success' },
          { code: 1, meaning: 'fatal' },
        ],
      },
      {
        toolId: 'tool-read-report',
        kind: 'host_builtin',
        inputSchemaRef: null,
        outputSchemaRef: null,
        sideEffectClass: 'read_only',
        deterministic: true,
        timeoutPolicyRef: null,
        exitSemantics: [{ code: 0, meaning: 'success' }],
      },
    ],
    nodes: [
      {
        nodeId: 'n-scan',
        executor: 'deterministic_script',
        role: 'worker',
        decisionAuthority: 'none',
        title: '确定性静态扫描节点',
        responsibility: '只读扫描受检目录并将结构化结果写入 .runs/**。',
        modelTier: 'deterministic_no_llm',
        allowedHosts: ['deepseek-harness', 'claude-code', 'codex'],
        sideEffectCeiling: 'workspace_write',
        allowedWriteSet: ['.runs/**'],
        allowedTools: ['tool-scan'],
        skillBindings: [],
        isolation: { workspaceMode: 'share', mergeBack: 'coordinator_merge', contextMode: 'fresh' },
        onFailure: { route: 'abort', maxRetries: 0 },
        hostRequirements: { requiredCapabilities: ['os_sandbox'] },
        hostFallbackPolicy: [],
        completionCriteria: [{ evidenceKey: 'ev-conclusion' }],
      },
      {
        nodeId: 'n-review',
        executor: 'llm_session',
        role: 'reviewer',
        decisionAuthority: 'final_veto',
        title: '单向结论认知独立复核节点',
        responsibility: '核验扫描范围与哈希绑定完整性。',
        modelTier: 'flagship_reasoning',
        allowedHosts: ['claude-code', 'codex'],
        sideEffectCeiling: 'read_only',
        allowedWriteSet: [],
        allowedTools: ['tool-read-report'],
        skillBindings: [],
        isolation: { workspaceMode: 'fresh_readonly', mergeBack: 'none', contextMode: 'fresh' },
        independence: {
          reviewsNodes: ['n-scan'],
          requireFreshContext: true,
          requireDistinctModelFamily: true,
          forbidWriteTools: true,
        },
        onFailure: { route: 'abort', maxRetries: 0 },
        hostRequirements: { requiredCapabilities: [] },
        hostFallbackPolicy: [],
        completionCriteria: [],
      },
    ],
    edges: [
      {
        edgeId: 'e-scan-review',
        fromNodeId: 'n-scan',
        toNodeId: 'n-review',
        edgeKind: 'review_submission',
        condition: null,
        handoff: {
          contract: 'professional-conclusion',
          freeTextOnlyForbidden: true,
          requiredUpstreamEvidence: ['ev-conclusion'],
        },
      },
    ],
    expectedEvidence: [
      {
        evidenceKey: 'ev-conclusion',
        kind: 'professional_conclusion',
        pathPattern: '.runs/conclusion.json',
        schemaRef: null,
        producedBy: 'n-scan',
        verifiedBy: 'n-review',
        critical: true,
      },
    ],
    hitlGates: [],
    budgetAndSafetyPolicy: {
      contextPolicy: {
        warnRatioBp: 4000,
        hardStopRatioBp: 8000,
        onWarn: 'warn_and_handoff',
      },
      maxTotalTokens: 120000,
      maxCostMicroUsd: 600000,
      maxWallClockSeconds: 600,
      onBudgetExceeded: 'abort',
      sandboxPolicy: {
        requireOsSandbox: true,
        networkAccess: 'none',
      },
    },
  }),
});

const SIDE_EFFECT_RANK = Object.freeze({
  read_only: 0,
  workspace_write: 1,
  external_side_effect: 2,
});

export function validateBlueprintCanvasDraft(bp) {
  const issues = [];
  if (!bp || typeof bp !== 'object') {
    return { valid: false, issues: ['蓝图根对象缺失'] };
  }
  const nodeMap = new Map((bp.nodes || []).map((n) => [n.nodeId, n]));
  const toolMap = new Map((bp.toolContracts || []).map((t) => [t.toolId, t]));

  if (!nodeMap.has(bp.entryNodeId)) {
    issues.push(`入口节点 ${bp.entryNodeId} 不存在于 nodes 列表中`);
  }
  for (const termId of bp.terminalNodeIds || []) {
    if (!nodeMap.has(termId)) {
      issues.push(`终止节点 ${termId} 不存在于 nodes 列表中`);
    }
  }

  const incomingEdgesByNode = new Map((bp.nodes || []).map((n) => [n.nodeId, []]));
  const forwardAdj = new Map((bp.nodes || []).map((n) => [n.nodeId, []]));
  for (const edge of bp.edges || []) {
    if (!nodeMap.has(edge.fromNodeId) || !nodeMap.has(edge.toNodeId)) {
      issues.push(`有向边 ${edge.edgeId} 引用了不存在的起止节点`);
      continue;
    }
    if (edge.fromNodeId === edge.toNodeId) {
      issues.push(`有向边 ${edge.edgeId} 不允许节点自环`);
    }
    incomingEdgesByNode.get(edge.toNodeId)?.push(edge);
    if (edge.edgeKind !== 'rework_feedback') {
      forwardAdj.get(edge.fromNodeId)?.push(edge.toNodeId);
    }
  }

  // 主干有向无环（DAG）与入口可达性核验
  if (nodeMap.has(bp.entryNodeId)) {
    const reachable = new Set();
    const queue = [bp.entryNodeId];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const nxt of forwardAdj.get(cur) || []) {
        if (!reachable.has(nxt)) queue.push(nxt);
      }
    }
    for (const n of bp.nodes || []) {
      if (!reachable.has(n.nodeId)) {
        issues.push(`节点 ${n.nodeId} 无法从入口节点 ${bp.entryNodeId} 到达`);
      }
    }
  }
  const visitState = new Map();
  const hasForwardCycle = (u) => {
    visitState.set(u, 1);
    for (const v of forwardAdj.get(u) || []) {
      const st = visitState.get(v) || 0;
      if (st === 1) return true;
      if (st === 0 && hasForwardCycle(v)) return true;
    }
    visitState.set(u, 2);
    return false;
  };
  for (const n of bp.nodes || []) {
    if (!visitState.has(n.nodeId) && hasForwardCycle(n.nodeId)) {
      issues.push('非返工边存在有向环路（违反主干 DAG 约束）');
      break;
    }
  }

  for (const node of bp.nodes || []) {
    if (!BLUEPRINT_ENUMS.executor.includes(node.executor)) {
      issues.push(`节点 ${node.nodeId} 的 executor="${String(node.executor)}" 不在受控枚举内`);
    }
    if (!BLUEPRINT_ENUMS.role.includes(node.role)) {
      issues.push(`节点 ${node.nodeId} 的 role="${String(node.role)}" 不在受控枚举内`);
    }
    if (!BLUEPRINT_ENUMS.decisionAuthority.includes(node.decisionAuthority)) {
      issues.push(`节点 ${node.nodeId} 的 decisionAuthority="${String(node.decisionAuthority)}" 不在受控枚举内`);
    }
    if (!BLUEPRINT_ENUMS.modelTier.includes(node.modelTier)) {
      issues.push(`节点 ${node.nodeId} 的 modelTier="${String(node.modelTier)}" 不在受控枚举内`);
    }
    if (!BLUEPRINT_ENUMS.sideEffectCeiling.includes(node.sideEffectCeiling)) {
      issues.push(`节点 ${node.nodeId} 的 sideEffectCeiling="${String(node.sideEffectCeiling)}" 不在受控枚举内`);
    }
    if (node.executor === 'deterministic_script' && node.modelTier !== 'deterministic_no_llm') {
      issues.push(`节点 ${node.nodeId} 为 deterministic_script，modelTier 必须设为 deterministic_no_llm`);
    }
    if (node.executor !== 'deterministic_script' && node.modelTier === 'deterministic_no_llm') {
      issues.push(`节点 ${node.nodeId} 为 ${node.executor}，modelTier 不能设为 deterministic_no_llm（仅 deterministic_script 可用）`);
    }
    if (node.sideEffectCeiling === 'read_only' && (node.allowedWriteSet || []).length > 0) {
      issues.push(`节点 ${node.nodeId} 副作用上限为 read_only，但 allowedWriteSet 非空`);
    }
    const nodeRank = SIDE_EFFECT_RANK[node.sideEffectCeiling] ?? -1;
    for (const tid of node.allowedTools || []) {
      const tc = toolMap.get(tid);
      if (!tc) {
        issues.push(`节点 ${node.nodeId} 引用了未声明的工具 ${tid}`);
      } else {
        const toolRank = SIDE_EFFECT_RANK[tc.sideEffectClass] ?? 99;
        if (toolRank > nodeRank) {
          issues.push(
            `节点 ${node.nodeId} (${node.sideEffectCeiling}) 不能挂载更高副作用等级的工具 ${tid} (${tc.sideEffectClass})`,
          );
        }
      }
    }
    if (node.role === 'reviewer') {
      if (node.sideEffectCeiling !== 'read_only') {
        issues.push(`复核节点 ${node.nodeId} 必须保持 read_only 副作用上限`);
      }
      const ind = node.independence;
      const revTargets = Array.isArray(ind?.reviewsNodes) ? ind.reviewsNodes : [];
      if (revTargets.length === 0) {
        issues.push(`复核节点 ${node.nodeId} 必须声明非空 independence.reviewsNodes`);
      }
      for (const targetId of revTargets) {
        const targetNode = nodeMap.get(targetId);
        if (!targetNode) {
          issues.push(`复核节点 ${node.nodeId} 的 reviewsNodes 引用了不存在节点 ${targetId}`);
        } else if (targetId === node.nodeId || targetNode.role === 'reviewer') {
          issues.push(`复核节点 ${node.nodeId} 严禁自审或互审复核节点 (${targetId})`);
        }
      }
      if (
        ind?.requireFreshContext !== true ||
        ind?.requireDistinctModelFamily !== true ||
        ind?.forbidWriteTools !== true
      ) {
        issues.push(
          `复核节点 ${node.nodeId} 必须同时开启 requireFreshContext、requireDistinctModelFamily 与 forbidWriteTools 反自审保护`,
        );
      }
      if (
        node.isolation?.contextMode !== 'fresh' ||
        node.isolation?.workspaceMode !== 'fresh_readonly'
      ) {
        issues.push(
          `复核节点 ${node.nodeId} 的 isolation 必须设为 contextMode="fresh" 且 workspaceMode="fresh_readonly"`,
        );
      }
    }
    if (node.sideEffectCeiling === 'external_side_effect') {
      const gates = (bp.hitlGates || []).filter(
        (g) =>
          g.protocol === 'plan_approve_digest' &&
          Array.isArray(g.coversSideEffects) &&
          g.coversSideEffects.includes('external_side_effect'),
      );
      const beforeNodeCovered = gates.some(
        (g) => g.placement === 'before_node' && g.attachToNodeId === node.nodeId,
      );
      const inEdges = incomingEdgesByNode.get(node.nodeId) || [];
      const allInEdgesCovered =
        node.nodeId !== bp.entryNodeId &&
        inEdges.length > 0 &&
        inEdges.every((e) => gates.some((g) => g.placement === 'on_edge' && g.edgeId === e.edgeId));
      if (!beforeNodeCovered && !allInEdgesCovered) {
        issues.push(
          `外部副作用节点 ${node.nodeId} 缺少前置 before_node 或覆盖全部入边的 plan_approve_digest 人工确认门禁 (BP-HITL-DOMINATOR)`,
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function renderBlueprintCanvasSubView(doc, state, { onStateChange = () => {} } = {}) {
  const mk = (tag, text, cls) => {
    const el = doc.createElement(tag);
    if (text !== undefined && text !== null) el.textContent = String(text);
    if (cls) el.className = cls;
    return el;
  };
  const badge = (text, tone = 'zinc') => mk('span', text, `st-badge st-badge-${tone}`);

  if (!state.bpCanvasDraft) {
    state.bpCanvasPreset = 'triage-validate-review-hitl';
    state.bpCanvasDraft = CANVAS_STARTER_PRESETS['triage-validate-review-hitl']();
    state.bpSelectedNodeId = state.bpCanvasDraft.nodes[0]?.nodeId || null;
  }

  const draft = state.bpCanvasDraft;
  const check = validateBlueprintCanvasDraft(draft);
  const digest = computeBlueprintDigestSync(draft);
  const selectedNode =
    draft.nodes.find((n) => n.nodeId === state.bpSelectedNodeId) || draft.nodes[0] || null;

  const root = mk('div', null, 'st-lc-section-stack');
  root.dataset.role = 'blueprint-canvas-view';

  // 1. 顶部工具栏：预设模板加载 + 校验状态 + blueprintRef 摘要 + 一键导出 JSON
  const toolbar = mk('div', null, 'st-card st-lc-matrix-toolbar');
  const leftControls = mk('div', null, 'st-graph-controls');
  leftControls.append(mk('strong', '起步蓝图预设：'));

  const presetSelect = mk('select', null, 'st-input');
  presetSelect.dataset.role = 'bp-preset-select';
  for (const [presetId, presetLabel] of [
    ['triage-validate-review-hitl', '四节点业务闭环（分诊 → 校验 → 异构独立复核 → HITL 落盘）'],
    ['deterministic-audit-gate', '双节点只读合规审计（静态扫描 → 单向专业结论复核）'],
  ]) {
    const opt = mk('option', presetLabel);
    opt.value = presetId;
    opt.selected = state.bpCanvasPreset === presetId;
    presetSelect.append(opt);
  }
  presetSelect.addEventListener('change', () => {
    const nextPreset = presetSelect.value;
    const factory = CANVAS_STARTER_PRESETS[nextPreset];
    if (factory) {
      state.bpCanvasPreset = nextPreset;
      state.bpCanvasDraft = factory();
      state.bpSelectedNodeId = state.bpCanvasDraft.nodes[0]?.nodeId || null;
      onStateChange();
    }
  });
  leftControls.append(presetSelect);

  leftControls.append(
    badge(
      check.valid ? '✅ 编排拓扑与反自审/HITL 门禁通过' : `🔴 检出 ${check.issues.length} 项拓扑契约违规`,
      check.valid ? 'emerald' : 'rose',
    ),
    badge(`blueprintRef: sha256:${digest.slice(0, 12)}…`, 'indigo'),
  );

  const rightControls = mk('div', null, 'st-graph-controls');
  const toggleExportBtn = mk(
    'button',
    state.bpShowExportJson ? '收起导出 JSON' : '📋 预览 / 导出标准蓝图 JSON',
    'st-btn st-btn-primary',
  );
  toggleExportBtn.type = 'button';
  toggleExportBtn.dataset.action = 'toggle-bp-json';
  toggleExportBtn.addEventListener('click', () => {
    state.bpShowExportJson = !state.bpShowExportJson;
    onStateChange();
  });
  rightControls.append(toggleExportBtn);
  toolbar.append(leftControls, rightControls);
  root.append(toolbar);

  // 2. 违规告警条（如有）
  if (!check.valid) {
    const alertCard = mk('div', null, 'st-card st-guide-section');
    alertCard.dataset.role = 'bp-validation-issues';
    alertCard.append(mk('strong', '⚠️ 编排拓扑与安全门禁实时拦截项：'));
    const ul = mk('ul', null, 'st-lc-cap-list');
    for (const iss of check.issues) {
      ul.append(mk('li', iss));
    }
    alertCard.append(ul);
    root.append(alertCard);
  }

  // 3. 可视化有向拓扑流画布（节点卡片 + 交接边 + HITL 门禁徽章）
  const canvasCard = mk('div', null, 'st-card st-guide-section');
  const cHead = mk('div', null, 'st-repo-opt-head');
  cHead.append(
    mk('h3', `编排拓扑画布：${draft.title}`, 'st-lc-sec-title'),
    badge(`${draft.nodes.length} 节点 · ${draft.edges.length} 交接边 · ${draft.hitlGates.length} 人工门禁`, 'purple'),
  );
  canvasCard.append(cHead, mk('p', draft.summary, 'st-muted-xs'));

  const nodeFlowGrid = mk('div', null, 'st-lc-feedback-grid');
  nodeFlowGrid.dataset.role = 'bp-node-grid';
  for (const node of draft.nodes) {
    const isSel = selectedNode && selectedNode.nodeId === node.nodeId;
    const isEntry = draft.entryNodeId === node.nodeId;
    const isTerm = (draft.terminalNodeIds || []).includes(node.nodeId);
    const attachedGate = (draft.hitlGates || []).find((g) => g.attachToNodeId === node.nodeId);

    const card = mk('div', null, `st-lc-feedback-card${isSel ? ' is-selected' : ''}`);
    card.dataset.nodeId = node.nodeId;

    const top = mk('div', null, 'st-lc-pill-row');
    top.append(
      mk('code', node.nodeId, 'st-inline-code'),
      badge(node.role, node.role === 'reviewer' ? 'purple' : 'indigo'),
      badge(node.sideEffectCeiling, node.sideEffectCeiling === 'external_side_effect' ? 'amber' : 'emerald'),
    );
    if (isEntry) top.append(badge('入口', 'indigo'));
    if (isTerm) top.append(badge('终点', 'zinc'));
    if (attachedGate) top.append(badge(`🛡️ HITL: ${attachedGate.gateId}`, 'amber'));

    const selectBtn = mk('button', isSel ? '✓ 当前编辑中' : '编辑节点契约', 'st-btn st-btn-xs');
    selectBtn.type = 'button';
    selectBtn.dataset.selectNode = node.nodeId;
    selectBtn.addEventListener('click', () => {
      state.bpSelectedNodeId = node.nodeId;
      onStateChange();
    });

    card.append(
      top,
      mk('strong', node.title),
      mk('div', `执行器：${node.executor} · 模型档位：${node.modelTier}`, 'st-muted-xs'),
      mk('div', node.responsibility, 'st-muted-xs'),
      selectBtn,
    );
    nodeFlowGrid.append(card);
  }
  canvasCard.append(nodeFlowGrid);

  // 交接边摘要列表
  const edgeStrip = mk('div', null, 'st-lc-planes-section');
  edgeStrip.append(mk('div', '结构化交接边（禁止纯自由文本口头交接）', 'st-lc-subhead'));
  const edgeStack = mk('div', null, 'st-lc-flow-stack');
  for (const edge of draft.edges) {
    const row = mk('div', null, 'st-lc-pill-row');
    row.append(
      badge(edge.fromNodeId, 'indigo'),
      mk('span', ` ──[${edge.edgeKind}]──▶ `, 'st-lc-flow-arrow'),
      badge(edge.toNodeId, 'emerald'),
      mk('code', edge.handoff.contract, 'st-inline-code'),
    );
    if ((edge.handoff.requiredUpstreamEvidence || []).length > 0) {
      row.append(badge(`前置证据: ${edge.handoff.requiredUpstreamEvidence.join(', ')}`, 'amber'));
    }
    edgeStack.append(row);
  }
  edgeStrip.append(edgeStack);
  canvasCard.append(edgeStrip);
  root.append(canvasCard);

  // 4. 受限枚举检查器（消除手工编写 JSON 枚举拼写错误）
  if (selectedNode) {
    const inspector = mk('div', null, 'st-card st-guide-section');
    inspector.dataset.role = 'bp-node-inspector';
    inspector.append(
      mk('h3', `节点受限契约编辑器：${selectedNode.nodeId}`, 'st-lc-sec-title'),
      mk('p', '所有关键契约字段均由 Contracts 1.23.0 权威枚举受限驱动，修改后实时重算拓扑合法性与 SHA-256 摘要：', 'st-muted-xs'),
    );

    const formRow = mk('div', null, 'st-lc-cap-filters');
    const makeEnumField = (labelTxt, fieldKey, allowedValues, onUpdate) => {
      const wrap = mk('label', null, 'st-graph-controls');
      wrap.append(mk('span', `${labelTxt}：`, 'st-muted-xs'));
      const sel = mk('select', null, 'st-input');
      sel.dataset.field = fieldKey;
      for (const v of allowedValues) {
        const opt = mk('option', v);
        opt.value = v;
        opt.selected = selectedNode[fieldKey] === v;
        sel.append(opt);
      }
      sel.addEventListener('change', () => {
        onUpdate(sel.value);
        onStateChange();
      });
      wrap.append(sel);
      return wrap;
    };

    formRow.append(
      makeEnumField('执行器 (executor)', 'executor', BLUEPRINT_ENUMS.executor, (val) => {
        selectedNode.executor = val;
        if (val === 'deterministic_script') {
          selectedNode.modelTier = 'deterministic_no_llm';
        } else if (selectedNode.modelTier === 'deterministic_no_llm') {
          selectedNode.modelTier = 'balanced_coding';
        }
      }),
      makeEnumField('角色 (role)', 'role', BLUEPRINT_ENUMS.role, (val) => {
        selectedNode.role = val;
      }),
      makeEnumField('裁决权 (decisionAuthority)', 'decisionAuthority', BLUEPRINT_ENUMS.decisionAuthority, (val) => {
        selectedNode.decisionAuthority = val;
      }),
      makeEnumField('模型档位 (modelTier)', 'modelTier', BLUEPRINT_ENUMS.modelTier, (val) => {
        selectedNode.modelTier = val;
        if (val === 'deterministic_no_llm') {
          selectedNode.executor = 'deterministic_script';
        } else if (selectedNode.executor === 'deterministic_script') {
          selectedNode.executor = 'llm_session';
        }
      }),
      makeEnumField('副作用上限 (sideEffectCeiling)', 'sideEffectCeiling', BLUEPRINT_ENUMS.sideEffectCeiling, (val) => {
        selectedNode.sideEffectCeiling = val;
      }),
    );
    inspector.append(formRow);
    root.append(inspector);
  }

  // 5. 标准 OrchestrationBlueprint JSON 预览与复制区
  if (state.bpShowExportJson) {
    const exportCard = mk('div', null, 'st-card st-guide-section');
    exportCard.dataset.role = 'bp-export-panel';
    const expHead = mk('div', null, 'st-repo-opt-head');
    expHead.append(
      mk('strong', '可直接保存至 artifacts/design/<family>-orchestration-blueprint.json 的标准文档'),
      mk('code', `blueprintRef.sha256 = ${digest}`, 'st-inline-code'),
    );
    const pre = mk('pre', `${JSON.stringify(draft, null, 2)}\n`, 'st-code-block');
    pre.dataset.role = 'bp-export-json';
    exportCard.append(expHead, pre);
    root.append(exportCard);
  }

  return root;
}
