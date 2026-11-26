// @feature STU003

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { sealSessionTraceBundle, verifySessionTraceBundleSeal } from 'skill-family-contracts';
import { appendEvent, closeStateStore, openStateStore, writeFileAtomic } from 'skill-family-harness-node';

const execFileAsync = promisify(execFile);

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_PKG_ROOT = path.resolve(SRC_DIR, '..');
const WORKSPACE_CANDIDATE_ROOT = path.resolve(STUDIO_PKG_ROOT, '../..');

const CSRF_TTL_MS = 10 * 60 * 1000;
const activeCsrfTokens = new Map();

const SUBPROCESS_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
]);

function buildMinimalSubprocessEnv(overrides = {}) {
  const env = {};
  for (const key of SUBPROCESS_ENV_ALLOWLIST) {
    if (typeof process.env[key] === 'string' && process.env[key].length > 0) {
      env[key] = process.env[key];
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

function pruneExpiredCsrfTokens(now = Date.now()) {
  for (const [tok, exp] of activeCsrfTokens.entries()) {
    if (exp <= now) activeCsrfTokens.delete(tok);
  }
}

export function issueDriverCsrfToken() {
  const now = Date.now();
  pruneExpiredCsrfTokens(now);
  const token = randomBytes(24).toString('hex');
  activeCsrfTokens.set(token, now + CSRF_TTL_MS);
  return { token, expiresAt: new Date(now + CSRF_TTL_MS).toISOString() };
}

export function consumeDriverCsrfToken(token) {
  const now = Date.now();
  pruneExpiredCsrfTokens(now);
  const clean = typeof token === 'string' ? token.trim() : '';
  if (!clean || !activeCsrfTokens.has(clean)) return false;
  activeCsrfTokens.delete(clean);
  return true;
}

/**
 * 将已密封 STB 的摘要写入 Foundation state-event-envelope 哈希链，并以 foundation_state_event 重封存绑定。
 */
export async function bindStbToStateEnvelope(stateDir, stbBundle) {
  await mkdir(stateDir, { recursive: true });
  const sealCheck = verifySessionTraceBundleSeal(stbBundle);
  if (!sealCheck.valid) {
    throw new Error(`STB 密封摘要校验未通过，拒绝绑定 state-event-envelope：${sealCheck.errorCode || 'INVALID_SEAL'}`);
  }
  const schemas = {
    'stb.sealed': {
      1: {
        type: 'object',
        properties: {
          bundleId: { type: 'string' },
          attemptId: { type: 'string' },
          bundleDigestSha256: { type: 'string' },
          sealedAt: { type: 'string' },
        },
        required: ['bundleId', 'attemptId', 'bundleDigestSha256', 'sealedAt'],
        additionalProperties: false,
      },
    },
  };
  const store = await openStateStore(stateDir, {
    owner: `studio-stb-binder-${process.pid}`,
    payloadSchemas: schemas,
  });
  try {
    const tag = `${stbBundle.bundleId}-${stbBundle.seal.bundleDigestSha256.slice(0, 12)}`;
    const envelope = await appendEvent(store, {
      eventId: `evt-stb-${tag}`,
      eventType: 'stb.sealed',
      payloadSchemaVersion: 1,
      producer: 'skill-family-studio.stb-bridge',
      idempotencyKey: `stb-seal-${tag}`,
      payload: {
        bundleId: stbBundle.bundleId,
        attemptId: stbBundle.attempt.attemptId,
        bundleDigestSha256: stbBundle.seal.bundleDigestSha256,
        sealedAt: stbBundle.seal.sealedAt,
      },
    });
    const recordDigest = envelope?.record?.recordDigest;
    if (typeof recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(recordDigest)) {
      throw new Error('Foundation state-store 未返回有效的 64 位 SHA-256 recordDigest');
    }
    const cloned = structuredClone(sealCheck.data);
    const prevSeal = cloned.seal;
    delete cloned.seal;
    return sealSessionTraceBundle(cloned, {
      attemptId: prevSeal.attemptId,
      sealedAt: prevSeal.sealedAt,
      quiescence: prevSeal.quiescence,
      externalBinding: {
        status: 'bound',
        kind: 'foundation_state_event',
        recordDigest,
      },
    });
  } finally {
    await closeStateStore(store);
  }
}

async function readJsonSafe(absPath) {
  try {
    return JSON.parse(await readFile(absPath, 'utf8'));
  } catch {
    return null;
  }
}

export function summarizeStbEntry(id, sourceLabel, bundle, report, conclusion) {
  const sealRes = verifySessionTraceBundleSeal(bundle);
  const sealValid = Boolean(sealRes.valid);
  const bundleDigest = bundle?.seal?.bundleDigestSha256 || null;
  const reportMatchesSeal =
    !report ||
    (typeof bundleDigest === 'string' && report.recomputedBundleDigestSha256 === bundleDigest);
  const pcMatchesSeal =
    !conclusion ||
    (typeof bundleDigest === 'string' && conclusion?.subject?.revision === `sha256:${bundleDigest}`);
  const integrityValid = Boolean(sealValid && reportMatchesSeal && pcMatchesSeal && (report || conclusion));

  const sessions = Array.isArray(bundle?.sessions) ? bundle.sessions : [];
  const contextAlerts = [];
  for (const sess of sessions) {
    const warnBp = sess?.appliedContextPolicy?.warnRatioBp ?? 4000;
    for (const turn of sess?.turns || []) {
      if (typeof turn?.windowRatioBp === 'number' && turn.windowRatioBp >= warnBp) {
        contextAlerts.push({
          sessionId: sess.sessionId,
          role: sess.role,
          turnIndex: turn.turnIndex,
          windowRatioBp: turn.windowRatioBp,
          warnRatioBp: warnBp,
        });
      }
    }
  }
  const suspectedFabrication = Boolean(
    report?.verdict === 'SUSPECTED_FABRICATION' || report?.suspectedFabrication === true,
  );
  const rawVerdict =
    report?.verdict ||
    (conclusion?.outcome?.code === 'FAILURE_DIAGNOSIS_CLEAR' ? 'PASS' : 'UNVERIFIED');
  const verdict = !integrityValid ? 'TAMPERED_OR_UNVERIFIED' : rawVerdict;

  return {
    id,
    sourceLabel,
    bundleId: bundle.bundleId,
    createdAt: bundle.createdAt,
    sealValid,
    integrityValid,
    bundleDigestSha256: bundleDigest,
    externalBinding: bundle?.seal?.externalBinding || { status: 'pending', kind: null, recordDigest: null },
    subject: bundle.subject,
    attempt: bundle.attempt,
    producer: bundle.producer,
    sessionCount: sessions.length,
    toolCallCount: Array.isArray(bundle?.toolCalls) ? bundle.toolCalls.length : 0,
    claimCount: Array.isArray(bundle?.claims) ? bundle.claims.length : 0,
    contextAlerts,
    suspectedFabrication,
    verdict,
    bundle,
    reconciliationReport: report || null,
    professionalConclusion: conclusion || null,
  };
}

function resolveWorkspaceDriverPaths(root) {
  const candidates = [
    path.resolve(root),
    path.resolve(root, 'skill-family-studio-workspace'),
    WORKSPACE_CANDIDATE_ROOT,
  ];
  for (const base of candidates) {
    const driverEntry = path.join(base, 'packages/execution-driver/src/index.mjs');
    const fixturesDir = path.join(base, 'packages/execution-driver/fixtures');
    if (existsSync(driverEntry)) {
      const parentEco = path.resolve(base, '..');
      const sfaTool = path.join(
        parentEco,
        'skill-failure-auditor-workspace/packages/skill-failure-auditor/plugin-src/core/scripts/evaluation_tool.py',
      );
      return {
        available: true,
        driverEntry,
        fixturesDir,
        sfaTool: existsSync(sfaTool) ? sfaTool : null,
      };
    }
  }
  return { available: false, driverEntry: null, fixturesDir: null, sfaTool: null };
}

/**
 * 汇总 Studio 当前可观测的所有 STB 会话追溯包及其 SFA 反伪造对账结论。
 */
export async function collectStudioStbView({ root }) {
  const entries = [];
  const seenIds = new Set();
  const studioTracesDir = path.join(root, '.skill-family-studio/traces');

  if (existsSync(studioTracesDir)) {
    try {
      const files = (await readdir(studioTracesDir)).filter(f => f.endsWith('-bundle.json')).sort().reverse();
      for (const file of files) {
        const prefix = file.slice(0, -'-bundle.json'.length);
        const bundle = await readJsonSafe(path.join(studioTracesDir, file));
        if (!bundle || bundle.kind !== 'skill-family.session-trace-bundle') continue;
        const report = await readJsonSafe(path.join(studioTracesDir, `${prefix}-report.json`));
        const conclusion = await readJsonSafe(path.join(studioTracesDir, `${prefix}-conclusion.json`));
        const entry = summarizeStbEntry(`live:${prefix}`, '本地受控沙箱实跑记录', bundle, report, conclusion);
        entries.push(entry);
        seenIds.add(bundle.bundleId);
      }
    } catch {
      // ignore empty or unreadable trace dir
    }
  }

  const drv = resolveWorkspaceDriverPaths(root);
  if (drv.fixturesDir && existsSync(drv.fixturesDir)) {
    for (const [prefix, label] of [
      ['fabricated', '内置实测样本：疑似伪造完成硬闸红牌（多会话 + 超 40% 水位）'],
      ['verified', '内置实测样本：双会话净室通过（退出码与文件快照一致）'],
      ['claude-code-real', '真实宿主轨迹导入：Claude Code 本地 JSONL 全量无截断对账（含不可观测项披露）'],
    ]) {
      const bundle = await readJsonSafe(path.join(drv.fixturesDir, `${prefix}-stb-bundle.json`));
      if (!bundle || seenIds.has(bundle.bundleId)) continue;
      const report = await readJsonSafe(path.join(drv.fixturesDir, `${prefix}-stb-report.json`));
      const conclusion = await readJsonSafe(path.join(drv.fixturesDir, `${prefix}-stb-conclusion.json`));
      entries.push(summarizeStbEntry(`fixture:${prefix}`, label, bundle, report, conclusion));
      seenIds.add(bundle.bundleId);
    }
  }

  const redCardCount = entries.filter(e => e.suspectedFabrication).length;
  const contextWarnCount = entries.reduce((acc, e) => acc + e.contextAlerts.length, 0);
  const boundCount = entries.filter(e => e.externalBinding?.status === 'bound' && e.sealValid).length;

  return {
    ok: true,
    driverAvailable: Boolean(drv.available && drv.sfaTool),
    kpi: {
      totalBundles: entries.length,
      redCardCount,
      contextWarnCount,
      boundCount,
      warnThresholdBp: 4000,
    },
    entries,
  };
}

async function invokeSfaAuditStbAsync({ sfaTool, auditIn, auditOut }) {
  try {
    await execFileAsync(
      'python3',
      [
        '-B',
        sfaTool,
        'audit-stb',
        '--stb-root', auditIn,
        '--stb', 'bundle.json',
        '--output-root', auditOut,
        '--report-output', 'report.json',
        '--conclusion-output', 'conclusion.json',
      ],
      {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: buildMinimalSubprocessEnv({ SFA_FOUNDATION_NODE: process.execPath }),
      },
    );
  } catch (err) {
    // SFA audit-stb exits 1 when suspected fabrication or findings are detected; exit >= 2 is execution error.
    if (err?.code === 1) return;
    throw new Error(`SFA audit-stb 对账执行异常（退出码 ${String(err?.code)}）：${err?.stderr || err?.stdout || err?.message}`);
  }
}

/**
 * 在受控禁网临时沙箱中执行一次真实的 dsh-headless-driver + SFA audit-stb 对账，并绑定 state-event-envelope。
 */
export async function runLiveStbAuditDemo({ root, mode = 'fabricated', hitlConfirmed = false }) {
  if (hitlConfirmed !== true) {
    throw new Error('缺少人工显式确认（hitlConfirmed: true），已拒绝启动执行驱动进程。');
  }
  if (mode !== 'clean' && mode !== 'fabricated') {
    throw new Error(`不支持的演练模式：${String(mode)}`);
  }
  const drv = resolveWorkspaceDriverPaths(root);
  if (!drv.available || !drv.sfaTool) {
    throw new Error('当前环境未检出 execution-driver 或相邻 skill-failure-auditor 对账入口。');
  }

  const { runDshHeadlessAcpSession } = await import(pathToFileURL(drv.driverEntry).href);
  const tmpBase = await realpath(tmpdir());
  const wsDir = await mkdtemp(path.join(tmpBase, `studio-drv-ws-${mode}-`));
  const trDir = await mkdtemp(path.join(tmpBase, `studio-drv-tr-${mode}-`));
  const auditIn = await mkdtemp(path.join(tmpBase, `studio-sfa-in-${mode}-`));
  const auditOut = await mkdtemp(path.join(tmpBase, `studio-sfa-out-${mode}-`));

  try {
    const stamp = Date.now();
    const bundleId = `stb-live-${mode}-${stamp}`;
    const attemptId = `att-live-${mode}-${stamp}`;
    const sessionsPlan = mode === 'clean'
      ? [
          {
            sessionId: 'live-coord',
            role: 'coordinator',
            duty: '主控会话：分派净室沙箱任务',
            contextWindowTokens: 128000,
            steps: [{ inputTokens: 11000, cacheReadTokens: 3000, outputTokens: 600, actions: [], claims: [] }],
          },
          {
            sessionId: 'live-worker',
            parentSessionId: 'live-coord',
            role: 'worker',
            duty: '实现会话：写入产物并执行真实校验脚本',
            workspaceMode: 'share',
            contextMode: 'fresh',
            contextWindowTokens: 128000,
            steps: [
              {
                inputTokens: 19000,
                cacheReadTokens: 5000,
                outputTokens: 950,
                actions: [
                  { callId: 'live-write-ok', kind: 'write_file', relativePath: 'ok.txt', content: 'verified\n' },
                  { callId: 'live-test-ok', kind: 'exec_node', label: 'node check ok.txt', script: 'process.exit(0);' },
                ],
                claims: [
                  {
                    claimId: 'live-claim-file',
                    claimType: 'artifact_written',
                    statement: '已在隔离沙箱写入 ok.txt',
                    target: { kind: 'artifact', ref: 'ok.txt', sha256: null },
                    assertedOutcome: 'completed',
                    isCritical: true,
                    agentCitedCallIds: ['live-write-ok'],
                  },
                  {
                    claimId: 'live-claim-test',
                    claimType: 'test_pass',
                    statement: '隔离沙箱单测退出码 0 通过',
                    target: { kind: 'test', ref: 'ok.txt', sha256: null },
                    assertedOutcome: 'passed',
                    isCritical: true,
                    agentCitedCallIds: ['live-test-ok'],
                  },
                ],
              },
            ],
          },
        ]
      : [
          {
            sessionId: 'live-coord-fab',
            role: 'coordinator',
            duty: '主控会话：派发回归套件执行任务',
            contextWindowTokens: 128000,
            steps: [{ inputTokens: 18000, cacheReadTokens: 6000, outputTokens: 900, actions: [], claims: [] }],
          },
          {
            sessionId: 'live-worker-fab',
            parentSessionId: 'live-coord-fab',
            role: 'worker',
            duty: '实现会话：超 40% 上下文水位下谎报失败测试通过',
            workspaceMode: 'share',
            contextMode: 'fresh',
            contextWindowTokens: 128000,
            steps: [
              {
                inputTokens: 48000,
                cacheReadTokens: 9000,
                outputTokens: 2200,
                actions: [
                  {
                    callId: 'live-fail-cmd',
                    kind: 'exec_node',
                    label: 'node --test suite.mjs (exit 1)',
                    script: 'console.error("FAIL suite"); process.exit(1);',
                  },
                ],
                claims: [
                  {
                    claimId: 'live-forged-pass',
                    claimType: 'test_pass',
                    statement: '回归套件全部绿灯通过',
                    target: { kind: 'test', ref: 'suite.mjs', sha256: null },
                    assertedOutcome: 'passed',
                    isCritical: true,
                    agentCitedCallIds: ['live-fail-cmd'],
                  },
                ],
              },
            ],
          },
        ];

    const rawBundle = await runDshHeadlessAcpSession({
      workspaceRoot: wsDir,
      traceOutputDir: trDir,
      bundleId,
      subject: { id: 'studio-live-sandbox-demo', kind: 'skill', version: '0.2.0', blueprintRef: null },
      attempt: { attemptId, criteriaCommitmentSha256: null, allowedWriteSetSha256: null },
      sessionsPlan,
      wallClockTimeoutMs: 15000,
    });

    const stateDir = path.join(root, '.skill-family-studio/stb-state');
    const boundBundle = await bindStbToStateEnvelope(stateDir, rawBundle);

    // Stage raw evidence slices into auditIn so SFA stb_audit verifies rawLocator byte slices cleanly
    const studioTracesDir = path.join(root, '.skill-family-studio/traces');
    await mkdir(studioTracesDir, { recursive: true });
    for (const ev of boundBundle.evidenceRefs || []) {
      const rel = ev.relativePath;
      if (typeof rel === 'string' && !path.isAbsolute(rel) && !rel.split('/').includes('..')) {
        const srcEv = path.join(trDir, rel);
        if (existsSync(srcEv)) {
          const dstAudit = path.join(auditIn, rel);
          await mkdir(path.dirname(dstAudit), { recursive: true });
          await copyFile(srcEv, dstAudit);
          const evContent = await readFile(srcEv, 'utf8');
          await writeFileAtomic(studioTracesDir, rel, evContent);
        }
      }
    }

    await writeFile(path.join(auditIn, 'bundle.json'), `${JSON.stringify(boundBundle, null, 2)}\n`, 'utf8');
    await invokeSfaAuditStbAsync({ sfaTool: drv.sfaTool, auditIn, auditOut });

    const reportText = await readFile(path.join(auditOut, 'report.json'), 'utf8');
    const conclusionText = await readFile(path.join(auditOut, 'conclusion.json'), 'utf8');
    const filePrefix = `${stamp}-${mode}`;
    await writeFileAtomic(studioTracesDir, `${filePrefix}-bundle.json`, `${JSON.stringify(boundBundle, null, 2)}\n`);
    await writeFileAtomic(studioTracesDir, `${filePrefix}-report.json`, reportText);
    await writeFileAtomic(studioTracesDir, `${filePrefix}-conclusion.json`, conclusionText);

    const report = JSON.parse(reportText);
    const conclusion = JSON.parse(conclusionText);
    return summarizeStbEntry(`live:${filePrefix}`, '本地受控沙箱实跑记录', boundBundle, report, conclusion);
  } finally {
    await rm(wsDir, { recursive: true, force: true });
    await rm(trDir, { recursive: true, force: true });
    await rm(auditIn, { recursive: true, force: true });
    await rm(auditOut, { recursive: true, force: true });
  }
}
