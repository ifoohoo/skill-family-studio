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
import {
  discoverStudioRepos,
  inspectProjectRepo,
  readRepoArchifyAsset,
  readRepoDocument,
  registerStudioRepo,
  unregisterStudioRepo,
  updateStudioRepoMeta,
} from './ecosystem.mjs';
import { STUDIO_GUIDE_MODEL } from './guide-content.mjs';
import {
  DEFAULT_STUDIO_REVIEWS_PATH,
  applyAnnotationMutation,
  applyDecisionMutation,
  assertSafeObjectKeys,
  buildStudioReviewSummary,
  cleanString,
  qualifyRepoTargetId,
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
import {
  collectStudioStbView,
  consumeDriverCsrfToken,
  issueDriverCsrfToken,
  runLiveStbAuditDemo,
} from './stb-bridge.mjs';
import { computePathDigest } from './setup-advisor.mjs';
import { inspectLifecycleCollaboration, loadLifecycleSummary } from './lifecycle-inspector.mjs';

const PKG_SRC_DIR = fileURLToPath(new URL('./', import.meta.url));
const UI_DIR = join(PKG_SRC_DIR, 'ui');
const MAX_SSE_CLIENTS = 64;

const ARCHIFY_BRIDGE_SCRIPT = `<style id="studio-archify-embed-fix">
html[data-embed="true"] body{min-height:0!important;margin:0!important;padding:0!important;overflow:auto!important;}
html[data-embed="true"] .toolbar,html[data-embed="true"] .header,html[data-embed="true"] .cards{display:none!important;}
html[data-embed="true"] .container{max-width:none!important;margin:0!important;padding:0!important;}
html[data-embed="true"] .diagram-container{display:flex!important;align-items:flex-start!important;justify-content:center!important;min-height:0!important;margin:0!important;padding:8px 12px!important;border:0!important;box-shadow:none!important;}
</style><script>
(function(){
  if(window.__studioArchifyBridge)return;
  window.__studioArchifyBridge=true;
  try{
    if(new URLSearchParams(window.location.search).get('embed')==='1'){
      document.documentElement.setAttribute('data-embed','true');
    }
  }catch(_){}
  var post=function(payload){try{if(window.parent&&window.parent!==window){window.parent.postMessage(payload,'*');}}catch(_){}};
  window.addEventListener('message',function(ev){
    var m=ev&&ev.data;
    if(!m||m.__studioArchifyHost!==true)return;
    if(m.type==='set-zoom'){
      var z=Math.max(0.4,Math.min(2.4,Number(m.zoom)||1));
      var dc=document.querySelector('.diagram-container');
      var target=dc||document.body;
      if(target){
        target.style.transformOrigin='top center';
        target.style.transform=Math.abs(z-1)<0.01?'':'scale('+z+')';
      }
    }
  });
  document.addEventListener('click',function(ev){
    var t=ev.target;
    if(!t||typeof t.closest!=='function')return;
    var el=t.closest('[data-node-id],[data-outline-node]')||t.closest('[id^="node-"]:not(#node-finder):not(#node-outline):not([id^="node-finder-"]):not([id^="node-outline-"])');
    if(!el)return;
    var nodeId=el.getAttribute('data-node-id')||el.getAttribute('data-outline-node')||'';
    if(!nodeId){
      var rawId=el.getAttribute('id')||'';
      if(rawId.indexOf('node-')===0&&rawId!=='node-finder'&&rawId!=='node-outline')nodeId=rawId.slice(5);
    }
    if(!nodeId)return;
    var label=el.getAttribute('data-node-label')||(el.hasAttribute('data-outline-node')?(el.textContent||'').trim():'')||nodeId;
    post({__studioArchify:true,type:'node-click',nodeId:nodeId,label:label});
  },true);
  document.addEventListener('keydown',function(ev){
    if(ev.key==='Escape')post({__studioArchify:true,type:'escape',nodeId:null});
    else if((ev.metaKey||ev.ctrlKey)&&!ev.altKey&&!ev.shiftKey&&String(ev.key||'').toLowerCase()==='k'){
      ev.preventDefault();
      post({__studioArchify:true,type:'focus-search',nodeId:null});
    }
  },true);
})();
</script>`;

export function injectArchifyBridgeHtml(htmlText) {
  const raw = String(htmlText ?? '');
  const idx = raw.search(/<\/body\s*>/i);
  if (idx === -1) return `${raw}\n${ARCHIFY_BRIDGE_SCRIPT}`;
  return `${raw.slice(0, idx)}${ARCHIFY_BRIDGE_SCRIPT}\n${raw.slice(idx)}`;
}

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
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

export function isSafeLoopbackOrigin(req, expectedPort = null) {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  if (typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false;
    if (expectedPort !== null && expectedPort !== undefined && Number(expectedPort) > 0) {
      const originPort = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
      if (originPort !== Number(expectedPort)) return false;
    }
    return true;
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
  if (['lifecycle', 'guide', 'graph', 'review', 'runtime'].includes(clean)) return clean;
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
  const lifecycleCache = new Map();
  let sandboxHandle = null;

  const getCatalog = async (force = false) => {
    if (!force && cachedCatalog && Date.now() - catalogAt < 15000) return cachedCatalog;
    cachedCatalog = await discoverStudioRepos(resolvedRoot, { scanRoots, env });
    catalogAt = Date.now();
    return cachedCatalog;
  };

  const getLifecyclePayload = async (catalog, reqRepoId = null, force = false) => {
    const cacheKey = reqRepoId || '__default__';
    const hit = lifecycleCache.get(cacheKey);
    if (!force && hit && Date.now() - hit.at < 12000) return hit.payload;
    const payload = await inspectLifecycleCollaboration({
      root: resolvedRoot,
      catalog,
      repoId: reqRepoId || null,
    });
    lifecycleCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
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
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          sendJson(res, 503, { ok: false, error: `实时事件订阅客户端数量已达上限（${MAX_SSE_CLIENTS}）。` });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          sseClients.delete(res);
        };
        sseClients.add(res);
        req.once('close', cleanup);
        req.once('aborted', cleanup);
        res.once('close', cleanup);
        res.once('error', cleanup);
        try {
          res.write(`event: connected\ndata: ${JSON.stringify({ writable, at: new Date().toISOString() })}\n\n`);
        } catch {
          cleanup();
        }
        return;
      }

      if (pathname === '/api/studio/state') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const force = url.searchParams.get('refresh') === '1';
        const catalog = await getCatalog(force);
        const fb = getLegacyFallback(catalog);
        const [store, lcSummary] = await Promise.all([
          readStudioReviewStore(resolvedRoot, {
            reviewsPath,
            legacyFallbackRoot: fb.legacyFallbackRoot,
            defaultPrimaryRepoId: fb.defaultPrimaryRepoId,
          }),
          loadLifecycleSummary({ root: resolvedRoot, catalog }),
        ]);
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
          lifecycle: lcSummary,
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
        const ext = extname(cleanPath).toLowerCase();
        const isHtml = ext === '.html' || ext === '.htm';
        const headers = {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        };
        let payload = bytes;
        if (isHtml) {
          headers['Content-Security-Policy'] = 'sandbox allow-scripts';
          payload = Buffer.from(injectArchifyBridgeHtml(bytes.toString('utf8')), 'utf8');
        }
        res.writeHead(200, headers);
        res.end(payload);
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
        const itemMetaByTarget = new Map();
        const touchedRepos = new Set();
        for (const qt of Object.keys(store.decisions ?? {})) {
          const { repoId } = splitQualifiedTargetId(qt);
          if (repoId) touchedRepos.add(repoId);
        }
        for (const ann of store.annotations ?? []) {
          const { repoId } = splitQualifiedTargetId(ann?.target || '');
          if (repoId) touchedRepos.add(repoId);
        }
        for (const rid of touchedRepos) {
          const rec = catalog.byId.get(rid);
          if (!rec) continue;
          try {
            const entry = await getRepoEntry(rec, false);
            for (const it of entry.publicSnapshot.reviewItems || []) {
              const qt = qualifyRepoTargetId(rid, it.target || it.uid);
              itemMetaByTarget.set(qt, { title: it.title || '', summary: it.summary || '', typeLabel: it.typeLabel || '' });
            }
          } catch {}
        }
        const summary = buildStudioReviewSummary(store, { repos: catalog.repos, itemMetaByTarget });
        if (url.searchParams.get('format') === 'markdown') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(Buffer.from(summary.markdown, 'utf8'));
          return;
        }
        sendJson(res, 200, { ok: true, writable, updatedAt: store.updatedAt, ...summary });
        return;
      }

      if (pathname === '/api/studio/lifecycle') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const force = url.searchParams.get('refresh') === '1';
        const catalog = await getCatalog(force);
        const reqRepo = url.searchParams.get('repo') || null;
        const lc = await getLifecyclePayload(catalog, reqRepo, force);
        sendJson(res, 200, lc);
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

      if (pathname === '/api/studio/stb') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        const stbPayload = await collectStudioStbView({ root: resolvedRoot });
        sendJson(res, 200, stbPayload);
        return;
      }

      if (pathname === '/api/studio/driver/csrf') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' }); return; }
        if (String(req.headers['x-studio-request'] ?? '').trim() !== '1') {
          sendJson(res, 403, { ok: false, error: 'CSRF 签发接口必须携带 X-Studio-Request: 1。' });
          return;
        }
        sendJson(res, 200, { ok: true, ...issueDriverCsrfToken() });
        return;
      }

      if (req.method === 'POST' || req.method === 'DELETE') {
        const expectedPort = server.address()?.port ?? (Number.isInteger(port) && port > 0 ? port : null);
        if (!isSafeLoopbackOrigin(req, expectedPort)) {
          sendJson(res, 403, { ok: false, error: '已拒绝非同端口本地回环 Origin 来源的写请求。' });
          return;
        }
        if (String(req.headers['x-studio-request'] ?? '').trim() !== '1') {
          sendJson(res, 403, { ok: false, error: '写接口必须携带自定义请求头 X-Studio-Request: 1。' });
          return;
        }
        const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
          sendJson(res, 415, { ok: false, error: '写接口仅接受 Content-Type: application/json。' });
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
          const registered = await enqueueWrite(async () => {
            const catalog = await getCatalog(false);
            const repoRoots = [...catalog.byId.values()].map(r => r.realPath);
            return registerMonitorTarget(resolvedRoot, body, runtimeRegistryPath, {
              allowedRoots: [resolvedRoot, ...repoRoots, ...allowedRoots, tmpdir()],
            });
          });
          broadcast('runtime-change', { at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, ...registered });
          return;
        }

        if (pathname === '/api/studio/runtime/unregister' || (req.method === 'DELETE' && pathname === '/api/studio/runtime/target')) {
          const removed = await enqueueWrite(async () => {
            const catalog = await getCatalog(false);
            const repoRoots = [...catalog.byId.values()].map(r => r.realPath);
            return removeMonitorTarget(resolvedRoot, body?.id ?? body, runtimeRegistryPath, {
              allowedRoots: [resolvedRoot, ...repoRoots, ...allowedRoots, tmpdir()],
            });
          });
          broadcast('runtime-change', { at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, ...removed });
          return;
        }

        if (pathname === '/api/studio/runtime/sandbox') {
          const sbxOut = await enqueueWrite(async () => {
            if (sandboxHandle?.releaseLock) {
              try { await sandboxHandle.releaseLock(); } catch {}
            }
            if (sandboxHandle?.sandboxRoot) {
              try { await rm(sandboxHandle.sandboxRoot, { recursive: true, force: true }); } catch {}
            }
            sandboxHandle = await runSandboxExercise({ holdLock: true, simulateTimeout: true });
            return { target: sandboxHandle.targetEntry, lockHeld: Boolean(sandboxHandle.isLockHeld?.()) };
          });
          broadcast('runtime-change', { at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, ...sbxOut });
          return;
        }

        if (pathname === '/api/studio/runtime/sandbox/release') {
          const relOut = await enqueueWrite(async () => {
            const released = sandboxHandle?.releaseLock ? Boolean(await sandboxHandle.releaseLock()) : false;
            return { released, lockHeld: Boolean(sandboxHandle?.isLockHeld?.()) };
          });
          broadcast('runtime-change', { at: new Date().toISOString(), action: 'sandbox-release' });
          sendJson(res, 200, { ok: true, ...relOut });
          return;
        }

        if (pathname === '/api/studio/repos/register') {
          const saved = await enqueueWrite(async () => registerStudioRepo(resolvedRoot, body));
          cachedCatalog = null;
          catalogAt = 0;
          repoCache.clear();
          lifecycleCache.clear();
          const nextCatalog = await getCatalog(true);
          const addedRec = [...nextCatalog.byId.values()].find(r => r.realPath === saved.realPath);
          broadcast('catalog-change', { action: 'register', repoId: addedRec?.id || null, at: new Date().toISOString() });
          sendJson(res, 200, {
            ok: true,
            addedRepoId: addedRec?.id || null,
            storagePath: saved.storagePath,
            ecosystem: {
              available: nextCatalog.available,
              count: nextCatalog.count,
              primaryRepoId: nextCatalog.primaryRepoId,
              repos: nextCatalog.repos,
            },
          });
          return;
        }

        if (pathname === '/api/studio/repos/unregister') {
          const curCatalog = await getCatalog(false);
          const saved = await enqueueWrite(async () => unregisterStudioRepo(resolvedRoot, body, curCatalog));
          cachedCatalog = null;
          catalogAt = 0;
          repoCache.clear();
          lifecycleCache.clear();
          const nextCatalog = await getCatalog(true);
          broadcast('catalog-change', { action: 'unregister', repoId: saved.removedRepoId, at: new Date().toISOString() });
          sendJson(res, 200, {
            ok: true,
            removedRepoId: saved.removedRepoId,
            mode: saved.mode,
            storagePath: saved.storagePath,
            ecosystem: {
              available: nextCatalog.available,
              count: nextCatalog.count,
              primaryRepoId: nextCatalog.primaryRepoId,
              repos: nextCatalog.repos,
            },
          });
          return;
        }

        if (pathname === '/api/studio/repos/meta') {
          const curCatalog = await getCatalog(false);
          const saved = await enqueueWrite(async () => updateStudioRepoMeta(resolvedRoot, body, curCatalog));
          cachedCatalog = null;
          catalogAt = 0;
          repoCache.clear();
          lifecycleCache.clear();
          const nextCatalog = await getCatalog(true);
          broadcast('catalog-change', { action: 'meta', repoId: saved.repoId, at: new Date().toISOString() });
          sendJson(res, 200, {
            ok: true,
            repoId: saved.repoId,
            storagePath: saved.storagePath,
            ecosystem: {
              available: nextCatalog.available,
              count: nextCatalog.count,
              primaryRepoId: nextCatalog.primaryRepoId,
              repos: nextCatalog.repos,
            },
          });
          return;
        }

        if (pathname === '/api/studio/driver/run-demo') {
          if (!consumeDriverCsrfToken(body.csrfToken)) {
            sendJson(res, 403, { ok: false, error: '一次性 CSRF 令牌无效或已过期，请重新确认后发起。' });
            return;
          }
          if (body.hitlConfirmed !== true) {
            sendJson(res, 400, { ok: false, error: '缺少人工显式确认（hitlConfirmed: true），已拒绝启动执行驱动进程。' });
            return;
          }
          const mode = body.mode === 'clean' ? 'clean' : 'fabricated';
          const entry = await enqueueWrite(async () => runLiveStbAuditDemo({
            root: resolvedRoot,
            mode,
            hitlConfirmed: true,
          }));
          broadcast('runtime-change', { action: 'stb-demo', bundleId: entry.bundleId, at: new Date().toISOString() });
          sendJson(res, 200, { ok: true, entry });
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
        '/assets/stb-ui.mjs': { file: join(UI_DIR, 'stb-ui.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/lifecycle-ui.mjs': { file: join(UI_DIR, 'lifecycle-ui.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/blueprint-canvas.mjs': { file: join(UI_DIR, 'blueprint-canvas.mjs'), type: MIME_TYPES['.mjs'] },
        '/graph-layout.mjs': { file: join(PKG_SRC_DIR, 'graph-layout.mjs'), type: MIME_TYPES['.mjs'] },
        '/assets/graph-layout.mjs': { file: join(PKG_SRC_DIR, 'graph-layout.mjs'), type: MIME_TYPES['.mjs'] },
      };
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        res.end();
        return;
      }
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
    const lifecycle = await loadLifecycleSummary({ root: resolvedRoot, catalog });
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
      lifecycle: {
        available: lifecycle.available,
        subject: lifecycle.subject || null,
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
