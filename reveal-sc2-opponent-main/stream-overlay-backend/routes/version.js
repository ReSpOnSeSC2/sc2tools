/**
 * SC2 Tools update-check route.
 *
 * Mounts two endpoints:
 *
 *   GET  /api/version
 *     Returns the current local version, the latest GH release, and the
 *     installer asset URLs. Also issues a single-use 5-minute nonce that
 *     /api/update/start requires. The GH lookup is cached for one hour so
 *     a hot SPA does not hammer the GitHub API.
 *
 *   POST /api/update/start
 *     Spawns packaging/silent-update.ps1 detached, then schedules this
 *     backend to exit after a 5-second grace period so the installer can
 *     replace the on-disk files. Three layers of defence against drive-by
 *     triggers:
 *       1. The request must come from 127.0.0.1 / ::1 (localhost-only).
 *       2. The Origin header must match Host (same-origin).
 *       3. The body must include a single-use nonce previously handed out
 *          by /api/version.
 *
 * The version source of truth is stream-overlay-backend/package.json.
 * Python-side __version__ reads the same file (see SC2Replay-Analyzer/
 * __init__.py) and a CI guard verifies they match.
 *
 * @module routes/version
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Router } = require('express');

// ----- Constants -----------------------------------------------------------
const ONE_HOUR_MS = 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const EXIT_GRACE_MS = 5000;
const FETCH_TIMEOUT_MS = 10000;
const GITHUB_REPO_DEFAULT = 'ReSpOnSeSC2/sc2tools';
const GITHUB_API_BASE = 'https://api.github.com';
const UNKNOWN_VERSION = '0.0.0+unknown';
const SILENT_UPDATE_RELATIVE = path.join('packaging', 'silent-update.ps1');
const PACKAGE_JSON_RELATIVE = path.join(
  'reveal-sc2-opponent-main', 'stream-overlay-backend', 'package.json',
);

// ----- Pure helpers (each <= 30 lines) -------------------------------------
function readCurrentVersion(packageJsonPath) {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.version === 'string' && data.version.trim()) {
      return data.version.trim();
    }
  } catch (_err) {
    // Fall through to unknown sentinel.
  }
  return UNKNOWN_VERSION;
}

async function fetchLatestRelease(repo) {
  const url = `${GITHUB_API_BASE}/repos/${repo}/releases/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'sc2tools-update-check',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub ${res.status}: ${res.statusText}`);
    }
    return parseReleaseBody(await res.json());
  } finally {
    clearTimeout(timeout);
  }
}

function parseReleaseBody(body) {
  return {
    tag: body.tag_name || '',
    url: body.html_url || '',
    notes: typeof body.body === 'string' ? body.body : '',
    publishedAt: body.published_at || null,
    assets: Array.isArray(body.assets)
      ? body.assets.map((a) => ({ name: a.name, url: a.browser_download_url }))
      : [],
  };
}

function compareVersions(a, b) {
  const parts = (v) => String(v || '').replace(/^v/, '')
    .split('.').map((p) => parseInt(p, 10) || 0);
  const [a1, a2, a3] = parts(a);
  const [b1, b2, b3] = parts(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isSameOrigin(req) {
  const origin = req.get('origin');
  const host = req.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch (_err) {
    return false;
  }
}

// ----- Cache + nonce factories ---------------------------------------------
function createCacheManager(packageJsonPath, githubRepo, fetcher, log) {
  let entry = null;  // { fetchedAt, payload }
  return async function getPayload() {
    if (entry && Date.now() - entry.fetchedAt < ONE_HOUR_MS) {
      return entry.payload;
    }
    const payload = await buildPayload(packageJsonPath, githubRepo, fetcher, log);
    entry = { fetchedAt: Date.now(), payload };
    return payload;
  };
}

async function buildPayload(packageJsonPath, githubRepo, fetcher, log) {
  const current = readCurrentVersion(packageJsonPath);
  let latest = current;
  let releaseUrl = `https://github.com/${githubRepo}/releases`;
  let releaseNotes = '';
  let exeUrl = null;
  let sha256Url = null;
  try {
    const release = await fetcher(githubRepo);
    latest = (release.tag || current).replace(/^v/, '');
    releaseUrl = release.url || releaseUrl;
    releaseNotes = release.notes;
    const exe = release.assets.find((a) => a.name?.endsWith('.exe'));
    const sha = release.assets.find((a) => a.name?.endsWith('.sha256'));
    exeUrl = exe?.url || null;
    sha256Url = sha?.url || null;
  } catch (err) {
    log.warn?.('[version] GitHub release lookup failed:', err.message);
  }
  return {
    current,
    latest,
    updateAvailable: compareVersions(latest, current) > 0,
    releaseUrl,
    releaseNotes,
    exeUrl,
    sha256Url,
    checkedAt: new Date().toISOString(),
  };
}

function createNonceManager() {
  const nonces = new Map();
  return {
    issue(payload) {
      const nonce = crypto.randomBytes(16).toString('hex');
      nonces.set(nonce, {
        issuedAt: Date.now(),
        expectedTag: payload.latest,
        exeUrl: payload.exeUrl,
        sha256Url: payload.sha256Url,
      });
      gcExpired(nonces);
      return nonce;
    },
    consume(nonce) {
      const found = nonces.get(nonce);
      if (!found) return null;
      nonces.delete(nonce);
      if (Date.now() - found.issuedAt > NONCE_TTL_MS) return null;
      return found;
    },
  };
}

function gcExpired(nonces) {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [key, value] of nonces) {
    if (value.issuedAt < cutoff) nonces.delete(key);
  }
}

// ----- Route handlers ------------------------------------------------------
function handleGetVersion(cache, nonces, log) {
  return async function getVersion(_req, res) {
    try {
      const payload = await cache();
      const updateNonce = nonces.issue(payload);
      res.json({ ...payload, updateNonce });
    } catch (err) {
      log.error?.('[version] /api/version failed:', err);
      res.status(500).json({ error: 'version_check_failed' });
    }
  };
}

function handlePostUpdateStart(nonces, deps) {
  return function postUpdateStart(req, res) {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ error: 'localhost_only' });
    }
    if (!isSameOrigin(req)) {
      return res.status(403).json({ error: 'same_origin_only' });
    }
    const nonce = req.body?.nonce;
    if (typeof nonce !== 'string') {
      return res.status(400).json({ error: 'missing_nonce' });
    }
    const entry = nonces.consume(nonce);
    if (!entry) {
      return res.status(400).json({ error: 'invalid_or_expired_nonce' });
    }
    if (!entry.exeUrl || !entry.sha256Url) {
      return res.status(400).json({ error: 'release_assets_unknown' });
    }
    return spawnHelperAndExit(entry, deps, res);
  };
}

function spawnHelperAndExit(entry, deps, res) {
  if (!fs.existsSync(deps.silentUpdateScript)) {
    return res.status(500).json({ error: 'helper_script_missing' });
  }
  const args = [
    '-ExecutionPolicy', 'Bypass', '-File', deps.silentUpdateScript,
    '-ExeUrl', entry.exeUrl,
    '-Sha256Url', entry.sha256Url,
    '-ParentPid', String(process.pid),
    '-Tag', entry.expectedTag,
  ];
  deps.spawn('powershell.exe', args, { detached: true, stdio: 'ignore' }).unref();
  deps.log.info?.(`[version] update helper spawned (tag=${entry.expectedTag})`);
  res.status(202).json({ ok: true, scheduledExitMs: EXIT_GRACE_MS });
  deps.setTimeout(() => deps.exit(), EXIT_GRACE_MS);
  return undefined;
}

// ----- Public factory ------------------------------------------------------
function resolveConfig(options) {
  const repoRoot = options.repoRoot
    || path.resolve(__dirname, '..', '..', '..');
  return {
    packageJsonPath: options.packageJsonPath
      || path.join(repoRoot, PACKAGE_JSON_RELATIVE),
    githubRepo: options.githubRepo || GITHUB_REPO_DEFAULT,
    silentUpdateScript: options.silentUpdateScript
      || path.join(repoRoot, SILENT_UPDATE_RELATIVE),
    fetcher: options.fetchLatest || fetchLatestRelease,
    spawn: options.spawn || spawn,
    exit: options.exit || (() => process.exit(0)),
    setTimeout: options.setTimeout || setTimeout,
    log: options.log || console,
  };
}

function createVersionRouter(options = {}) {
  const config = resolveConfig(options);
  const cache = createCacheManager(
    config.packageJsonPath, config.githubRepo, config.fetcher, config.log,
  );
  const nonces = createNonceManager();
  const router = Router();
  router.get('/api/version', handleGetVersion(cache, nonces, config.log));
  router.post('/api/update/start', handlePostUpdateStart(nonces, config));
  return router;
}

module.exports = {
  createVersionRouter,
  // Exposed for unit tests; not part of the public API.
  _internal: {
    compareVersions,
    readCurrentVersion,
    fetchLatestRelease,
    parseReleaseBody,
    isLocalRequest,
    isSameOrigin,
    UNKNOWN_VERSION,
    NONCE_TTL_MS,
    ONE_HOUR_MS,
    EXIT_GRACE_MS,
  },
};
