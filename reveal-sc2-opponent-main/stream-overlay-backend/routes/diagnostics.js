/**
 * DIAGNOSTICS ROUTER (Stage 4)
 * ============================================================
 * Express sub-router that powers the SPA's Diagnostics view and the
 * "Copy diagnostic bundle" button. The 13 individual checks live in
 * `routes/diagnostics_checks.js`; shared utilities live in
 * `routes/diagnostics_helpers.js`; the zip streamer lives in
 * `routes/diagnostics_bundle.js`. This file owns the express glue,
 * the in-memory cache, and the dependency object every check receives.
 *
 * Hard rules honored here:
 *   - All checks run IN PARALLEL via Promise.all (see runAllChecks).
 *     Even on a clean install where most checks fail, the page is
 *     never blocked on a slow one (worst-case ~5-8s for the slowest
 *     network call).
 *   - 30-second in-memory cache. Pass ?refresh=1 to bypass.
 *   - No PII ever logged or returned in the live response. Profile +
 *     config are deep-cloned and run through `redact()` before being
 *     placed in the diagnostic-bundle zip.
 *   - The factory `createDiagnosticsRouter({ ... })` lets jest point
 *     the router at a tmp directory and inject a fake fetch / spawn
 *     for offline tests.
 *
 * Endpoints:
 *   GET /api/diagnostics             -> { checks, generated_at, cached }
 *   GET /api/diagnostics/bundle      -> application/zip  (redacted)
 *
 * Example:
 *   const { createDiagnosticsRouter } = require('./routes/diagnostics');
 *   app.use(createDiagnosticsRouter({
 *     dataDir: path.join(ROOT, 'data'),
 *     analyzerScriptsDir: path.resolve(ROOT, '..', 'SC2Replay-Analyzer'),
 *   }));
 */

'use strict';

const path = require('path');
const express = require('express');

const {
  STATUS_ERR, buildResult, readJsonOrNull,
} = require('./diagnostics_helpers');
const checks = require('./diagnostics_checks');
const { streamBundle } = require('./diagnostics_bundle');

// ------------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------------

const PROFILE_FILE = 'profile.json';
const CONFIG_FILE = 'config.json';

const HTTP_INTERNAL = 500;
const CACHE_TTL_MS = 30 * 1000;
const DEFAULT_PULSE_BASE = 'https://sc2pulse.nephest.com/sc2/api';

const CHECK_RUNNERS = Object.freeze([
  ['python', checks.checkPython],
  ['sc2reader', checks.checkSc2Reader],
  ['replay_folders', checks.checkReplayFolders],
  ['meta_database', checks.checkMetaDatabase],
  ['profile_config', checks.checkProfileConfig],
  ['battlenet_pulse', checks.checkBattleNetPulse],
  ['twitch', checks.checkTwitch],
  ['obs', checks.checkObs],
  ['disk_space', checks.checkDiskSpace],
  ['recent_errors', checks.checkRecentErrors],
  ['macro_engine_version', checks.checkMacroEngineVersion],
  ['community_builds_api', checks.checkCommunityBuildsApi],
  ['cloud_optin_queue', checks.checkCloudOptInQueue],
]);

// ------------------------------------------------------------------
// FACTORY
// ------------------------------------------------------------------

/**
 * Build the diagnostics router. Pass the absolute paths of the data
 * dir + the SC2Replay-Analyzer scripts dir; everything else has a
 * sensible default and can be overridden in tests.
 *
 * Example:
 *   const router = createDiagnosticsRouter({
 *     dataDir: '/abs/path/to/data',
 *     analyzerScriptsDir: '/abs/path/to/SC2Replay-Analyzer',
 *   });
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.analyzerScriptsDir]
 * @param {string} [options.pythonCmd]
 * @param {function} [options.fetchImpl]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.pulseBaseUrl]
 * @param {number} [options.cacheTtlMs]
 * @returns {express.Router}
 */
function createDiagnosticsRouter(options) {
  if (!options || !options.dataDir) {
    throw new Error('createDiagnosticsRouter: dataDir is required');
  }
  const cfg = buildConfig(options);
  const router = express.Router();
  const cacheState = { value: null, expiresAt: 0 };
  router.get('/api/diagnostics',
    (req, res) => handleGetDiagnostics(req, res, cfg, cacheState));
  router.get('/api/diagnostics/bundle',
    (req, res) => handleGetBundle(req, res, cfg));
  return router;
}

/**
 * Materialize defaults + frozen config from the options object.
 *
 * @param {object} options
 * @returns {object}
 */
function buildConfig(options) {
  const defaultPython = process.platform === 'win32' ? 'py' : 'python3';
  const fetchImpl = options.fetchImpl
    || (typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null);
  if (!fetchImpl) {
    throw new Error(
      'createDiagnosticsRouter: no fetch implementation available');
  }
  return Object.freeze({
    dataDir: options.dataDir,
    analyzerScriptsDir: options.analyzerScriptsDir
      || path.resolve(options.dataDir, '..', '..', 'SC2Replay-Analyzer'),
    pythonCmd: options.pythonCmd || defaultPython,
    fetchImpl,
    env: options.env || process.env,
    pulseBaseUrl: options.pulseBaseUrl || DEFAULT_PULSE_BASE,
    cacheTtlMs: typeof options.cacheTtlMs === 'number'
      ? options.cacheTtlMs : CACHE_TTL_MS,
  });
}

// ------------------------------------------------------------------
// HANDLERS
// ------------------------------------------------------------------

/**
 * Express handler for GET /api/diagnostics with 30s cache. ?refresh=1
 * bypasses the cache.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} cfg
 * @param {object} cacheState
 */
async function handleGetDiagnostics(req, res, cfg, cacheState) {
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  const now = Date.now();
  if (!force && cacheState.value && cacheState.expiresAt > now) {
    res.json({ ...cacheState.value, cached: true });
    return;
  }
  try {
    const deps = buildCheckDeps(cfg);
    const results = await runAllChecks(deps);
    const body = { generated_at: new Date().toISOString(),
      checks: results, cached: false };
    cacheState.value = body;
    cacheState.expiresAt = now + cfg.cacheTtlMs;
    res.json(body);
  } catch (err) {
    res.status(HTTP_INTERNAL).json({ error: 'diagnostics_failed',
      message: String(err && err.message || err) });
  }
}

/**
 * Express handler for GET /api/diagnostics/bundle. Always re-runs the
 * checks (no cache) so the bundle is a snapshot of "right now".
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} cfg
 */
async function handleGetBundle(req, res, cfg) {
  try {
    const deps = buildCheckDeps(cfg);
    const results = await runAllChecks(deps);
    await streamBundle(res, deps, results);
  } catch (err) {
    if (!res.headersSent) {
      res.status(HTTP_INTERNAL).json({ error: 'bundle_failed',
        message: String(err && err.message || err) });
    }
  }
}

// ------------------------------------------------------------------
// AGGREGATOR
// ------------------------------------------------------------------

/**
 * Run every check in parallel. Each check is wrapped so an unexpected
 * throw never breaks the whole response -- worst case is a single ERR
 * card with the exception message.
 *
 * @param {object} deps
 * @returns {Promise<object[]>}
 */
async function runAllChecks(deps) {
  return Promise.all(
    CHECK_RUNNERS.map(([id, fn]) => safeRun(id, () => fn(deps))));
}

/**
 * Wrap a check so an exception turns into an ERR card instead of a
 * 500 response.
 *
 * @param {string} id
 * @param {function} fn
 * @returns {Promise<object>}
 */
async function safeRun(id, fn) {
  try { return await fn(); }
  catch (err) {
    return buildResult({ id, title: id, status: STATUS_ERR,
      summary: 'Check threw an unexpected error',
      detail: { error: String(err && err.message || err) } });
  }
}

/**
 * Read profile + config once and bundle them with the static cfg into
 * the deps object every check receives. Failures here are swallowed
 * because checkProfileConfig surfaces them with a friendly message.
 *
 * @param {object} cfg
 * @returns {object}
 */
function buildCheckDeps(cfg) {
  let profile = null;
  let config = null;
  try { profile = readJsonOrNull(path.join(cfg.dataDir, PROFILE_FILE)); }
  catch (_e) { /* surfaced by checkProfileConfig */ }
  try { config = readJsonOrNull(path.join(cfg.dataDir, CONFIG_FILE)); }
  catch (_e) { /* surfaced by checkProfileConfig */ }
  return { ...cfg, profile, config };
}

module.exports = {
  createDiagnosticsRouter,
  // Exported for unit tests:
  _internals: {
    buildConfig, buildCheckDeps, runAllChecks, safeRun,
    handleGetDiagnostics, handleGetBundle,
    CHECK_RUNNERS,
  },
};
