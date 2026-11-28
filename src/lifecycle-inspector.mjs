// @feature STU004
// @feature STU005
// @feature STU007

import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { VERSION_LOCK_PATH } from 'artifact-graph';
import { findSchemaByObject, verifySessionTraceBundleSeal } from 'skill-family-contracts';
import { readFileContained, resolveContained } from 'skill-family-harness-node';
import { parse as parseYaml } from 'yaml';
import {
  compareSemverTuple,
  formatSemverTuple,
  inspectDownstreamExecutionReceipt,
  inspectDownstreamLockFreshness,
  inspectPortfolioAllocations,
  parseSemverTuple,
} from './alignment-inspector.mjs';
import { loadStudioWorkspaceConfig } from './ecosystem.mjs';
import { sanitizePublicText } from './markdown-render.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_LIFECYCLE_REGISTRY_REL = 'artifacts/requirements-data/lifecycle-ecosystem.registry.json';
export const DEFAULT_LIFECYCLE_MODEL_REL = 'artifacts/domain-models/DM-002.json';

const FOUNDATION_PKG_NAMES = Object.freeze([
  'skill-family-contracts',
  'skill-family-harness-node',
  'skill-family-engineering-kit',
]);

export const RING_SHORT_META = Object.freeze({
  core: { ring: 'core', label: '内环核心', badgeTone: 'indigo', enterSwimlane: true },
  method: { ring: 'method', label: '可插拔方法', badgeTone: 'emerald', enterSwimlane: true },
  consumer: { ring: 'consumer', label: '下游消费样本', badgeTone: 'zinc', enterSwimlane: false },
  retired: { ring: 'retired', label: '已退役归并', badgeTone: 'amber', enterSwimlane: false },
  'external-tool': { ring: 'external-tool', label: '外部工具依赖', badgeTone: 'purple', enterSwimlane: false },
});

async function existsDir(absPath) {
  try {
    const st = await lstat(absPath);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

async function existsContainedFile(repoReal, relPath) {
  const clean = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) return false;
  try {
    const abs = await resolveContained(repoReal, clean);
    const st = await lstat(abs);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

async function readTextContainedSafe(repoReal, relPath) {
  const clean = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) return null;
  try {
    const abs = await resolveContained(repoReal, clean);
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return await readFileContained(repoReal, clean, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

async function readJsonContainedSafe(repoReal, relPath) {
  const raw = await readTextContainedSafe(repoReal, relPath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function listSubpackageNames(repoReal) {
  try {
    const pkgsAbs = await resolveContained(repoReal, 'packages');
    const st = await lstat(pkgsAbs);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    const entries = await readdir(pkgsAbs, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function runGitReadOnly(repoReal, args) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', '-C', repoReal, ...args],
      {
        timeout: 3500,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
    );
    return { ok: true, stdout: String(stdout ?? '').trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function isPlaceholderVersion(ver) {
  const s = String(ver ?? '').trim();
  if (!s) return true;
  return /^0\.0\.0(?:-|$)/.test(s);
}

async function probeSourceVersion(repoReal, publicName = '') {
  const subDirs = await listSubpackageNames(repoReal);
  const orderedSubs = publicName && subDirs.includes(publicName)
    ? [publicName, ...subDirs.filter(s => s !== publicName)]
    : subDirs;

  const subCandidates = [];
  for (const sub of orderedSubs) {
    const pkgRel = `packages/${sub}/package.json`;
    const pkg = await readJsonContainedSafe(repoReal, pkgRel);
    if (typeof pkg?.version === 'string' && pkg.version.trim()) {
      subCandidates.push({
        version: pkg.version.trim(),
        source: `${pkgRel}#version`,
        exactPublicMatch: sub === publicName || pkg.name === publicName,
        isPrivate: Boolean(pkg.private),
      });
    }
    const manifestRel = `packages/${sub}/plugin-src/manifest.json`;
    const mf = await readJsonContainedSafe(repoReal, manifestRel);
    if (typeof mf?.version === 'string' && mf.version.trim()) {
      subCandidates.push({
        version: mf.version.trim(),
        source: `${manifestRel}#version`,
        exactPublicMatch: sub === publicName || mf.name === publicName,
        isPrivate: false,
      });
    }
  }

  const exactSub = subCandidates.find(c => c.exactPublicMatch && !isPlaceholderVersion(c.version));
  if (exactSub) return { version: exactSub.version, probeSource: exactSub.source };

  const nonPrivateSub = subCandidates.find(c => !c.isPrivate && !isPlaceholderVersion(c.version));
  if (nonPrivateSub) return { version: nonPrivateSub.version, probeSource: nonPrivateSub.source };

  const rootPkg = await readJsonContainedSafe(repoReal, 'package.json');
  if (typeof rootPkg?.version === 'string' && rootPkg.version.trim() && !isPlaceholderVersion(rootPkg.version)) {
    return { version: rootPkg.version.trim(), probeSource: 'package.json#version' };
  }

  if (subCandidates.length > 0) {
    return { version: subCandidates[0].version, probeSource: subCandidates[0].source };
  }

  for (const verRel of ['VERSION', 'public-source/.codex-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
    if (verRel === 'VERSION') {
      const txt = await readTextContainedSafe(repoReal, 'VERSION');
      if (txt && txt.trim()) return { version: txt.trim().split(/\s+/)[0], probeSource: 'VERSION' };
    } else {
      const pj = await readJsonContainedSafe(repoReal, verRel);
      if (typeof pj?.version === 'string' && pj.version.trim()) {
        return { version: pj.version.trim(), probeSource: `${verRel}#version` };
      }
    }
  }

  if (typeof rootPkg?.version === 'string' && rootPkg.version.trim()) {
    return { version: rootPkg.version.trim(), probeSource: 'package.json#version' };
  }

  return { version: null, probeSource: '未检出版本声明文件' };
}

async function probeGitStatusAndTags(repoReal) {
  const hasGit = await existsDir(join(repoReal, '.git')) || await existsContainedFile(repoReal, '.git');
  if (!hasGit) {
    return {
      isGitRepo: false,
      latestGitTag: null,
      aheadCommits: null,
      worktreeClean: null,
      tagProbeSource: '非独立 Git 仓库',
      cleanProbeSource: '非独立 Git 仓库',
    };
  }

  const [tagRes, statusRes] = await Promise.all([
    runGitReadOnly(repoReal, ['describe', '--tags', '--abbrev=0']),
    runGitReadOnly(repoReal, ['status', '--porcelain', '--untracked-files=no']),
  ]);

  let latestGitTag = null;
  let aheadCommits = null;
  let tagProbeSource = 'git describe --tags --abbrev=0（当前仓库无本地 Tag）';

  if (tagRes.ok && tagRes.stdout) {
    latestGitTag = tagRes.stdout.split(/\r?\n/)[0].trim();
    const aheadRes = await runGitReadOnly(repoReal, ['rev-list', `${latestGitTag}..HEAD`, '--count']);
    if (aheadRes.ok && /^\d+$/.test(aheadRes.stdout)) {
      aheadCommits = Number.parseInt(aheadRes.stdout, 10);
    }
    tagProbeSource = `git describe --tags --abbrev=0 && git rev-list ${latestGitTag}..HEAD --count`;
  }

  const worktreeClean = statusRes.ok ? statusRes.stdout === '' : null;
  return {
    isGitRepo: true,
    latestGitTag,
    aheadCommits,
    worktreeClean,
    tagProbeSource,
    cleanProbeSource: 'git status --porcelain --untracked-files=no',
  };
}

async function probeFoundationTrack(repoReal, repoEntry) {
  const subDirs = await listSubpackageNames(repoReal);
  const selfContractsPkg = await readJsonContainedSafe(repoReal, 'packages/skill-family-contracts/package.json');
  if (repoEntry?.expectedFoundationTrack === 'self-foundation' || selfContractsPkg?.name === 'skill-family-contracts') {
    const selfVer = selfContractsPkg?.version || (await readJsonContainedSafe(repoReal, 'package.json'))?.version || '0.39.x';
    return {
      foundationTrackActual: 'self-foundation',
      foundationPinDetail: `Foundation 自身权威源仓 (${selfVer})`,
      packages: {
        'skill-family-contracts': selfVer,
        'skill-family-harness-node': selfVer,
        'skill-family-engineering-kit': selfVer,
      },
      hasLegacy022: false,
      alignedWithExpected: true,
      probeSource: selfContractsPkg ? 'packages/skill-family-contracts/package.json#version' : 'package.json#version',
    };
  }

  const evidence = [];
  const collectDepsFromPkg = (pkgObj, relPath) => {
    if (!pkgObj) return;
    const deps = { ...(pkgObj.dependencies || {}), ...(pkgObj.devDependencies || {}) };
    for (const pkgName of FOUNDATION_PKG_NAMES) {
      const spec = typeof deps[pkgName] === 'string' ? deps[pkgName].trim() : '';
      const tuple = parseSemverTuple(spec);
      if (tuple) {
        evidence.push({ pkgName, version: formatSemverTuple(tuple), tuple, source: `${relPath}#${pkgName}` });
      }
    }
  };

  collectDepsFromPkg(await readJsonContainedSafe(repoReal, 'package.json'), 'package.json');
  for (const sub of subDirs) {
    collectDepsFromPkg(await readJsonContainedSafe(repoReal, `packages/${sub}/package.json`), `packages/${sub}/package.json`);
  }

  const profilePaths = ['profile.json', ...subDirs.map(s => `packages/${s}/profile.json`)];
  for (const rel of profilePaths) {
    const prof = await readJsonContainedSafe(repoReal, rel);
    if (!prof) continue;
    const pinMap = prof?.adoption?.foundation_pin?.packages || prof?.foundationPin?.packages || null;
    if (pinMap && typeof pinMap === 'object') {
      for (const pkgName of FOUNDATION_PKG_NAMES) {
        const pinEntry = pinMap[pkgName];
        if (
          pinEntry
          && typeof pinEntry === 'object'
          && pinEntry.path === null
          && pinEntry.sha256 === null
          && !prof?.adoption?.adopted_at
        ) {
          // 跳过 engineering-kit 初始化留下的未生效空模板占位（path/sha256/adopted_at 均为 null）
          continue;
        }
        const rawVer = typeof pinEntry === 'string' ? pinEntry : pinEntry?.version;
        const tuple = parseSemverTuple(rawVer);
        if (tuple) {
          evidence.push({
            pkgName,
            version: formatSemverTuple(tuple),
            tuple,
            profileId: prof?.adoption?.foundation_profile?.id || null,
            profileVer: prof?.adoption?.foundation_profile?.version || null,
            source: `${rel}#adoption.foundation_pin`,
          });
        }
      }
    }
  }

  const extraPinPaths = [
    'spec/foundation-integration/foundation-pin.json',
    'spec/policies/foundation-version-drift.json',
    ...subDirs.flatMap(s => [
      `packages/${s}/spec/foundation-integration/foundation-pin.json`,
      `packages/${s}/spec/policies/foundation-version-drift.json`,
    ]),
  ];
  for (const rel of extraPinPaths) {
    const doc = await readJsonContainedSafe(repoReal, rel);
    if (!doc) continue;
    if (Array.isArray(doc.packages) && doc.packages.length > 0) {
      for (const item of doc.packages) {
        const tuple = parseSemverTuple(item?.version);
        if (tuple) {
          evidence.push({
            pkgName: item?.name || 'foundation-pin',
            version: formatSemverTuple(tuple),
            tuple,
            source: `${rel}#packages`,
          });
        }
      }
      continue;
    }
    const structuralCandidates = [
      doc.pinnedVersion,
      doc.foundationVersion,
      doc.targetVersion,
      doc.minimumFoundationVersion,
    ].filter(v => typeof v === 'string');
    let matchedStructured = false;
    for (const candidate of structuralCandidates) {
      const tuple = parseSemverTuple(candidate);
      if (tuple) {
        evidence.push({ pkgName: 'foundation-pin', version: formatSemverTuple(tuple), tuple, source: rel });
        matchedStructured = true;
      }
    }
    if (!matchedStructured) {
      const sanitized = { ...doc };
      delete sanitized.note;
      if (sanitized.source && typeof sanitized.source === 'object') {
        sanitized.source = { ...sanitized.source, note: undefined };
      }
      const rawText = JSON.stringify(sanitized);
      const m022 = /\b0\.22\.\d+\b/.exec(rawText);
      const m039 = /\b0\.39\.\d+\b/.exec(rawText);
      const tuple = parseSemverTuple(m022?.[0] || m039?.[0] || null);
      if (tuple) {
        evidence.push({ pkgName: 'foundation-pin', version: formatSemverTuple(tuple), tuple, source: rel });
      }
    }
  }

  if (evidence.length === 0) {
    const expected = repoEntry?.expectedFoundationTrack || 'not-applicable';
    return {
      foundationTrackActual: 'not-applicable',
      foundationPinDetail: '未声明 Foundation 三包依赖或 profile 钉扎',
      packages: {},
      hasLegacy022: false,
      alignedWithExpected: expected === 'not-applicable',
      probeSource: 'package.json / profile.json（无 Foundation 依赖项）',
    };
  }

  let minItem = evidence[0];
  let maxItem = evidence[0];
  const packages = {};
  for (const item of evidence) {
    if (!packages[item.pkgName]) packages[item.pkgName] = item.version;
    if (compareSemverTuple(item.tuple, minItem.tuple) < 0) minItem = item;
    if (compareSemverTuple(item.tuple, maxItem.tuple) > 0) maxItem = item;
  }

  const hasLegacy022 = evidence.some(e => e.tuple[0] === 0 && e.tuple[1] === 22);
  const allAtLeast039 = evidence.every(e => compareSemverTuple(e.tuple, [0, 39, 0]) >= 0);
  const actualTrack = hasLegacy022
    ? '0.22.0'
    : (allAtLeast039 ? '0.39.x' : minItem.version);

  const uniqueSources = [...new Set(evidence.map(e => e.source))].slice(0, 3);
  const detail = hasLegacy022
    ? `旧版 ${minItem.version}${minItem.profileId ? ` (${minItem.profileId} v${minItem.profileVer || 2})` : ''} 钉扎漂移`
    : `已锁定 Foundation ${maxItem.version}`;

  const expected = repoEntry?.expectedFoundationTrack || '0.39.x';
  const alignedWithExpected = expected === '0.39.x'
    ? (!hasLegacy022 && allAtLeast039)
    : (expected === actualTrack);

  return {
    foundationTrackActual: actualTrack,
    foundationPinDetail: detail,
    packages,
    hasLegacy022,
    alignedWithExpected,
    probeSource: uniqueSources.join(' · '),
  };
}

async function probeDocSite(repoReal, expectedDocSiteMode = 'not_applicable') {
  const candidates = [
    'public-release.json',
    'docs/public/public-release.json',
    'docs/workspace-site/public-release.json',
  ];
  for (const rel of candidates) {
    const doc = await readJsonContainedSafe(repoReal, rel);
    if (!doc) continue;
    const repoSites = Array.isArray(doc.repos)
      ? doc.repos.map(r => r?.site).filter(Boolean)
      : (doc.site && typeof doc.site === 'object' ? [doc.site] : []);
    const independentHit = repoSites.find(s => typeof s.publicSiteRepo === 'string' && s.publicSiteRepo.endsWith('-site'));
    const anyPublicSite = independentHit || repoSites.find(s => typeof s.publicSiteRepo === 'string' && s.publicSiteRepo.trim());
    if (anyPublicSite) {
      const siteRepo = String(anyPublicSite.publicSiteRepo).trim();
      const isIndependent = siteRepo.endsWith('-site');
      const pagesUrl = typeof anyPublicSite.pagesUrl === 'string' && anyPublicSite.pagesUrl.trim()
        ? anyPublicSite.pagesUrl.trim()
        : null;
      const format = typeof anyPublicSite.format === 'string' ? anyPublicSite.format : null;
      return {
        mode: isIndependent ? 'independent_site_070' : 'legacy_docs_site',
        isIndependentSite: isIndependent,
        publicSiteRepo: siteRepo,
        pagesUrl,
        format,
        label: isIndependent ? `独立 -site 站 (${siteRepo.split('/').pop()})` : `历史站点 (${siteRepo})`,
        alignedWithExpected: expectedDocSiteMode === 'independent_site_070' ? isIndependent : true,
        probeSource: `${rel}#repos[].site.publicSiteRepo`,
      };
    }
  }

  const relYamlRaw = await readTextContainedSafe(repoReal, '.release-skill/project.yaml');
  if (relYamlRaw) {
    try {
      const parsed = parseYaml(relYamlRaw);
      const units = Array.isArray(parsed?.releaseUnits) ? parsed.releaseUnits : [];
      const siteUnit = units.find(u => typeof u?.publicRepo === 'string' && u.publicRepo.endsWith('-site'));
      if (siteUnit) {
        return {
          mode: 'independent_site_070',
          isIndependentSite: true,
          publicSiteRepo: siteUnit.publicRepo,
          pagesUrl: typeof siteUnit.pagesUrl === 'string' ? siteUnit.pagesUrl : null,
          format: 'markdown-v2',
          label: `独立 -site 站 (${siteUnit.publicRepo.split('/').pop()})`,
          alignedWithExpected: true,
          probeSource: '.release-skill/project.yaml#releaseUnits[].publicRepo',
        };
      }
    } catch {}
  }

  const hasInternalDocs = await existsContainedFile(repoReal, 'mkdocs.yml')
    || await existsContainedFile(repoReal, 'docs/USER-GUIDE.md')
    || await existsContainedFile(repoReal, 'docs/README.md');

  if (hasInternalDocs) {
    return {
      mode: 'workspace_internal',
      isIndependentSite: false,
      publicSiteRepo: null,
      pagesUrl: null,
      format: null,
      label: expectedDocSiteMode === 'independent_site_070' ? '仓内文档（待迁移独立 -site）' : '工作区内部文档',
      alignedWithExpected: expectedDocSiteMode !== 'independent_site_070',
      probeSource: 'mkdocs.yml / docs/（未检出 *-site publicSiteRepo）',
    };
  }

  return {
    mode: 'not_applicable',
    isIndependentSite: false,
    publicSiteRepo: null,
    pagesUrl: null,
    format: null,
    label: expectedDocSiteMode === 'independent_site_070' ? '待建独立 -site 站' : '不适用',
    alignedWithExpected: expectedDocSiteMode === 'not_applicable',
    probeSource: '未检出 public-release.json#site',
  };
}

async function probeLocksAndReceipt(repoReal) {
  const subDirs = await listSubpackageNames(repoReal);
  let lockRel = null;
  if (await existsContainedFile(repoReal, VERSION_LOCK_PATH)) {
    lockRel = VERSION_LOCK_PATH;
  } else {
    for (const sub of subDirs) {
      const candidate = `packages/${sub}/${VERSION_LOCK_PATH}`;
      if (await existsContainedFile(repoReal, candidate)) {
        lockRel = candidate;
        break;
      }
    }
  }

  const [execReceipt, lockFreshness] = await Promise.all([
    inspectDownstreamExecutionReceipt(repoReal),
    lockRel === VERSION_LOCK_PATH
      ? inspectDownstreamLockFreshness(repoReal)
      : Promise.resolve({ fresh: Boolean(lockRel), hasCodeLocks: false, executionVerified: false, mode: lockRel ? 'subpackage_lock' : 'missing_lock_file' }),
  ]);

  const sources = [];
  if (lockRel) sources.push(lockRel);
  if (execReceipt.receiptPath) sources.push(`${execReceipt.receiptPath} (SHA-256)`);
  if (sources.length === 0) sources.push('未检出 traceability-version-lock.json 与 sft 收据');

  return {
    lockPresent: Boolean(lockRel),
    lockPath: lockRel,
    codeLocksFresh: Boolean(lockFreshness.fresh && lockFreshness.hasCodeLocks),
    receiptPassed: Boolean(execReceipt.passed),
    receiptPath: execReceipt.receiptPath || null,
    receiptReason: execReceipt.reason || null,
    badgeLabel: execReceipt.passed && lockRel
      ? '✅ SHA-256 实测收据+版本锁'
      : (execReceipt.passed
        ? '✅ SHA-256 实测收据通过'
        : (lockRel ? '🔗 已建追溯锁·缺实测收据' : '⚪ 未建锁与收据')),
    badgeTone: execReceipt.passed ? 'emerald' : (lockRel ? 'indigo' : 'zinc'),
    probeSource: sources.join(' + '),
  };
}

function parseJsObjectEntriesFromSource(rawSource) {
  const entries = [];
  if (!rawSource) return entries;
  const blockRe = /\{\s*capabilityId\s*:\s*['"]([^'"]+)['"][\s\S]*?\}/g;
  for (const m of rawSource.matchAll(blockRe)) {
    const block = m[0];
    const pick = key => {
      const hit = new RegExp(`\\b${key}\\s*:\\s*['"]([^'"]+)['"]`).exec(block);
      return hit ? hit[1].trim() : null;
    };
    entries.push({
      capabilityId: m[1].trim(),
      displayName: pick('displayName'),
      stage: pick('stage'),
      providerId: pick('providerId'),
      sourceProject: pick('sourceProject'),
      integrationStatus: pick('integrationStatus'),
      marketplaceStatus: pick('marketplaceStatus'),
      migrationStatus: pick('migrationStatus'),
      maturity: pick('maturity'),
      lifecycleState: pick('lifecycleState'),
    });
  }
  return entries;
}

async function probeHubActual(hubRepoReal, registryRepos) {
  if (!hubRepoReal) {
    return {
      present: false,
      providers: [],
      drifts: [],
      byPublicName: {},
      probeSource: '未定位到 Hub 仓库目录',
    };
  }

  const providerRelCandidates = [
    'lifecycle-providers.mjs',
    'packages/skill-family-hub/src/lifecycle-providers.mjs',
    'src/lifecycle-providers.mjs',
  ];
  let providers = [];
  let providerSource = null;
  for (const rel of providerRelCandidates) {
    const raw = await readTextContainedSafe(hubRepoReal, rel);
    if (raw) {
      const parsed = parseJsObjectEntriesFromSource(raw);
      if (parsed.length > 0) {
        providers = parsed;
        providerSource = rel;
        break;
      }
    }
  }

  const marketRelCandidates = [
    'marketplace.json',
    'public-snapshot/marketplace.json',
    'public-snapshot/.agents/plugins/marketplace.json',
    'catalog.json',
  ];
  let marketSource = null;
  for (const rel of marketRelCandidates) {
    const mj = await readJsonContainedSafe(hubRepoReal, rel);
    if (mj) {
      marketSource = rel;
      if (providers.length === 0 && Array.isArray(mj.plugins || mj.capabilities)) {
        for (const p of (mj.plugins || mj.capabilities)) {
          if (!p || typeof p !== 'object') continue;
          providers.push({
            capabilityId: p.capabilityId || p.name || p.id || 'plugin',
            displayName: p.displayName || p.description || p.name || '',
            providerId: p.providerId || p.name || p.id || '',
            sourceProject: p.sourceProject || p.name || p.id || '',
            marketplaceStatus: p.marketplaceStatus || (p.status === 'retired' ? 'retired' : 'published'),
            lifecycleState: p.lifecycleState || p.status || 'active',
            maturity: p.maturity || 'released',
          });
        }
      }
      break;
    }
  }

  const byPublicName = {};
  for (const p of providers) {
    for (const key of [p.sourceProject, p.providerId]) {
      if (!key) continue;
      if (!byPublicName[key]) byPublicName[key] = [];
      byPublicName[key].push(p);
    }
  }

  const drifts = [];
  for (const repo of registryRepos || []) {
    const matches = [
      ...(byPublicName[repo.publicName] || []),
      ...(repo.name !== repo.publicName ? (byPublicName[repo.name] || []) : []),
    ];
    const uniqueMatches = [...new Map(matches.map(m => [m.capabilityId, m])).values()];
    if (repo.ring === 'retired' || repo.expectedHubPresence === 'retired_must_exit') {
      const stillActive = uniqueMatches.filter(m => m.lifecycleState === 'active' || m.marketplaceStatus === 'published');
      if (stillActive.length > 0) {
        drifts.push({
          repoId: repo.id,
          publicName: repo.publicName,
          kind: 'retired_still_active_in_hub',
          detail: `${repo.publicName} 在注册表已定性为「已退役归并」，但 Hub (${providerSource || marketSource}) 中 ${stillActive.map(x => x.providerId).join('/')} 仍标为 lifecycleState=${stillActive[0].lifecycleState}`,
        });
      }
    }
    if (repo.publicName === 'skill-eval' || repo.publicName === 'skill-family-eval') {
      const legacyHeimdall = uniqueMatches.find(m => m.providerId === 'heimdall' && m.lifecycleState === 'active');
      if (legacyHeimdall) {
        drifts.push({
          repoId: repo.id,
          publicName: repo.publicName,
          kind: 'legacy_heimdall_active_in_hub',
          detail: `${repo.publicName} 在 Hub (${providerSource || marketSource}) 中仍以旧壳名 providerId="heimdall" 处于 active 状态，待重塑切换`,
        });
      }
    }
  }

  const usedSources = [providerSource, marketSource].filter(Boolean);
  return {
    present: providers.length > 0 || Boolean(marketSource),
    providers,
    drifts,
    byPublicName,
    probeSource: usedSources.length > 0 ? `Hub 实测：${usedSources.join(' + ')}` : 'Hub 目录未检出 lifecycle-providers.mjs',
  };
}

async function probeAuditReleaseCycle(auditRepoReal) {
  if (!auditRepoReal) {
    return {
      detected: true,
      pinnedCall: 'audit_repo_missing',
      detail: '未定位到 Audit 仓库目录，按 fail-closed 判定解耦状态未核实',
      probeSource: '未检出 Audit 仓库',
    };
  }
  const subDirs = await listSubpackageNames(auditRepoReal);
  const methodCandidates = [
    'spec/methods/release-audit.json',
    ...subDirs.map(s => `packages/${s}/spec/methods/release-audit.json`),
  ];
  let checkedMethodCount = 0;
  let verifiedMethodSource = null;
  for (const rel of methodCandidates) {
    const methodDoc = await readJsonContainedSafe(auditRepoReal, rel);
    if (!methodDoc) continue;
    checkedMethodCount += 1;
    verifiedMethodSource = rel;
    const raw = JSON.stringify(methodDoc);
    const procExec = methodDoc?.maximumSideEffects?.processExecution;
    if ((raw.includes('verify-records') && raw.includes('release-skill')) || (procExec && procExec !== 'none')) {
      const pinMatch = /release-skill@([0-9A-Za-z._-]+):verify-records/.exec(raw);
      return {
        detected: true,
        pinnedCall: pinMatch ? `release-skill@${pinMatch[1]}:verify-records` : `processExecution:${procExec || 'verify-records'}`,
        detail: `检出 Audit release-audit 方法仍声明反向进程执行或 verify-records 耦合（${procExec || 'verify-records'}），与发布门禁消费形成双向耦合环`,
        probeSource: rel,
      };
    }
  }
  if (checkedMethodCount === 0) {
    return {
      detected: true,
      pinnedCall: 'release_audit_contract_missing',
      detail: 'Audit 仓库未检出 spec/methods/release-audit.json 方法合同，按 fail-closed 判定未完成单向解耦核实',
      probeSource: 'spec/methods/release-audit.json（缺失）',
    };
  }

  const receiptHelperCandidates = [
    'plugin-src/skills/skill-family-audit-release/scripts/release_receipts.py',
    ...subDirs.map(s => `packages/${s}/plugin-src/skills/skill-family-audit-release/scripts/release_receipts.py`),
    'generated/platforms/claude-code/skills/skill-family-audit-release-audit/scripts/release_receipts.py',
    ...subDirs.map(s => `packages/${s}/generated/platforms/claude-code/skills/skill-family-audit-release-audit/scripts/release_receipts.py`),
  ];
  for (const rel of receiptHelperCandidates) {
    const raw = await readTextContainedSafe(auditRepoReal, rel);
    if (raw) {
      return {
        detected: true,
        pinnedCall: 'release_receipts_bridge_present',
        detail: `检出残留反向桥接脚本 ${rel}`,
        probeSource: rel,
      };
    }
  }

  return {
    detected: false,
    pinnedCall: null,
    detail: '未检出 Audit 对 release-skill verify-records 的反向调用，单向解耦已成立',
    probeSource: `${verifiedMethodSource}（processExecution=none 且零 verify-records 反向调用）`,
  };
}

export function buildLifecycleRingMap(registry) {
  const ringDefs = {};
  for (const r of registry?.rings || []) {
    if (!r || typeof r.id !== 'string') continue;
    const base = RING_SHORT_META[r.id] || { ring: r.id, label: r.label || r.id, badgeTone: r.badgeTone || 'zinc', enterSwimlane: false };
    ringDefs[r.id] = {
      id: r.id,
      ring: r.id,
      label: base.label,
      fullLabel: r.label || base.label,
      badgeTone: r.badgeTone || base.badgeTone,
      enterSwimlane: Boolean(r.enterSwimlane && (r.id === 'core' || r.id === 'method')),
      boundaryRule: r.boundaryRule || '',
    };
  }
  for (const [k, v] of Object.entries(RING_SHORT_META)) {
    if (!ringDefs[k]) ringDefs[k] = { id: k, ...v, fullLabel: v.label, boundaryRule: '' };
  }

  const ringByRepoName = {};
  for (const repo of registry?.repositories || []) {
    if (!repo || typeof repo !== 'object') continue;
    const meta = ringDefs[repo.ring] || RING_SHORT_META.consumer;
    const badge = {
      ring: meta.ring,
      label: meta.label,
      fullLabel: meta.fullLabel,
      tone: meta.badgeTone,
      enterSwimlane: meta.enterSwimlane,
    };
    const keys = [
      repo.id,
      repo.name,
      repo.publicName,
      typeof repo.repoRef === 'string' && repo.repoRef.trim() && repo.repoRef !== '.'
        ? basename(repo.repoRef.trim())
        : null,
    ].filter(Boolean);
    for (const k of keys) {
      if (!['__proto__', 'constructor', 'prototype'].includes(k)) {
        ringByRepoName[k] = badge;
      }
    }
  }
  return { ringDefs, ringByRepoName };
}

export async function discoverLifecycleCollection(workspaceRoot, catalog = null, requestedRepoId = null) {
  const candidateRecords = [];
  const seenPaths = new Set();
  const pushCandidate = async (realPath, repoId = null, repoName = null) => {
    if (!realPath || seenPaths.has(realPath)) return;
    seenPaths.add(realPath);
    candidateRecords.push({ realPath, repoId, repoName: repoName || basename(realPath) });
  };

  if (requestedRepoId && catalog?.byId?.has(requestedRepoId)) {
    const rec = catalog.byId.get(requestedRepoId);
    await pushCandidate(rec.realPath, rec.id, rec.name);
  }

  try {
    const rootReal = await realpath(resolve(workspaceRoot));
    const matchedInCat = catalog?.byId ? [...catalog.byId.values()].find(r => r.realPath === rootReal) : null;
    await pushCandidate(rootReal, matchedInCat?.id || null, matchedInCat?.name || basename(rootReal));
  } catch {}

  if (catalog?.byId) {
    const allRecs = [...catalog.byId.values()];
    for (const r of allRecs.filter(x => x.isPrimary)) await pushCandidate(r.realPath, r.id, r.name);
    for (const r of allRecs.filter(x => x.repoRole === 'portfolio')) await pushCandidate(r.realPath, r.id, r.name);
    for (const r of allRecs) await pushCandidate(r.realPath, r.id, r.name);
  }

  for (const cand of candidateRecords) {
    const wsCfg = await loadStudioWorkspaceConfig(cand.realPath).catch(() => ({ collections: [] }));
    const col = (wsCfg.collections || []).find(c => c && c.kind === 'lifecycle-collaboration-model') || null;
    const registryRel = (typeof col?.registryJson === 'string' && col.registryJson.trim())
      ? col.registryJson.trim()
      : DEFAULT_LIFECYCLE_REGISTRY_REL;
    if (await existsContainedFile(cand.realPath, registryRel)) {
      const modelRel = (typeof col?.modelJson === 'string' && col.modelJson.trim())
        ? col.modelJson.trim()
        : DEFAULT_LIFECYCLE_MODEL_REL;
      const archDocRel = (typeof col?.architectureDoc === 'string' && col.architectureDoc.trim())
        ? col.architectureDoc.trim()
        : 'artifacts/design/lifecycle-collaboration-architecture.md';
      const roadmapSpecRel = (typeof col?.roadmapSpec === 'string' && col.roadmapSpec.trim())
        ? col.roadmapSpec.trim()
        : 'artifacts/specs/SPEC-LC-migration-roadmap.md';
      return {
        found: true,
        hostRepoReal: cand.realPath,
        hostRepoId: cand.repoId,
        hostRepoName: cand.repoName,
        sourceMode: col ? '.studio-workspace.json#collections[lifecycle-collaboration-model]' : 'fallback:lifecycle-ecosystem.registry.json',
        collectionId: col?.id || 'lifecycle-collaboration',
        registryRel,
        modelRel: (await existsContainedFile(cand.realPath, modelRel)) ? modelRel : null,
        architectureDocRel: (await existsContainedFile(cand.realPath, archDocRel)) ? archDocRel : null,
        roadmapSpecRel: (await existsContainedFile(cand.realPath, roadmapSpecRel)) ? roadmapSpecRel : null,
      };
    }
  }

  return { found: false };
}

export async function loadLifecycleSummary({ root = '.', catalog = null, repoId = null } = {}) {
  const disc = await discoverLifecycleCollection(root, catalog, repoId);
  if (!disc.found) {
    return { available: false, ringByRepoName: {} };
  }
  const registry = await readJsonContainedSafe(disc.hostRepoReal, disc.registryRel);
  if (!registry || !Array.isArray(registry.phases) || !Array.isArray(registry.repositories)) {
    return { available: false, ringByRepoName: {} };
  }
  const { ringByRepoName } = buildLifecycleRingMap(registry);
  return {
    available: true,
    hostRepoId: disc.hostRepoId,
    hostRepoName: disc.hostRepoName,
    sourceMode: disc.sourceMode,
    subject: registry.subject || null,
    terminologyPolicy: registry.terminologyPolicy || null,
    ringByRepoName,
  };
}

async function resolveRepoTarget(hostRepoReal, repoEntry, catalog) {
  const rawRef = repoEntry?.repoRef;
  if (rawRef === null || rawRef === undefined || String(rawRef).trim() === '') {
    return { existsOnDisk: false, realPath: null, studioRepoId: null, resolveSource: 'repoRef=null（非本地托管仓库）' };
  }
  const refStr = String(rawRef).trim();
  if (refStr.includes('\0')) {
    return { existsOnDisk: false, realPath: null, studioRepoId: null, resolveSource: '非法路径字符' };
  }
  const candidateAbs = resolve(hostRepoReal, refStr);
  let real;
  try {
    const st = await lstat(candidateAbs);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { existsOnDisk: false, realPath: null, studioRepoId: null, resolveSource: `未检出本地目录 (${refStr})` };
    }
    real = await realpath(candidateAbs);
  } catch {
    return { existsOnDisk: false, realPath: null, studioRepoId: null, resolveSource: `未检出本地目录 (${refStr})` };
  }

  let studioRepoId = null;
  if (catalog?.byId) {
    for (const rec of catalog.byId.values()) {
      if (rec.realPath === real || rec.name === repoEntry.name || rec.packageName === repoEntry.publicName) {
        studioRepoId = rec.id;
        if (rec.realPath === real) break;
      }
    }
  }
  return {
    existsOnDisk: true,
    realPath: real,
    studioRepoId,
    resolveSource: refStr === '.' ? '当前高阶工作区根目录' : `相对路径解析 (${sanitizePublicText(refStr)})`,
  };
}

function lookupProbedRepo(probedByKey, key) {
  if (!key) return null;
  return probedByKey.get(key) || probedByKey.get(basename(String(key))) || null;
}

async function checkAnyFileInTargets(targets, relCandidates) {
  const hits = [];
  for (const t of targets) {
    if (!t.live?.realPath) continue;
    for (const rel of relCandidates) {
      if (await existsContainedFile(t.live.realPath, rel)) {
        hits.push(`${t.publicName}/${rel}`);
        break;
      }
    }
  }
  return hits;
}

async function evaluateArchitecturalRisks(rawRisks, probedRepos, probedByKey, hubActual, auditCycle) {
  return Promise.all((rawRisks || []).map(async risk => {
    let detected = false;
    let liveEvidence = '';
    let probeSource = '';

    if (risk.probeKind === 'foundation_pin_022') {
      const legacyRepos = probedRepos.filter(r =>
        (r.ring === 'core' || r.ring === 'method')
        && r.live?.existsOnDisk
        && (
          r.live.foundation?.hasLegacy022
          || (
            r.expectedFoundationTrack === '0.39.x'
            && r.live.foundation?.foundationTrackActual !== 'not-applicable'
            && !r.live.foundation?.alignedWithExpected
          )
        ),
      );
      detected = legacyRepos.length > 0;
      liveEvidence = detected
        ? `实时检出 ${legacyRepos.length} 个仓未对齐 0.39.x：${legacyRepos.map(r => `${r.publicName}(${r.live.foundation.foundationTrackActual})`).join('、')}`
        : '所有要求接入 Foundation 0.39.x 的在盘仓库均已完成版本对齐，零 0.22.0 残留。';
      probeSource = legacyRepos.length > 0
        ? legacyRepos.map(r => `${r.publicName}:${r.live.foundation.probeSource}`).slice(0, 3).join(' ； ')
        : '全量仓库 package.json + profile.json 实时扫描';
    } else if (risk.probeKind === 'audit_release_cycle') {
      detected = Boolean(auditCycle.detected);
      liveEvidence = auditCycle.detail;
      probeSource = `skill-family-audit/${auditCycle.probeSource}`;
    } else if (risk.probeKind === 'hub_state_drift') {
      detected = (hubActual.drifts || []).length > 0;
      liveEvidence = detected
        ? hubActual.drifts.map(d => d.detail).join('；')
        : 'Hub 台账状态与生命周期三环注册表完全一致，无退役/旧壳残留。';
      probeSource = hubActual.probeSource;
    } else if (risk.probeKind === 'eval_shell_reshape') {
      const evalRepo = lookupProbedRepo(probedByKey, 'skill-family-eval')
        || lookupProbedRepo(probedByKey, 'skill-eval')
        || probedRepos.find(r => r.publicName === 'skill-family-eval' || r.publicName === 'skill-eval');
      const ver = evalRepo?.live?.sourceVersion?.version || null;
      const fndAligned = Boolean(evalRepo?.live?.foundation?.alignedWithExpected && evalRepo?.live?.foundation?.foundationTrackActual === '0.39.x');
      const requiredEngineModules = evalRepo ? await Promise.all([
        'packages/skill-eval/src/oracle-vault.mjs',
        'packages/skill-eval/src/judge-calibration.mjs',
        'packages/skill-eval/src/sfa-hard-gate.mjs',
        'packages/skill-eval/src/scorecard-engine.mjs',
        'packages/skill-eval/src/eval-conclusion.mjs',
        'packages/skill-eval/schemas/scorecard.schema.json',
      ].map(rel => checkAnyFileInTargets([evalRepo], [rel]).then(hits => hits.length > 0))) : [];
      const allModulesPresent = requiredEngineModules.length === 6 && requiredEngineModules.every(Boolean);
      const hasLegacyHeimdallDir = evalRepo?.live?.realPath
        ? await existsDir(join(evalRepo.live.realPath, 'heimdall'))
        : false;
      const receiptReady = Boolean(evalRepo?.live?.locksAndReceipt?.receiptPassed && evalRepo?.live?.locksAndReceipt?.lockPresent);
      detected = !evalRepo?.live?.existsOnDisk || isPlaceholderVersion(ver) || !fndAligned || !allModulesPresent || hasLegacyHeimdallDir || !receiptReady;
      liveEvidence = evalRepo?.live?.existsOnDisk
        ? `当前版本=${ver || '未声明'}，底座=${evalRepo.live.foundation?.foundationTrackActual || 'not-applicable'}，核心模块=${allModulesPresent ? '6/6 就绪' : '缺失'}，heimdall残留=${hasLegacyHeimdallDir ? '存在' : '已清理'}，锁与收据=${evalRepo.live.locksAndReceipt?.badgeLabel || '未建'}`
        : '本地未检出已重塑的计分卡引擎包';
      probeSource = evalRepo?.live?.existsOnDisk
        ? `skill-eval/${evalRepo.live.sourceVersion?.probeSource || 'package.json'} + packages/skill-eval/src/* + sft-runs.json`
        : 'skill-eval 目录探针';
    }

    return {
      ...risk,
      detected,
      liveStatus: detected ? 'active_risk' : 'resolved',
      liveBadgeLabel: detected ? '🔴 实时检出风险' : '🟢 探针核验已收敛',
      liveBadgeTone: detected ? (risk.severity === 'high' ? 'rose' : 'amber') : 'emerald',
      liveEvidence,
      probeSource,
    };
  }));
}

function evaluateCapabilityCatalog(rawCatalog, probedByKey) {
  return (rawCatalog || []).map(cap => {
    const owners = (cap.ownerRepos || []).map(k => lookupProbedRepo(probedByKey, k)).filter(Boolean);
    if (cap.verificationMode === 'machine_probe') {
      const onDiskOwners = owners.filter(o => o.live?.existsOnDisk);
      const ownerSnippets = onDiskOwners.map(o => {
        const ver = o.live.sourceVersion?.version ? `v${o.live.sourceVersion.version}` : '无版本号';
        const rcpt = o.live.locksAndReceipt?.receiptPassed ? 'sft收据通过' : (o.live.locksAndReceipt?.lockPresent ? '含版本锁' : '无锁');
        return `${o.publicName}(${ver}, ${rcpt})`;
      });
      const srcList = onDiskOwners.map(o => `${o.publicName}:${o.live.sourceVersion?.probeSource || 'package.json'}`);
      if (cap.probeRule) srcList.push(`规则:${cap.probeRule}`);
      return {
        ...cap,
        verificationBadge: '🔍 机器探针实测',
        verificationTone: 'indigo',
        liveProbeDetail: ownerSnippets.length > 0
          ? `在盘实测：${ownerSnippets.join(' · ')}`
          : '归属仓尚未在本地落盘',
        probeSource: srcList.join(' · ') || cap.probeRule || '仓库磁盘探针',
      };
    }
    return {
      ...cap,
      verificationBadge: '📋 架构声明',
      verificationTone: 'zinc',
      liveProbeDetail: '人工架构盘点声明（待补自动化探针或运行时埋点核验）',
      probeSource: cap.probeRule || 'lifecycle-ecosystem.registry.json#capabilityCatalog（人工声明）',
    };
  });
}

async function evaluateRoadmapMilestones(rawRoadmap, ctx) {
  const { portfolioAlloc, probedRepos, probedByKey, hubActual, auditCycle } = ctx;
  const resolveMilestoneTargets = (ownerRepos, fallbackPred) => {
    const explicit = (ownerRepos || []).map(k => lookupProbedRepo(probedByKey, k)).filter(Boolean);
    return explicit.length > 0 ? explicit : probedRepos.filter(fallbackPred);
  };

  const outStages = [];
  for (const stage of rawRoadmap || []) {
    const milestones = [];
    let passedCount = 0;
    for (const ms of stage.milestones || []) {
      let status = 'planned';
      let badgeLabel = '⏳ 待建设';
      let badgeTone = 'zinc';
      let liveDetail = '';
      let probeSource = '';

      if (ms.probeCheck === 'portfolio_5_of_5_verified') {
        const allocItems = (portfolioAlloc?.items || []).filter(i => i.disposition === 'allocated');
        const total = allocItems.length;
        const verified = portfolioAlloc?.summary?.verifiedSatisfied ?? 0;
        if (total >= 5 && verified === total) {
          status = 'passed';
          badgeLabel = `✅ 已达成 (${verified}/${total})`;
          badgeTone = 'emerald';
        } else if (verified > 0) {
          status = 'partial';
          badgeLabel = `🔵 部分达成 (${verified}/${total})`;
          badgeTone = 'indigo';
        }
        liveDetail = portfolioAlloc?.present
          ? `高阶活跃需求 ${verified}/${total} 项达到 verified_satisfied（零未互认漂移）`
          : '未检出 artifacts/portfolio-allocations.json';
        probeSource = 'artifacts/portfolio-allocations.json + 下游 sft-runs.json SHA-256 互锁核验';
      } else if (ms.probeCheck === 'core_locks_and_receipts') {
        const targets = resolveMilestoneTargets(ms.ownerRepos, r => r.ring === 'core' && r.live?.existsOnDisk && r.repoRef !== '.');
        const onDisk = targets.filter(r => r.live?.existsOnDisk && r.repoRef !== '.');
        const withBoth = onDisk.filter(r => r.live.locksAndReceipt?.lockPresent && r.live.locksAndReceipt?.receiptPassed);
        const withLock = onDisk.filter(r => r.live.locksAndReceipt?.lockPresent);
        if (onDisk.length > 0 && withBoth.length === onDisk.length) {
          status = 'passed';
          badgeLabel = `✅ 已达成 (${withBoth.length}/${onDisk.length})`;
          badgeTone = 'emerald';
        } else if (withBoth.length > 0 || withLock.length > 0) {
          status = 'partial';
          badgeLabel = `🔵 就绪 ${withBoth.length}/${onDisk.length} 收据 · ${withLock.length}/${onDisk.length} 锁`;
          badgeTone = 'indigo';
        }
        liveDetail = `目标仓 ${withBoth.length}/${onDisk.length} 具备 SHA-256 实测收据与追溯锁`;
        probeSource = '各目标仓 artifacts/traceability-version-lock.json + sft-runs.json';
      } else if (ms.probeCheck === 'independent_site_070') {
        const docRender = lookupProbedRepo(probedByKey, 'skill-family-doc-render')
          || lookupProbedRepo(probedByKey, 'skill-family-docs')
          || probedRepos.find(r =>
            r.publicName === 'skill-family-doc-render'
            || r.publicName === 'skill-family-docs',
          );
        const drTuple = parseSemverTuple(docRender?.live?.sourceVersion?.version);
        const drReady = Boolean(drTuple && compareSemverTuple(drTuple, [0, 7, 0]) >= 0);
        const rawTargets = resolveMilestoneTargets(ms.ownerRepos, r => r.ring === 'core' && r.expectedDocSiteMode === 'independent_site_070');
        const expectedSiteTargets = rawTargets.filter(r => r.expectedDocSiteMode === 'independent_site_070');
        const targets = expectedSiteTargets.length > 0 ? expectedSiteTargets : rawTargets;
        const siteReady = targets.filter(r => r.live?.docSite?.isIndependentSite);
        if (drReady && targets.length > 0 && siteReady.length === targets.length) {
          status = 'passed';
          badgeLabel = `✅ 已达成 (${siteReady.length}/${targets.length} 独立 -site)`;
          badgeTone = 'emerald';
        } else if (drReady || siteReady.length > 0) {
          status = 'partial';
          badgeLabel = `🔵 引擎 v${docRender?.live?.sourceVersion?.version || '—'} · ${siteReady.length}/${targets.length} 仓已切 -site`;
          badgeTone = 'indigo';
        }
        liveDetail = `渲染引擎 v${docRender?.live?.sourceVersion?.version || '未知'}；独立 -site 就绪仓：${siteReady.map(r => r.publicName).join('、') || '暂无'}`;
        probeSource = 'public-release.json#repos[].site.publicSiteRepo + packages/skill-family-doc-render/package.json';
      } else if (ms.probeCheck === 'studio_lifecycle_cockpit') {
        const studioRepo = lookupProbedRepo(probedByKey, 'skill-family-studio')
          || probedRepos.find(r => r.publicName === 'skill-family-studio');
        let hasInspector = false;
        let hasUi = false;
        if (studioRepo?.live?.realPath) {
          hasInspector = await existsContainedFile(studioRepo.live.realPath, 'packages/skill-family-studio/src/lifecycle-inspector.mjs')
            || await existsContainedFile(studioRepo.live.realPath, 'src/lifecycle-inspector.mjs');
          hasUi = await existsContainedFile(studioRepo.live.realPath, 'packages/skill-family-studio/src/ui/lifecycle-ui.mjs')
            || await existsContainedFile(studioRepo.live.realPath, 'src/ui/lifecycle-ui.mjs');
        } else {
          hasInspector = true;
          hasUi = true;
        }
        if (hasInspector && hasUi) {
          status = 'passed';
          badgeLabel = '✅ 已达成 (只读探针驾驶舱已就绪)';
          badgeTone = 'emerald';
        } else if (hasInspector || hasUi) {
          status = 'partial';
          badgeLabel = '🔵 部分就绪';
          badgeTone = 'indigo';
        }
        liveDetail = hasInspector && hasUi
          ? 'Studio 已挂载 /api/studio/lifecycle 实时只读探针与「🧭 全周期协同」四子视图驾驶舱'
          : 'Studio 全周期协同探针模块尚未完整落盘';
        probeSource = 'src/lifecycle-inspector.mjs + src/ui/lifecycle-ui.mjs + /api/studio/lifecycle';
      } else if (ms.probeCheck === 'foundation_039_unification') {
        const targets = resolveMilestoneTargets(ms.ownerRepos, r => (r.ring === 'core' || r.ring === 'method') && r.expectedFoundationTrack === '0.39.x');
        const expectedTargets = targets.filter(r => r.expectedFoundationTrack === '0.39.x' && r.live?.existsOnDisk);
        const aligned = expectedTargets.filter(r => r.live.foundation?.alignedWithExpected && !r.live.foundation?.hasLegacy022);
        const legacy = expectedTargets.filter(r => r.live.foundation?.hasLegacy022);
        if (expectedTargets.length > 0 && aligned.length === expectedTargets.length) {
          status = 'passed';
          badgeLabel = `✅ 已达成 (${aligned.length}/${expectedTargets.length} 统一 0.39.x)`;
          badgeTone = 'emerald';
        } else if (aligned.length > 0) {
          status = 'partial';
          badgeLabel = `🟠 已对齐 ${aligned.length}/${expectedTargets.length}（${legacy.length} 仓仍留 0.22.0）`;
          badgeTone = 'amber';
        }
        liveDetail = legacy.length > 0
          ? `待升级 0.22.0 仓：${legacy.map(r => r.publicName).join('、')}`
          : `全部 ${aligned.length} 个目标仓已统一至 Foundation 0.39.x`;
        probeSource = 'package.json + profile.json#adoption.foundation_pin';
      } else if (ms.probeCheck === 'audit_unidirectional_decouple') {
        const cycleFree = !auditCycle.detected;
        const hubClean = (hubActual.drifts || []).length === 0;
        if (cycleFree && hubClean) {
          status = 'passed';
          badgeLabel = '✅ 已达成 (单向解耦 & Hub 零漂移)';
          badgeTone = 'emerald';
        } else if (cycleFree || hubClean) {
          status = 'partial';
          badgeLabel = '🟠 部分收敛';
          badgeTone = 'amber';
        } else {
          status = 'planned';
          badgeLabel = '🔴 待解耦收敛';
          badgeTone = 'rose';
        }
        liveDetail = `${auditCycle.detected ? 'Audit 仍调用 release-skill verify-records' : 'Audit 已剪断反向调用'}；Hub 状态漂移 ${hubActual.drifts.length} 项`;
        probeSource = `skill-family-audit/${auditCycle.probeSource} + ${hubActual.probeSource}`;
      } else if (ms.probeCheck === 'acp_dsh_driver_and_stb') {
        const targets = resolveMilestoneTargets(ms.ownerRepos, r => r.ring === 'core' && r.live?.existsOnDisk);
        const driverPkgHits = await checkAnyFileInTargets(targets, [
          'packages/execution-driver/package.json',
        ]);
        const driverEntryHits = await checkAnyFileInTargets(targets, [
          'packages/execution-driver/src/index.mjs',
        ]);
        const driverReady = driverPkgHits.length > 0 && driverEntryHits.length > 0;
        const stbContractRegistered = Boolean(findSchemaByObject('session-trace-bundle'));
        const stbHits = await checkAnyFileInTargets(targets, [
          'packages/skill-family-contracts/src/schemas/session-trace-bundle.schema.json',
          'packages/skill-family-contracts/schemas/session-trace-bundle.schema.json',
          'schemas/session-trace-bundle.schema.json',
        ]);
        let verifiedSampleReady = false;
        for (const repo of targets) {
          if (!repo?.live?.realPath) continue;
          const sampleStb = await readJsonContainedSafe(repo.live.realPath, 'packages/execution-driver/fixtures/verified-stb-bundle.json')
            || await readJsonContainedSafe(repo.live.realPath, '.skill-family-studio/traces/latest-stb.json');
          const samplePc = await readJsonContainedSafe(repo.live.realPath, 'packages/execution-driver/fixtures/verified-stb-conclusion.json')
            || await readJsonContainedSafe(repo.live.realPath, '.skill-family-studio/traces/latest-stb-conclusion.json');
          if (!sampleStb || !samplePc) continue;
          const sealVerify = verifySessionTraceBundleSeal(sampleStb);
          const digest = sealVerify.valid ? sealVerify.bundleDigestSha256 : null;
          if (
            sealVerify.valid
            && typeof digest === 'string'
            && samplePc?.kind === 'skill-family.professional-conclusion'
            && samplePc?.provider?.id === 'skill-failure-auditor'
            && samplePc?.outcome?.code === 'FAILURE_DIAGNOSIS_CLEAR'
            && samplePc?.details?.verdict === 'PASS'
            && samplePc?.subject?.revision === `sha256:${digest}`
          ) {
            verifiedSampleReady = true;
            break;
          }
        }
        if (driverReady && stbContractRegistered && stbHits.length > 0 && verifiedSampleReady) {
          status = 'passed';
          badgeLabel = '✅ 已达成 (Driver + STB + SFA 核验闭环)';
          badgeTone = 'emerald';
        } else if (driverReady || stbHits.length > 0) {
          status = 'partial';
          badgeLabel = '🔵 部分落盘';
          badgeTone = 'indigo';
        }
        liveDetail = `ACP Driver 包：${driverReady ? driverPkgHits[0] : '待建'} · STB Schema：${stbHits[0] || '待建'} · SFA 封存对账实证：${verifiedSampleReady ? '已就绪' : '待核验'}`;
        probeSource = 'packages/execution-driver + session-trace-bundle.schema.json + SFA 封存对账结论探针';
      } else if (ms.probeCheck === 'blueprint_canvas_and_mocks') {
        const studioRepo = lookupProbedRepo(probedByKey, 'skill-family-studio')
          || probedRepos.find(r => r.publicName === 'skill-family-studio');
        const sftRepo = lookupProbedRepo(probedByKey, 'skill-family-test')
          || probedRepos.find(r => r.publicName === 'skill-family-test');
        const bpHits = studioRepo ? await checkAnyFileInTargets([studioRepo], [
          'packages/skill-family-studio/src/ui/blueprint-canvas.mjs',
          'src/ui/blueprint-canvas.mjs',
        ]) : [];
        const replayHits = sftRepo ? await checkAnyFileInTargets([sftRepo], [
          'packages/skill-family-test/src/tool-mock-replay.mjs',
          'src/tool-mock-replay.mjs',
        ]) : [];
        let bpSemanticReady = false;
        if (studioRepo?.live?.realPath && bpHits.length > 0) {
          const studioPrefix = studioRepo.publicName ? `${studioRepo.publicName}/` : `${studioRepo.name}/`;
          const bpRel = bpHits[0].startsWith(studioPrefix)
            ? bpHits[0].slice(studioPrefix.length)
            : bpHits[0].startsWith(`${studioRepo.name}/`)
              ? bpHits[0].slice(studioRepo.name.length + 1)
              : bpHits[0];
          const bpSrc = await readTextContainedSafe(studioRepo.live.realPath, bpRel);
          bpSemanticReady = Boolean(
            bpSrc &&
            !/\.\s*innerHTML\b/.test(bpSrc) &&
            bpSrc.includes('BLUEPRINT_ENUMS') &&
            /export\s+function\s+validateBlueprintCanvasDraft\b/.test(bpSrc) &&
            /export\s+function\s+computeBlueprintDigestSync\b/.test(bpSrc) &&
            /export\s+function\s+renderBlueprintCanvasSubView\b/.test(bpSrc),
          );
        }
        let replaySemanticReady = false;
        if (sftRepo?.live?.realPath && replayHits.length > 0) {
          const sftPrefix = sftRepo.publicName ? `${sftRepo.publicName}/` : `${sftRepo.name}/`;
          const replayRel = replayHits[0].startsWith(sftPrefix)
            ? replayHits[0].slice(sftPrefix.length)
            : replayHits[0].startsWith(`${sftRepo.name}/`)
              ? replayHits[0].slice(sftRepo.name.length + 1)
              : replayHits[0];
          const replaySrc = await readTextContainedSafe(sftRepo.live.realPath, replayRel);
          replaySemanticReady = Boolean(
            replaySrc &&
            /export\s+function\s+sealToolMockFixture\b/.test(replaySrc) &&
            /export\s+function\s+verifyToolMockFixtureSeal\b/.test(replaySrc) &&
            /export\s+function\s+verifyToolReplayRun\b/.test(replaySrc),
          );
        }
        if (bpSemanticReady && replaySemanticReady) {
          status = 'passed';
          badgeLabel = '✅ 已达成';
          badgeTone = 'emerald';
        } else if (bpHits.length > 0 || replayHits.length > 0) {
          status = 'partial';
          badgeLabel = '🔵 部分落盘';
          badgeTone = 'indigo';
        }
        liveDetail = `编排蓝图画布：${bpSemanticReady ? bpHits[0] : (bpHits[0] ? `${bpHits[0]} (语义探针未齐)` : '待建设')} · sft 工具替身回放：${replaySemanticReady ? replayHits[0] : (replayHits[0] ? `${replayHits[0]} (导出未齐)` : '待建设')}`;
        probeSource = 'skill-family-studio/blueprint-canvas.mjs + skill-family-test/tool-mock-replay.mjs 内容语义探针';
      } else if (ms.probeCheck === 'skill_eval_scorecard_engine') {
        const evalRepo = lookupProbedRepo(probedByKey, 'skill-family-eval')
          || lookupProbedRepo(probedByKey, 'skill-eval')
          || probedRepos.find(r => r.publicName === 'skill-family-eval' || r.publicName === 'skill-eval');
        const rsRepo = lookupProbedRepo(probedByKey, 'release-skill')
          || probedRepos.find(r => r.publicName === 'release-skill');
        const sfaRepo = lookupProbedRepo(probedByKey, 'skill-failure-auditor')
          || probedRepos.find(r => r.publicName === 'skill-failure-auditor');
        const requiredModules = [
          'packages/skill-eval/package.json',
          'packages/skill-eval/src/oracle-vault.mjs',
          'packages/skill-eval/src/judge-calibration.mjs',
          'packages/skill-eval/src/sfa-hard-gate.mjs',
          'packages/skill-eval/src/scorecard-engine.mjs',
          'packages/skill-eval/src/eval-conclusion.mjs',
          'packages/skill-eval/schemas/scorecard.schema.json',
        ];
        const moduleChecks = evalRepo ? await Promise.all(
          requiredModules.map(rel => checkAnyFileInTargets([evalRepo], [rel]).then(hits => hits[0] || null)),
        ) : [];
        const presentCount = moduleChecks.filter(Boolean).length;
        let adversarialReady = false;
        if (evalRepo?.live?.realPath) {
          const advSrc = await readTextContainedSafe(
            evalRepo.live.realPath,
            'packages/skill-eval/src/adversarial-suite.mjs',
          );
          adversarialReady = Boolean(
            advSrc &&
            advSrc.includes('ADVERSARIAL_SUITE_ID') &&
            advSrc.includes('evaluateAdversarialRun'),
          );
        }
        let rsEvalProofReady = false;
        if (rsRepo?.live?.realPath) {
          const rsProofSrc = await readTextContainedSafe(
            rsRepo.live.realPath,
            'packages/release-skill/src/commands/professional-proof.mjs',
          );
          rsEvalProofReady = Boolean(
            rsProofSrc &&
            /export\s+async\s+function\s+readEvalProfessionalProof\b/.test(rsProofSrc),
          );
        }
        const sfaAligned = sfaRepo?.live?.existsOnDisk
          ? Boolean(sfaRepo.live.foundation?.alignedWithExpected && sfaRepo.live.foundation?.foundationTrackActual === '0.39.x')
          : true;
        const hubEvalActive = (hubActual.providers || []).some(
          p =>
            p.capabilityId === 'quality-evaluation' &&
            (p.providerId === 'skill-family-eval' || p.providerId === 'skill-eval') &&
            p.lifecycleState === 'active' &&
            p.integrationStatus === 'published-verified',
        );
        const verReady = evalRepo?.live?.existsOnDisk && !isPlaceholderVersion(evalRepo.live.sourceVersion?.version);
        const fndReady = Boolean(
          evalRepo?.live?.foundation?.alignedWithExpected &&
          evalRepo?.live?.foundation?.foundationTrackActual === '0.39.x' &&
          sfaAligned,
        );
        const siteReady = Boolean(evalRepo?.live?.docSite?.isIndependentSite);
        const receiptReady = Boolean(evalRepo?.live?.locksAndReceipt?.receiptPassed);
        if (
          verReady &&
          fndReady &&
          presentCount === requiredModules.length &&
          siteReady &&
          receiptReady &&
          rsEvalProofReady &&
          hubEvalActive &&
          adversarialReady
        ) {
          status = 'passed';
          badgeLabel = '✅ 已达成 (含对抗评测与 P7 门禁闭环)';
          badgeTone = 'emerald';
        } else if (presentCount > 0 || fndReady) {
          status = 'partial';
          badgeLabel = adversarialReady
            ? '🔵 引擎与对抗包已落盘（待上下游门禁串联）'
            : '🔵 0.1.0 引擎就绪（待 4B-2 安全对抗套件）';
          badgeTone = 'indigo';
        }
        liveDetail = `skill-family-eval v${evalRepo?.live?.sourceVersion?.version || '0.0.0'}，核心模块=${presentCount}/${requiredModules.length}，P7门禁=${rsEvalProofReady ? '已接线' : '待接线'}，Hub槽位=${hubEvalActive ? 'active' : '待切换'}，对抗套件=${adversarialReady ? '已就绪' : '待 4B-2'}`;
        probeSource = 'skill-eval/src/* + release-skill/professional-proof.mjs + Hub lifecycle-providers.mjs';
      } else if (ms.probeCheck === 'studio_server_otel_dengbao') {
        const targets = resolveMilestoneTargets(ms.ownerRepos, r => r.ring === 'core' && r.live?.existsOnDisk);
        const studioRepo = lookupProbedRepo(probedByKey, 'skill-family-studio')
          || targets.find(r => r.publicName === 'skill-family-studio')
          || null;
        const sfaRepo = lookupProbedRepo(probedByKey, 'skill-failure-auditor')
          || probedRepos.find(r => r.publicName === 'skill-failure-auditor')
          || null;
        const rsRepo = lookupProbedRepo(probedByKey, 'release-skill')
          || probedRepos.find(r => r.publicName === 'release-skill')
          || null;

        const srvCandidates = [
          'packages/skill-family-studio/src/studio-collector-server.mjs',
          'packages/studio-server/package.json',
          'src/studio-collector-server.mjs',
        ];
        const otelCandidates = [
          'packages/skill-family-studio/src/otel-siem-exporter.mjs',
          'packages/otel-compliance-exporter/package.json',
          'src/otel-siem-exporter.mjs',
        ];
        const srvHits = await checkAnyFileInTargets(targets, srvCandidates);
        const otelHits = await checkAnyFileInTargets(targets, otelCandidates);

        let otelSemanticReady = false;
        let collectorSemanticReady = false;
        let governanceSemanticReady = false;
        if (studioRepo?.live?.realPath) {
          const otelSrc = (await readTextContainedSafe(
            studioRepo.live.realPath,
            'packages/skill-family-studio/src/otel-siem-exporter.mjs',
          )) || (await readTextContainedSafe(studioRepo.live.realPath, 'src/otel-siem-exporter.mjs'));
          const srvSrc = (await readTextContainedSafe(
            studioRepo.live.realPath,
            'packages/skill-family-studio/src/studio-collector-server.mjs',
          )) || (await readTextContainedSafe(studioRepo.live.realPath, 'src/studio-collector-server.mjs'));

          const retentionMatch = otelSrc
            ? /export\s+const\s+MIN_RETENTION_DAYS\s*=\s*(\d+)\b/.exec(otelSrc)
            : null;
          const retentionFloor = retentionMatch ? Number.parseInt(retentionMatch[1], 10) : 0;

          otelSemanticReady = Boolean(
            otelSrc &&
            retentionFloor >= 180 &&
            !/\.\s*innerHTML\b/.test(otelSrc) &&
            /export\s+class\s+ComplianceAuditLedger\b/.test(otelSrc) &&
            /export\s+function\s+exportStbToOtelSpans\b/.test(otelSrc) &&
            /export\s+function\s+exportAuditEventsToSiemNdjson\b/.test(otelSrc) &&
            /export\s+function\s+buildDengbaoEvidenceMappingReport\b/.test(otelSrc),
          );
          collectorSemanticReady = Boolean(
            srvSrc &&
            !/\.\s*innerHTML\b/.test(srvSrc) &&
            /export\s+function\s+createStudioCollectorServer\b/.test(srvSrc) &&
            /export\s+class\s+QuotaCircuitBreaker\b/.test(srvSrc),
          );
          governanceSemanticReady = Boolean(
            collectorSemanticReady &&
            /export\s+class\s+TenantRbacAuthorizer\b/.test(srvSrc) &&
            /export\s+class\s+HitlApprovalQueue\b/.test(srvSrc) &&
            /export\s+async\s+function\s+exportIncidentToFb2Candidate\b/.test(srvSrc),
          );
        }

        let sfaExportReady = false;
        if (sfaRepo?.live?.realPath) {
          const sfaPy =
            (await readTextContainedSafe(
              sfaRepo.live.realPath,
              'packages/skill-failure-auditor/plugin-src/core/scripts/evaluation_tool.py',
            )) ||
            (await readTextContainedSafe(
              sfaRepo.live.realPath,
              'skills/skill-failure-auditor/scripts/evaluation_tool.py',
            )) ||
            (await readTextContainedSafe(sfaRepo.live.realPath, 'scripts/evaluation_tool.py'));
          sfaExportReady = Boolean(sfaPy && sfaPy.includes('export-repro-candidate'));
        }

        let rsControlledPrivateReady = false;
        if (rsRepo?.live?.realPath) {
          const rsReceiptReady = Boolean(
            rsRepo.live.locksAndReceipt?.receiptPassed || rsRepo.live.locksAndReceipt?.lockPresent,
          );
          const rsPolicySrc =
            (await readTextContainedSafe(
              rsRepo.live.realPath,
              'packages/release-skill/src/core/git-url-policy.mjs',
            )) || (await readTextContainedSafe(rsRepo.live.realPath, 'src/core/git-url-policy.mjs'));
          const rsSourcePolicyImplemented = Boolean(
            rsPolicySrc &&
              rsPolicySrc.includes('validateSourcePolicyDeclaration') &&
              rsPolicySrc.includes('controlled-private'),
          );
          rsControlledPrivateReady = Boolean(rsReceiptReady && rsSourcePolicyImplemented);
        }

        const studioReceiptReady = studioRepo?.live?.existsOnDisk
          ? Boolean(studioRepo.live.locksAndReceipt?.receiptPassed)
          : false;
        const requiresM32Governance = ms.id === 'M3-2';
        const fullSemanticPass = requiresM32Governance
          ? Boolean(otelSemanticReady && governanceSemanticReady && sfaExportReady && rsControlledPrivateReady && studioReceiptReady)
          : Boolean(otelSemanticReady && collectorSemanticReady && studioReceiptReady);

        if (fullSemanticPass) {
          status = 'passed';
          badgeLabel = requiresM32Governance
            ? '✅ 已达成 (RBAC + HITL + 线上 FB-2 闭环)'
            : '✅ 已达成 (采集器 + OTel/SIEM + ≥180天哈希链)';
          badgeTone = 'emerald';
        } else if (srvHits.length > 0 || otelHits.length > 0) {
          status = 'partial';
          badgeLabel = '🔵 模块已落盘（待补齐语义契约或实测收据）';
          badgeTone = 'indigo';
        }
        liveDetail = `Studio Server：${collectorSemanticReady ? srvHits[0] : (srvHits[0] ? `${srvHits[0]} (语义未齐)` : '远期规划')} · OTel/SIEM ≥180天等保留存：${otelSemanticReady ? otelHits[0] : (otelHits[0] ? `${otelHits[0]} (语义未齐)` : '远期规划')}${requiresM32Governance ? ` · RBAC/HITL/FB-2：${governanceSemanticReady && sfaExportReady ? '已就绪' : '待核验'}` : ''}`;
        probeSource = 'studio-collector-server.mjs + otel-siem-exporter.mjs 语义探针 + sft-runs.json';
      }

      if (status === 'passed') passedCount += 1;
      milestones.push({
        ...ms,
        liveStatus: status,
        liveBadgeLabel: badgeLabel,
        liveBadgeTone: badgeTone,
        liveDetail,
        probeSource,
      });
    }
    const totalMs = milestones.length;
    outStages.push({
      ...stage,
      milestones,
      passedCount,
      totalCount: totalMs,
      completionPercent: totalMs > 0 ? Math.round((passedCount / totalMs) * 100) : 0,
    });
  }
  return outStages;
}

export async function inspectLifecycleCollaboration({ root = '.', catalog = null, repoId = null } = {}) {
  const disc = await discoverLifecycleCollection(root, catalog, repoId);
  if (!disc.found) {
    return {
      ok: true,
      available: false,
      reason: 'registry_not_found',
      ringByRepoName: {},
    };
  }

  const [registry, modelDoc, portfolioAlloc] = await Promise.all([
    readJsonContainedSafe(disc.hostRepoReal, disc.registryRel),
    disc.modelRel ? readJsonContainedSafe(disc.hostRepoReal, disc.modelRel) : Promise.resolve(null),
    inspectPortfolioAllocations(disc.hostRepoReal, catalog),
  ]);

  if (!registry || !Array.isArray(registry.phases) || !Array.isArray(registry.repositories)) {
    return {
      ok: true,
      available: false,
      reason: 'invalid_registry_payload',
      ringByRepoName: {},
    };
  }

  const { ringDefs, ringByRepoName } = buildLifecycleRingMap(registry);
  const rawRepos = registry.repositories;
  const resolvedTargets = await Promise.all(rawRepos.map(r => resolveRepoTarget(disc.hostRepoReal, r, catalog)));

  const hubIdx = rawRepos.findIndex(r => r.publicName === 'skill-family-hub');
  const auditIdx = rawRepos.findIndex(r => r.publicName === 'skill-family-audit');
  const hubRepoReal = hubIdx >= 0 ? resolvedTargets[hubIdx]?.realPath : null;
  const auditRepoReal = auditIdx >= 0 ? resolvedTargets[auditIdx]?.realPath : null;

  const [hubActual, auditCycle] = await Promise.all([
    probeHubActual(hubRepoReal, rawRepos),
    probeAuditReleaseCycle(auditRepoReal),
  ]);

  const probedRepos = await Promise.all(rawRepos.map(async (repoEntry, idx) => {
    const target = resolvedTargets[idx];
    const ringMeta = ringDefs[repoEntry.ring] || RING_SHORT_META.consumer;
    const hubMatches = [
      ...(hubActual.byPublicName[repoEntry.publicName] || []),
      ...(repoEntry.name !== repoEntry.publicName ? (hubActual.byPublicName[repoEntry.name] || []) : []),
    ];
    const uniqueHub = [...new Map(hubMatches.map(m => [m.capabilityId, m])).values()];

    if (!target.existsOnDisk || !target.realPath) {
      return {
        ...repoEntry,
        ringBadge: { ring: ringMeta.ring, label: ringMeta.label, tone: ringMeta.badgeTone, enterSwimlane: ringMeta.enterSwimlane },
        studioRepoId: null,
        live: {
          existsOnDisk: false,
          realPath: null,
          resolveSource: target.resolveSource,
          sourceVersion: { version: null, probeSource: target.resolveSource },
          git: { isGitRepo: false, latestGitTag: null, aheadCommits: null, worktreeClean: null, tagProbeSource: target.resolveSource, cleanProbeSource: target.resolveSource },
          foundation: { foundationTrackActual: 'not-applicable', foundationPinDetail: '非本地仓库', alignedWithExpected: true, hasLegacy022: false, probeSource: target.resolveSource },
          locksAndReceipt: { lockPresent: false, receiptPassed: false, badgeLabel: '⚪ 非在盘仓库', badgeTone: 'zinc', probeSource: target.resolveSource },
          docSite: { mode: 'not_applicable', isIndependentSite: false, pagesUrl: null, label: '不适用', probeSource: target.resolveSource },
          hubEntries: uniqueHub,
          hubProbeSource: hubActual.probeSource,
        },
      };
    }

    // 严格只针对 core + method 在盘仓跑子进程 git 探针以加速响应，consumer/retired 仓库若需要也安全支持只读探测
    const runFullProbes = repoEntry.ring === 'core' || repoEntry.ring === 'method' || repoEntry.ring === 'retired';
    const [sourceVersion, gitInfo, foundation, locksAndReceipt, docSite] = await Promise.all([
      probeSourceVersion(target.realPath, repoEntry.publicName),
      runFullProbes
        ? probeGitStatusAndTags(target.realPath)
        : Promise.resolve({ isGitRepo: true, latestGitTag: null, aheadCommits: null, worktreeClean: null, tagProbeSource: '下游消费样本豁免深扫', cleanProbeSource: '下游消费样本豁免深扫' }),
      probeFoundationTrack(target.realPath, repoEntry),
      runFullProbes
        ? probeLocksAndReceipt(target.realPath)
        : Promise.resolve({ lockPresent: false, receiptPassed: false, badgeLabel: '下游消费样本', badgeTone: 'zinc', probeSource: '不纳入元平台核心门禁' }),
      probeDocSite(target.realPath, repoEntry.expectedDocSiteMode),
    ]);

    return {
      ...repoEntry,
      ringBadge: { ring: ringMeta.ring, label: ringMeta.label, tone: ringMeta.badgeTone, enterSwimlane: ringMeta.enterSwimlane },
      studioRepoId: target.studioRepoId,
      live: {
        existsOnDisk: true,
        realPath: target.realPath,
        resolveSource: target.resolveSource,
        sourceVersion,
        git: gitInfo,
        foundation,
        locksAndReceipt,
        docSite,
        hubEntries: uniqueHub,
        hubProbeSource: hubActual.probeSource,
      },
    };
  }));

  const probedByKey = new Map();
  for (const r of probedRepos) {
    for (const k of [r.id, r.name, r.publicName, typeof r.repoRef === 'string' && r.repoRef !== '.' ? basename(r.repoRef) : null]) {
      if (k && !probedByKey.has(k)) probedByKey.set(k, r);
    }
  }

  const architecturalRisks = await evaluateArchitecturalRisks(
    registry.architecturalRisks,
    probedRepos,
    probedByKey,
    hubActual,
    auditCycle,
  );
  const capabilityCatalog = evaluateCapabilityCatalog(registry.capabilityCatalog, probedByKey);
  const roadmap = await evaluateRoadmapMilestones(registry.roadmap, {
    portfolioAlloc,
    probedRepos,
    probedByKey,
    hubActual,
    auditCycle,
  });

  // 严格三环泳道隔离：consumer / retired / external-tool 绝不进入泳道行！
  const coreRepos = probedRepos.filter(r => r.ring === 'core');
  const methodRepos = probedRepos.filter(r => r.ring === 'method');
  const consumerRepos = probedRepos.filter(r => r.ring === 'consumer');
  const retiredRepos = probedRepos.filter(r => r.ring === 'retired');
  const externalToolRepos = probedRepos.filter(r => r.ring === 'external-tool');

  const coreWithLock = coreRepos.filter(r => r.live?.locksAndReceipt?.lockPresent).length;
  const coreWithReceipt = coreRepos.filter(r => r.live?.locksAndReceipt?.receiptPassed || r.repoRef === '.' && (portfolioAlloc?.summary?.verifiedSatisfied ?? 0) >= 5).length;
  const activeRiskCount = architecturalRisks.filter(r => r.detected).length;
  const stage0 = roadmap.find(s => s.id === 'stage-0') || roadmap[0] || { passedCount: 0, totalCount: 0, completionPercent: 0, window: '' };

  const publicRepos = probedRepos.map(r => ({
    ...r,
    live: {
      ...r.live,
      realPath: undefined,
    },
  }));

  return {
    ok: true,
    available: true,
    probedAt: new Date().toISOString(),
    hostRepoId: disc.hostRepoId,
    hostRepoName: disc.hostRepoName,
    sourceMode: disc.sourceMode,
    documents: {
      registryPath: disc.registryRel,
      modelPath: disc.modelRel,
      architectureDocPath: disc.architectureDocRel,
      roadmapSpecPath: disc.roadmapSpecRel,
    },
    modelSummary: modelDoc ? {
      id: modelDoc.id || modelDoc.model_id || 'DM-002',
      title: modelDoc.name || modelDoc.title || '全周期协同领域模型',
      version: modelDoc.version || '1.0.0',
      objectsCount: Array.isArray(modelDoc.objects) ? modelDoc.objects.length : 0,
      transitionsCount: Array.isArray(modelDoc.state_transitions || modelDoc.transitions) ? (modelDoc.state_transitions || modelDoc.transitions).length : 0,
    } : null,
    schemaVersion: registry.schemaVersion,
    id: registry.id,
    updatedAt: registry.updatedAt,
    subject: registry.subject,
    terminologyPolicy: registry.terminologyPolicy,
    kpi: {
      subjectTitle: registry.subject?.title || '技能族全生命周期平台生态',
      subjectKind: registry.subject?.kind || 'ecosystem',
      reusableForSingleFamily: Boolean(registry.subject?.reusableForSingleFamily),
      phasesCount: registry.phases.length,
      planesCount: (registry.crossCuttingPlanes || []).length,
      feedbackLoopsCount: (registry.feedbackLoops || []).length,
      coreTotal: coreRepos.length,
      coreWithLock,
      coreWithReceipt,
      methodTotal: methodRepos.length,
      activeRiskCount,
      totalRiskCount: architecturalRisks.length,
      stage0Passed: stage0.passedCount,
      stage0Total: stage0.totalCount,
      stage0Percent: stage0.completionPercent,
      stage0Window: stage0.window || '',
      portfolioVerifiedSatisfied: portfolioAlloc?.summary?.verifiedSatisfied ?? 0,
      portfolioAllocatedTotal: (portfolioAlloc?.items || []).filter(i => i.disposition === 'allocated').length,
    },
    rings: Object.values(ringDefs),
    ringByRepoName,
    phases: [...registry.phases].sort((a, b) => (a.order || 0) - (b.order || 0)),
    crossCuttingPlanes: registry.crossCuttingPlanes || [],
    feedbackLoops: registry.feedbackLoops || [],
    swimlane: {
      coreRows: publicRepos.filter(r => r.ring === 'core'),
      methodRows: publicRepos.filter(r => r.ring === 'method'),
      excludedSummary: {
        consumerCount: consumerRepos.length,
        consumerNames: consumerRepos.map(r => r.publicName),
        retiredCount: retiredRepos.length,
        retiredNames: retiredRepos.map(r => r.publicName),
        externalToolCount: externalToolRepos.length,
        externalToolNames: externalToolRepos.map(r => r.publicName),
      },
    },
    repositories: publicRepos,
    ledgerRepos: publicRepos.filter(r => r.ring === 'core' || r.ring === 'method'),
    contractFlows: registry.contractFlows || [],
    divisionOfLabor: registry.divisionOfLabor || [],
    architecturalRisks,
    capabilityCatalog,
    roadmap,
    architectureDecisions: registry.architectureDecisions || [],
    hubProbeSummary: {
      present: hubActual.present,
      providersCount: hubActual.providers.length,
      driftsCount: hubActual.drifts.length,
      probeSource: hubActual.probeSource,
    },
    auditCycleProbe: auditCycle,
  };
}
