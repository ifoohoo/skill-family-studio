// @feature STU007
// @scenario S-012
// @design design-studio-server-and-governance-v3

import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  digestDocument,
  sealSessionTraceBundle,
  verifySessionTraceBundleSeal,
} from 'skill-family-contracts';
import {
  HARNESS_ERROR_KINDS,
  appendEvent,
  appendUsageEvent,
  closeStateStore,
  closeUsageGuard,
  openStateStore,
  openUsageGuard,
  readEvents,
  readUsage,
  resolveContained,
  writeFileAtomic,
} from 'skill-family-harness-node';
import {
  ComplianceAuditLedger,
  MIN_RETENTION_DAYS,
  assertValidRetentionDays,
  buildDengbaoEvidenceMappingReport,
  exportAuditEventsToSiemNdjson,
  exportStbToOtelSpans,
  redactCompliancePayload,
} from './otel-siem-exporter.mjs';
import { isSafeLoopbackHost, isSafeLoopbackOrigin } from './server.mjs';
import { resolveWorkspaceDriverPaths } from './stb-bridge.mjs';

const execFileAsync = promisify(execFile);
const HEX64_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_HITL_TTL_MS = 604_800_000;
const MAX_RAW_EVIDENCE_FILES = 16;
const MAX_RAW_EVIDENCE_BYTES = 65_536;
const RESERVED_EVIDENCE_FILENAMES = new Set([
  'bundle.json',
  'report.json',
  'conclusion.json',
  'repro-candidate.json',
]);

export const GOVERNANCE_PROFILES = Object.freeze(['solo', 'team', 'regulated']);
export const APPROVAL_MODES = Object.freeze(['off', 'self', 'dual']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const ROLE_PERMISSIONS = Object.freeze({
  viewer: Object.freeze(['telemetry:read', 'hitl:read', 'incident:read']),
  operator: Object.freeze([
    'telemetry:read',
    'telemetry:ingest',
    'quota:evaluate',
    'hitl:read',
    'hitl:request',
    'incident:read',
  ]),
  approver: Object.freeze(['telemetry:read', 'hitl:read', 'hitl:decide']),
  auditor: Object.freeze(['telemetry:read', 'hitl:read', 'incident:read', 'compliance:export']),
  tenant_admin: Object.freeze([
    'telemetry:read',
    'telemetry:ingest',
    'quota:evaluate',
    'quota:manage',
    'hitl:read',
    'hitl:request',
    'incident:read',
    'incident:triage',
    'compliance:export',
  ]),
});

const SUBPROCESS_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
]);

function collectorError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function assertNonNegativeSafeInt(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw collectorError(
      'INVALID_QUOTA_DELTA',
      `${fieldName} 必须为非负安全整数（当前值：${String(value)}）。`,
      400,
    );
  }
  return value;
}

function sanitizeRawEvidenceFiles(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw collectorError('INVALID_RAW_EVIDENCE_FILES', 'rawEvidenceFiles 必须为普通键值对象。', 400);
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_RAW_EVIDENCE_FILES) {
    throw collectorError(
      'RAW_EVIDENCE_LIMIT_EXCEEDED',
      `rawEvidenceFiles 文件数不得超过 ${MAX_RAW_EVIDENCE_FILES} 个。`,
      400,
    );
  }
  const clean = {};
  let totalBytes = 0;
  for (const [relPath, content] of entries) {
    if (
      typeof relPath !== 'string' ||
      !relPath.trim() ||
      relPath.includes('\0') ||
      relPath.includes('\\') ||
      path.posix.isAbsolute(relPath)
    ) {
      throw collectorError('UNSAFE_RAW_EVIDENCE_PATH', `不安全的附属证据相对路径：${String(relPath)}`, 400);
    }
    const normalized = path.posix.normalize(relPath).replace(/^\.\//, '');
    const segments = normalized.split('/');
    if (
      !normalized ||
      segments.some(seg => !seg || seg === '.' || seg === '..') ||
      RESERVED_EVIDENCE_FILENAMES.has(segments[segments.length - 1])
    ) {
      throw collectorError('UNSAFE_RAW_EVIDENCE_PATH', `禁止写入保留或越界路径：${String(relPath)}`, 400);
    }
    if (typeof content !== 'string') {
      throw collectorError('INVALID_RAW_EVIDENCE_FILES', `附属证据 ${normalized} 内容必须为字符串。`, 400);
    }
    const scrubbedText = String(redactCompliancePayload(content));
    totalBytes += Buffer.byteLength(scrubbedText, 'utf8');
    if (totalBytes > MAX_RAW_EVIDENCE_BYTES) {
      throw collectorError('RAW_EVIDENCE_LIMIT_EXCEEDED', 'rawEvidenceFiles 总字节数超过 64KiB 上限。', 400);
    }
    clean[normalized] = scrubbedText;
  }
  return clean;
}

function buildMinimalEnv(overrides = {}) {
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

export class LoopbackSoloAuthProvider {
  #principalId;
  #tenantId;

  constructor({ principalId = 'local-solo-owner', tenantId = 'local' } = {}) {
    this.#principalId = principalId;
    this.#tenantId = tenantId;
  }

  get summary() {
    return {
      kind: 'loopback-solo',
      principalCount: 1,
      zeroPlaintextTokens: true,
      authRequired: false,
      tenants: [this.#tenantId],
    };
  }

  authorize({ targetTenantId = null } = {}) {
    return {
      ok: true,
      statusCode: 200,
      code: 'SOLO_LOOPBACK_AUTHORIZED',
      principal: {
        principalId: this.#principalId,
        tenantId: targetTenantId || this.#tenantId,
        roles: Object.freeze(['tenant_admin', 'operator', 'approver', 'auditor']),
      },
    };
  }
}

export class TenantRbacAuthorizer {
  #principals = [];
  #secretVaultProvider = null;
  #hasVaultPrincipals = false;

  constructor({ principals = [], secretVaultProvider = null } = {}) {
    if (secretVaultProvider !== null && typeof secretVaultProvider?.resolvePrincipalDigest !== 'function') {
      throw collectorError('INVALID_SECRET_VAULT_PROVIDER', 'secretVaultProvider 必须实现 resolvePrincipalDigest(principalId)。', 500);
    }
    this.#secretVaultProvider = secretVaultProvider;
    if (!Array.isArray(principals) || principals.length === 0) {
      throw collectorError('RBAC_PRINCIPALS_REQUIRED', 'TenantRbacAuthorizer 至少需要配置一个身份主体。', 500);
    }
    const seenIds = new Set();
    for (const raw of principals) {
      if (!raw || typeof raw !== 'object') {
        throw collectorError('INVALID_PRINCIPAL_CONFIG', '身份主体配置必须为对象。', 500);
      }
      if ('token' in raw || 'secret' in raw || 'apiKey' in raw || 'password' in raw) {
        throw collectorError(
          'PLAINTEXT_SECRET_FORBIDDEN',
          `主体 ${String(raw.principalId || 'unknown')} 含有明文凭据字段，服务端仅允许配置 64 位 SHA-256 tokenSha256 或挂载 secretVaultProvider。`,
          500,
        );
      }
      const principalId = String(raw.principalId || '').trim();
      const tenantId = String(raw.tenantId || '').trim();
      if (!SAFE_ID_RE.test(principalId) || !SAFE_ID_RE.test(tenantId)) {
        throw collectorError('INVALID_PRINCIPAL_IDENTITY', 'principalId 与 tenantId 必须为合法安全标识符。', 500);
      }
      if (seenIds.has(principalId)) {
        throw collectorError('DUPLICATE_PRINCIPAL_ID', `重复的 principalId：${principalId}`, 500);
      }
      let digestBuf = null;
      if (raw.tokenSha256 !== undefined) {
        const cleanHex = String(raw.tokenSha256 || '').trim();
        if (!HEX64_RE.test(cleanHex)) {
          throw collectorError(
            'PLAINTEXT_SECRET_FORBIDDEN',
            `主体 ${principalId} 的 tokenSha256 必须为 64 位小写十六进制 SHA-256 摘要。`,
            500,
          );
        }
        digestBuf = Buffer.from(cleanHex, 'hex');
      } else if (this.#secretVaultProvider) {
        this.#hasVaultPrincipals = true;
      } else {
        throw collectorError(
          'PLAINTEXT_SECRET_FORBIDDEN',
          `主体 ${principalId} 未提供 64 位小写十六进制 tokenSha256 且未挂载 secretVaultProvider。`,
          500,
        );
      }
      if (!Array.isArray(raw.roles) || raw.roles.length === 0) {
        throw collectorError('INVALID_PRINCIPAL_ROLES', `主体 ${principalId} 必须声明至少一个角色。`, 500);
      }
      const permSet = new Set();
      const roles = [];
      for (const r of raw.roles) {
        const roleName = String(r || '').trim();
        const rolePerms = ROLE_PERMISSIONS[roleName];
        if (!rolePerms) {
          throw collectorError('UNKNOWN_RBAC_ROLE', `主体 ${principalId} 包含未知角色：${roleName}`, 500);
        }
        roles.push(roleName);
        for (const p of rolePerms) permSet.add(p);
      }
      seenIds.add(principalId);
      this.#principals.push({
        principalId,
        tenantId,
        roles: Object.freeze(roles),
        permissions: permSet,
        digestBuf,
      });
    }
  }

  get summary() {
    return {
      kind: this.#secretVaultProvider ? 'vault-backed-rbac' : 'static-token-hash-rbac',
      authRequired: true,
      principalCount: this.#principals.length,
      zeroPlaintextTokens: true,
      tenants: [...new Set(this.#principals.map(p => p.tenantId))].sort(),
    };
  }

  #finalizeMatch(matched, requiredPermission, targetTenantId) {
    if (!matched) {
      return {
        ok: false,
        statusCode: 401,
        code: 'AUTH_TOKEN_INVALID',
        principalId: 'anonymous',
        tenantId: targetTenantId || 'unknown',
        reason: 'Bearer 令牌未匹配任何已授权主体。',
      };
    }
    if (targetTenantId && matched.tenantId !== targetTenantId) {
      return {
        ok: false,
        statusCode: 403,
        code: 'RBAC_TENANT_ISOLATION_DENIED',
        principalId: matched.principalId,
        tenantId: matched.tenantId,
        reason: `主体 ${matched.principalId}（租户 ${matched.tenantId}）无权访问目标租户 ${targetTenantId}。`,
      };
    }
    if (requiredPermission && !matched.permissions.has(requiredPermission)) {
      return {
        ok: false,
        statusCode: 403,
        code: 'RBAC_PERMISSION_DENIED',
        principalId: matched.principalId,
        tenantId: matched.tenantId,
        reason: `主体 ${matched.principalId} 缺少所需权限 ${requiredPermission}。`,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      code: 'AUTHORIZED',
      principal: {
        principalId: matched.principalId,
        tenantId: matched.tenantId,
        roles: matched.roles,
      },
    };
  }

  authorize({ authorizationHeader, requiredPermission, targetTenantId = null } = {}) {
    const rawHeader = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
    const m = /^Bearer\s+(\S+)$/i.exec(rawHeader);
    if (!m || !m[1]) {
      return {
        ok: false,
        statusCode: 401,
        code: 'AUTH_BEARER_TOKEN_MISSING',
        principalId: 'anonymous',
        tenantId: targetTenantId || 'unknown',
        reason: '缺少有效的 Authorization: Bearer 令牌。',
      };
    }

    const candidateBuf = createHash('sha256').update(m[1], 'utf8').digest();
    if (!this.#hasVaultPrincipals) {
      let matched = null;
      for (const entry of this.#principals) {
        if (entry.digestBuf && timingSafeEqual(candidateBuf, entry.digestBuf)) {
          matched = entry;
        }
      }
      return this.#finalizeMatch(matched, requiredPermission, targetTenantId);
    }

    return (async () => {
      let matched = null;
      for (const entry of this.#principals) {
        let targetBuf = entry.digestBuf;
        if (!targetBuf && this.#secretVaultProvider) {
          const resolved = await this.#secretVaultProvider.resolvePrincipalDigest(entry.principalId);
          const cleanHex = String(resolved || '').trim();
          if (HEX64_RE.test(cleanHex)) {
            targetBuf = Buffer.from(cleanHex, 'hex');
          }
        }
        if (targetBuf && timingSafeEqual(candidateBuf, targetBuf)) {
          matched = entry;
        }
      }
      return this.#finalizeMatch(matched, requiredPermission, targetTenantId);
    })();
  }
}

export const StaticTokenHashAuthProvider = TenantRbacAuthorizer;

const USAGE_SCHEMAS = Object.freeze({
  'quota.usage': {
    1: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        delta: { type: 'integer' },
      },
      required: ['runId', 'delta'],
      additionalProperties: false,
    },
  },
});

export class QuotaCircuitBreaker {
  #storageRoot;
  #enforced;
  #policies = new Map();
  #recordedRuns = new Map();
  #queue = Promise.resolve();

  constructor({ storageRoot, tenantQuotas = {}, enforced = true } = {}) {
    if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
      throw collectorError('INVALID_QUOTA_ROOT', 'QuotaCircuitBreaker 需要非空 storageRoot。', 500);
    }
    this.#storageRoot = storageRoot;
    this.#enforced = Boolean(enforced);
    for (const [tenantId, policy] of Object.entries(tenantQuotas || {})) {
      this.setTenantQuota(tenantId, policy);
    }
  }

  get enforced() {
    return this.#enforced;
  }

  setTenantQuota(tenantId, policy = {}) {
    if (!SAFE_ID_RE.test(String(tenantId || ''))) {
      throw collectorError('INVALID_TENANT_ID', `非法租户标识：${String(tenantId)}`, 400);
    }
    const maxTotalTokens = Number(policy.maxTotalTokens ?? 5_000_000);
    const maxCostMicrosUsd = Number(policy.maxCostMicrosUsd ?? 50_000_000);
    const maxSingleRunTokens = Number(policy.maxSingleRunTokens ?? 500_000);
    if (
      !Number.isSafeInteger(maxTotalTokens) ||
      maxTotalTokens < 0 ||
      !Number.isSafeInteger(maxCostMicrosUsd) ||
      maxCostMicrosUsd < 0 ||
      !Number.isSafeInteger(maxSingleRunTokens) ||
      maxSingleRunTokens < 0
    ) {
      throw collectorError('INVALID_QUOTA_POLICY', '配额上限必须为非负安全整数。', 400);
    }
    this.#policies.set(tenantId, { maxTotalTokens, maxCostMicrosUsd, maxSingleRunTokens });
  }

  get summary() {
    return {
      enabled: true,
      enforced: this.#enforced,
      configuredTenants: [...this.#policies.keys()].sort(),
    };
  }

  #getPolicy(tenantId) {
    return (
      this.#policies.get(tenantId) || {
        maxTotalTokens: 5_000_000,
        maxCostMicrosUsd: 50_000_000,
        maxSingleRunTokens: 500_000,
      }
    );
  }

  #enqueue(fn) {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  async evaluateAndRecord({
    tenantId,
    runId = `run-${randomUUID()}`,
    tokensDelta = 0,
    costMicrosUsdDelta = 0,
    dryRun = false,
  } = {}) {
    if (!SAFE_ID_RE.test(String(tenantId || '')) || !SAFE_ID_RE.test(String(runId || ''))) {
      throw collectorError('INVALID_QUOTA_IDENTITY', 'tenantId 与 runId 必须为合法安全标识符。', 400);
    }
    const safeTokens = assertNonNegativeSafeInt(tokensDelta, 'tokensDelta');
    const safeCost = assertNonNegativeSafeInt(costMicrosUsdDelta, 'costMicrosUsdDelta');
    const policy = this.#getPolicy(tenantId);

    if (this.#enforced && safeTokens > policy.maxSingleRunTokens) {
      return {
        allowed: false,
        code: 'QUOTA_CIRCUIT_OPEN',
        dimension: 'single_run_tokens',
        limit: policy.maxSingleRunTokens,
        projected: safeTokens,
        tenantId,
      };
    }

    return this.#enqueue(async () => {
      const runKey = `${tenantId}:${runId}`;
      const priorRun = this.#recordedRuns.get(runKey);
      if (!dryRun && priorRun) {
        if (priorRun.tokensDelta !== safeTokens || priorRun.costMicrosUsdDelta !== safeCost) {
          throw collectorError(
            'QUOTA_RUN_ID_CONFLICT',
            `同一租户下 runId ${runId} 已记录过不同的用量增量。`,
            409,
          );
        }
        return { ...priorRun.result, idempotentReplay: true };
      }

      const tenantDir = path.join(this.#storageRoot, `tenant-${tenantId}`);
      const lockRoot = path.join(tenantDir, 'locks');
      await mkdir(lockRoot, { recursive: true });

      const tokGuard = await openUsageGuard({
        stateRoot: path.join(tenantDir, 'tokens-store'),
        lockRoot,
        lockPath: 'tokens.lock',
        owner: `quota-tok-${process.pid}`,
        payloadSchemas: USAGE_SCHEMAS,
        initial: 0,
        upperBound: this.#enforced ? policy.maxTotalTokens : Number.MAX_SAFE_INTEGER,
        reducer: (acc, rec) => acc + Number(rec.payload?.delta || 0),
      });
      let costGuard = null;
      try {
        costGuard = await openUsageGuard({
          stateRoot: path.join(tenantDir, 'cost-store'),
          lockRoot,
          lockPath: 'cost.lock',
          owner: `quota-cost-${process.pid}`,
          payloadSchemas: USAGE_SCHEMAS,
          initial: 0,
          upperBound: this.#enforced ? policy.maxCostMicrosUsd : Number.MAX_SAFE_INTEGER,
          reducer: (acc, rec) => acc + Number(rec.payload?.delta || 0),
        });

        const currentTokens = await readUsage(tokGuard);
        const currentCost = await readUsage(costGuard);

        if (this.#enforced && currentTokens + safeTokens > policy.maxTotalTokens) {
          return {
            allowed: false,
            code: 'QUOTA_CIRCUIT_OPEN',
            dimension: 'tenant_total_tokens',
            limit: policy.maxTotalTokens,
            current: currentTokens,
            projected: currentTokens + safeTokens,
            tenantId,
          };
        }
        if (this.#enforced && currentCost + safeCost > policy.maxCostMicrosUsd) {
          return {
            allowed: false,
            code: 'QUOTA_CIRCUIT_OPEN',
            dimension: 'tenant_cost_micros_usd',
            limit: policy.maxCostMicrosUsd,
            current: currentCost,
            projected: currentCost + safeCost,
            tenantId,
          };
        }

        if (!dryRun && (safeTokens > 0 || safeCost > 0)) {
          await appendUsageEvent(tokGuard, {
            eventId: `tok-${runId}`,
            idempotencyKey: `tok-${runId}`,
            eventType: 'quota.usage',
            payloadSchemaVersion: 1,
            producer: 'skill-family-studio.quota-breaker',
            payload: { runId: String(runId), delta: safeTokens },
          });
          await appendUsageEvent(costGuard, {
            eventId: `cost-${runId}`,
            idempotencyKey: `cost-${runId}`,
            eventType: 'quota.usage',
            payloadSchemaVersion: 1,
            producer: 'skill-family-studio.quota-breaker',
            payload: { runId: String(runId), delta: safeCost },
          });
        }

        const totalTokensUsed = dryRun ? currentTokens : await readUsage(tokGuard);
        const totalCostMicrosUsdUsed = dryRun ? currentCost : await readUsage(costGuard);
        const projectedTokens = dryRun ? currentTokens + safeTokens : totalTokensUsed;
        const projectedCost = dryRun ? currentCost + safeCost : totalCostMicrosUsdUsed;
        const advisoryExceeded =
          !this.#enforced &&
          (safeTokens > policy.maxSingleRunTokens ||
            projectedTokens > policy.maxTotalTokens ||
            projectedCost > policy.maxCostMicrosUsd);
        const outcome = {
          allowed: true,
          code: advisoryExceeded ? 'QUOTA_ADVISORY_EXCEEDED' : 'QUOTA_OK',
          enforced: this.#enforced,
          advisoryExceeded,
          tenantId,
          totalTokensUsed,
          totalCostMicrosUsdUsed,
          limits: policy,
        };
        if (!dryRun) {
          this.#recordedRuns.set(runKey, {
            tokensDelta: safeTokens,
            costMicrosUsdDelta: safeCost,
            result: outcome,
          });
        }
        return outcome;
      } catch (err) {
        if (err?.details?.kind === HARNESS_ERROR_KINDS.UPPER_BOUND_EXCEEDED) {
          return {
            allowed: false,
            code: 'QUOTA_CIRCUIT_OPEN',
            dimension: 'foundation_usage_guard',
            limit: err.details.upperBound,
            projected: err.details.projected,
            tenantId,
          };
        }
        if (err?.code === 'SFC2004') {
          throw collectorError('QUOTA_RUN_ID_CONFLICT', `同一租户下 runId ${runId} 已记录过不同的用量增量。`, 409);
        }
        throw err;
      } finally {
        if (costGuard) await closeUsageGuard(costGuard).catch(() => {});
        await closeUsageGuard(tokGuard).catch(() => {});
      }
    });
  }
}

const HITL_SCHEMAS = Object.freeze({
  'hitl.requested': {
    1: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        tenantId: { type: 'string' },
        requesterPrincipalId: { type: 'string' },
        planDigest: { type: 'string' },
        actionType: { type: 'string' },
        summary: { type: 'string' },
        createdAt: { type: 'string' },
        expiresAt: { type: 'string' },
      },
      required: [
        'requestId',
        'tenantId',
        'requesterPrincipalId',
        'planDigest',
        'actionType',
        'summary',
        'createdAt',
        'expiresAt',
      ],
      additionalProperties: false,
    },
  },
  'hitl.decided': {
    1: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        tenantId: { type: 'string' },
        approverPrincipalId: { type: 'string' },
        decision: { type: 'string' },
        reason: { type: 'string' },
        decidedAt: { type: 'string' },
      },
      required: ['requestId', 'tenantId', 'approverPrincipalId', 'decision', 'reason', 'decidedAt'],
      additionalProperties: false,
    },
  },
});

export class HitlApprovalQueue {
  #stateRoot;
  #approvalMode;
  #queue = Promise.resolve();

  constructor({ stateRoot, approvalMode = 'dual' } = {}) {
    if (typeof stateRoot !== 'string' || !stateRoot.trim()) {
      throw collectorError('INVALID_HITL_ROOT', 'HitlApprovalQueue 需要非空 stateRoot。', 500);
    }
    if (!APPROVAL_MODES.includes(approvalMode)) {
      throw collectorError(
        'INVALID_APPROVAL_MODE',
        `approvalMode 必须为 ${APPROVAL_MODES.join(' | ')} 之一（当前值：${String(approvalMode)}）。`,
        500,
      );
    }
    this.#stateRoot = stateRoot;
    this.#approvalMode = approvalMode;
  }

  get approvalMode() {
    return this.#approvalMode;
  }

  get summary() {
    return {
      approvalMode: this.#approvalMode,
      antiSelfApprovalEnforced: this.#approvalMode === 'dual',
      planDigestBound: true,
    };
  }

  #enqueue(fn) {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  #scopedKey(tenantId, requestId) {
    return `${String(tenantId)}::${String(requestId)}`;
  }

  #foldRequests(events, nowIso = new Date().toISOString()) {
    const nowMs = Date.parse(String(nowIso));
    const map = new Map();
    for (const rec of events) {
      const p = rec.payload || {};
      const key = this.#scopedKey(p.tenantId, p.requestId);
      if (rec.eventType === 'hitl.requested') {
        map.set(key, {
          requestId: p.requestId,
          tenantId: p.tenantId,
          requesterPrincipalId: p.requesterPrincipalId,
          planDigest: p.planDigest,
          actionType: p.actionType,
          summary: p.summary,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
          status: 'PENDING',
          approverPrincipalId: null,
          decisionReason: null,
          decidedAt: null,
          requestRecordDigest: rec.recordDigest,
          decisionRecordDigest: null,
        });
      } else if (rec.eventType === 'hitl.decided') {
        const item = map.get(key);
        if (item) {
          item.status = p.decision;
          item.approverPrincipalId = p.approverPrincipalId;
          item.decisionReason = p.reason;
          item.decidedAt = p.decidedAt;
          item.decisionRecordDigest = rec.recordDigest;
        }
      }
    }
    for (const item of map.values()) {
      const expMs = Date.parse(item.expiresAt);
      if (item.status === 'PENDING' && Number.isFinite(nowMs) && Number.isFinite(expMs) && nowMs > expMs) {
        item.status = 'EXPIRED';
      }
    }
    return map;
  }

  async submitRequest({
    requestId = `hitl-${randomUUID()}`,
    tenantId,
    requesterPrincipalId,
    planDigest,
    actionType = 'external_side_effect',
    summary = '',
    ttlMs = 3_600_000,
    nowIso = new Date().toISOString(),
  } = {}) {
    if (!HEX64_RE.test(String(planDigest || ''))) {
      throw collectorError('INVALID_PLAN_DIGEST', 'HITL 审批请求必须绑定 64 位小写十六进制 planDigest。', 400);
    }
    if (!SAFE_ID_RE.test(String(requestId)) || !SAFE_ID_RE.test(String(tenantId || ''))) {
      throw collectorError('INVALID_HITL_IDENTITY', 'requestId 与 tenantId 必须为安全标识符。', 400);
    }
    const effectiveTtlMs = ttlMs === undefined ? 3_600_000 : ttlMs;
    if (!Number.isSafeInteger(effectiveTtlMs) || effectiveTtlMs < 1000 || effectiveTtlMs > MAX_HITL_TTL_MS) {
      throw collectorError(
        'INVALID_HITL_TTL',
        `ttlMs 必须为 1000 至 ${MAX_HITL_TTL_MS} 之间的安全整数。`,
        400,
      );
    }
    const createdMs = Date.parse(String(nowIso));
    if (!Number.isFinite(createdMs)) {
      throw collectorError('INVALID_TIMESTAMP', '审批请求时间戳格式非法。', 400);
    }
    const expiresAt = new Date(createdMs + effectiveTtlMs).toISOString();
    const sanitizedActionType = String(redactCompliancePayload(String(actionType || 'external_side_effect')));
    const sanitizedSummary = String(redactCompliancePayload(String(summary || '')));
    const scopedKey = this.#scopedKey(tenantId, requestId);
    const eventSuffix = createHash('sha256').update(scopedKey, 'utf8').digest('hex').slice(0, 24);

    return this.#enqueue(async () => {
      await mkdir(this.#stateRoot, { recursive: true });
      const store = await openStateStore(this.#stateRoot, {
        owner: `hitl-queue-${process.pid}`,
        payloadSchemas: HITL_SCHEMAS,
      });
      try {
        const priorEvents = await readEvents(store);
        const existing = this.#foldRequests(priorEvents, nowIso).get(scopedKey);
        if (existing) {
          if (
            existing.requesterPrincipalId === String(requesterPrincipalId) &&
            existing.planDigest === String(planDigest) &&
            existing.actionType === sanitizedActionType &&
            existing.summary === sanitizedSummary
          ) {
            return { ...existing, idempotentReplay: true };
          }
          throw collectorError(
            'HITL_REQUEST_ID_CONFLICT',
            `同一租户下审批单 ${requestId} 已存在且绑定内容不一致。`,
            409,
          );
        }

        await appendEvent(store, {
          eventId: `req-${eventSuffix}`,
          idempotencyKey: `req-${eventSuffix}`,
          eventType: 'hitl.requested',
          payloadSchemaVersion: 1,
          producer: 'skill-family-studio.hitl-queue',
          payload: {
            requestId: String(requestId),
            tenantId: String(tenantId),
            requesterPrincipalId: String(requesterPrincipalId),
            planDigest: String(planDigest),
            actionType: sanitizedActionType,
            summary: sanitizedSummary,
            createdAt: new Date(createdMs).toISOString(),
            expiresAt,
          },
        });
        if (this.#approvalMode === 'off') {
          await appendEvent(store, {
            eventId: `dec-${eventSuffix}`,
            idempotencyKey: `dec-${eventSuffix}`,
            eventType: 'hitl.decided',
            payloadSchemaVersion: 1,
            producer: 'skill-family-studio.hitl-queue',
            payload: {
              requestId: String(requestId),
              tenantId: String(tenantId),
              approverPrincipalId: String(requesterPrincipalId),
              decision: 'APPROVED',
              reason: 'auto-approved (approvalMode=off)',
              decidedAt: new Date(createdMs).toISOString(),
            },
          });
        }
        const all = await readEvents(store);
        return this.#foldRequests(all, nowIso).get(scopedKey);
      } finally {
        await closeStateStore(store);
      }
    });
  }

  async decideRequest({
    requestId,
    tenantId,
    approverPrincipalId,
    decision,
    reason = '',
    nowIso = new Date().toISOString(),
  } = {}) {
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw collectorError('INVALID_HITL_DECISION', 'HITL 裁决只能为 APPROVED 或 REJECTED。', 400);
    }
    const decidedMs = Date.parse(String(nowIso));
    if (!Number.isFinite(decidedMs)) {
      throw collectorError('INVALID_TIMESTAMP', '审批裁决时间戳格式非法。', 400);
    }
    const scopedKey = this.#scopedKey(tenantId, requestId);
    const eventSuffix = createHash('sha256').update(scopedKey, 'utf8').digest('hex').slice(0, 24);

    return this.#enqueue(async () => {
      await mkdir(this.#stateRoot, { recursive: true });
      const store = await openStateStore(this.#stateRoot, {
        owner: `hitl-queue-${process.pid}`,
        payloadSchemas: HITL_SCHEMAS,
      });
      try {
        const existingEvents = await readEvents(store);
        const current = this.#foldRequests(existingEvents, nowIso).get(scopedKey);
        if (!current || current.tenantId !== tenantId) {
          throw collectorError('HITL_REQUEST_NOT_FOUND', `未找到审批单：${String(requestId)}`, 404);
        }
        if (this.#approvalMode === 'dual' && current.requesterPrincipalId === approverPrincipalId) {
          throw collectorError(
            'HITL_SELF_APPROVAL_FORBIDDEN',
            `当前为强监管双人审批模式（approvalMode=dual），申请人 ${approverPrincipalId} 不得自行审批其提交的计划。`,
            403,
          );
        }
        if (current.status === 'EXPIRED') {
          throw collectorError('HITL_REQUEST_EXPIRED', `审批单 ${requestId} 已超过有效期 ${current.expiresAt}。`, 409);
        }
        if (current.status !== 'PENDING') {
          throw collectorError('HITL_ALREADY_DECIDED', `审批单 ${requestId} 已处于终态 ${current.status}。`, 409);
        }

        await appendEvent(store, {
          eventId: `dec-${eventSuffix}`,
          idempotencyKey: `dec-${eventSuffix}`,
          eventType: 'hitl.decided',
          payloadSchemaVersion: 1,
          producer: 'skill-family-studio.hitl-queue',
          payload: {
            requestId: String(requestId),
            tenantId: String(tenantId),
            approverPrincipalId: String(approverPrincipalId),
            decision,
            reason: String(redactCompliancePayload(String(reason || ''))),
            decidedAt: new Date(decidedMs).toISOString(),
          },
        });
        const updated = await readEvents(store);
        return this.#foldRequests(updated, nowIso).get(scopedKey);
      } finally {
        await closeStateStore(store);
      }
    });
  }

  async listRequests({ tenantId = null, nowIso = new Date().toISOString() } = {}) {
    return this.#enqueue(async () => {
      await mkdir(this.#stateRoot, { recursive: true });
      const store = await openStateStore(this.#stateRoot, {
        owner: `hitl-queue-${process.pid}`,
        payloadSchemas: HITL_SCHEMAS,
      });
      try {
        const events = await readEvents(store);
        const all = [...this.#foldRequests(events, nowIso).values()];
        return tenantId ? all.filter(r => r.tenantId === tenantId) : all;
      } finally {
        await closeStateStore(store);
      }
    });
  }

  async verifyExecutionApproval({
    requestId,
    tenantId,
    planDigest,
    nowIso = new Date().toISOString(),
  } = {}) {
    if (!HEX64_RE.test(String(planDigest || ''))) {
      return { approved: false, code: 'INVALID_PLAN_DIGEST' };
    }
    if (this.#approvalMode === 'off') {
      return {
        approved: true,
        code: 'HITL_AUTO_BYPASSED_OFF_MODE',
        approvalMode: 'off',
        requestId: requestId || null,
        planDigest,
      };
    }
    const items = await this.listRequests({ tenantId, nowIso });
    const hit = items.find(r => r.requestId === requestId);
    if (!hit) return { approved: false, code: 'HITL_REQUEST_NOT_FOUND' };
    const expMs = Date.parse(hit.expiresAt);
    const nowMs = Date.parse(String(nowIso));
    if (Number.isFinite(expMs) && Number.isFinite(nowMs) && nowMs > expMs) {
      return { approved: false, code: 'HITL_REQUEST_EXPIRED' };
    }
    if (hit.status !== 'APPROVED') {
      return { approved: false, code: `HITL_STATUS_${hit.status}` };
    }
    if (hit.planDigest !== planDigest) {
      return { approved: false, code: 'HITL_PLAN_DIGEST_MISMATCH' };
    }
    return {
      approved: true,
      code: 'HITL_APPROVED',
      requestId: hit.requestId,
      planDigest: hit.planDigest,
      approverPrincipalId: hit.approverPrincipalId,
      decisionRecordDigest: hit.decisionRecordDigest,
    };
  }
}

export async function exportIncidentToFb2Candidate({
  incident,
  workspaceRoot = process.cwd(),
} = {}) {
  if (!incident || !incident.stbBundle) {
    throw collectorError('INVALID_INCIDENT_RECORD', '缺少有效的线上异常单或密封 STB。', 400);
  }
  const sealCheck = verifySessionTraceBundleSeal(incident.stbBundle);
  if (!sealCheck.valid) {
    throw collectorError('STB_SEAL_INVALID', '线上异常关联的 STB 封存校验未通过。', 400);
  }

  const drv = resolveWorkspaceDriverPaths(workspaceRoot);
  if (drv.sfaTool) {
    const tmpBase = await realpath(tmpdir());
    const stbDir = await mkdtemp(path.join(tmpBase, 'studio-fb2-stb-'));
    const auditDir = await mkdtemp(path.join(tmpBase, 'studio-fb2-audit-'));
    const outDir = await mkdtemp(path.join(tmpBase, 'studio-fb2-cand-'));
    try {
      const sanitizedEvidence = sanitizeRawEvidenceFiles(incident.rawEvidenceFiles || {});
      for (const [relPath, content] of Object.entries(sanitizedEvidence)) {
        const containedAbs = await resolveContained(stbDir, relPath);
        await mkdir(path.dirname(containedAbs), { recursive: true });
        await writeFileAtomic(stbDir, relPath, content);
      }
      await writeFileAtomic(stbDir, 'bundle.json', `${JSON.stringify(incident.stbBundle, null, 2)}\n`);

      let hasAuditReport = false;
      try {
        await execFileAsync(
          'python3',
          [
            '-B',
            drv.sfaTool,
            'audit-stb',
            '--stb-root',
            stbDir,
            '--stb',
            'bundle.json',
            '--output-root',
            auditDir,
            '--report-output',
            'report.json',
            '--conclusion-output',
            'conclusion.json',
          ],
          {
            encoding: 'utf8',
            timeout: 20000,
            env: buildMinimalEnv({ SFA_FOUNDATION_NODE: process.execPath }),
          },
        );
        hasAuditReport = true;
      } catch (err) {
        if (err?.code === 1) hasAuditReport = true;
      }

      const exportArgs = [
        '-B',
        drv.sfaTool,
        'export-repro-candidate',
        '--stb-root',
        stbDir,
        '--stb',
        'bundle.json',
        ...(hasAuditReport ? ['--report-root', auditDir, '--report', 'report.json'] : []),
        '--output-root',
        outDir,
        '--candidate-output',
        'repro-candidate.json',
      ];
      await execFileAsync('python3', exportArgs, {
        encoding: 'utf8',
        timeout: 20000,
        env: buildMinimalEnv({ SFA_FOUNDATION_NODE: process.execPath }),
      });

      const rawCandidate = JSON.parse(await readFile(path.join(outDir, 'repro-candidate.json'), 'utf8'));
      const scrubbed = redactCompliancePayload(rawCandidate);
      const { candidateDigestSha256: _oldDigest, ...bodyWithoutDigest } = scrubbed;
      const finalizedBody = {
        ...bodyWithoutDigest,
        feedbackLoopId: 'FB-2',
        redaction: {
          ...(bodyWithoutDigest.redaction && typeof bodyWithoutDigest.redaction === 'object'
            ? bodyWithoutDigest.redaction
            : {}),
          applied: true,
        },
        humanReviewRequired: true,
      };
      const candidateDigestSha256 = digestDocument(finalizedBody);
      return {
        ...finalizedBody,
        candidateDigestSha256,
      };
    } catch {
      // Fall through to deterministic sanitized candidate when raw transcript slices are absent
    } finally {
      await rm(stbDir, { recursive: true, force: true });
      await rm(auditDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  }

  const bundleDigest = sealCheck.bundleDigestSha256;
  const rawSuffix = String(incident.incidentId || bundleDigest.slice(0, 8))
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const caseId = `REPRO-ONLINE-${rawSuffix || bundleDigest.slice(0, 8).toUpperCase()}`;
  const fallbackBody = {
    schemaVersion: 1,
    kind: 'skill-failure-auditor.repro-candidate',
    feedbackLoopId: 'FB-2',
    humanReviewRequired: true,
    redaction: {
      applied: true,
      policy: 'studio-compliance-redactor-v1',
    },
    sourceBundle: {
      bundleId: String(incident.stbBundle.bundleId),
      attemptId: String(
        incident.stbBundle.attempt?.attemptId || incident.stbBundle.seal?.attemptId || 'att-online-01',
      ),
      recomputedBundleDigestSha256: bundleDigest,
      ...(incident.originalBundleDigestSha256
        ? { originalBundleDigestSha256: incident.originalBundleDigestSha256 }
        : {}),
      verdict: incident.reason === 'SUSPECTED_FABRICATION' ? 'SUSPECTED_FABRICATION' : 'FINDINGS',
      triggeredRuleIds:
        Array.isArray(incident.triggeredRuleIds) && incident.triggeredRuleIds.length > 0
          ? incident.triggeredRuleIds
          : ['FM-01'],
    },
    proposedCase: {
      caseId,
      title: redactCompliancePayload(
        `线上异常回归：${incident.stbBundle.subject?.id || 'skill'} (${incident.reason || 'FINDINGS'})`,
      ),
      prompt: redactCompliancePayload(
        `复现生产异常单 ${incident.incidentId} 的工具调用失败或边界拦截场景，严禁未通过校验谎报完成。`,
      ),
      assertions: [
        {
          id: 'online-repro-verified-output',
          kind: 'json_subset',
          targetPath: 'outputs/repro-status.json',
          expected: { verified: true },
        },
      ],
    },
  };
  return {
    ...fallbackBody,
    candidateDigestSha256: digestDocument(fallbackBody),
  };
}

function sendJsonResponse(res, statusCode, payload, extraHeaders = {}) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendTextResponse(res, statusCode, contentType, text) {
  const bytes = Buffer.from(String(text), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(bytes);
}

async function readBoundedJson(req, { maxBytes = 524_288, requireJsonContentType = false } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw collectorError('PAYLOAD_TOO_LARGE', '请求体超过 512KiB 上限。', 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  if (requireJsonContentType) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      throw collectorError('UNSUPPORTED_MEDIA_TYPE', '免鉴权回环接口仅接受 application/json 请求体。', 415);
    }
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw collectorError('INVALID_JSON_BODY', '请求体必须为合法 JSON 对象。', 400);
  }
}

function countBundleTokens(stbBundle) {
  let total = 0;
  for (const sess of stbBundle?.sessions || []) {
    for (const turn of sess.turns || []) {
      total +=
        Math.max(0, Math.trunc(Number(turn.inputTokens || 0))) +
        Math.max(0, Math.trunc(Number(turn.cacheReadTokens || 0))) +
        Math.max(0, Math.trunc(Number(turn.outputTokens || 0)));
    }
  }
  return total;
}

function detectBundleFailureReason(stbBundle) {
  if (Array.isArray(stbBundle?.sandboxEvents) && stbBundle.sandboxEvents.length > 0) {
    return 'SANDBOX_BOUNDARY_VIOLATION';
  }
  const failedCall = (stbBundle?.toolCalls || []).find(
    tc => tc.status === 'failed' || (typeof tc.exitCode === 'number' && tc.exitCode !== 0),
  );
  if (failedCall) {
    const claimedPass = (stbBundle?.claims || []).some(
      c =>
        (c.assertedOutcome === 'passed' || c.assertedOutcome === 'completed') &&
        Array.isArray(c.agentCitedCallIds) &&
        c.agentCitedCallIds.includes(failedCall.callId),
    );
    return claimedPass ? 'SUSPECTED_FABRICATION' : 'TOOL_CALL_FAILURE';
  }
  const abnormalSession = (stbBundle?.sessions || []).find(
    s => s.termination?.reason && s.termination.reason !== 'completed',
  );
  if (abnormalSession) return `SESSION_${String(abnormalSession.termination.reason).toUpperCase()}`;
  return null;
}

function buildScrubbedSealedStb(stbBundle) {
  const scrubbedUnsigned = redactCompliancePayload(stbBundle);
  return sealSessionTraceBundle(scrubbedUnsigned, {
    attemptId: String(stbBundle.seal?.attemptId || stbBundle.attempt?.attemptId || 'att-online'),
    sealedAt: String(stbBundle.seal?.sealedAt || stbBundle.createdAt),
    quiescence: redactCompliancePayload(stbBundle.seal.quiescence),
    externalBinding: redactCompliancePayload(stbBundle.seal.externalBinding),
  });
}

function wrapCustomAuditStoreProvider(rawStore, fallbackRetentionDays, fallbackEnforceFloor) {
  return {
    get retentionDays() {
      return rawStore.retentionDays ?? fallbackRetentionDays;
    },
    get enforceRetentionFloor() {
      return rawStore.enforceRetentionFloor ?? fallbackEnforceFloor;
    },
    async appendAuditRecord(entry = {}) {
      const scrubbedEntry = {
        ...entry,
        tenantId: String(redactCompliancePayload(String(entry.tenantId || 'default'))),
        actorId: String(redactCompliancePayload(String(entry.actorId || 'anonymous'))),
        action: String(redactCompliancePayload(String(entry.action || 'unknown'))),
        target: String(redactCompliancePayload(String(entry.target || '*'))),
        decision: String(redactCompliancePayload(String(entry.decision || 'UNKNOWN'))),
        category: String(redactCompliancePayload(String(entry.category || 'governance'))),
        occurredAt: String(entry.occurredAt || new Date().toISOString()),
        details: redactCompliancePayload(entry.details ?? {}),
      };
      return await rawStore.appendAuditRecord(scrubbedEntry);
    },
    async readRawEnvelopes(opts) {
      return await rawStore.readRawEnvelopes(opts);
    },
    async verifyRetentionIntegrity(opts) {
      return await rawStore.verifyRetentionIntegrity(opts);
    },
    async assertPurgePermitted(opts) {
      if (typeof rawStore.assertPurgePermitted === 'function') {
        return await rawStore.assertPurgePermitted(opts);
      }
      return { purgePermitted: !fallbackEnforceFloor, checkedCount: 0 };
    },
  };
}

export function createStudioCollectorServer({
  storageRoot,
  profile = 'solo',
  approvalMode,
  enforceQuota,
  enforceRetentionFloor,
  retentionDays,
  principals = [],
  authProvider = null,
  secretVaultProvider = null,
  auditStoreProvider = null,
  tenantQuotas = {},
  serviceName = 'skill-family-studio-collector',
  workspaceRoot = process.cwd(),
  clock = () => new Date().toISOString(),
  host = '127.0.0.1',
  port = 0,
} = {}) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw collectorError('INVALID_STORAGE_ROOT', 'createStudioCollectorServer 需要非空 storageRoot。', 500);
  }
  if (!GOVERNANCE_PROFILES.includes(profile)) {
    throw collectorError(
      'INVALID_GOVERNANCE_PROFILE',
      `profile 必须为 ${GOVERNANCE_PROFILES.join(' | ')} 之一（当前值：${String(profile)}）。`,
      500,
    );
  }
  if (typeof clock !== 'function') {
    throw collectorError('INVALID_CLOCK_PROVIDER', 'clock 必须为返回 ISO 时间戳的函数。', 500);
  }
  if (secretVaultProvider !== null && typeof secretVaultProvider?.resolvePrincipalDigest !== 'function') {
    throw collectorError(
      'INVALID_SECRET_VAULT_PROVIDER',
      'secretVaultProvider 必须实现 resolvePrincipalDigest(principalId) 接口。',
      500,
    );
  }

  const cleanHost = String(host || '127.0.0.1').trim().replace(/^\[|\]$/g, '');
  const effectiveApprovalMode =
    approvalMode ?? (profile === 'regulated' ? 'dual' : profile === 'team' ? 'self' : 'off');
  if (!APPROVAL_MODES.includes(effectiveApprovalMode)) {
    throw collectorError(
      'INVALID_APPROVAL_MODE',
      `approvalMode 必须为 ${APPROVAL_MODES.join(' | ')} 之一（当前值：${String(effectiveApprovalMode)}）。`,
      500,
    );
  }
  const effectiveEnforceQuota = enforceQuota ?? profile !== 'solo';
  const effectiveEnforceRetention = enforceRetentionFloor ?? profile === 'regulated';
  const effectiveRetentionDays =
    retentionDays ?? (profile === 'regulated' ? MIN_RETENTION_DAYS : profile === 'team' ? 90 : 30);

  assertValidRetentionDays(effectiveRetentionDays, { enforceDengbaoFloor: effectiveEnforceRetention });

  let authorizer = authProvider;
  if (authorizer !== null) {
    if (typeof authorizer?.authorize !== 'function') {
      throw collectorError('INVALID_AUTH_PROVIDER', 'authProvider 必须实现 authorize() 接口。', 500);
    }
  } else if (profile === 'solo' && (!Array.isArray(principals) || principals.length === 0)) {
    authorizer = new LoopbackSoloAuthProvider();
  } else {
    authorizer = new TenantRbacAuthorizer({ principals, secretVaultProvider });
  }

  const isUnauthenticatedMode = authorizer.summary?.authRequired === false;
  if (isUnauthenticatedMode) {
    if (profile !== 'solo') {
      throw collectorError(
        'AUTH_REQUIRED_FOR_PROFILE',
        `画像 ${profile} 禁止挂载免鉴权 authProvider（仅 solo 模式允许本机免鉴权）。`,
        500,
      );
    }
    if (!LOOPBACK_HOSTS.has(cleanHost.toLowerCase())) {
      throw collectorError(
        'SOLO_PROFILE_LOOPBACK_REQUIRED',
        `个人免鉴权模式（profile=solo）仅允许绑定本机回环地址（当前 host：${String(host)}）。`,
        500,
      );
    }
  }

  let ledger;
  if (auditStoreProvider !== null) {
    if (
      typeof auditStoreProvider?.appendAuditRecord !== 'function' ||
      typeof auditStoreProvider?.readRawEnvelopes !== 'function' ||
      typeof auditStoreProvider?.verifyRetentionIntegrity !== 'function'
    ) {
      throw collectorError(
        'INVALID_AUDIT_STORE_PROVIDER',
        'auditStoreProvider 必须实现 appendAuditRecord / readRawEnvelopes / verifyRetentionIntegrity 接口。',
        500,
      );
    }
    ledger = wrapCustomAuditStoreProvider(auditStoreProvider, effectiveRetentionDays, effectiveEnforceRetention);
  } else {
    ledger = new ComplianceAuditLedger({
      stateRoot: path.join(storageRoot, 'compliance-ledger'),
      retentionDays: effectiveRetentionDays,
      enforceRetentionFloor: effectiveEnforceRetention,
    });
  }

  const quotaBreaker = new QuotaCircuitBreaker({
    storageRoot: path.join(storageRoot, 'quota-state'),
    tenantQuotas,
    enforced: effectiveEnforceQuota,
  });
  const hitlQueue = new HitlApprovalQueue({
    stateRoot: path.join(storageRoot, 'hitl-state'),
    approvalMode: effectiveApprovalMode,
  });

  const providerSeams = Object.freeze({
    auth: authProvider ? 'custom-provider' : authorizer.summary?.kind || 'builtin',
    secretVault: secretVaultProvider ? 'custom-provider' : 'none',
    auditStore: auditStoreProvider ? 'custom-provider' : 'builtin-state-store',
  });

  const otelSpansByTenant = new Map();
  const ingestedStbReceipts = new Map();
  const incidents = new Map();
  let activeBoundPort = null;

  async function requireAuth(req, res, requiredPermission, targetTenantId = null, actionLabel = requiredPermission) {
    const auth = await authorizer.authorize({
      authorizationHeader: req.headers.authorization,
      headers: req.headers,
      requiredPermission,
      targetTenantId,
    });
    const principalOk = Boolean(
      auth &&
        auth.ok === true &&
        auth.principal &&
        SAFE_ID_RE.test(String(auth.principal.principalId || '')) &&
        SAFE_ID_RE.test(String(auth.principal.tenantId || '')),
    );
    if (!principalOk) {
      const statusCode = Number.isInteger(auth?.statusCode) && auth.statusCode >= 400 ? auth.statusCode : 401;
      const errCode = typeof auth?.code === 'string' && auth.code ? auth.code : 'AUTH_DENIED';
      const errReason = typeof auth?.reason === 'string' && auth.reason ? auth.reason : '身份鉴权未通过。';
      const safeTenant = SAFE_ID_RE.test(String(auth?.tenantId || ''))
        ? String(auth.tenantId)
        : targetTenantId || 'unknown';
      const safeActor = SAFE_ID_RE.test(String(auth?.principalId || '')) ? String(auth.principalId) : 'anonymous';
      await ledger.appendAuditRecord({
        tenantId: safeTenant,
        actorId: safeActor,
        action: actionLabel,
        target: req.url || '/',
        decision: 'DENY',
        category: 'security.auth',
        occurredAt: clock(),
        details: { code: errCode, reason: errReason },
      });
      sendJsonResponse(res, statusCode, { ok: false, code: errCode, error: errReason });
      return null;
    }
    return auth.principal;
  }

  async function assertBodyTenantMatchesPrincipal(req, res, principal, requestedTenant, actionLabel) {
    if (typeof requestedTenant === 'string' && requestedTenant.trim() && requestedTenant !== principal.tenantId) {
      const reason = `主体 ${principal.principalId}（租户 ${principal.tenantId}）无权操作目标租户 ${requestedTenant}。`;
      await ledger.appendAuditRecord({
        tenantId: principal.tenantId,
        actorId: principal.principalId,
        action: actionLabel,
        target: req.url || '/',
        decision: 'DENY',
        category: 'security.auth',
        occurredAt: clock(),
        details: { code: 'RBAC_TENANT_ISOLATION_DENIED', requestedTenant, reason },
      });
      sendJsonResponse(res, 403, {
        ok: false,
        code: 'RBAC_TENANT_ISOLATION_DENIED',
        error: reason,
      });
      return false;
    }
    return true;
  }

  const httpServer = createServer(async (req, res) => {
    try {
      if (isUnauthenticatedMode) {
        if (!isSafeLoopbackHost(req) || !isSafeLoopbackOrigin(req, activeBoundPort)) {
          sendJsonResponse(res, 403, {
            ok: false,
            code: 'LOOPBACK_ORIGIN_OR_HOST_REJECTED',
            error: '免鉴权个人模式拒绝跨源请求或非回环 Host 头（防止 DNS Rebinding 与 CSRF）。',
          });
          return;
        }
      }

      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      const method = req.method || 'GET';
      const jsonOpts = { requireJsonContentType: isUnauthenticatedMode };

      if (method === 'GET' && pathname === '/healthz') {
        sendJsonResponse(res, 200, {
          ok: true,
          service: serviceName,
          profile,
          approvalMode: effectiveApprovalMode,
          quotaEnforced: effectiveEnforceQuota,
          retentionDays: effectiveRetentionDays,
          retentionLockEnforced: effectiveEnforceRetention,
          minimumRetentionDaysFloor: MIN_RETENTION_DAYS,
          providerSeams,
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/quota/evaluate') {
        const principal = await requireAuth(req, res, 'quota:evaluate', null, 'quota.evaluate');
        if (!principal) return;
        const body = await readBoundedJson(req, jsonOpts);
        if (!(await assertBodyTenantMatchesPrincipal(req, res, principal, body.tenantId, 'quota.evaluate'))) {
          return;
        }
        const result = await quotaBreaker.evaluateAndRecord({
          tenantId: principal.tenantId,
          runId: body.runId,
          tokensDelta: body.tokensDelta ?? 0,
          costMicrosUsdDelta: body.costMicrosUsdDelta ?? 0,
          dryRun: body.dryRun !== false,
        });
        await ledger.appendAuditRecord({
          tenantId: principal.tenantId,
          actorId: principal.principalId,
          action: 'quota.evaluate',
          target: String(body.runId || 'precheck'),
          decision: result.allowed ? 'ALLOW' : 'CIRCUIT_OPEN',
          category: 'governance.quota',
          occurredAt: clock(),
          details: result,
        });
        sendJsonResponse(res, result.allowed ? 200 : 429, { ok: result.allowed, ...result });
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/telemetry/stb') {
        const principal = await requireAuth(req, res, 'telemetry:ingest', null, 'telemetry.ingest');
        if (!principal) return;
        const body = await readBoundedJson(req, jsonOpts);
        if (!(await assertBodyTenantMatchesPrincipal(req, res, principal, body.tenantId, 'telemetry.ingest'))) {
          return;
        }
        const stbBundle = body.bundle || body.stbBundle || body;

        const sealCheck = verifySessionTraceBundleSeal(stbBundle);
        if (!sealCheck.valid) {
          await ledger.appendAuditRecord({
            tenantId: principal.tenantId,
            actorId: principal.principalId,
            action: 'telemetry.ingest',
            target: String(stbBundle?.bundleId || 'unknown'),
            decision: 'REJECT_INVALID_SEAL',
            category: 'telemetry.integrity',
            occurredAt: clock(),
            details: { errorCode: sealCheck.errorCode || 'INVALID_SEAL' },
          });
          sendJsonResponse(res, 400, {
            ok: false,
            code: 'STB_SEAL_INVALID',
            error: 'SessionTraceBundle 封存摘要校验未通过，拒绝入库。',
          });
          return;
        }

        const dedupKey = `${principal.tenantId}:${sealCheck.bundleDigestSha256}`;
        if (ingestedStbReceipts.has(dedupKey)) {
          sendJsonResponse(res, 200, {
            ...ingestedStbReceipts.get(dedupKey),
            idempotentReplay: true,
          });
          return;
        }

        const sanitizedRawFiles = sanitizeRawEvidenceFiles(body.rawEvidenceFiles);
        const objectiveBundleTokens = countBundleTokens(stbBundle);
        const callerTokens =
          body.tokensUsed !== undefined
            ? assertNonNegativeSafeInt(body.tokensUsed, 'tokensUsed')
            : objectiveBundleTokens;
        const tokensUsed = Math.max(objectiveBundleTokens, callerTokens);
        const callerCost =
          body.costMicrosUsd !== undefined
            ? assertNonNegativeSafeInt(body.costMicrosUsd, 'costMicrosUsd')
            : Math.trunc(tokensUsed * 2);
        const costMicrosUsd = Math.max(Math.trunc(objectiveBundleTokens * 2), callerCost);

        const quotaRes = await quotaBreaker.evaluateAndRecord({
          tenantId: principal.tenantId,
          runId: `${stbBundle.bundleId}-${sealCheck.bundleDigestSha256.slice(0, 12)}`,
          tokensDelta: tokensUsed,
          costMicrosUsdDelta: costMicrosUsd,
          dryRun: false,
        });

        if (!quotaRes.allowed) {
          await ledger.appendAuditRecord({
            tenantId: principal.tenantId,
            actorId: principal.principalId,
            action: 'telemetry.ingest',
            target: stbBundle.bundleId,
            decision: 'CIRCUIT_OPEN',
            category: 'governance.quota',
            occurredAt: clock(),
            details: quotaRes,
          });
          sendJsonResponse(res, 429, { ok: false, ...quotaRes });
          return;
        }

        const otelBatch = exportStbToOtelSpans(stbBundle, {
          serviceName,
          tenantId: principal.tenantId,
        });
        const tenantBatches = otelSpansByTenant.get(principal.tenantId) || [];
        tenantBatches.push(otelBatch);
        otelSpansByTenant.set(principal.tenantId, tenantBatches);

        const failureReason = detectBundleFailureReason(stbBundle);
        let incidentId = null;
        if (failureReason) {
          incidentId = `inc-${stbBundle.bundleId}-${sealCheck.bundleDigestSha256.slice(0, 8)}`;
          const scrubbedSealedStb = buildScrubbedSealedStb(stbBundle);
          incidents.set(incidentId, {
            incidentId,
            tenantId: principal.tenantId,
            bundleId: stbBundle.bundleId,
            originalBundleDigestSha256: sealCheck.bundleDigestSha256,
            bundleDigestSha256: scrubbedSealedStb.seal.bundleDigestSha256,
            reason: failureReason,
            triggeredRuleIds: failureReason === 'SUSPECTED_FABRICATION' ? ['FM-01', 'FM-22'] : ['FM-ONLINE-01'],
            createdAt: clock(),
            stbBundle: scrubbedSealedStb,
            rawEvidenceFiles: sanitizedRawFiles,
          });
        }

        const auditRec = await ledger.appendAuditRecord({
          idempotencyKey: `stb-ingest-${principal.tenantId}-${sealCheck.bundleDigestSha256}`,
          tenantId: principal.tenantId,
          actorId: principal.principalId,
          action: 'telemetry.ingest',
          target: stbBundle.bundleId,
          decision: 'ACCEPTED',
          category: 'telemetry.stb',
          occurredAt: stbBundle.seal?.sealedAt || clock(),
          details: {
            bundleDigestSha256: sealCheck.bundleDigestSha256,
            traceId: otelBatch.traceId,
            spanCount: otelBatch.spanCount,
            tokensUsed,
            costMicrosUsd,
            incidentId,
          },
        });

        const responsePayload = {
          ok: true,
          bundleId: stbBundle.bundleId,
          bundleDigestSha256: sealCheck.bundleDigestSha256,
          traceId: otelBatch.traceId,
          spanCount: otelBatch.spanCount,
          auditSequence: auditRec.sequence,
          auditRecordDigest: auditRec.recordDigest,
          incidentId,
          quota: quotaRes,
        };
        ingestedStbReceipts.set(dedupKey, responsePayload);
        sendJsonResponse(res, 201, responsePayload);
        return;
      }

      if (pathname === '/api/v1/hitl/requests' && method === 'GET') {
        const requestedTenant = parsedUrl.searchParams.get('tenantId');
        const principal = await requireAuth(req, res, 'hitl:read', requestedTenant, 'hitl.list');
        if (!principal) return;
        const items = await hitlQueue.listRequests({ tenantId: principal.tenantId, nowIso: clock() });
        sendJsonResponse(res, 200, { ok: true, requests: items });
        return;
      }

      if (pathname === '/api/v1/hitl/requests' && method === 'POST') {
        const principal = await requireAuth(req, res, 'hitl:request', null, 'hitl.request');
        if (!principal) return;
        const body = await readBoundedJson(req, jsonOpts);
        if (!(await assertBodyTenantMatchesPrincipal(req, res, principal, body.tenantId, 'hitl.request'))) {
          return;
        }
        const created = await hitlQueue.submitRequest({
          requestId: body.requestId,
          tenantId: principal.tenantId,
          requesterPrincipalId: principal.principalId,
          planDigest: body.planDigest,
          actionType: body.actionType,
          summary: body.summary,
          ttlMs: body.ttlMs,
          nowIso: clock(),
        });
        await ledger.appendAuditRecord({
          tenantId: principal.tenantId,
          actorId: principal.principalId,
          action: 'hitl.request',
          target: created.requestId,
          decision: 'QUEUED',
          category: 'governance.hitl',
          occurredAt: clock(),
          details: { planDigest: created.planDigest, expiresAt: created.expiresAt },
        });
        sendJsonResponse(res, created.idempotentReplay ? 200 : 201, { ok: true, request: created });
        return;
      }

      const hitlDecideMatch = /^\/api\/v1\/hitl\/requests\/([A-Za-z0-9._:-]+)\/decide$/.exec(pathname);
      if (hitlDecideMatch && method === 'POST') {
        const requestId = decodeURIComponent(hitlDecideMatch[1]);
        const principal = await requireAuth(req, res, 'hitl:decide', null, 'hitl.decide');
        if (!principal) return;
        const body = await readBoundedJson(req, jsonOpts);
        if (!(await assertBodyTenantMatchesPrincipal(req, res, principal, body.tenantId, 'hitl.decide'))) {
          return;
        }
        try {
          const decided = await hitlQueue.decideRequest({
            requestId,
            tenantId: principal.tenantId,
            approverPrincipalId: principal.principalId,
            decision: body.decision,
            reason: body.reason,
            nowIso: clock(),
          });
          await ledger.appendAuditRecord({
            tenantId: principal.tenantId,
            actorId: principal.principalId,
            action: 'hitl.decide',
            target: requestId,
            decision: decided.status,
            category: 'governance.hitl',
            occurredAt: clock(),
            details: { planDigest: decided.planDigest, decisionRecordDigest: decided.decisionRecordDigest },
          });
          sendJsonResponse(res, 200, { ok: true, request: decided });
        } catch (err) {
          await ledger.appendAuditRecord({
            tenantId: principal.tenantId,
            actorId: principal.principalId,
            action: 'hitl.decide',
            target: requestId,
            decision: 'DENY',
            category: 'governance.hitl',
            occurredAt: clock(),
            details: { code: err.code || 'HITL_ERROR', message: err.message },
          });
          throw err;
        }
        return;
      }

      if (pathname === '/api/v1/compliance/otel' && method === 'GET') {
        const requestedTenant = parsedUrl.searchParams.get('tenantId');
        const principal = await requireAuth(req, res, 'compliance:export', requestedTenant, 'compliance.export.otel');
        if (!principal) return;
        const batches = otelSpansByTenant.get(principal.tenantId) || [];
        const resourceSpans = batches.flatMap(b => b.resourceSpans);
        sendJsonResponse(res, 200, {
          ok: true,
          tenantId: principal.tenantId,
          batchCount: batches.length,
          resourceSpans,
        });
        return;
      }

      if (pathname === '/api/v1/compliance/siem' && method === 'GET') {
        const requestedTenant = parsedUrl.searchParams.get('tenantId');
        const principal = await requireAuth(req, res, 'compliance:export', requestedTenant, 'compliance.export.siem');
        if (!principal) return;
        const rawRecords = await ledger.readRawEnvelopes({ afterSequence: 0 });
        const ndjson = exportAuditEventsToSiemNdjson(rawRecords, {
          tenantId: principal.tenantId,
          serviceName,
        });
        sendTextResponse(res, 200, 'application/x-ndjson; charset=utf-8', ndjson);
        return;
      }

      if (pathname === '/api/v1/compliance/dengbao' && method === 'GET') {
        const requestedTenant = parsedUrl.searchParams.get('tenantId');
        const principal = await requireAuth(
          req,
          res,
          'compliance:export',
          requestedTenant,
          'compliance.export.dengbao',
        );
        if (!principal) return;
        const integrity = await ledger.verifyRetentionIntegrity({ nowIso: clock() });
        const report = buildDengbaoEvidenceMappingReport({
          tenantId: principal.tenantId,
          retentionDays: integrity?.retentionDays ?? ledger.retentionDays ?? effectiveRetentionDays,
          enforceRetentionFloor: ledger.enforceRetentionFloor ?? effectiveEnforceRetention,
          ledgerIntegrity: integrity,
          rbacSummary: authorizer.summary,
          quotaSummary: quotaBreaker.summary,
          hitlSummary: hitlQueue.summary,
          sandboxVerified: true,
          generatedAt: clock(),
        });
        sendJsonResponse(res, 200, { ok: true, ledgerIntegrity: integrity, report });
        return;
      }

      if (pathname === '/api/v1/incidents' && method === 'GET') {
        const requestedTenant = parsedUrl.searchParams.get('tenantId');
        const principal = await requireAuth(req, res, 'incident:read', requestedTenant, 'incident.list');
        if (!principal) return;
        const list = [...incidents.values()]
          .filter(inc => inc.tenantId === principal.tenantId)
          .map(({ stbBundle: _b, rawEvidenceFiles: _r, ...meta }) => meta);
        sendJsonResponse(res, 200, { ok: true, incidents: list });
        return;
      }

      const fb2Match = /^\/api\/v1\/incidents\/([A-Za-z0-9._:-]+)\/export-fb2$/.exec(pathname);
      if (fb2Match && method === 'POST') {
        const incidentId = decodeURIComponent(fb2Match[1]);
        const principal = await requireAuth(req, res, 'incident:triage', null, 'incident.export_fb2');
        if (!principal) return;
        await readBoundedJson(req, jsonOpts);
        const incident = incidents.get(incidentId);
        if (!incident) {
          sendJsonResponse(res, 404, { ok: false, code: 'INCIDENT_NOT_FOUND', error: '未找到对应线上异常单。' });
          return;
        }
        if (incident.tenantId !== principal.tenantId) {
          await ledger.appendAuditRecord({
            tenantId: principal.tenantId,
            actorId: principal.principalId,
            action: 'incident.export_fb2',
            target: incidentId,
            decision: 'DENY',
            category: 'security.auth',
            occurredAt: clock(),
            details: { code: 'RBAC_TENANT_ISOLATION_DENIED', reason: '跨租户线上异常单访问已拦截并留痕。' },
          });
          sendJsonResponse(res, 403, {
            ok: false,
            code: 'RBAC_TENANT_ISOLATION_DENIED',
            error: '无权导出其他租户的线上异常单。',
          });
          return;
        }
        const candidate = await exportIncidentToFb2Candidate({ incident, workspaceRoot });
        await ledger.appendAuditRecord({
          tenantId: principal.tenantId,
          actorId: principal.principalId,
          action: 'incident.export_fb2',
          target: incidentId,
          decision: 'EXPORTED_PENDING_HUMAN_CONFIRM',
          category: 'governance.fb2',
          occurredAt: clock(),
          details: {
            caseId: candidate.proposedCase?.caseId || candidate.caseId || incidentId,
            candidateDigestSha256: candidate.candidateDigestSha256,
            humanReviewRequired: candidate.humanReviewRequired,
          },
        });
        sendJsonResponse(res, 200, { ok: true, incidentId, candidate });
        return;
      }

      sendJsonResponse(res, 404, { ok: false, code: 'ROUTE_NOT_FOUND', error: '未找到请求的治理采集接口。' });
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      const extraHeaders = status === 413 ? { Connection: 'close' } : {};
      sendJsonResponse(
        res,
        status,
        {
          ok: false,
          code: err?.code || 'INTERNAL_COLLECTOR_ERROR',
          error: redactCompliancePayload(err?.message || '采集服务端内部异常'),
        },
        extraHeaders,
      );
    }
  });

  return {
    profile,
    approvalMode: effectiveApprovalMode,
    providerSeams,
    httpServer,
    ledger,
    authorizer,
    quotaBreaker,
    hitlQueue,
    async start() {
      await new Promise((resolveListen, rejectListen) => {
        httpServer.once('error', rejectListen);
        httpServer.listen(port, cleanHost, () => {
          httpServer.removeListener('error', rejectListen);
          resolveListen();
        });
      });
      const addr = httpServer.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      activeBoundPort = boundPort;
      const formattedHost = cleanHost.includes(':') ? `[${cleanHost}]` : cleanHost;
      return { host: cleanHost, port: boundPort, baseUrl: `http://${formattedHost}:${boundPort}` };
    },
    async close() {
      if (!httpServer.listening) return;
      await new Promise((resolveClose, rejectClose) => {
        httpServer.close(err => (err ? rejectClose(err) : resolveClose()));
      });
    },
  };
}
