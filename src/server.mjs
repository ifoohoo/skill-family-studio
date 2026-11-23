// @feature STU001
// @feature STU002
// @feature STU003
// @feature STU005
// @feature STU006

import { existsSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOUNDATION_PACKAGE_VERSION } from 'skill-family-harness-node';
import { inspectRepoAlignment } from './alignment-inspector.mjs';
import { discoverStudioRepos, inspectProjectRepo, readRepoArchifyAsset, readRepoDocument } from './ecosystem.mjs';
import { STUDIO_GUIDE_MODEL } from './guide-content.mjs';
import {
  DEFAULT_STUDIO_REVIEWS_PATH,
  applyAnnotationMutation,
  applyDecisionMutation,
  assertSafeObjectKeys,
  buildStudioReviewSummary,
  cleanString,
  readStudioReviewStore,
  splitQualifiedTargetId,
  writeStudioReviewStore,
} from './review-state.mjs';
import {
  DEFAULT_LOCK_WARN_MS,
  STUDIO_RUNTIME_REGISTRY_PATH,
  collectStudioRuntimeView,
  registerMonitorTarget,
  removeMonitorTarget,
  runSandboxExercise,
} from './runtime-bridge.mjs';
import { collectSessionFleet } from './session-fleet.mjs';
import { computePathDigest } from './setup-advisor.mjs';

const PKG_SRC_DIR = fileURLToPath(new URL('./', import.meta.url));
const UI_DIR = join(PKG_SRC_DIR, 'ui');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(bytes);
}

export function isSafeLoopbackHost(req) {
  const rawHost = req.headers.host;
  if (rawHost === undefined || rawHost === '') return true;
  if (typeof rawHost !== 'string') return false;
  const trimmed = rawHost.trim();
  if (!trimmed || /[/?#@\\\s]/.test(trimmed)) return false;
  try {
    const parsed = new URL(`http://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export function isSafeLoopbackOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 262144) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('请求体超过大小上限（256KB）。'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`无效的 JSON 请求体：${error.message}`), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('请求体顶层须为 JSON 对象。'), { statusCode: 400 });
  }
  if (/"__proto__"\s*:|"constructor"\s*:|"prototype"\s*:/.test(raw)) {
    throw Object.assign(new Error('请求体包含受保护的原型属性名，已拒绝执行。'), { statusCode: 400 });
  }
  assertSafeObjectKeys(parsed);
  return parsed;
}

export function normalizeStudioTab(rawTab) {
  if (!rawTab) return null;
  const clean = String(rawTab).trim().toLowerCase();
  if (!clean) return null;
  if (clean === 'overview') return 'guide';
  if (clean === 'monitor') return 'runtime';
  if (['guide', 'graph', 'review', 'runtime'].includes(clean)) return clean;
  return 'graph';
}

function safeDecodeUri(raw, label = '请求路径') {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw Object.assign(new Error(`非法的百分号编码${label}。`), { statusCode: 400 });
  }
}

export async function createStudioServer({
  root = '.',
  port = 0,
  writable = true,
  reviewsPath = DEFAULT_STUDIO_REVIEWS_PATH,
  runtimeRegistryPath = STUDIO_RUNTIME_REGISTRY_PATH,
  lockWarnMs = DEFAULT_LOCK_WARN_MS,
  allowedRoots = [],
  workbenchUrl = null,
  scanRoots,
  defaultTab = null,
  defaultRepo = null,
  env = process.env,
} = {}) {
  const resolvedRoot = resolve(root);
  const rootReal = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const rootDigest = computePathDigest(rootReal);
  const normalizedDefaultTab = normalizeStudioTab(defaultTab);
  const emptyScanDir = await mkdtemp(join(tmpdir(), 'sfs-scan-'));
  let writeChain = Promise.resolve();
  const enqueueWrite = fn => {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  };

  let cachedCatalog = null;
  let catalogAt = 0;
  const repoCache = new Map();
  let sandboxHandle = null;

  const getCatalog = async (force = false) => {
    if (!force && cachedCatalog && Date.now() - catalogAt < 15000) return cachedCatalog;
    cachedCatalog = await discoverStudioRepos(resolvedRoot, { scanRoots, env });
    catalogAt = Date.now();
    return cachedCatalog;
  };

  const getRepoEntry = async (record, force = false) => {
    const hit = repoCache.get(record.id);
    if (!force && hit && Date.now() - hit.at < 20000) return hit.entry;
    const entry = await inspectProjectRepo(record, emptyScanDir);
    repoCache.set(record.id, { at: Date.now(), entry });
    return entry;
  };

  const getLegacyFallback = catalog => {
    const records = [...(catalog?.byId?.values() ?? [])];
    const hit = records.find(r => existsSync(join(r.realPath, 'artifacts/reviews/workbench-reviews.json')))
      || records.find(r => r.repoRole === 'portfolio')
      || records[0];
    return {
      legacyFallbackRoot: hit?.realPath ?? null,
      defaultPrimaryRepoId: hit?.id ?? catalog?.primaryRepoId ?? null,
    };
  };

  const sseClients = new Set();
  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of sseClients) {
      try { c.write(frame); } catch { sseClients.delete(c); }
    }
  };
  const heartbeat = setInterval(() => {
    for (const c of sseClients) {
      try { c.write(': ping\n\n'); } catch { sseClients.delete(c); }
    }
  }, 20000);
  heartbeat.unref?.();

  const runtimeWatchers = [];
  let runtimeDebounceTimer = null;
  const triggerRuntimeBroadcast = () => {
    if (runtimeDebounceTimer) clearTimeout(runtimeDebounceTimer);
    runtimeDebounceTimer = setTimeout(() => {
      runtimeDebounceTimer = null;
      broadcast('runtime-change', { at: new Date().toISOString() });
    }, 220);
    runtimeDebounceTimer.unref?.();
  };
  for (const relDir of ['.skill-family-studio', '.artifacts/runtime-monitor', 'artifacts/runtime-monitor']) {
    const absDir = join(resolvedRoot, relDir);
    if (existsSync(absDir)) {
      try {
        const w = watch(absDir, () => triggerRuntimeBroadcast());
        w.unref?.();
        runtimeWatchers.push(w);
      } catch {}
    }
  }

  const server = createServer(async (req, res) => {
    try {
      if (!isSafeLoopbackHost(req)) {
        sendJson(res, 403, {
          ok: false,
          error: '已拒绝非本地回环 Host 请求头（仅允许 127.0.0.1、localhost 或 [::1] 访问）。',
        });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = safeDecodeUri(url.pathname, '请求路径');

      if (pathname === '/api/health') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        sendJson(res, 200, {
          ok: true,
          service: 'skill-family-studio',
          pid: process.pid,
          rootDigest,
          foundationVersion: FOUNDATION_PACKAGE_VERSION,
          writable,
          at: new Date().toISOString(),
        });
        return;
      }

      if (pathname === '/api/studio/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ writable, at: new Date().toISOString() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (pathname === '/api/studio/state') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const force = url.searchParams.get('refresh') === '1';
        const catalog = await getCatalog(force);
        const fb = getLegacyFallback(catalog);
        const store = await readStudioReviewStore(resolvedRoot, {
          reviewsPath,
          legacyFallbackRoot: fb.legacyFallbackRoot,
          defaultPrimaryRepoId: fb.defaultPrimaryRepoId,
        });
        sendJson(res, 200, {
          ok: true,
          writable,
          rootDigest,
          defaultTab: normalizedDefaultTab,
          defaultRepo,
          updatedAt: store.updatedAt,
          decisions: store.decisions,
          annotations: store.annotations,
          guide: STUDIO_GUIDE_MODEL,
          ecosystem: {
            available: catalog.available,
            count: catalog.count,
            primaryRepoId: catalog.primaryRepoId,
            repos: catalog.repos,
          },
        });
        return;
      }

      if (pathname === '/api/studio/repo') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const catalog = await getCatalog(false);
        const repoId = url.searchParams.get('repo') || catalog.primaryRepoId;
        const record = repoId ? catalog.byId.get(repoId) : null;
        if (!record) {
          sendJson(res, 404, { ok: false, error: `未找到指定的技能族仓库：${repoId || ''}` });
          return;
        }
        const entry = await getRepoEntry(record, url.searchParams.get('refresh') === '1');
        sendJson(res, 200, {
          ok: true,
          repo: catalog.repos.find(r => r.id === record.id),
          snapshot: entry.publicSnapshot,
        });
        return;
      }

      if (pathname === '/api/studio/doc') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const catalog = await getCatalog(false);
        const repoId = url.searchParams.get('repo') || catalog.primaryRepoId;
        const record = repoId ? catalog.byId.get(repoId) : null;
        if (!record) {
          sendJson(res, 404, { ok: false, error: `未找到指定的技能族仓库：${repoId || ''}` });
          return;
        }
        const entry = await getRepoEntry(record, false);
        const doc = await readRepoDocument(record, entry, {
          path: url.searchParams.get('path'),
          uid: url.searchParams.get('uid'),
        });
        sendJson(res, 200, doc);
        return;
      }

      if (pathname.startsWith('/api/studio/archify/')) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const rawRest = req.url.split('?')[0].slice('/api/studio/archify/'.length);
        const slashIdx = rawRest.indexOf('/');
        if (slashIdx <= 0) { sendJson(res, 400, { ok: false, error: '缺少 Archify 仓库或资源路径。' }); return; }
        const repoId = safeDecodeUri(rawRest.slice(0, slashIdx), '仓库标识');
        const assetRel = safeDecodeUri(rawRest.slice(slashIdx + 1), '资源路径');
        const catalog = await getCatalog(false);
        const record = catalog.byId.get(repoId);
        if (!record) { sendJson(res, 404, { ok: false, error: `未找到指定的技能族仓库：${repoId}` }); return; }
        const entry = await getRepoEntry(record, false);
        const { cleanPath, bytes } = await readRepoArchifyAsset(record, entry, assetRel);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(cleanPath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(bytes);
        return;
      }

      if (pathname === '/api/studio/summary') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const catalog = await getCatalog(false);
        const fb = getLegacyFallback(catalog);
        const store = await readStudioReviewStore(resolvedRoot, {
          reviewsPath,
          legacyFallbackRoot: fb.legacyFallbackRoot,
          defaultPrimaryRepoId: fb.defaultPrimaryRepoId,
        });
        const summary = buildStudioReviewSummary(store, { repos: catalog.repos });
        if (url.searchParams.get('format') === 'markdown') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(Buffer.from(summary.markdown, 'utf8'));
          return;
        }
        sendJson(res, 200, { ok: true, writable, updatedAt: store.updatedAt, ...summary });
        return;
      }

      if (pathname === '/api/studio/alignment') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const catalog = await getCatalog(url.searchParams.get('refresh') === '1');
        const repoId = url.searchParams.get('repo') || catalog.primaryRepoId;
        const record = repoId ? catalog.byId.get(repoId) : null;
        if (!record) {
          sendJson(res, 404, { ok: false, error: `未找到指定的技能族仓库：${repoId || ''}` });
          return;
        }
        const alignment = await inspectRepoAlignment(record, catalog);
        sendJson(res, 200, alignment);
        return;
      }

      if (pathname === '/api/studio/runtime' || pathname === '/api/monitor/snapshot') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const catalog = await getCatalog(false);
        const selectedRepoId = url.searchParams.get('repo') || catalog.primaryRepoId;
        const extraTargets = sandboxHandle ? [sandboxHandle.targetEntry] : [];
        const rt = await collectStudioRuntimeView({
          root: resolvedRoot,
          catalog,
          selectedRepoId,
          registryPath: runtimeRegistryPath,
          extraTargets,
          hasActiveSandboxLock: Boolean(sandboxHandle?.isLockHeld?.()),
          lockWarnMs,
          allowedRoots,
          workbenchUrl,
        });
        sendJson(res, 200, rt);
        return;
      }

      if (pathname === '/api/studio/fleet') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const catalog = await getCatalog(false);
        const fleet = await collectSessionFleet({
          root: resolvedRoot,
          catalog,
          sandboxActive: Boolean(sandboxHandle),
          env,
        });
        sendJson(res, 200, fleet);
        return;
      }

      if (req.method === 'POST' || req.method === 'DELETE') {
        if (!isSafeLoopbackOrigin(req)) {
          sendJson(res, 403, { ok: false, error: '已拒绝非本地回环 Origin 来源的写请求。' });
          return;
        }
        if (!writable) {
          sendJson(res, 403, { ok: false, error: '当前控制台处于只读模式；请去掉 --readonly 参数以启用审阅落盘。' });
          return;
        }
        const body = req.method === 'DELETE'
          ? { id: url.searchParams.get('id') || '' }
          : await readJsonBody(req);

        if (pathname === '/api/studio/annotations' || pathname === '/api/studio/decisions') {
          const catalog = await getCatalog(false);
          const reqRepo = cleanString(body.repo, 140);
          const { repoId: embeddedRepo } = body.target !== undefined && body.target !== null
            ? splitQualifiedTargetId(cleanString(body.target, 280))
            : { repoId: null };
          if (reqRepo && embeddedRepo && reqRepo !== embeddedRepo) {
            sendJson(res, 400, {
              ok: false,
              error: `请求体 repo (${reqRepo}) 与 target 内嵌仓库前缀 (${embeddedRepo}) 不一致。`,
            });
            return;
          }
          const checkRepo = embeddedRepo || reqRepo;
          if (checkRepo && !catalog.byId.has(checkRepo)) {
            sendJson(res, 404, { ok: false, error: `未找到指定的技能族仓库：${checkRepo}` });
            return;
          }
          const effectiveRepoId = checkRepo || catalog.primaryRepoId || 'workspace';
          const fb = getLegacyFallback(catalog);
          const out = await enqueueWrite(async () => {
            const store = await readStudioReviewStore(resolvedRoot, {
              reviewsPath,
              legacyFallbackRoot: fb.legacyFallbackRoot,
              defaultPrimaryRepoId: fb.defaultPrimaryRepoId,
            });
            const mut = pathname === '/api/studio/annotations'
              ? applyAnnotationMutation(store, body, { repoId: effectiveRepoId })
              : applyDecisionMutation(store, body, { repoId: effectiveRepoId });
            const saved = await writeStudioReviewStore(resolvedRoot, store, { reviewsPath });
            return { ...mut, saved };
          });
          broadcast('review-change', { updatedAt: out.saved.updatedAt });
          sendJson(res, 200, {
            ok: true,
            effectiveStatus: out.effectiveStatus,
            ...(out.annotation ? { annotation: out.annotation } : {}),
            ...(out.deletedId ? { deletedId: out.deletedId } : {}),
            ...(out.decision ? { decision: out.decision } : {}),
            updatedAt: out.saved.updatedAt,
            decisions: out.saved.decisions,
            annotations: out.saved.annotations,
          });
          return;
        }

        if (pathname === '/api/studio/runtime/register' || pathname === '/api/monitor/register') {
          const catalog = await getCatalog(false);
          const repoRoots = [...catalog.byId.values()].map(r => r.realPath);
          const registered = await registerMonitorTarget(resolvedRoot, body, runtimeRegistryPath, {
            allowedRoots: [resolvedRoot, ...repoRoots, ...allowedRoots, tmpdir()],
          });
          broadcast('runtime-change', { at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, ...registered });
          return;
        }

        if (pathname === '/api/studio/runtime/unregister' || (req.method === 'DELETE' && pathname === '/api/studio/runtime/target')) {
          const catalog = await getCatalog(false);
          const repoRoots = [...catalog.byId.values()].map(r => r.realPath);
          const removed = await removeMonitorTarget(resolvedRoot, body?.id ?? body, runtimeRegistryPath, {
            allowedRoots: [resolvedRoot, ...repoRoots, ...allowedRoots, tmpdir()],
          });
          broadcast('runtime-change', { at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, ...removed });
          return;
        }

        if (pathname === '/api/studio/runtime/sandbox') {
          if (sandboxHandle?.releaseLock) {
            try { await sandboxHandle.releaseLock(); } catch {}
          }
          if (sandboxHandle?.sandboxRoot) {
            try { await rm(sandboxHandle.sandboxRoot, { recursive: true, force: true }); } catch {}
          }
          sandboxHandle = await runSandboxExercise({ holdLock: true, simulateTimeout: true });
          broadcast('runtime-change', { at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, target: sandboxHandle.targetEntry, lockHeld: Boolean(sandboxHandle.isLockHeld?.()) });
          return;
        }

        if (pathname === '/api/studio/runtime/sandbox/release') {
          const released = sandboxHandle?.releaseLock ? Boolean(await sandboxHandle.releaseLock()) : false;
          broadcast('runtime-change', { at: new Date().toISOString(), action: 'sandbox-release' });
          sendJson(res, 200, { ok: true, released, lockHeld: Boolean(sandboxHandle?.isLockHeld?.()) });
          return;
        }
      }

      if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
        sendJson(res, 405, { ok: false, error: '不支持的 HTTP 方法。' });
        return;
      }

      const staticMap = {
        '/': { file: join(UI_DIR, 'index.html'), type: MIME_TYPES['.html'] },
        '/index.html': { file: join(UI_DIR, 'index.html'), type: MIME_TYPES['.html'] },
        '/assets/studio.css': { file: join(UI_DIR, 'studio.css'), type: MIME_TYPES['.css'] },
        '/assets/app.mjs': { file: join(UI_DIR, 'app.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/tooltips.mjs': { file: join(UI_DIR, 'tooltips.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/diagram-svg.mjs': { file: join(UI_DIR, 'diagram-svg.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/fleet-ui.mjs': { file: join(UI_DIR, 'fleet-ui.mjs'), type: MIME_TYPES['.mjs'] },
        '/graph-layout.mjs': { file: join(PKG_SRC_DIR, 'graph-layout.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/graph-layout.mjs': { file: join(PKG_SRC_DIR, 'graph-layout.mjs'), type: MIME_TYPES['.mjs'] },
      };
      const hit = staticMap[pathname];
      if (!hit) {
        sendJson(res, 404, { ok: false, error: `未找到请求路径：${pathname}` });
        return;
      }
      const bytes = await readFile(hit.file);
      res.writeHead(200, {
        'Content-Type': hit.type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const code = error?.statusCode || 500;
      sendJson(res, code, { ok: false, error: error?.message || '服务器内部错误' });
    }
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    if (runtimeDebounceTimer) clearTimeout(runtimeDebounceTimer);
    for (const w of runtimeWatchers) { try { w.close(); } catch {} }
    for (const c of sseClients) { try { c.end(); } catch {} }
    sseClients.clear();
    if (sandboxHandle?.releaseLock) {
      Promise.resolve(sandboxHandle.releaseLock())
        .catch(() => {})
        .finally(() => {
          if (sandboxHandle?.sandboxRoot) {
            rm(sandboxHandle.sandboxRoot, { recursive: true, force: true }).catch(() => {});
          }
        });
    }
    rm(emptyScanDir, { recursive: true, force: true }).catch(() => {});
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });

  const boundPort = server.address().port;
  const serverUrl = `http://127.0.0.1:${boundPort}/`;
  const readyFile = typeof env?.SF_MONITOR_READY_FILE === 'string' ? env.SF_MONITOR_READY_FILE.trim() : '';
  if (readyFile) {
    try {
      await mkdir(dirname(resolve(readyFile)), { recursive: true });
      await writeFile(
        resolve(readyFile),
        `${JSON.stringify({
          ok: true,
          service: 'skill-family-studio',
          port: boundPort,
          pid: process.pid,
          url: serverUrl,
          foundationVersion: FOUNDATION_PACKAGE_VERSION,
          at: new Date().toISOString(),
        }, null, 2)}\n`,
        'utf8',
      );
    } catch {}
  }

  return {
    server,
    port: boundPort,
    writable,
    url: serverUrl,
    close: () => {
      for (const c of sseClients) { try { c.end(); } catch {} }
      sseClients.clear();
      server.closeAllConnections?.();
      return new Promise(res => server.close(() => res()));
    },
  };
}

export async function collectStudioSnapshot({
  root = '.',
  scanRoots,
  repo = null,
  reviewsPath = DEFAULT_STUDIO_REVIEWS_PATH,
  runtimeRegistryPath = STUDIO_RUNTIME_REGISTRY_PATH,
  env = process.env,
} = {}) {
  const resolvedRoot = resolve(root);
  const rootReal = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const rootDigest = computePathDigest(rootReal);
  const emptyScanDir = await mkdtemp(join(tmpdir(), 'sfs-snap-'));
  try {
    const catalog = await discoverStudioRepos(resolvedRoot, { scanRoots, env });
    const targetRepoId = repo || catalog.primaryRepoId;
    const record = targetRepoId ? catalog.byId.get(targetRepoId) : null;
    const inspected = record ? await inspectProjectRepo(record, emptyScanDir) : null;
    const alignment = record ? await inspectRepoAlignment(record, catalog) : null;
    const legacyHit = [...catalog.byId.values()].find(r => existsSync(join(r.realPath, 'artifacts/reviews/workbench-reviews.json')))
      || [...catalog.byId.values()].find(r => r.repoRole === 'portfolio')
      || null;
    const store = await readStudioReviewStore(resolvedRoot, {
      reviewsPath,
      legacyFallbackRoot: legacyHit?.realPath ?? null,
      defaultPrimaryRepoId: legacyHit?.id ?? catalog.primaryRepoId ?? null,
    });
    const reviewSummary = buildStudioReviewSummary(store, { repos: catalog.repos });
    const runtime = await collectStudioRuntimeView({
      root: resolvedRoot,
      catalog,
      selectedRepoId: targetRepoId,
      registryPath: runtimeRegistryPath,
    });
    return {
      schemaVersion: 1,
      kind: 'skill-family-studio.snapshot',
      ok: true,
      generatedAt: new Date().toISOString(),
      ecosystem: {
        available: catalog.available,
        count: catalog.count,
        primaryRepoId: catalog.primaryRepoId,
        repos: catalog.repos,
      },
      selectedRepo: inspected ? inspected.publicSnapshot : null,
      alignment,
      reviewSummary: {
        counts: reviewSummary.counts,
        repos: reviewSummary.repos,
        unresolvedAnnotations: reviewSummary.unresolvedAnnotations,
      },
      runtime: {
        foundationVersion: runtime.foundationVersion,
        kpi: runtime.kpi,
        currentRepoHasRuntime: runtime.currentRepoHasRuntime,
        targetsCount: runtime.targets?.length ?? 0,
      },
    };
  } finally {
    await rm(emptyScanDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runStudioDoctor({ root = '.', scanRoots, env = process.env } = {}) {
  const checks = [];
  const nodeVer = process.versions.node;
  const [maj, min, pat] = nodeVer.split('.').map(Number);
  const nodeOk = maj === 22 && (min > 22 || (min === 22 && pat >= 2));
  checks.push({
    id: 'node-runtime',
    ok: nodeOk,
    detail: `Node.js v${nodeVer}（要求 >=22.22.2 <23）`,
  });

  const cssRaw = await readFile(join(UI_DIR, 'studio.css'), 'utf8');
  const cssClean = cssRaw.replaceAll('http://www.w3.org/2000/svg', '');
  const offlineOk = !/https?:\/\/|@import\s+url\(/i.test(cssClean) && !/max-width\s*:\s*1440px/i.test(cssRaw);
  checks.push({
    id: 'offline-widescreen-ui',
    ok: offlineOk,
    detail: offlineOk ? '离线样式校验通过（零外网请求、零 1440px 锁宽限制）' : '样式存在外网引用或残余锁宽限制',
  });

  const catalog = await discoverStudioRepos(resolve(root), { scanRoots, env });
  checks.push({
    id: 'ecosystem-discovery',
    ok: true,
    detail: `已发现 ${catalog.count} 座带制品图配置的仓库`,
  });

  const ok = checks.every(c => c.ok);
  return {
    ok,
    service: 'skill-family-studio',
    checkedAt: new Date().toISOString(),
    discoveredRepos: catalog.count,
    checks,
  };
}
