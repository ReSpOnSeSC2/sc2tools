// @ts-check
/**
 * STARTUP DOCTOR / DIAGNOSTICS ROUTER
 * ============================================================
 * Friend's-install fix: the SPA was rendering a generic "No data"
 * empty state on a fresh install with no way for the user to tell
 * whether (a) the python launcher wasn't installed, (b) the macro
 * CLI was stale, (c) the data files were unreadable, or (d) they
 * really had zero replays. The doctor router runs all of those
 * checks server-side and returns a structured payload the SPA
 * banner (components/doctor-banner.jsx) renders with one row per
 * failure plus a Fix button.
 *
 * ENDPOINTS
 * ---------
 *   GET /api/doctor/check
 *       -> { ok, generated_at, checks: [...] }
 *       Cached 60s in-process. Pass ?refresh=1 to force a re-probe
 *       (also clears the cli-probe cache so a stale macro_cli /
 *       apm_cli is re-checked).
 *
 *   POST /api/doctor/cache/clear
 *       -> { ok: true }
 *       Clears the in-memory cache. Used by the SPA banner after
 *       the user dismisses + we want to re-evaluate after a fix.
 *
 * CHECK SHAPE
 * -----------
 *   { id, title, status: 'ok'|'warn'|'err', summary, fix?: { kind, target } }
 *
 *   fix.kind values:
 *     - 'rerun_launcher'  -> banner shows copy-to-clipboard hint
 *     - 'open_wizard'     -> banner dispatches sc2:open-wizard event
 *     - 'open_settings'   -> banner navigates to settings tab
 *
 * Engineering preamble compliance:
 *   - Functions <= 30 lines, complexity <= 10.
 *   - Each check is a self-contained async function.
 *   - Errors are caught at the per-check boundary; one bad probe
 *     never tanks the whole report.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { spawn } = require('child_process');
const { probeCli, clearCliProbeCache } = require('../lib/cli-probe');

const REPORT_TTL_MS = 60_000;
const PY_VERSION_TIMEOUT_MS = 3_000;
const NODE_MIN_MAJOR = 18;
const PY_MIN_MAJOR = 3;
const PY_MIN_MINOR = 10;
const PROBE_FILE = '.doctor-write-probe';

let cachedReport = null;

function pickPythonExe() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return process.platform === 'win32' ? 'py' : 'python3';
}

function ok(id, title, summary, extra) {
  return Object.assign({ id, title, status: 'ok', summary }, extra || {});
}
function warn(id, title, summary, fix) {
  return { id, title, status: 'warn', summary, ...(fix ? { fix } : {}) };
}
function err(id, title, summary, fix) {
  return { id, title, status: 'err', summary, ...(fix ? { fix } : {}) };
}

// --- individual checks --------------------------------------------------

function checkNodeRuntime() {
  const major = Number((process.version || 'v0').slice(1).split('.')[0]);
  if (Number.isFinite(major) && major >= NODE_MIN_MAJOR) {
    return ok('node_runtime', 'Node.js runtime',
      `Running on Node ${process.version}.`);
  }
  return err('node_runtime', 'Node.js runtime',
    `Node ${process.version} is below the supported minimum (v${NODE_MIN_MAJOR}+).`,
    { kind: 'rerun_launcher', target: 'START_SC2_TOOLS.bat' });
}

function spawnPyVersion(pythonExe) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(pythonExe, ['--version'], { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stderr: String(e && e.message || e) });
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      resolve({ code: -2, stderr: 'timeout' });
    }, PY_VERSION_TIMEOUT_MS);
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', () => { clearTimeout(timer); resolve({ code: -3, stderr }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function checkPythonPresent(pythonExe) {
  const r = await spawnPyVersion(pythonExe);
  if (r.code !== 0) {
    return err('python_present', 'Python launcher',
      `'${pythonExe}' is not on PATH or returned exit ${r.code}.`,
      { kind: 'rerun_launcher', target: 'START_SC2_TOOLS.bat' });
  }
  const text = (r.stdout || r.stderr || '').trim();
  const m = text.match(/Python (\d+)\.(\d+)/);
  if (!m) {
    return warn('python_present', 'Python launcher',
      `Python detected but version unparseable: "${text}".`);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < PY_MIN_MAJOR || (major === PY_MIN_MAJOR && minor < PY_MIN_MINOR)) {
    return warn('python_present', 'Python launcher',
      `Python ${major}.${minor} detected; ${PY_MIN_MAJOR}.${PY_MIN_MINOR}+ recommended.`);
  }
  return ok('python_present', 'Python launcher', `Detected ${text}.`);
}

async function checkCliSubcommands(opts) {
  const { id, title, cliName, required, projectDir, pythonExe } = opts;
  let result;
  try {
    result = await probeCli({ pythonExe, projectDir, cliName, required });
  } catch (e) {
    return err(id, title,
      `Probe failed: ${(e && e.message) || e}`,
      { kind: 'rerun_launcher', target: 'START_SC2_TOOLS.bat' });
  }
  if (result.ok) {
    return ok(id, title, `${cliName}.py supports [${required.join(', ')}].`);
  }
  return err(id, title,
    `${cliName}.py is missing subcommand(s) [${result.missing.join(', ')}]. Your install is out of date.`,
    { kind: 'rerun_launcher', target: 'START_SC2_TOOLS.bat' });
}

function checkDataFilesWritable(dataDir) {
  if (!fs.existsSync(dataDir)) {
    return err('data_files_writable', 'Data directory',
      `${dataDir} does not exist.`,
      { kind: 'rerun_launcher', target: 'START_SC2_TOOLS.bat' });
  }
  const probePath = path.join(dataDir, PROBE_FILE);
  try {
    fs.writeFileSync(probePath, String(Date.now()));
  } catch (e) {
    return err('data_files_writable', 'Data directory',
      `Cannot write to ${dataDir}: ${(e && e.message) || e}.`);
  } finally {
    try { fs.unlinkSync(probePath); } catch (_) { /* probe file may not exist */ }
  }
  return ok('data_files_writable', 'Data directory',
    `Read/write access to ${dataDir} confirmed.`);
}

function checkConfigPresent(dataDir) {
  const cfg = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfg)) {
    return ok('config_present', 'Profile configuration',
      'config.json found.');
  }
  return warn('config_present', 'Profile configuration',
    'No config.json yet -- the first-run wizard sets up your character ID.',
    { kind: 'open_wizard', target: 'wizard' });
}

function checkReplayFolder(dataDir) {
  const profilePath = path.join(dataDir, 'profile.json');
  if (!fs.existsSync(profilePath)) {
    return warn('replay_folder', 'Replay folder',
      'profile.json not yet saved; replay folder unknown.',
      { kind: 'open_wizard', target: 'wizard' });
  }
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8') || '{}');
  } catch (e) {
    return warn('replay_folder', 'Replay folder',
      `profile.json unreadable: ${(e && e.message) || e}.`,
      { kind: 'open_settings', target: 'profile' });
  }
  const folder = profile && profile.replay_folder;
  if (!folder) {
    return warn('replay_folder', 'Replay folder',
      'profile.json has no replay_folder set.',
      { kind: 'open_settings', target: 'profile' });
  }
  if (!fs.existsSync(folder)) {
    return warn('replay_folder', 'Replay folder',
      `Configured replay folder not found on disk: ${folder}.`,
      { kind: 'open_settings', target: 'profile' });
  }
  return ok('replay_folder', 'Replay folder', `Reachable at ${folder}.`);
}

// --- aggregator ---------------------------------------------------------

async function runAllChecks(ctx) {
  const { repoRoot, dataDir, pythonExe } = ctx;
  const results = [];
  results.push(checkNodeRuntime());
  results.push(await checkPythonPresent(pythonExe));
  results.push(await checkCliSubcommands({
    id: 'macro_cli_compute', title: 'macro_cli subcommands',
    cliName: 'macro_cli', required: ['backfill', 'compute'],
    projectDir: repoRoot, pythonExe,
  }));
  results.push(await checkCliSubcommands({
    id: 'apm_cli_compute', title: 'apm_cli subcommands',
    cliName: 'apm_cli', required: ['compute'],
    projectDir: repoRoot, pythonExe,
  }));
  results.push(checkDataFilesWritable(dataDir));
  results.push(checkConfigPresent(dataDir));
  results.push(checkReplayFolder(dataDir));
  return results;
}

function buildReport(checks) {
  const overall = checks.every((c) => c.status === 'ok');
  return {
    ok: overall,
    generated_at: new Date().toISOString(),
    checks,
  };
}

/**
 * Build the doctor router.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.dataDir
 * @param {string} [opts.pythonExe]
 */
function createDoctorRouter(opts) {
  const router = express.Router();
  const repoRoot = opts && opts.repoRoot;
  const dataDir = opts && opts.dataDir;
  const pythonExe = (opts && opts.pythonExe) || pickPythonExe();
  if (!repoRoot || !dataDir) {
    throw new Error('createDoctorRouter: repoRoot and dataDir required');
  }
  const ctx = { repoRoot, dataDir, pythonExe };

  router.get('/api/doctor/check', async (req, res) => {
    const refresh = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
    if (refresh) {
      cachedReport = null;
      clearCliProbeCache();
    }
    if (cachedReport && (Date.now() - cachedReport.t) < REPORT_TTL_MS) {
      return res.json(cachedReport.value);
    }
    try {
      const checks = await runAllChecks(ctx);
      const report = buildReport(checks);
      cachedReport = { t: Date.now(), value: report };
      res.json(report);
    } catch (e) {
      res.status(500).json({
        ok: false, error: `doctor failed: ${(e && e.message) || e}`,
      });
    }
  });

  router.post('/api/doctor/cache/clear', (_req, res) => {
    cachedReport = null;
    clearCliProbeCache();
    res.json({ ok: true });
  });

  return router;
}

/**
 * Run the checks once at startup and log warnings for any non-ok rows.
 * Doesn't fail startup; the SPA banner is the user surface. Useful so
 * the operator sees the same diagnosis the SPA will show.
 *
 * @param {object} ctx Same shape as createDoctorRouter opts.
 * @returns {Promise<{ok: boolean, checks: any[]}>}
 */
async function runStartupCheck(ctx) {
  const fullCtx = {
    repoRoot: ctx.repoRoot,
    dataDir: ctx.dataDir,
    pythonExe: ctx.pythonExe || pickPythonExe(),
  };
  const checks = await runAllChecks(fullCtx);
  const failures = checks.filter((c) => c.status !== 'ok');
  for (const c of failures) {
    const tag = c.status === 'err' ? '[doctor:err]' : '[doctor:warn]';
    console.warn(`${tag} ${c.id}: ${c.summary}`);
  }
  return { ok: failures.length === 0, checks };
}

module.exports = {
  createDoctorRouter,
  runStartupCheck,
  // exported for tests
  runAllChecks,
  buildReport,
};
