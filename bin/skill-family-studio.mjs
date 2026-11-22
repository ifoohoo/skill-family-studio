#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveContained, writeFileAtomic } from 'skill-family-harness-node';
import { DEFAULT_STUDIO_REVIEWS_PATH } from '../src/review-state.mjs';
import { collectStudioSnapshot, createStudioServer, runStudioDoctor } from '../src/server.mjs';

export const DEFAULT_STUDIO_PORT = 57630;
const CLI_PATH = fileURLToPath(import.meta.url);

function printHelp() {
  process.stdout.write(`skill-family-studio —— 制品图谱审阅与 Foundation 运行态监控统一控制台

用法：
  skill-family-studio <subcommand> [options]

可用子命令：
  serve     在前台启动单端口本地回环控制台（默认 127.0.0.1:57630）
  ensure    幂等检测目标端口是否已有运行中的 Studio；若无则后台守护启动并返回入口 URL
  snapshot  离线采集设计态制品图、审阅汇总与 Foundation 运行态 JSON 快照
  doctor    核验本地 Node.js 版本、离线宽屏前端资产与生态仓库扫描状态

常用参数：
  --root <dir>            工作区根目录（默认当前目录）
  --port <port>           监听端口（serve/ensure 默认 57630，传 0 使用随机空闲端口）
  --scan-roots <dirs>     逗号分隔的生态扫描目录（传 none 仅扫描 --root）
  --tab <tab>             默认打开页签：guide | graph | review | runtime
  --repo <id>             默认选中的仓库标识（如 skill-family/skill-family-workspace）
  --reviews-file <path>   审阅台账保存路径（相对于 --root，默认 .skill-family-studio/reviews.json）
  --out <relPath>         snapshot 子命令将 JSON 写入 --root 内的相对路径
  --readonly              只读预览模式，拒绝审阅批注或结论落盘
  --help, -h              显示本帮助说明
`);
}

function probeStudioHealth(port, timeoutMs = 1200) {
  return new Promise(resolveProbe => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: timeoutMs },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolveProbe(res.statusCode === 200 && data?.ok === true && data?.service === 'skill-family-studio' ? data : null);
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

export async function ensureStudioDaemon({
  root = '.',
  port = DEFAULT_STUDIO_PORT,
  scanRoots,
  tab,
  repo,
  reviewsPath = DEFAULT_STUDIO_REVIEWS_PATH,
} = {}) {
  const resolvedRoot = resolve(root);
  const existing = await probeStudioHealth(port);
  const query = new URLSearchParams();
  if (tab) query.set('tab', tab);
  if (repo) query.set('repo', repo);
  const suffix = query.toString() ? `?${query}` : '';
  const url = `http://127.0.0.1:${port}/${suffix}`;
  if (existing) {
    return { ok: true, reused: true, port, url, health: existing };
  }

  const stateDir = join(resolvedRoot, '.skill-family-studio');
  await mkdir(stateDir, { recursive: true });
  const logFd = await open(join(stateDir, 'studio.log'), 'a');
  const childArgs = [CLI_PATH, 'serve', '--root', resolvedRoot, '--port', String(port), '--reviews-file', reviewsPath];
  if (scanRoots) childArgs.push('--scan-roots', String(scanRoots));
  if (tab) childArgs.push('--tab', String(tab));
  if (repo) childArgs.push('--repo', String(repo));

  const child = spawn(process.execPath, childArgs, {
    cwd: resolvedRoot,
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
  });
  child.unref();
  await logFd.close();

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const ready = await probeStudioHealth(port, 800);
    if (ready) {
      await writeFileAtomic(
        resolvedRoot,
        '.skill-family-studio/daemon.json',
        `${JSON.stringify({ pid: child.pid, port, url, startedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      return { ok: true, reused: false, pid: child.pid, port, url };
    }
    await new Promise(r => setTimeout(r, 140));
  }
  throw new Error(`后台启动 skill-family-studio 超时（端口 ${port} 未在 6 秒内就绪）；请检查 .skill-family-studio/studio.log。`);
}

async function main(argv = process.argv.slice(2)) {
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
      out: { type: 'string' },
      readonly: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const sub = positionals[0] || (values.help ? 'help' : 'serve');
  if (values.help || sub === 'help') {
    printHelp();
    return;
  }

  const root = resolve(values.root || '.');
  const port = values.port !== undefined ? Number.parseInt(values.port, 10) : DEFAULT_STUDIO_PORT;

  if (sub === 'serve') {
    const srv = await createStudioServer({
      root,
      port,
      writable: !values.readonly,
      reviewsPath: values['reviews-file'],
      scanRoots: values['scan-roots'],
      defaultTab: values.tab || null,
      defaultRepo: values.repo || null,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'serve', port: srv.port, url: srv.url, writable: srv.writable })}\n`);
    const shutdown = () => srv.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  if (sub === 'ensure') {
    const res = await ensureStudioDaemon({
      root,
      port,
      scanRoots: values['scan-roots'],
      tab: values.tab,
      repo: values.repo,
      reviewsPath: values['reviews-file'],
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (sub === 'snapshot') {
    const snap = await collectStudioSnapshot({
      root,
      scanRoots: values['scan-roots'],
      repo: values.repo || null,
      reviewsPath: values['reviews-file'],
    });
    const text = `${JSON.stringify(snap, null, 2)}\n`;
    if (values.out) {
      const absOut = await resolveContained(root, values.out);
      await mkdir(dirname(absOut), { recursive: true });
      await writeFileAtomic(root, values.out, text);
    }
    process.stdout.write(text);
    return;
  }

  if (sub === 'doctor') {
    const report = await runStudioDoctor({ root, scanRoots: values['scan-roots'] });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`未知子命令 "${sub}"；请运行 skill-family-studio --help 查看支持的命令（serve / ensure / snapshot / doctor）。`);
}

if (process.argv[1] && resolve(process.argv[1]) === CLI_PATH) {
  main().catch(err => {
    process.stderr.write(`[skill-family-studio] ${err?.message || err}\n`);
    process.exitCode = 1;
  });
}
