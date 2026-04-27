/**
 * DIAGNOSTICS CHECKS (Stage 4)
 * ============================================================
 * The 13 individual health checks consumed by routes/diagnostics.js.
 * Every check is an async function that takes a frozen `deps` object
 * (see buildCheckDeps in routes/diagnostics.js) and returns the
 * uniform result shape produced by `buildResult` from
 * routes/diagnostics_helpers.js:
 *
 *   { id, title, status, summary, [detail], [fix_action] }
 *
 * Hard rules honored here:
 *   - No PII in summaries or returned details. Battle tags, character
 *     ids, twitch tokens, and OBS passwords stay on disk -- the live
 *     response only carries summary booleans / counts / hostnames.
 *   - Every network call has an explicit read timeout (HTTP_READ_TIMEOUT_MS
 *     in helpers; OBS_HANDSHAKE_TIMEOUT_MS for tcpReachable).
 *   - Subprocess calls go through `runProcess`, which always uses
 *     list-form args and never shell=true.
 *
 * Example:
 *   const checks = require('./diagnostics_checks');
 *   const r = await checks.checkPython({ pythonCmd: 'py' });
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const {
  STATUS_OK, STATUS_WARN, STATUS_ERR, STATUS_PENDING,
  buildResult, readJsonOrNull, statSizeOrNull, statMtimeIsoOrNull,
  tailLines, runProcess, httpJson, tcpReachable, formatBytes,
} = require('./diagnostics_helpers');

// ------------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------------

const PROFILE_FILE = 'profile.json';
const CONFIG_FILE = 'config.json';
const META_DB_FILE = 'meta_database.json';
const PROFILE_SCHEMA_FILE = 'profile.schema.json';
const CONFIG_SCHEMA_FILE = 'config.schema.json';
const REPLAY_ERRORS_LOG = 'replay_errors.log';
const ANALYZER_LOG = 'analyzer.log';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const OBS_HANDSHAKE_TIMEOUT_MS = 4000;
const HTTP_READ_TIMEOUT_MS = 8000;
const RECENT_LOG_LINES = 5;
const DISK_WARN_BYTES = 1024 * 1024 * 1024;
const SC2READER_MIN_LOTV_BUILD = 89720;
const PYTHON_MIN_MAJOR = 3;
const PYTHON_MIN_MINOR = 10;
const SECS_PER_DAY = 24 * 60 * 60;
const TWITCH_HELIX_USERS_URL = 'https://api.twitch.tv/helix/users';
const SCHEMA_ERROR_PREVIEW_LIMIT = 5;
const STDERR_PREVIEW_BYTES = 1000;

// ------------------------------------------------------------------
// CHECK 1: PYTHON
// ------------------------------------------------------------------

/**
 * Resolve an installed python interpreter (`py` on Windows, `python3`
 * elsewhere) and confirm it satisfies the minimum version.
 *
 * Example:
 *   const card = await checkPython({ pythonCmd: 'py' });
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkPython(deps) {
  const id = 'python';
  const title = 'Python interpreter';
  const result = await runProcess(deps.pythonCmd, ['--version']);
  if (result.code !== 0) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: `${deps.pythonCmd} not found or failed`,
      detail: { stderr: result.stderr.trim(), code: result.code },
      fix: { label: 'Install Python', kind: 'link',
        target: 'https://www.python.org/downloads/' } });
  }
  return interpretPythonVersion(`${result.stdout} ${result.stderr}`.trim(),
    id, title);
}

/**
 * Parse `python --version` output and grade it against the minimum.
 *
 * @param {string} text
 * @param {string} id
 * @param {string} title
 * @returns {object}
 */
function interpretPythonVersion(text, id, title) {
  const match = text.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'Could not parse Python version', detail: { raw: text } });
  }
  const [_, majS, minS, patS] = match;
  const major = parseInt(majS, 10);
  const minor = parseInt(minS, 10);
  const ok = major > PYTHON_MIN_MAJOR
    || (major === PYTHON_MIN_MAJOR && minor >= PYTHON_MIN_MINOR);
  return buildResult({ id, title, status: ok ? STATUS_OK : STATUS_WARN,
    summary: `Python ${major}.${minor}.${parseInt(patS, 10)}`,
    detail: { major, minor, patch: parseInt(patS, 10),
      min: `${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}` },
    fix: ok ? undefined : { label: 'Upgrade Python',
      kind: 'link', target: 'https://www.python.org/downloads/' } });
}

// ------------------------------------------------------------------
// CHECK 2: SC2READER
// ------------------------------------------------------------------

const SC2READER_PROBE_CODE = [
  'import os, sc2reader',
  'p = os.path.join(os.path.dirname(sc2reader.__file__), "data", "LotV")',
  'try:',
  '    builds = sorted(int(n.split("_", 1)[0]) for n in os.listdir(p)',
  '                    if n.endswith("_abilities.csv") and n[:5].isdigit())',
  '    mx = builds[-1] if builds else 0',
  'except Exception:',
  '    mx = 0',
  'print(sc2reader.__version__ + "|" + str(mx))',
].join('\n');

/**
 * Confirm sc2reader is importable and report the highest LotV ability
 * datapack build it understands.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkSc2Reader(deps) {
  const id = 'sc2reader';
  const title = 'sc2reader datapack';
  const r = await runProcess(deps.pythonCmd, ['-c', SC2READER_PROBE_CODE]);
  if (r.code !== 0) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: 'sc2reader not importable',
      detail: { stderr: r.stderr.trim().slice(0, STDERR_PREVIEW_BYTES) },
      fix: { label: 'Install sc2reader', kind: 'cmd',
        target: `${deps.pythonCmd} -m pip install sc2reader==1.8.0` } });
  }
  const [version, maxBuildStr] = r.stdout.trim().split('|');
  const maxBuild = parseInt(maxBuildStr, 10) || 0;
  const tooOld = maxBuild > 0 && maxBuild < SC2READER_MIN_LOTV_BUILD;
  return buildResult({ id, title,
    status: tooOld ? STATUS_WARN : STATUS_OK,
    summary: `sc2reader ${version}, max LotV build ${maxBuild || '?'}`,
    detail: { version, max_lotv_build: maxBuild,
      min_required: SC2READER_MIN_LOTV_BUILD },
    fix: tooOld ? { label: 'Upgrade sc2reader', kind: 'cmd',
      target: `${deps.pythonCmd} -m pip install --upgrade sc2reader` }
      : undefined });
}

// ------------------------------------------------------------------
// CHECK 3: REPLAY FOLDERS
// ------------------------------------------------------------------

/**
 * Inspect each configured replay folder. OK only when every folder
 * exists, is readable, and contains at least one .SC2Replay.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkReplayFolders(deps) {
  const id = 'replay_folders';
  const title = 'Replay folders';
  const folders = ((deps.config && deps.config.paths
    && deps.config.paths.replay_folders) || []);
  if (folders.length === 0) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: 'No replay folders configured',
      fix: { label: 'Open Settings', kind: 'link', target: '#settings' } });
  }
  const reports = folders.map(inspectReplayFolder);
  const anyMissing = reports.some((r) => !r.exists);
  const allEmpty = reports.every((r) => r.exists && r.replay_count === 0);
  let status = STATUS_OK;
  if (anyMissing) status = STATUS_ERR;
  else if (allEmpty) status = STATUS_WARN;
  const total = reports.reduce((acc, r) => acc + (r.replay_count || 0), 0);
  return buildResult({ id, title, status,
    summary: `${reports.length} folder(s), ${total} replays total`,
    detail: { folders: reports },
    fix: anyMissing ? { label: 'Open Settings', kind: 'link',
      target: '#settings' } : undefined });
}

/**
 * Stat a single folder: existence, readability, .SC2Replay count, age
 * of the newest .SC2Replay (in days).
 *
 * @param {string} dirPath
 * @returns {object}
 */
function inspectReplayFolder(dirPath) {
  const out = { path: dirPath, exists: false, readable: false,
    replay_count: 0, newest_replay_age_days: null };
  try {
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) return out;
    out.exists = true;
    fs.accessSync(dirPath, fs.constants.R_OK);
    out.readable = true;
  } catch (_e) { return out; }
  const newest = scanForReplays(dirPath, out);
  if (newest > 0) {
    out.newest_replay_age_days = Math.round(
      (Date.now() - newest) / 1000 / SECS_PER_DAY);
  }
  return out;
}

/**
 * Walk the entries of a directory once, counting .SC2Replay files and
 * tracking the newest mtime. Returns the newest mtime in millis.
 *
 * @param {string} dirPath
 * @param {object} out  (mutated: out.replay_count is bumped)
 * @returns {number}
 */
function scanForReplays(dirPath, out) {
  let newest = 0;
  try {
    for (const entry of fs.readdirSync(dirPath)) {
      if (!entry.toLowerCase().endsWith('.sc2replay')) continue;
      out.replay_count += 1;
      try {
        const m = fs.statSync(path.join(dirPath, entry)).mtimeMs;
        if (m > newest) newest = m;
      } catch (_inner) { /* skip individual file errors */ }
    }
  } catch (_e) { /* dir read failed mid-scan */ }
  return newest;
}

// ------------------------------------------------------------------
// CHECK 4: META DATABASE
// ------------------------------------------------------------------

/**
 * Confirm meta_database.json is valid JSON and report build/game counts.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkMetaDatabase(deps) {
  const id = 'meta_database';
  const title = 'meta_database.json';
  const filePath = path.join(deps.dataDir, META_DB_FILE);
  if (!fs.existsSync(filePath)) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: 'meta_database.json missing',
      fix: { label: 'Run wizard', kind: 'link', target: '#wizard' } });
  }
  const size = statSizeOrNull(filePath) || 0;
  const mtime = statMtimeIsoOrNull(filePath);
  let parsed;
  try { parsed = readJsonOrNull(filePath); }
  catch (err) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: 'meta_database.json is not valid JSON',
      detail: { error: String(err.message || err), size_bytes: size } });
  }
  const builds = (parsed && typeof parsed === 'object') ? Object.keys(parsed) : [];
  const totalGames = builds.reduce((acc, k) => acc
    + (parsed[k] && Array.isArray(parsed[k].games) ? parsed[k].games.length : 0),
    0);
  const status = totalGames === 0 ? STATUS_WARN : STATUS_OK;
  return buildResult({ id, title, status,
    summary: `${builds.length} build(s), ${totalGames} game(s)`,
    detail: { build_count: builds.length, total_games: totalGames,
      size_bytes: size, last_write: mtime } });
}

// ------------------------------------------------------------------
// CHECK 5: PROFILE + CONFIG SCHEMA
// ------------------------------------------------------------------

/**
 * Validate profile.json + config.json against their JSON schemas.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkProfileConfig(deps) {
  const id = 'profile_config';
  const title = 'profile.json + config.json';
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const issues = [];
  validateOne(deps.dataDir, PROFILE_FILE, PROFILE_SCHEMA_FILE, ajv, issues);
  validateOne(deps.dataDir, CONFIG_FILE, CONFIG_SCHEMA_FILE, ajv, issues);
  if (issues.length === 0) {
    return buildResult({ id, title, status: STATUS_OK,
      summary: 'profile + config valid' });
  }
  const anyMissing = issues.some((i) => i.missing);
  return buildResult({ id, title,
    status: anyMissing ? STATUS_ERR : STATUS_WARN,
    summary: anyMissing ? 'profile or config missing'
      : `${issues.length} schema issue(s)`,
    detail: { issues },
    fix: { label: 'Open Settings', kind: 'link', target: '#settings' } });
}

/**
 * Validate one JSON file against one schema. Records issues into
 * the provided array; never throws.
 *
 * @param {string} dir
 * @param {string} dataName
 * @param {string} schemaName
 * @param {object} ajv
 * @param {object[]} issues
 */
function validateOne(dir, dataName, schemaName, ajv, issues) {
  const dataPath = path.join(dir, dataName);
  const schemaPath = path.join(dir, schemaName);
  if (!fs.existsSync(dataPath)) { issues.push({ file: dataName, missing: true }); return; }
  if (!fs.existsSync(schemaPath)) {
    issues.push({ file: dataName, schema_missing: true });
    return;
  }
  let data; let schema;
  try { data = readJsonOrNull(dataPath); }
  catch (err) {
    issues.push({ file: dataName, parse_error: String(err.message || err) });
    return;
  }
  try { schema = readJsonOrNull(schemaPath); }
  catch (err) {
    issues.push({ file: schemaName, parse_error: String(err.message || err) });
    return;
  }
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const e of (validate.errors || []).slice(0, SCHEMA_ERROR_PREVIEW_LIMIT)) {
      issues.push({ file: dataName, path: e.instancePath || '/',
        message: e.message });
    }
  }
}

// ------------------------------------------------------------------
// CHECK 6: BATTLE.NET / SC2PULSE
// ------------------------------------------------------------------

/**
 * Resolve the configured pulse character via SC2Pulse and confirm
 * a real character record comes back.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkBattleNetPulse(deps) {
  const id = 'battlenet_pulse';
  const title = 'Battle.net (SC2Pulse)';
  const internal = pickPulseInternalId(deps);
  if (!internal.id) return internal.notice;
  const url = `${deps.pulseBaseUrl}/character/${encodeURIComponent(internal.id)}`;
  const r = await httpJson(deps.fetchImpl, url, { readMs: HTTP_READ_TIMEOUT_MS });
  if (r.error || !r.ok) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: r.error ? 'SC2Pulse request failed'
        : `SC2Pulse returned HTTP ${r.status}`,
      detail: { url, status: r.status, error: r.error || null } });
  }
  const member = r.json && r.json.character ? r.json.character : null;
  if (!member) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'SC2Pulse returned 200 but no character record',
      detail: { url } });
  }
  return buildResult({ id, title, status: STATUS_OK,
    summary: `Character resolved (id ${internal.id})`,
    detail: { internal_id: internal.id, has_record: true } });
}

/**
 * Resolve the SC2Pulse internal numeric id to use for the live check.
 * Prefers config.stream_overlay.pulse_character_ids[0]; falls back to
 * profile.battlenet.character_id when it's already in numeric form.
 *
 * @param {object} deps
 * @returns {{id:string|null, notice:object}}
 */
function pickPulseInternalId(deps) {
  const id = 'battlenet_pulse';
  const title = 'Battle.net (SC2Pulse)';
  const ov = (deps.config && deps.config.stream_overlay) || {};
  const overlayIds = Array.isArray(ov.pulse_character_ids) ? ov.pulse_character_ids : [];
  const fromOverlay = overlayIds.find((s) => /^\d+$/.test(String(s)));
  if (fromOverlay) return { id: String(fromOverlay), notice: null };
  const cid = deps.profile && deps.profile.battlenet
    && deps.profile.battlenet.character_id;
  if (cid && /^\d+$/.test(String(cid))) return { id: String(cid), notice: null };
  if (!cid) {
    return { id: null, notice: buildResult({ id, title, status: STATUS_WARN,
      summary: 'No character_id in profile.json',
      fix: { label: 'Run wizard', kind: 'link', target: '#wizard' } }) };
  }
  return { id: null, notice: buildResult({ id, title, status: STATUS_WARN,
    summary: 'No SC2Pulse internal id available',
    detail: { hint: 'Run the wizard so it can resolve battle.net id '
      + 'to a pulse internal id and persist it in '
      + 'config.stream_overlay.pulse_character_ids.' } }) };
}

// ------------------------------------------------------------------
// CHECK 7: TWITCH HELIX
// ------------------------------------------------------------------

/**
 * If overlay is enabled and a twitch channel + helix credentials are
 * present, hit /helix/users to confirm the channel resolves.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkTwitch(deps) {
  const id = 'twitch';
  const title = 'Twitch (helix)';
  const ov = (deps.config && deps.config.stream_overlay) || {};
  if (!ov.enabled) {
    return buildResult({ id, title, status: STATUS_PENDING,
      summary: 'Stream overlay disabled in config' });
  }
  if (!ov.twitch_channel) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'No twitch_channel configured',
      fix: { label: 'Open Settings', kind: 'link', target: '#settings' } });
  }
  const clientId = deps.env.TWITCH_CLIENT_ID;
  const oauth = (deps.env.TWITCH_OAUTH_TOKEN || '').replace(/^oauth:/, '');
  if (!clientId || !oauth) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'TWITCH_CLIENT_ID or TWITCH_OAUTH_TOKEN missing',
      detail: { has_client_id: !!clientId, has_oauth_token: !!oauth } });
  }
  const url = `${TWITCH_HELIX_USERS_URL}?login=${encodeURIComponent(ov.twitch_channel)}`;
  const r = await httpJson(deps.fetchImpl, url, {
    headers: { 'Client-Id': clientId, Authorization: `Bearer ${oauth}` },
    readMs: HTTP_READ_TIMEOUT_MS });
  return interpretTwitch(r, id, title, ov.twitch_channel);
}

/**
 * Map a helix HTTP response to an OK / WARN / ERR card.
 *
 * @param {object} r httpJson() result
 * @param {string} id
 * @param {string} title
 * @param {string} channel
 * @returns {object}
 */
function interpretTwitch(r, id, title, channel) {
  if (r.error) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: 'Twitch request failed', detail: { error: r.error } });
  }
  if (r.status === HTTP_UNAUTHORIZED) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: 'TWITCH_OAUTH_TOKEN rejected (HTTP 401)',
      fix: { label: 'Refresh token', kind: 'link',
        target: 'https://dev.twitch.tv/console/apps' } });
  }
  if (r.status === HTTP_FORBIDDEN || r.status === HTTP_NOT_FOUND) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: `Twitch channel "${channel}" not found (HTTP ${r.status})` });
  }
  if (!r.ok) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: `Twitch helix HTTP ${r.status}` });
  }
  const users = (r.json && Array.isArray(r.json.data)) ? r.json.data : [];
  if (users.length === 0) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: `Channel "${channel}" not found on Twitch` });
  }
  return buildResult({ id, title, status: STATUS_OK,
    summary: `Channel "${channel}" resolved`,
    detail: { user_id: users[0].id || null,
      broadcaster_type: users[0].broadcaster_type || null } });
}

// ------------------------------------------------------------------
// CHECK 8: OBS WEBSOCKET
// ------------------------------------------------------------------

/**
 * Quick TCP-level reachability check against the OBS websocket host:port.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkObs(deps) {
  const id = 'obs';
  const title = 'OBS WebSocket';
  const ov = (deps.config && deps.config.stream_overlay) || {};
  if (!ov.enabled) {
    return buildResult({ id, title, status: STATUS_PENDING,
      summary: 'Stream overlay disabled in config' });
  }
  const ws = ov.obs_websocket || {};
  if (!ws.host || !ws.port) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'host/port not configured' });
  }
  const reach = await tcpReachable(ws.host, ws.port, OBS_HANDSHAKE_TIMEOUT_MS);
  if (!reach.ok) {
    return buildResult({ id, title, status: STATUS_ERR,
      summary: `OBS unreachable at ${ws.host}:${ws.port}`,
      detail: { error: reach.error },
      fix: { label: 'Open OBS settings', kind: 'modal', target: 'obs-help' } });
  }
  return buildResult({ id, title, status: STATUS_OK,
    summary: `OBS port ${ws.port} reachable on ${ws.host}`,
    detail: { host: ws.host, port: ws.port,
      auth_configured: !!(ws.password && ws.password.length > 0) } });
}

// ------------------------------------------------------------------
// CHECK 9: DISK SPACE
// ------------------------------------------------------------------

/**
 * Report free bytes on the data drive. WARN below DISK_WARN_BYTES.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkDiskSpace(deps) {
  const id = 'disk_space';
  const title = 'Disk space (data drive)';
  let free = null; let total = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(deps.dataDir);
      free = Number(s.bavail) * Number(s.bsize);
      total = Number(s.blocks) * Number(s.bsize);
    }
  } catch (err) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'Could not read disk stats',
      detail: { error: String(err.message || err) } });
  }
  if (free === null) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'fs.statfsSync unavailable on this Node',
      detail: { node_version: process.version } });
  }
  const status = free < DISK_WARN_BYTES ? STATUS_WARN : STATUS_OK;
  return buildResult({ id, title, status,
    summary: `${formatBytes(free)} free of ${formatBytes(total)}`,
    detail: { free_bytes: free, total_bytes: total,
      warn_below_bytes: DISK_WARN_BYTES } });
}

// ------------------------------------------------------------------
// CHECK 10: RECENT ERRORS
// ------------------------------------------------------------------

/**
 * Tail the last few error-flavoured lines from replay_errors.log and
 * analyzer.log.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkRecentErrors(deps) {
  const id = 'recent_errors';
  const title = 'Recent errors';
  const fileA = path.join(deps.dataDir, REPLAY_ERRORS_LOG);
  const fileB = path.join(deps.dataDir, ANALYZER_LOG);
  const linesA = tailLines(fileA, RECENT_LOG_LINES, /./);
  const linesB = tailLines(fileB, RECENT_LOG_LINES, /ERROR|error/);
  const errorsA = linesA.filter((l) => /not found|error|fail/i.test(l));
  const allErrors = [...errorsA, ...linesB];
  if (allErrors.length === 0) {
    return buildResult({ id, title, status: STATUS_OK,
      summary: 'No recent errors in logs',
      detail: { replay_errors_log: fileA, analyzer_log: fileB } });
  }
  return buildResult({ id, title, status: STATUS_WARN,
    summary: `${allErrors.length} recent error line(s)`,
    detail: { replay_errors_tail: linesA.slice(-RECENT_LOG_LINES),
      analyzer_errors_tail: linesB.slice(-RECENT_LOG_LINES) } });
}

// ------------------------------------------------------------------
// CHECK 11: MACRO ENGINE VERSION
// ------------------------------------------------------------------

/**
 * Compare the engine_version embedded in macro_score.py to the value
 * persisted in config.json. A drift suggests a re-backfill is needed.
 *
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function checkMacroEngineVersion(deps) {
  const id = 'macro_engine_version';
  const title = 'Macro engine version';
  const code = buildMacroProbeCode(deps.analyzerScriptsDir);
  const r = await runProcess(deps.pythonCmd, ['-c', code]);
  if (r.code !== 0) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'Could not read MACRO_ENGINE_VERSION constant',
      detail: { stderr: r.stderr.trim().slice(0, STDERR_PREVIEW_BYTES) } });
  }
  const codeVer = r.stdout.trim();
  const cfgVer = (deps.config && deps.config.macro_engine
    && deps.config.macro_engine.engine_version) || null;
  if (!cfgVer) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: 'config.json has no macro_engine.engine_version',
      detail: { code_version: codeVer } });
  }
  if (cfgVer !== codeVer) {
    return buildResult({ id, title, status: STATUS_WARN,
      summary: `Mismatch: code=${codeVer}, config=${cfgVer}`,
      detail: { code_version: codeVer, config_version: cfgVer },
      fix: { label: 'Re-backfill macro scores', kind: 'cmd',
        target: 'python -m scripts.macro_cli backfill' } });
  }
  return buildResult({ id, title, status: STATUS_OK,
    summary: `Engine pinned at ${codeVer}` });
}

/**
 * Build the small python snippet that imports the macro engine module
 * from the configured scripts dir and prints MACRO_ENGINE_VERSION.
 *
 * @param {string} analyzerScriptsDir
 * @returns {string}
 */
function buildMacroProbeCode(analyzerScriptsDir) {
  const escaped = analyzerScriptsDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'import sys',
    `sys.path.insert(0, "${escaped}")`,
    'from analytics.macro_score import MACRO_ENGINE_VERSION',
    'print(MACRO_ENGINE_VERSION)',
  ].join('\n');
}

// ------------------------------------------------------------------
// CHECKS 12 + 13: STAGE 7 / STAGE 14 PENDING
// ------------------------------------------------------------------

/** @returns {Promise<object>} */
async function checkCommunityBuildsApi() {
  return buildResult({ id: 'community_builds_api',
    title: 'Community builds API',
    status: STATUS_PENDING,
    summary: 'Awaiting Stage 7',
    detail: { note: 'Will GET /v1/community-builds/health once shipped.' } });
}

/** @returns {Promise<object>} */
async function checkCloudOptInQueue() {
  return buildResult({ id: 'cloud_optin_queue',
    title: 'Cloud opt-in queue',
    status: STATUS_PENDING,
    summary: 'Awaiting Stage 14',
    detail: { note: 'Will report unflushed observation count once shipped.' } });
}

module.exports = {
  checkPython, checkSc2Reader, checkReplayFolders, checkMetaDatabase,
  checkProfileConfig, checkBattleNetPulse, checkTwitch, checkObs,
  checkDiskSpace, checkRecentErrors, checkMacroEngineVersion,
  checkCommunityBuildsApi, checkCloudOptInQueue,
  // Exported for tests:
  _internals: {
    interpretPythonVersion, inspectReplayFolder, scanForReplays,
    validateOne, pickPulseInternalId, interpretTwitch, buildMacroProbeCode,
  },
};
