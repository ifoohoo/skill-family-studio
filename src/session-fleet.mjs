// @feature STU006
// @feature STU003

import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { sanitizePublicText } from './markdown-render.mjs';

const SENSITIVE_PATH_RE = /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|keychains|\.env(?:\.[^\\/]+)?)(?:$|[\\/])/i;
const SECRET_TOKEN_RE = /(?:sk-[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/g;

export function sanitizeFleetText(value) {
  return sanitizePublicText(String(value ?? '')).replace(SECRET_TOKEN_RE, '<REDACTED_TOKEN>');
}

function tryUnwrapJsonString(val) {
  if (typeof val !== 'string') return val === undefined || val === null ? '' : String(val);
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return val;
}

function summarizeDutyFromPrompt(rawPrompt, fallback = '子智能体专项任务') {
  const clean = sanitizeFleetText(rawPrompt)
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#\s>*-]+/, '')
    .trim();
  if (!clean) return fallback;
  const firstLine = clean.split(/\r?\n/).map(l => l.replace(/^[#\s>*-]+/, '').trim()).find(l => l.length > 3) || clean;
  const normalized = firstLine.replace(/\s+/g, ' ');
  return normalized.length > 42 ? `${normalized.slice(0, 41)}…` : normalized;
}

function inferRoleBadge(label, isRoot, isReviewer) {
  if (isRoot) return '主控';
  if (isReviewer || /审阅|复核|review|audit/i.test(label)) return '审阅';
  if (/前端|UI|界面|css|交互/i.test(label)) return '前端';
  if (/测试|核验|浏览器|e2e|test/i.test(label)) return '核验';
  if (/手册|文档|故事|guide|doc/i.test(label)) return '文档';
  if (/架构|引擎|对齐|后端|setup|fleet/i.test(label)) return '架构';
  return '执行';
}

async function readJsonlLinesBounded(filePath, maxBytes = 2_500_000, maxLines = 1800) {
  if (SENSITIVE_PATH_RE.test(filePath)) return [];
  let st;
  try { st = await lstat(filePath); } catch { return []; }
  if (!st.isFile() || st.isSymbolicLink()) return [];
  const lines = [];
  let seenBytes = 0;
  const stream = createReadStream(filePath, { encoding: 'utf8', start: 0, end: Math.max(0, Math.min(st.size - 1, maxBytes - 1)) });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      seenBytes += Buffer.byteLength(line, 'utf8');
      lines.push(line);
      if (lines.length >= maxLines || seenBytes >= maxBytes) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines;
}

export function parseAntigravityTranscript(rawLines, conversationId) {
  const lines = Array.isArray(rawLines) ? rawLines : String(rawLines ?? '').split(/\r?\n/).filter(Boolean);
  let model = '';
  let startedAt = null;
  let updatedAt = null;
  let steps = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let lastStepStatus = 'DONE';
  let userPrompt = '';
  let callerId = null;
  let workspaceHint = '';

  const pendingSubagentInvokes = [];
  const spawnedChildren = [];
  const sentMessages = [];
  const receivedMessages = [];

  for (const raw of lines) {
    let rec;
    try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    steps += 1;
    if (rec.created_at) {
      if (!startedAt) startedAt = rec.created_at;
      updatedAt = rec.created_at;
    }
    if (rec.status) lastStepStatus = String(rec.status).toUpperCase();
    if (rec.model && !model) model = String(rec.model);
    if (Number.isFinite(rec.input_tokens)) inputTokens += rec.input_tokens;
    if (Number.isFinite(rec.cache_read_tokens)) cacheReadTokens += rec.cache_read_tokens;
    if (Number.isFinite(rec.output_tokens)) outputTokens += rec.output_tokens;

    const content = typeof rec.content === 'string' ? rec.content : '';
    if (!workspaceHint && content) {
      const wsMatch = /\/source\/([^/\s"'`]+)/.exec(content);
      if (wsMatch) workspaceHint = wsMatch[1];
    }

    if (rec.type === 'USER_INPUT' && !userPrompt && content) {
      const ur = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
      userPrompt = sanitizeFleetText((ur ? ur[1] : content).slice(0, 1200));
    }

    if (rec.type === 'SYSTEM_MESSAGE' && content) {
      const msgMatches = [...content.matchAll(/\[Message\]\s+timestamp=([^\s]+)\s+sender=([^\s]+)\s+priority=[^\s]+\s+content=([\s\S]*?)(?=(?:\n\d+\.\s+\[Message\]|\n<\/SYSTEM_MESSAGE>|$))/g)];
      for (const m of msgMatches) {
        const sender = m[2].trim();
        const bodyText = sanitizeFleetText(m[3].trim());
        if (!callerId && !userPrompt && steps <= 2) {
          callerId = sender;
          userPrompt = bodyText.slice(0, 2000);
        } else {
          receivedMessages.push({
            seq: rec.step_index ?? steps,
            time: m[1].trim() || rec.created_at || updatedAt,
            from: sender,
            to: conversationId,
            kind: 'report',
            kindLabel: '完成回报',
            body: bodyText.slice(0, 4000),
          });
        }
      }
    }

    for (const tc of Array.isArray(rec.tool_calls) ? rec.tool_calls : []) {
      const name = tc?.name;
      const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
      if (name === 'invoke_subagent') {
        const promptText = sanitizeFleetText(tryUnwrapJsonString(args.Prompt || args.Task || ''));
        const explicitName = sanitizeFleetText(tryUnwrapJsonString(args.Name || args.SubagentName || ''));
        pendingSubagentInvokes.push({
          seq: rec.step_index ?? steps,
          time: rec.created_at || updatedAt,
          model: sanitizeFleetText(tryUnwrapJsonString(args.Model || '')),
          duty: explicitName || summarizeDutyFromPrompt(promptText),
          prompt: promptText.slice(0, 4000),
        });
      } else if (name === 'send_message') {
        const recipient = sanitizeFleetText(tryUnwrapJsonString(args.Recipient || '')).trim();
        const body = sanitizeFleetText(tryUnwrapJsonString(args.Message || '')).trim();
        if (recipient && body) {
          sentMessages.push({
            seq: rec.step_index ?? steps,
            time: rec.created_at || updatedAt,
            from: conversationId,
            to: recipient,
            kind: 'message',
            kindLabel: '协作消息',
            body: body.slice(0, 4000),
          });
        }
      }
    }

    if (rec.type === 'GENERIC' && content.includes('Created the following subagent:')) {
      const idx = content.indexOf('Created the following subagent:');
      const braceStart = content.indexOf('{', idx);
      const braceEnd = braceStart >= 0 ? content.indexOf('\n}', braceStart) : -1;
      if (braceStart >= 0 && braceEnd > braceStart) {
        try {
          const info = JSON.parse(content.slice(braceStart, braceEnd + 2));
          if (info?.conversationId) {
            const matchedInvoke = pendingSubagentInvokes.shift() || {
              seq: rec.step_index ?? steps,
              time: rec.created_at || updatedAt,
              model: '',
              duty: '派生子会话任务',
              prompt: '',
            };
            const wsUris = Array.isArray(info.workspaceUris) ? info.workspaceUris.map(u => sanitizeFleetText(u)) : [];
            if (!workspaceHint && wsUris[0]) workspaceHint = basename(decodeURIComponent(wsUris[0]));
            spawnedChildren.push({
              childId: String(info.conversationId),
              seq: matchedInvoke.seq,
              time: matchedInvoke.time || rec.created_at || updatedAt,
              model: matchedInvoke.model,
              duty: matchedInvoke.duty,
              prompt: matchedInvoke.prompt,
            });
          }
        } catch {}
      }
    }
  }

  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const endMs = updatedAt ? Date.parse(updatedAt) : NaN;
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const status = lastStepStatus === 'RUNNING' ? 'running' : 'completed';

  return {
    id: conversationId,
    host: 'antigravity',
    model: model || 'unknown',
    startedAt,
    updatedAt,
    durationMs,
    steps,
    status,
    tokens: { input: inputTokens, cacheRead: cacheReadTokens, output: outputTokens, total: totalTokens },
    callerId,
    workspaceHint,
    duty: summarizeDutyFromPrompt(userPrompt, '协调会话'),
    prompt: userPrompt,
    spawnedChildren,
    sentMessages,
    receivedMessages,
  };
}

function buildFamilyFromParsedSessions(rootSess, byId) {
  const agents = [];
  const delegations = [];
  const events = [];
  const visited = new Set();

  const walk = (sess, parentId, depth, idxHue, inheritedDuty, inheritedPrompt) => {
    if (!sess || visited.has(sess.id)) return;
    visited.add(sess.id);
    const isRoot = parentId === null;
    const displayTitle = isRoot ? (sess.duty || '主控协调会话') : (inheritedDuty || sess.duty || `子会话 ${sess.id.slice(0, 6)}`);
    const isReviewer = /审阅|复核|review|audit/i.test(displayTitle);
    const role = isRoot ? 'coordinator' : (isReviewer ? 'reviewer' : 'subagent');
    agents.push({
      id: sess.id,
      parentId,
      depth,
      name: sanitizeFleetText(displayTitle),
      role,
      roleShort: inferRoleBadge(displayTitle, isRoot, isReviewer),
      hueIndex: isRoot ? 0 : idxHue,
      model: sanitizeFleetText(sess.model || 'unknown'),
      status: sess.status || 'completed',
      startedAt: sess.startedAt,
      updatedAt: sess.updatedAt,
      durationMs: sess.durationMs || 0,
      steps: sess.steps || 0,
      tokens: sess.tokens || { input: 0, cacheRead: 0, output: 0, total: 0 },
      loadPercent: 0,
      duty: sanitizeFleetText(displayTitle),
      prompt: sanitizeFleetText(inheritedPrompt || sess.prompt || ''),
      executionMode: isRoot ? '主控协调' : (isReviewer ? '只读独立复核' : '后台独立子会话'),
    });

    for (let i = 0; i < (sess.spawnedChildren || []).length; i += 1) {
      const ch = sess.spawnedChildren[i];
      const childSess = byId.get(ch.childId);
      const childStatus = childSess ? childSess.status : 'completed';
      delegations.push({
        id: `del:${sess.id}:${ch.childId}:${ch.seq}`,
        seq: ch.seq,
        time: ch.time,
        from: sess.id,
        to: ch.childId,
        label: sanitizeFleetText(ch.duty),
        mode: /审阅|复核|review/i.test(ch.duty) ? 'reviewer' : 'subagent',
        status: childStatus === 'running' ? 'in_progress' : 'completed',
        prompt: sanitizeFleetText(ch.prompt),
      });
      events.push({
        id: `ev-del:${sess.id}:${ch.childId}:${ch.seq}`,
        seq: ch.seq,
        time: ch.time,
        kind: 'delegation',
        kindLabel: '子会话委派',
        from: sess.id,
        to: ch.childId,
        duty: sanitizeFleetText(ch.duty),
        executionMode: /审阅|复核|review/i.test(ch.duty) ? '只读独立复核' : '后台独立子会话',
        summary: sanitizeFleetText(ch.duty),
        body: sanitizeFleetText(ch.prompt),
        note: '来自父会话日志的创建与首次委派记录。',
      });
      if (childSess) {
        walk(childSess, sess.id, depth + 1, (idxHue + i + 1) % 8, ch.duty, ch.prompt);
      } else {
        agents.push({
          id: ch.childId,
          parentId: sess.id,
          depth: depth + 1,
          name: sanitizeFleetText(ch.duty || `子会话 ${ch.childId.slice(0, 6)}`),
          role: 'subagent',
          roleShort: inferRoleBadge(ch.duty, false, false),
          hueIndex: (idxHue + i + 1) % 8,
          model: sanitizeFleetText(ch.model || sess.model || 'inherit'),
          status: 'completed',
          startedAt: ch.time,
          updatedAt: ch.time,
          durationMs: 0,
          steps: 1,
          tokens: { input: 0, cacheRead: 0, output: 0, total: 0 },
          loadPercent: 0,
          duty: sanitizeFleetText(ch.duty),
          prompt: sanitizeFleetText(ch.prompt),
          executionMode: '后台独立子会话',
        });
      }
    }

    for (const m of sess.sentMessages || []) {
      events.push({
        id: `ev-msg:${m.from}:${m.to}:${m.seq}`,
        seq: m.seq,
        time: m.time,
        kind: 'message',
        kindLabel: '续派/协作消息',
        from: m.from,
        to: m.to,
        duty: '会话间消息传递',
        executionMode: '实时消息路由',
        summary: sanitizeFleetText(m.body.slice(0, 120)),
        body: sanitizeFleetText(m.body),
        note: '父/子会话通过 send_message 发送的上下文指令或同步结果。',
      });
    }

    for (const r of sess.receivedMessages || []) {
      events.push({
        id: `ev-rep:${r.from}:${r.to}:${r.seq}`,
        seq: r.seq,
        time: r.time,
        kind: 'report',
        kindLabel: '完成回报',
        from: r.from,
        to: r.to,
        duty: '阶段性或终态完成回报',
        executionMode: '异步事件唤醒',
        summary: sanitizeFleetText(r.body.slice(0, 120)),
        body: sanitizeFleetText(r.body),
        note: '子会话完成后回传至主控会话的最终结果与证据摘要。',
      });
    }
  };

  walk(rootSess, null, 0, 0, rootSess.duty, rootSess.prompt);

  const totalTokens = agents.reduce((s, a) => s + (a.tokens?.total || 0), 0);
  for (const a of agents) {
    a.loadPercent = totalTokens > 0 ? Number((((a.tokens?.total || 0) / totalTokens) * 100).toFixed(1)) : 0;
  }
  events.sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0) || (a.seq ?? 0) - (b.seq ?? 0));

  return {
    id: `ag:${rootSess.id}`,
    host: 'antigravity',
    title: sanitizeFleetText(rootSess.duty || `Antigravity 会话 ${rootSess.id.slice(0, 8)}`),
    repoHint: sanitizeFleetText(rootSess.workspaceHint || ''),
    startedAt: rootSess.startedAt,
    updatedAt: rootSess.updatedAt,
    summary: {
      totalAgents: agents.length,
      runningAgents: agents.filter(a => a.status === 'running').length,
      totalDelegations: delegations.length,
      totalMessages: events.length,
      totalTokens,
    },
    agents,
    delegations,
    events,
  };
}

export function buildSandboxFleetSample(nowIso = new Date().toISOString()) {
  const baseMs = Date.parse(nowIso) || Date.now();
  const iso = offsetSec => new Date(baseMs - (600 - offsetSec) * 1000).toISOString();
  const agents = [
    {
      id: 'coord-main',
      parentId: null,
      depth: 0,
      name: '主控协调会话 · 波次调度',
      role: 'coordinator',
      roleShort: '主控',
      hueIndex: 0,
      model: 'gemini-4-xhigh',
      status: 'running',
      startedAt: iso(0),
      updatedAt: iso(595),
      durationMs: 595_000,
      steps: 42,
      tokens: { input: 640_000, cacheRead: 1_100_000, output: 185_000, total: 1_925_000 },
      loadPercent: 34.8,
      duty: '拆分任务波次、协调子智能体写集与汇总结论',
      prompt: '### 主控目标\n协调完成核心对齐引擎、编队监控面板、使用手册润色与全链路核验，严禁越过授权修改兄弟仓库。',
      executionMode: '主控持续调度',
    },
    {
      id: 'sub-arch',
      parentId: 'coord-main',
      depth: 1,
      name: '架构与对齐引擎子会话',
      role: 'subagent',
      roleShort: '架构',
      hueIndex: 1,
      model: 'gemini-4-high',
      status: 'completed',
      startedAt: iso(25),
      updatedAt: iso(260),
      durationMs: 235_000,
      steps: 24,
      tokens: { input: 280_000, cacheRead: 520_000, output: 94_000, total: 894_000 },
      loadPercent: 16.2,
      duty: '实现 setup-advisor 探针与多级任务树解析',
      prompt: '请实现 `setup-advisor.mjs` 与多级任务树解析逻辑：\n1. 自动识别单仓与多仓角色\n2. 支持 Markdown 缩进子任务与 JSON `children[]` 汇总。',
      executionMode: '后台独立子会话',
    },
    {
      id: 'sub-frontend',
      parentId: 'coord-main',
      depth: 1,
      name: '前端编队与交互稳态子会话',
      role: 'subagent',
      roleShort: '前端',
      hueIndex: 2,
      model: 'gemini-4-high',
      status: 'running',
      startedAt: iso(35),
      updatedAt: iso(590),
      durationMs: 555_000,
      steps: 36,
      tokens: { input: 360_000, cacheRead: 690_000, output: 132_000, total: 1_182_000 },
      loadPercent: 21.4,
      duty: '构建 Agent 网络拓扑、跨泳道协作与就地解释浮层',
      prompt: '请参考多 Agent 编队布局完成 `fleet-ui.mjs` 与 `tooltips.mjs`：\n- 点击图谱节点保持坐标恒定\n- 全部卡片使用安全 DOM API 构建。',
      executionMode: '后台独立子会话',
    },
    {
      id: 'sub-docs',
      parentId: 'coord-main',
      depth: 1,
      name: '说明书与故事润色子会话',
      role: 'subagent',
      roleShort: '文档',
      hueIndex: 3,
      model: 'gemini-4-high',
      status: 'completed',
      startedAt: iso(50),
      updatedAt: iso(310),
      durationMs: 260_000,
      steps: 19,
      tokens: { input: 190_000, cacheRead: 310_000, output: 72_000, total: 572_000 },
      loadPercent: 10.3,
      duty: '重写零基础逐页说明书、角色动线与状态原理图',
      prompt: '按自然中文表达标准重写 `guide-content.mjs` 与 `USER-GUIDE.md`，消除双套编号冲突并增加常见问题 FAQ。',
      executionMode: '后台独立子会话',
    },
    {
      id: 'sub-verify',
      parentId: 'coord-main',
      depth: 1,
      name: '宽屏浏览器与测试门禁子会话',
      role: 'subagent',
      roleShort: '核验',
      hueIndex: 4,
      model: 'gemini-4-high',
      status: 'completed',
      startedAt: iso(330),
      updatedAt: iso(520),
      durationMs: 190_000,
      steps: 18,
      tokens: { input: 165_000, cacheRead: 290_000, output: 48_000, total: 503_000 },
      loadPercent: 9.1,
      duty: '验证 2560px 宽屏适配、浮层收起与单测回归',
      prompt: '在随机测试端口运行完整服务单测，验证零横向溢出、`Escape` 全浮层收起及脱敏边界。',
      executionMode: '后台独立子会话',
    },
    {
      id: 'sub-reviewer',
      parentId: 'sub-verify',
      depth: 2,
      name: '独立只读审阅官',
      role: 'reviewer',
      roleShort: '审阅',
      hueIndex: 5,
      model: 'gemini-4-xhigh',
      status: 'completed',
      startedAt: iso(525),
      updatedAt: iso(585),
      durationMs: 60_000,
      steps: 12,
      tokens: { input: 180_000, cacheRead: 220_000, output: 55_000, total: 455_000 },
      loadPercent: 8.2,
      duty: '只读对照需求契约与代码变更并出具独立核验报告',
      prompt: '对本轮全部改动进行只读独立审查，重点核查：`unclaimedEntries === 0`、零私有路径泄露与无外部 CDN 引用。',
      executionMode: '只读独立复核',
    },
  ];

  const delegations = [
    { id: 'sbx-del-1', seq: 11, time: iso(25), from: 'coord-main', to: 'sub-arch', label: '实现 setup-advisor 与任务树解析', mode: 'subagent', status: 'completed', prompt: agents[1].prompt },
    { id: 'sbx-del-2', seq: 12, time: iso(35), from: 'coord-main', to: 'sub-frontend', label: '构建编队监控界面与就地提示浮层', mode: 'subagent', status: 'in_progress', prompt: agents[2].prompt },
    { id: 'sbx-del-3', seq: 13, time: iso(50), from: 'coord-main', to: 'sub-docs', label: '重写零基础逐页说明书与状态流转图', mode: 'subagent', status: 'completed', prompt: agents[3].prompt },
    { id: 'sbx-del-4', seq: 28, time: iso(330), from: 'coord-main', to: 'sub-verify', label: '运行 2560px 宽屏及全功能回归核验', mode: 'subagent', status: 'completed', prompt: agents[4].prompt },
    { id: 'sbx-del-5', seq: 36, time: iso(525), from: 'sub-verify', to: 'sub-reviewer', label: '发起只读独立终审与闭环核验', mode: 'reviewer', status: 'completed', prompt: agents[5].prompt },
  ];

  const events = [
    ...delegations.map(d => ({
      id: `sbx-ev-${d.id}`,
      seq: d.seq,
      time: d.time,
      kind: 'delegation',
      kindLabel: '子会话委派',
      from: d.from,
      to: d.to,
      duty: d.label,
      executionMode: d.mode === 'reviewer' ? '只读独立复核' : '后台独立子会话',
      summary: d.label,
      body: d.prompt,
      note: '来自父会话日志的创建与首次委派记录，不计入续派消息数。',
    })),
    {
      id: 'sbx-ev-rep-arch',
      seq: 21,
      time: iso(260),
      kind: 'report',
      kindLabel: '完成回报',
      from: 'sub-arch',
      to: 'coord-main',
      duty: '架构与对齐引擎交付回报',
      executionMode: '异步完成回报',
      summary: '已完成 inspect-setup 与多级任务树解析，所有单测全绿。',
      body: '## 阶段回报\n- 已新增 `setup-advisor.mjs` 支持单仓/多仓探测\n- 已扩展 `parsePlanSummary` 解析 3 层任务树\n- 自测退出码 `0`。',
      note: '子会话向主控回报阶段交付结果与验证证据。',
    },
    {
      id: 'sbx-ev-msg-fe',
      seq: 24,
      time: iso(280),
      kind: 'message',
      kindLabel: '协作消息',
      from: 'coord-main',
      to: 'sub-frontend',
      duty: '同步最新 API 字段与无内联 HTML 约束',
      executionMode: '实时消息路由',
      summary: '请将事件检查器中的 Markdown 切换改为纯 DOM 构建，保持 app.mjs 仅 1 处 innerHTML。',
      body: '### 主控续派提醒\n请确保 `fleet-ui.mjs` 全量采用 `document.createElement` + `textContent` 构建卡片与检查器，避免触发 DOM XSS 检查失败。',
      note: '主控会话向执行中子会话发送的补充约束消息。',
    },
    {
      id: 'sbx-ev-rep-docs',
      seq: 27,
      time: iso(310),
      kind: 'report',
      kindLabel: '完成回报',
      from: 'sub-docs',
      to: 'coord-main',
      duty: '说明书重写交付回报',
      executionMode: '异步完成回报',
      summary: '已合并角色动线并补齐逐页界面拆解与 FAQ，与 USER-GUIDE.md 字节一致。',
      body: '## 文档交付摘要\n- 废除 1~4 站与 1~5 步双套编号冲突\n- 新增「逐页界面全拆解」与「高频疑问解答 FAQ」\n- 两张原理图已就绪。',
      note: '子会话向主控回报文档已就绪。',
    },
    {
      id: 'sbx-ev-rep-rev',
      seq: 41,
      time: iso(585),
      kind: 'report',
      kindLabel: '完成回报',
      from: 'sub-reviewer',
      to: 'coord-main',
      duty: '独立只读审阅签收',
      executionMode: '只读独立复核',
      summary: 'PASS：全部核心源码已绑定版本锁，零私有路径泄露，公开仓校验一致。',
      body: '## 独立复核结论：PASS\n- `unclaimedEntries = 0`\n- 公开仓与私仓 SHA-256 100% 匹配\n- 全部 9 项产品指摘均已闭环。',
      note: '独立审阅官向主控回报最终审核意见。',
    },
  ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  return {
    id: 'sandbox-fleet-demo',
    host: 'sandbox',
    title: '沙箱多智能体协作编队演练（6 会话闭环样板）',
    repoHint: 'skill-family-studio',
    startedAt: iso(0),
    updatedAt: iso(595),
    summary: {
      totalAgents: agents.length,
      runningAgents: agents.filter(a => a.status === 'running').length,
      totalDelegations: delegations.length,
      totalMessages: events.length,
      totalTokens: agents.reduce((s, a) => s + a.tokens.total, 0),
    },
    agents,
    delegations,
    events,
  };
}

let fleetCache = { key: '', at: 0, result: null };

export function parseClaudeSessionJsonl(rawLines, sessionId, subagentLinesMap = new Map()) {
  const lines = Array.isArray(rawLines) ? rawLines : String(rawLines ?? '').split(/\r?\n/).filter(Boolean);
  let startedAt = null;
  let updatedAt = null;
  let model = '';
  let steps = 0;
  let inTok = 0, cacheTok = 0, outTok = 0;
  let duty = 'Claude Code 会话';
  let prompt = '';
  const delegations = [];
  const events = [];
  const agents = [];

  for (const raw of lines) {
    let rec;
    try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    steps += 1;
    if (rec.timestamp) { if (!startedAt) startedAt = rec.timestamp; updatedAt = rec.timestamp; }
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;
    if (msg?.model && !model) model = String(msg.model);
    if (msg?.usage) {
      inTok += Number(msg.usage.input_tokens || 0);
      cacheTok += Number(msg.usage.cache_read_input_tokens || 0);
      outTok += Number(msg.usage.output_tokens || 0);
    }
    if (rec.type === 'user' && !prompt && typeof msg?.content === 'string') {
      prompt = sanitizeFleetText(msg.content.slice(0, 1200));
      duty = summarizeDutyFromPrompt(prompt, duty);
    }
    for (const blk of Array.isArray(msg?.content) ? msg.content : []) {
      if (blk?.type === 'tool_use' && (blk.name === 'Agent' || blk.name === 'Task')) {
        const subId = sanitizeFleetText(blk.id || `cl-sub-${delegations.length + 1}`);
        const subDesc = sanitizeFleetText(blk.input?.description || blk.input?.subagent_type || '子任务委派');
        const subPrompt = sanitizeFleetText(blk.input?.prompt || '');
        delegations.push({
          id: `cl-del-${subId}`,
          seq: steps,
          time: rec.timestamp || updatedAt,
          from: sessionId,
          to: subId,
          label: subDesc,
          mode: 'subagent',
          status: 'completed',
          prompt: subPrompt.slice(0, 4000),
        });
        events.push({
          id: `cl-ev-${subId}`,
          seq: steps,
          time: rec.timestamp || updatedAt,
          kind: 'delegation',
          kindLabel: '子会话委派',
          from: sessionId,
          to: subId,
          duty: subDesc,
          executionMode: 'Claude 子智能体',
          summary: subDesc,
          body: subPrompt.slice(0, 4000),
          note: '来自 Claude Code 会话日志中的 Agent/Task 委派记录。',
        });
      }
    }
  }

  agents.push({
    id: sessionId,
    parentId: null,
    depth: 0,
    name: duty,
    role: 'coordinator',
    roleShort: '主控',
    hueIndex: 0,
    model: sanitizeFleetText(model || 'claude'),
    status: 'completed',
    startedAt,
    updatedAt,
    durationMs: startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0,
    steps,
    tokens: { input: inTok, cacheRead: cacheTok, output: outTok, total: inTok + cacheTok + outTok },
    loadPercent: 0,
    duty,
    prompt,
    executionMode: 'Claude 主会话',
  });

  let idx = 1;
  for (const [subName, subRaw] of subagentLinesMap.entries()) {
    let sSteps = 0, sIn = 0, sOut = 0, sModel = model, sStart = null, sEnd = null;
    for (const raw of subRaw) {
      let rec;
      try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
      sSteps += 1;
      if (rec.timestamp) { if (!sStart) sStart = rec.timestamp; sEnd = rec.timestamp; }
      if (rec.message?.model && !sModel) sModel = rec.message.model;
      if (rec.message?.usage) { sIn += Number(rec.message.usage.input_tokens || 0); sOut += Number(rec.message.usage.output_tokens || 0); }
    }
    const delMatch = delegations[idx - 1];
    const subId = delMatch?.to || subName;
    agents.push({
      id: subId,
      parentId: sessionId,
      depth: 1,
      name: delMatch?.label || `子体 ${subName}`,
      role: 'subagent',
      roleShort: inferRoleBadge(delMatch?.label || subName, false, false),
      hueIndex: idx % 8,
      model: sanitizeFleetText(sModel || 'claude'),
      status: 'completed',
      startedAt: sStart || startedAt,
      updatedAt: sEnd || updatedAt,
      durationMs: sStart && sEnd ? Math.max(0, Date.parse(sEnd) - Date.parse(sStart)) : 0,
      steps: sSteps,
      tokens: { input: sIn, cacheRead: 0, output: sOut, total: sIn + sOut },
      loadPercent: 0,
      duty: delMatch?.label || subName,
      prompt: delMatch?.prompt || '',
      executionMode: 'Claude 子智能体',
    });
    idx += 1;
  }

  const totalTokens = agents.reduce((s, a) => s + a.tokens.total, 0);
  for (const a of agents) a.loadPercent = totalTokens > 0 ? Number(((a.tokens.total / totalTokens) * 100).toFixed(1)) : 0;
  return {
    id: `cl:${sessionId}`,
    host: 'claude',
    title: duty,
    repoHint: '',
    startedAt,
    updatedAt,
    summary: {
      totalAgents: agents.length,
      runningAgents: 0,
      totalDelegations: delegations.length,
      totalMessages: events.length,
      totalTokens,
    },
    agents,
    delegations,
    events,
  };
}

export function parseCodexSessionJsonl(rawLines, fileId) {
  const lines = Array.isArray(rawLines) ? rawLines : String(rawLines ?? '').split(/\r?\n/).filter(Boolean);
  let id = fileId;
  let parentId = null;
  let cwd = '';
  let startedAt = null;
  let updatedAt = null;
  let steps = 0;
  let totalTokens = 0;
  let model = 'codex';
  let prompt = '';
  const spawned = [];

  for (const raw of lines) {
    let rec;
    try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    steps += 1;
    if (rec.timestamp) { if (!startedAt) startedAt = rec.timestamp; updatedAt = rec.timestamp; }
    if (rec.type === 'session_meta' && rec.payload) {
      if (rec.payload.id) id = String(rec.payload.id);
      if (rec.payload.cwd) cwd = sanitizeFleetText(rec.payload.cwd);
      parentId = rec.payload.parent_thread_id || rec.payload.forked_from_id || null;
      if (rec.payload.model) model = sanitizeFleetText(rec.payload.model);
    } else if (rec.type === 'event_msg' && rec.payload?.type === 'token_count') {
      const info = rec.payload.info?.total_token_usage;
      if (info && Number.isFinite(info.total_tokens)) totalTokens = Math.max(totalTokens, info.total_tokens);
    } else if (rec.type === 'response_item' && rec.payload) {
      if (rec.payload.role === 'user' && !prompt && Array.isArray(rec.payload.content)) {
        const txt = rec.payload.content.map(c => c?.text || '').join(' ').trim();
        if (txt) prompt = sanitizeFleetText(txt.slice(0, 1200));
      }
      if (rec.payload.type === 'function_call' && rec.payload.name === 'spawn_agent') {
        spawned.push({ seq: steps, time: rec.timestamp || updatedAt, rawArgs: sanitizeFleetText(String(rec.payload.arguments || '').slice(0, 2000)) });
      }
    }
  }
  return {
    id: String(id),
    parentId: parentId ? String(parentId) : null,
    workspaceHint: cwd ? basename(cwd) : '',
    startedAt,
    updatedAt,
    durationMs: startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0,
    steps,
    model,
    duty: summarizeDutyFromPrompt(prompt, `Codex 会话 ${String(id).slice(0, 8)}`),
    prompt,
    totalTokens,
    spawned,
  };
}

export async function collectSessionFleet({
  root = '.',
  catalog = null,
  sandboxActive = false,
  maxAntigravityDirs = 18,
  env = process.env,
} = {}) {
  const home = env?.HOME || homedir();
  const brainDir = env?.STUDIO_ANTIGRAVITY_BRAIN_DIR || join(home, '.gemini', 'antigravity', 'brain');
  const claudeDir = env?.STUDIO_CLAUDE_PROJECTS_DIR || join(home, '.claude', 'projects');
  const codexDir = env?.STUDIO_CODEX_SESSIONS_DIR || join(home, '.codex', 'sessions');
  const localFleetDir = join(root, '.skill-family-studio', 'fleet');
  const cacheKey = `${root}|${sandboxActive ? '1' : '0'}|${brainDir}|${claudeDir}|${codexDir}`;
  if (!sandboxActive && fleetCache.key === cacheKey && Date.now() - fleetCache.at < 5000 && fleetCache.result) {
    return fleetCache.result;
  }

  const families = [];
  const sourcesScanned = { antigravity: 0, claude: 0, codex: 0, local: 0 };

  if (sandboxActive) {
    families.push(buildSandboxFleetSample());
  }

  // 1. 扫描 Antigravity 多智能体会话日志（只读、按更新时间降序且限制扫描规模）
  try {
    const dirEnts = await readdir(brainDir, { withFileTypes: true });
    const withStats = [];
    for (const ent of dirEnts) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const logPath = join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = await lstat(logPath);
        if (st.isFile() && !st.isSymbolicLink()) withStats.push({ id: ent.name, logPath, mtimeMs: st.mtimeMs });
      } catch {}
    }
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recent = withStats.slice(0, maxAntigravityDirs);
    const parsedList = await Promise.all(recent.map(async item => {
      const lines = await readJsonlLinesBounded(item.logPath, 2_200_000, 1800);
      return parseAntigravityTranscript(lines, item.id);
    }));
    sourcesScanned.antigravity = parsedList.length;

    const byId = new Map(parsedList.map(p => [p.id, p]));
    const childIds = new Set();
    for (const p of parsedList) {
      for (const ch of p.spawnedChildren) childIds.add(ch.childId);
    }
    const repoNames = new Set([basename(root), ...(catalog?.repos || []).map(r => r.name)].filter(Boolean));
    for (const p of parsedList) {
      if (childIds.has(p.id)) continue;
      if (p.spawnedChildren.length === 0 && p.steps < 3) continue;
      const fam = buildFamilyFromParsedSessions(p, byId);
      fam.repoMatched = Boolean(p.workspaceHint && repoNames.has(p.workspaceHint));
      families.push(fam);
    }
  } catch {}

  // 2. 扫描 Claude Code 项目会话与 subagents 目录（有界只读）
  try {
    const projDirs = await readdir(claudeDir, { withFileTypes: true });
    const candFiles = [];
    for (const pd of projDirs.slice(0, 12)) {
      if (!pd.isDirectory()) continue;
      const pAbs = join(claudeDir, pd.name);
      let files = [];
      try { files = await readdir(pAbs, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        try {
          const st = await lstat(join(pAbs, f.name));
          if (st.isFile() && !st.isSymbolicLink()) candFiles.push({ proj: pd.name, id: basename(f.name, '.jsonl'), abs: join(pAbs, f.name), dir: join(pAbs, basename(f.name, '.jsonl'), 'subagents'), mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
    candFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const cf of candFiles.slice(0, 6)) {
      const lines = await readJsonlLinesBounded(cf.abs, 1_000_000, 800);
      const subMap = new Map();
      try {
        const subEnts = await readdir(cf.dir, { withFileTypes: true });
        for (const se of subEnts.slice(0, 12)) {
          if (se.isFile() && se.name.endsWith('.jsonl')) {
            subMap.set(basename(se.name, '.jsonl'), await readJsonlLinesBounded(join(cf.dir, se.name), 500_000, 400));
          }
        }
      } catch {}
      sourcesScanned.claude += 1;
      const fam = parseClaudeSessionJsonl(lines, cf.id, subMap);
      if (fam.agents.length > 1 || fam.delegations.length > 0) families.push(fam);
    }
  } catch {}

  // 3. 扫描 Codex 最近会话日志并关联 parent_thread_id / spawned（有界只读）
  try {
    const codexFiles = [];
    const walkCodex = async (dir, depth = 0) => {
      if (depth > 3 || codexFiles.length >= 24) return;
      let ents = [];
      try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
      ents.sort((a, b) => b.name.localeCompare(a.name));
      for (const e of ents) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walkCodex(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const st = await lstat(full);
            if (st.isFile() && !st.isSymbolicLink()) codexFiles.push({ abs: full, mtimeMs: st.mtimeMs });
          } catch {}
        }
      }
    };
    await walkCodex(codexDir);
    codexFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const parsedCodex = await Promise.all(codexFiles.slice(0, 10).map(async f => parseCodexSessionJsonl(await readJsonlLinesBounded(f.abs, 800_000, 500), basename(f.abs, '.jsonl'))));
    sourcesScanned.codex = parsedCodex.length;
    const codexChildren = new Map();
    for (const c of parsedCodex) {
      if (c.parentId) {
        if (!codexChildren.has(c.parentId)) codexChildren.set(c.parentId, []);
        codexChildren.get(c.parentId).push(c);
      }
    }
    for (const rootC of parsedCodex) {
      const kids = codexChildren.get(rootC.id) || [];
      if (rootC.parentId || (kids.length === 0 && rootC.spawned.length === 0)) continue;
      const agents = [{
        id: rootC.id, parentId: null, depth: 0, name: rootC.duty, role: 'coordinator', roleShort: '主控',
        hueIndex: 0, model: rootC.model, status: 'completed', startedAt: rootC.startedAt, updatedAt: rootC.updatedAt,
        durationMs: rootC.durationMs, steps: rootC.steps, tokens: { input: 0, cacheRead: 0, output: 0, total: rootC.totalTokens },
        loadPercent: 0, duty: rootC.duty, prompt: rootC.prompt, executionMode: 'Codex 主线程',
      }];
      const delegations = [];
      const events = [];
      kids.forEach((k, i) => {
        agents.push({
          id: k.id, parentId: rootC.id, depth: 1, name: k.duty, role: 'subagent', roleShort: inferRoleBadge(k.duty, false, false),
          hueIndex: (i + 1) % 8, model: k.model, status: 'completed', startedAt: k.startedAt, updatedAt: k.updatedAt,
          durationMs: k.durationMs, steps: k.steps, tokens: { input: 0, cacheRead: 0, output: 0, total: k.totalTokens },
          loadPercent: 0, duty: k.duty, prompt: k.prompt, executionMode: 'Codex 派生线程',
        });
        delegations.push({ id: `cx-del-${k.id}`, seq: i + 1, time: k.startedAt, from: rootC.id, to: k.id, label: k.duty, mode: 'subagent', status: 'completed', prompt: k.prompt });
        events.push({ id: `cx-ev-${k.id}`, seq: i + 1, time: k.startedAt, kind: 'delegation', kindLabel: '子会话委派', from: rootC.id, to: k.id, duty: k.duty, executionMode: 'Codex 派生线程', summary: k.duty, body: k.prompt, note: '来自 Codex 会话 parent_thread_id 树归并。' });
      });
      const sumTok = agents.reduce((s, a) => s + a.tokens.total, 0);
      for (const a of agents) a.loadPercent = sumTok > 0 ? Number(((a.tokens.total / sumTok) * 100).toFixed(1)) : 0;
      families.push({
        id: `cx:${rootC.id}`, host: 'codex', title: rootC.duty, repoHint: rootC.workspaceHint, startedAt: rootC.startedAt, updatedAt: rootC.updatedAt,
        summary: { totalAgents: agents.length, runningAgents: 0, totalDelegations: delegations.length, totalMessages: events.length, totalTokens: sumTok },
        agents, delegations, events,
      });
    }
  } catch {}

  // 2. 读取本地 .skill-family-studio/fleet/*.json（支持外部或测试注入编队快照）
  try {
    const localEnts = await readdir(localFleetDir, { withFileTypes: true });
    for (const ent of localEnts) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const abs = join(localFleetDir, ent.name);
      if (SENSITIVE_PATH_RE.test(abs)) continue;
      const doc = JSON.parse(await readFile(abs, 'utf8'));
      if (doc && Array.isArray(doc.agents)) {
        sourcesScanned.local += 1;
        families.push({
          id: sanitizeFleetText(doc.id || basename(ent.name, '.json')),
          host: sanitizeFleetText(doc.host || 'local'),
          title: sanitizeFleetText(doc.title || basename(ent.name, '.json')),
          repoHint: sanitizeFleetText(doc.repoHint || basename(root)),
          startedAt: doc.startedAt || null,
          updatedAt: doc.updatedAt || null,
          summary: doc.summary || {
            totalAgents: doc.agents.length,
            runningAgents: doc.agents.filter(a => a.status === 'running').length,
            totalDelegations: (doc.delegations || []).length,
            totalMessages: (doc.events || []).length,
            totalTokens: doc.agents.reduce((s, a) => s + (a.tokens?.total || 0), 0),
          },
          agents: doc.agents.map(a => ({ ...a, name: sanitizeFleetText(a.name), duty: sanitizeFleetText(a.duty), prompt: sanitizeFleetText(a.prompt) })),
          delegations: (doc.delegations || []).map(d => ({ ...d, label: sanitizeFleetText(d.label), prompt: sanitizeFleetText(d.prompt) })),
          events: (doc.events || []).map(e => ({ ...e, summary: sanitizeFleetText(e.summary), body: sanitizeFleetText(e.body) })),
        });
      }
    }
  } catch {}

  // 若真实机器尚未扫描出任何编队，仍保留可预览状态标记
  families.sort((a, b) => {
    if (a.host === 'sandbox' && b.host !== 'sandbox') return -1;
    if (b.host === 'sandbox' && a.host !== 'sandbox') return 1;
    if (Boolean(a.repoMatched) !== Boolean(b.repoMatched)) return a.repoMatched ? -1 : 1;
    return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
  });

  const result = {
    schemaVersion: 1,
    ok: true,
    generatedAt: new Date().toISOString(),
    sourcesScanned,
    familiesCount: families.length,
    families: families.slice(0, 12),
  };
  if (!sandboxActive) fleetCache = { key: cacheKey, at: Date.now(), result };
  return result;
}
