#!/usr/bin/env node
// @feature STU003
// @feature STU004
// @feature STU006

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveContained, writeFileAtomic } from 'skill-family-harness-node';
import { DEFAULT_STUDIO_REVIEWS_PATH } from '../src/review-state.mjs';
import { DEFAULT_LOCK_WARN_MS, STUDIO_RUNTIME_REGISTRY_PATH } from '../src/runtime-bridge.mjs';
import { collectStudioSnapshot, createStudioServer, normalizeStudioTab, runStudioDoctor } from '../src/server.mjs';
import { computePathDigest, initWorkspaceConfig, inspectSetup } from '../src/setup-advisor.mjs';

export const DEFAULT_STUDIO_PORT = 57630;
const CLI_PATH = fileURLToPath(import.meta.url);

function printHelp() {
  process.stdout.write(`skill-family-studio —— 制品图谱审阅与 Foundation 运行态监控统一控制台

用法：
  skill-family-studio <subcommand> [options]

可用子命令：
  inspect-setup  只读探测当前目录角色（单仓 / 高阶仓 / 详设子仓 / 多仓父目录）与推荐启动方式
  init-workspace 安全生成声明式 .studio-workspace.json 多仓边界配置
  serve          在前台启动单端口本地回环控制台（默认 127.0.0.1:57630）
  ensure         幂等检测目标端口是否已收录当前目录并复用；未收录则隔离拉起新端口
  open           ensure 的兼容别名，供制品助手等委托调用幂等打开控制台
  snapshot       离线采集设计态制品图、审阅汇总与运行态 JSON 快照
  doctor         核验本地 Node.js 版本、离线宽屏前端资产与生态仓库扫描状态

常用参数：
  --root <dir>            工作区根目录（默认当前目录）
  --port <port>           监听端口（serve/ensure/open 默认 57630，传 0 使用随机空闲端口）
  --scan-roots <dirs>     逗号分隔的生态扫描目录（传 none 仅扫描 --root）
  --tab <tab>             默认打开页签：guide（兼容 overview）| graph | review | runtime
  --repo <id>             默认选中的仓库标识
  --mode <mode>           init-workspace 模式：single | related | custom
  --title <text>          init-workspace 工作区标题
  --role <role>           init-workspace 角色（portfolio | workspace）
  --reviews-file <path>   审阅台账保存路径（相对于 --root，默认 .skill-family-studio/reviews.json）
  --registry <path>       运行态监控注册表路径（兼容 Foundation monitor 委托）
  --lock-warn-ms <ms>     令牌锁持锁超时预警阈值毫秒数（默认 30000）
  --allowed-root <dir>    额外允许运行态监控读取的根目录（可重复传入）
  --workbench-url <url>   兼容传入的外部工作台关联地址
  --writable              显式开启审阅落盘模式（默认可写）
  --readonly              只读预览模式，拒绝审阅批注或结论落盘
  --out <relPath>         snapshot 子命令将 JSON 写入 --root 内的相对路径
  --json                  以结构化 JSON 输出
  --help, -h              显示本帮助说明
`);
}

function probeStudioJson(port, reqPath, timeoutMs = 1200) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(null);
  return new Promise(resolveProbe => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', timeout: timeoutMs },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolveProbe(res.statusCode === 200 ? data : null);
          } catch {
            resolveProbe(null);
          }
        });
      },
    );
    req.on('error', () => resolveProbe(null));
    req.on('timeout', () => { req.destroy(); resolveProbe(null); });
    req.end();
  });
}

async function probeStudioHealth(port, timeoutMs = 1200) {
  const data = await probeStudioJson(port, '/api/health', timeoutMs);
  return data?.ok === true && data?.service === 'skill-family-studio' ? data : null;
}

export function parseStudioCliArgs(argv = []) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      port: { type: 'string' },
      'scan-roots': { type: 'string' },
      tab: { type: 'string' },
      repo: { type: 'string' },
      'reviews-file': { type: 'string', default: DEFAULT_STUDIO_REVIEWS_PATH },
      registry: { type: 'string' },
      'lock-warn-ms': { type: 'string' },
      'allowed-root': { type: 'string', multiple: true },
      'workbench-url': { type: 'string' },
      mode: { type: 'string' },
      title: { type: 'string' },
      role: { type: 'string' },
      out: { type: 'string' },
      writable: { type: 'boolean' },
      readonly: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.writable === true && values.readonly === true) {
    throw new Error('--writable 与 --readonly 互斥，不能同时传入。');
  }
  const effectiveWritable = values.readonly ? false : (values.writable !== undefined ? Boolean(values.writable) : true);
  const rawTab = values.tab || (values.registry ? 'runtime' : null);
  const normalizedTab = normalizeStudioTab(rawTab);
  const port = values.port !== undefined ? Number.parseInt(values.port, 10) : DEFAULT_STUDIO_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效的 --port 参数 "${values.port}"；须为 0 至 65535 之间的整数。`);
  }
  const lockWarnMs = values['lock-warn-ms'] !== undefined
    ? Number.parseInt(values['lock-warn-ms'], 10)
    : DEFAULT_LOCK_WARN_MS;
  const allowedRoots = (values['allowed-root'] ?? [])
    .flatMap(item => String(item).split(','))
    .map(s => s.trim())
    .filter(Boolean);

  return {
    subcommand: positionals[0] || (values.help ? 'help' : 'serve'),
    help: Boolean(values.help),
    root: resolve(values.root || '.'),
    port,
    scanRoots: values['scan-roots'],
    tab: normalizedTab,
    repo: values.repo || null,
    reviewsPath: values['reviews-file'] || DEFAULT_STUDIO_REVIEWS_PATH,
    runtimeRegistryPath: values.registry || STUDIO_RUNTIME_REGISTRY_PATH,
    lockWarnMs: Number.isFinite(lockWarnMs) && lockWarnMs > 0 ? lockWarnMs : DEFAULT_LOCK_WARN_MS,
    allowedRoots,
    workbenchUrl: values['workbench-url'] || null,
    writable: effectiveWritable,
    out: values.out || null,
    mode: values.mode || 'single',
    title: values.title || null,
    role: values.role || null,
  };
}

export async function ensureStudioDaemon({
  root = '.',
  port = DEFAULT_STUDIO_PORT,
  scanRoots,
  tab,
  repo,
  writable = true,
  reviewsPath = DEFAULT_STUDIO_REVIEWS_PATH,
  runtimeRegistryPath = STUDIO_RUNTIME_REGISTRY_PATH,
  lockWarnMs = DEFAULT_LOCK_WARN_MS,
  allowedRoots = [],
  workbenchUrl = null,
} = {}) {
  const resolvedRoot = resolve(root);
  const rootReal = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const targetDigest = computePathDigest(rootReal);
  const normalizedTab = normalizeStudioTab(tab);
  const buildUrl = (p, repoOverride = repo) => {
    const query = new URLSearchParams();
    if (normalizedTab) query.set('tab', normalizedTab);
    if (repoOverride) query.set('repo', repoOverride);
    const suffix = query.toString() ? `?${query}` : '';
    return `http://127.0.0.1:${p}/${suffix}`;
  };

  let spawnPort = port;
  let isolatedFromPort = null;
  if (port > 0) {
    const existing = await probeStudioHealth(port);
    if (existing) {
      const stateDoc = await probeStudioJson(port, '/api/studio/state', 1500);
      const reposList = stateDoc?.ecosystem?.repos || [];
      const matchedRepo = reposList.find(r => r?.pathDigest && r.pathDigest === targetDigest) || null;
      const rootMatched = existing.rootDigest === targetDigest || stateDoc?.rootDigest === targetDigest;
      if (matchedRepo || rootMatched) {
        const effectiveRepo = repo || matchedRepo?.id || null;
        return {
          ok: true,
          reused: true,
          port,
          pid: existing.pid ?? null,
          matchedRepoId: matchedRepo?.id ?? null,
          url: buildUrl(port, effectiveRepo),
          health: existing,
        };
      }
      // 现有实例未收录目标 --root，改为独立分配空闲端口，避免打开错误的仓库工作区
      spawnPort = 0;
      isolatedFromPort = port;
    }
  }

  const stateDir = join(resolvedRoot, '.skill-family-studio');
  await mkdir(stateDir, { recursive: true });
  const logFd = await open(join(stateDir, 'studio.log'), 'a');
  const readyDir = await mkdtemp(join(await realpath(tmpdir()), 'sfs-ensure-ready-'));
  const readyFile = join(readyDir, 'ready.json');

  const childArgs = [
    CLI_PATH, 'serve',
    '--root', resolvedRoot,
    '--port', String(spawnPort),
    '--reviews-file', reviewsPath,
    '--registry', runtimeRegistryPath,
    '--lock-warn-ms', String(lockWarnMs),
    ...(writable ? ['--writable'] : ['--readonly']),
  ];
  if (scanRoots) childArgs.push('--scan-roots', String(scanRoots));
  if (normalizedTab) childArgs.push('--tab', normalizedTab);
  if (repo) childArgs.push('--repo', String(repo));
  if (workbenchUrl) childArgs.push('--workbench-url', String(workbenchUrl));
  for (const ar of allowedRoots) childArgs.push('--allowed-root', String(ar));

  try {
    const child = spawn(process.execPath, childArgs, {
      cwd: resolvedRoot,
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: { ...process.env, SF_MONITOR_READY_FILE: readyFile },
    });
    child.unref();
    await logFd.close();

    const deadline = Date.now() + 6000;
    let actualPort = spawnPort > 0 ? spawnPort : null;
    while (Date.now() < deadline) {
      if (!actualPort) {
        try {
          const rj = JSON.parse(await readFile(readyFile, 'utf8'));
          if (Number.isInteger(rj?.port) && rj.port > 0) actualPort = rj.port;
        } catch {}
      }
      if (actualPort) {
        const ready = await probeStudioHealth(actualPort, 800);
        if (ready) {
          const finalUrl = buildUrl(actualPort);
          await writeFileAtomic(
            resolvedRoot,
            '.skill-family-studio/daemon.json',
            `${JSON.stringify({ pid: child.pid, port: actualPort, url: finalUrl, startedAt: new Date().toISOString() }, null, 2)}\n`,
          );
          return {
            ok: true,
            reused: false,
            pid: child.pid,
            port: actualPort,
            url: finalUrl,
            ...(isolatedFromPort ? {
              isolatedFromPort,
              note: `端口 ${isolatedFromPort} 运行中的工作台未收录目标仓库，已为你独立启动新端口 ${actualPort}，避免打开错误项目。`,
            } : {}),
          };
        }
      }
      await new Promise(r => setTimeout(r, 90));
    }
    throw new Error(`后台启动 skill-family-studio 超时（端口 ${spawnPort} 未在 6 秒内就绪）；请检查 .skill-family-studio/studio.log。`);
  } finally {
    await rm(readyDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseStudioCliArgs(argv);
  if (opts.help || opts.subcommand === 'help') {
    printHelp();
    return;
  }

  if (opts.subcommand === 'serve') {
    const srv = await createStudioServer({
      root: opts.root,
      port: opts.port,
      writable: opts.writable,
      reviewsPath: opts.reviewsPath,
      runtimeRegistryPath: opts.runtimeRegistryPath,
      lockWarnMs: opts.lockWarnMs,
      allowedRoots: opts.allowedRoots,
      workbenchUrl: opts.workbenchUrl,
      scanRoots: opts.scanRoots,
      defaultTab: opts.tab,
      defaultRepo: opts.repo,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'serve', port: srv.port, pid: process.pid, url: srv.url, writable: srv.writable })}\n`);
    const shutdown = () => srv.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  if (opts.subcommand === 'ensure' || opts.subcommand === 'open') {
    const res = await ensureStudioDaemon(opts);
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (opts.subcommand === 'snapshot') {
    const snap = await collectStudioSnapshot({
      root: opts.root,
      scanRoots: opts.scanRoots,
      repo: opts.repo,
      reviewsPath: opts.reviewsPath,
      runtimeRegistryPath: opts.runtimeRegistryPath,
    });
    const text = `${JSON.stringify(snap, null, 2)}\n`;
    if (opts.out) {
      const absOut = await resolveContained(opts.root, opts.out);
      await mkdir(dirname(absOut), { recursive: true });
      await writeFileAtomic(opts.root, opts.out, text);
    }
    process.stdout.write(text);
    return;
  }

  if (opts.subcommand === 'inspect-setup') {
    const setup = await inspectSetup({ root: opts.root });
    process.stdout.write(`${JSON.stringify(setup, null, 2)}\n`);
    return;
  }

  if (opts.subcommand === 'init-workspace') {
    const created = await initWorkspaceConfig({
      root: opts.root,
      mode: opts.mode,
      scanRoots: opts.scanRoots,
      title: opts.title,
      role: opts.role,
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return;
  }

  if (opts.subcommand === 'doctor') {
    const report = await runStudioDoctor({ root: opts.root, scanRoots: opts.scanRoots });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`未知子命令 "${opts.subcommand}"；请运行 skill-family-studio --help 查看支持的命令（inspect-setup / init-workspace / serve / ensure / open / snapshot / doctor）。`);
}

if (process.argv[1] && resolve(process.argv[1]) === CLI_PATH) {
  main().catch(err => {
    process.stderr.write(`[skill-family-studio] ${err?.message || err}\n`);
    process.exitCode = 1;
  });
}
