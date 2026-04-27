/**
 * ONBOARDING ROUTER (Stage 2.2)
 * ============================================================
 * Express sub-router that backs the first-run wizard rendered by
 * public/analyzer/index.html when GET /api/profile/exists returns
 * { exists: false }.
 *
 * Endpoints
 * ---------
 *   POST /api/onboarding/scan-replay-folders
 *       -> { ok, folders: [{ path, replay_count, source }] }
 *       Walks common SC2 replay folder locations on the host and
 *       counts .SC2Replay files. No Python needed -- this is a pure
 *       Node fs walk over a small known list of paths.
 *
 *   POST /api/onboarding/scan-identities
 *     body: { folder: string, sample_size?: number }
 *       -> { ok, scanned, skipped, players: [{ name, character_id,
 *                                              games_seen }] }
 *       Spawns reveal-sc2-opponent-main/scripts/identity_cli.py and
 *       returns its JSON output untouched.
 *
 *   POST /api/onboarding/test/twitch
 *     body: { channel?: string, oauth_token: string }
 *       -> { ok, login?: string, user_id?: string, error?: string }
 *       Round-trip against api.twitch.tv/helix/users with the supplied
 *       oauth token. The token is treated as a secret -- it is NEVER
 *       logged, and the caller's body is not echoed back.
 *
 *   POST /api/onboarding/test/obs
 *     body: { host: string, port: number, password?: string }
 *       -> { ok, version?: string, error?: string }
 *       Performs a real obs-websocket v5 handshake (Hello -> Identify
 *       -> Identified) over a short-lived ws connection. We use the
 *       already-installed `ws` package rather than adding obs-
 *       websocket-js as a new dep -- the auth handshake is just
 *       sha256(password + salt) -> sha256(secret + challenge).
 *
 *   POST /api/onboarding/test/pulse
 *     body: { character_id: string }
 *       -> { ok, name?, region?, league?, error? }
 *       Direct fetch against sc2pulse.nephest.com so the wizard
 *       confirms the user typed a real Pulse-known character id.
 *
 *   POST /api/onboarding/start-initial-backfill
 *       -> { ok, started: true } | { ok: false, error }
 *       Forwards to the analyzer router's POST /api/analyzer/macro/
 *       backfill/start in-process via a loopback HTTP request, so the
 *       wizard's final step can kick the existing backfill machinery
 *       without re-implementing it here.
 *
 * Atomicity
 * ---------
 * No data mutations live in this router; all writes go through the
 * existing /api/profile and /api/config PUT handlers in
 * routes/settings.js (which already do atomic write -> fsync ->
 * rename). The wizard's UI is responsible for hitting those after the
 * user clicks "Apply & start" in step 6.
 *
 * Logging policy
 * --------------
 * Per security rules: opponent names, battle tags, push tokens, refresh
 * tokens, oauth tokens, OBS passwords are NEVER logged. We log the
 * endpoint name + status code only, with one structured field for the
 * shape of the response (ok/false). If a downstream service errors we
 * log the error class but not the inputs.
 *
 * Example
 * -------
 *   const { createOnboardingRouter } = require('./routes/onboarding');
 *   app.use(createOnboardingRouter({
 *     scriptsDir: path.resolve(__dirname, '..', 'scripts'),
 *     pythonExe: pickPythonExe(),
 *     loopbackBase: () => `http://127.0.0.1:${PORT}`,
 *   }));
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// --------------------------------------------------------------
// CONSTANTS
// --------------------------------------------------------------

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UPSTREAM = 502;
const HTTP_INTERNAL = 500;

// Python helper budgets. The wizard is interactive; long waits are
// worse than partial results.
const IDENTITY_TIMEOUT_MS = 60_000;     // 60s ceiling for ~100 replays
const IDENTITY_DEFAULT_SAMPLE = 100;
const IDENTITY_MAX_SAMPLE = 1000;

// OBS handshake budget. A normally-running obs-websocket replies in
// <100ms over loopback; 5s is a generous "is it really there?" cap.
const OBS_HANDSHAKE_TIMEOUT_MS = 5_000;
const OBS_RPC_VERSION = 1;
const OBS_OPCODE_HELLO = 0;
const OBS_OPCODE_IDENTIFY = 1;
const OBS_OPCODE_IDENTIFIED = 2;

// External HTTP budgets. Twitch and Pulse are public services on the
// far side of the internet; 8s is generous for a single GET.
const HTTP_TIMEOUT_MS = 8_000;

const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';
const PULSE_API_ROOT = 'https://sc2pulse.nephest.com/sc2/api';

const REPLAY_EXT = '.SC2Replay';

// Common SC2 replay multiplayer folder shapes. Order matters for the
// wizard's "Recommended" badge: more-specific paths win.
const COMMON_FOLDER_SOURCES = [
  {
    label: 'OneDrive (current Windows layout)',
    glob: ['OneDrive', 'Pictures', 'Documents', 'StarCraft II',
           'Accounts', '*', '*', 'Replays', 'Multiplayer'],
    base: 'home',
  },
  {
    label: 'Documents (classic Windows layout)',
    glob: ['Documents', 'StarCraft II',
           'Accounts', '*', '*', 'Replays', 'Multiplayer'],
    base: 'home',
  },
  {
    label: 'Documents (Vista/older Windows)',
    glob: ['My Documents', 'StarCraft II',
           'Accounts', '*', '*', 'Replays', 'Multiplayer'],
    base: 'home',
  },
  {
    label: 'macOS Documents',
    glob: ['Library', 'Application Support', 'Blizzard', 'StarCraft II',
           'Accounts', '*', '*', 'Replays', 'Multiplayer'],
    base: 'home',
  },
  {
    label: 'Drive root',
    glob: ['StarCraft II', 'Replays'],
    base: 'C:\\',
  },
];

// --------------------------------------------------------------
// VALIDATORS
// --------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badBody(res, message) {
  return res.status(HTTP_BAD_REQUEST).json({ ok: false, error: message });
}

function asNonEmptyString(value) {
  return (typeof value === 'string' && value.trim().length > 0)
    ? value.trim() : null;
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// --------------------------------------------------------------
// REPLAY FOLDER SCAN (no Python required)
// --------------------------------------------------------------

/**
 * Expand a glob pattern made of literal segments and `*` wildcards
 * starting from ``base``. Returns absolute directory paths that
 * actually exist on disk. The wildcard depth is bounded by the
 * pattern length, so this is a small fixed walk -- never an
 * unbounded fs traversal.
 *
 * Example:
 *   expandGlob('/home/user', ['Documents', '*', 'Replays'])
 *
 * @param {string} base Absolute starting directory.
 * @param {Array<string>} segments Pattern parts. '*' = any one dir.
 * @returns {Array<string>} Existing absolute paths.
 */
function expandGlob(base, segments) {
  let frontier = [base];
  for (const segment of segments) {
    const next = [];
    for (const dir of frontier) {
      if (segment === '*') {
        for (const child of safeReaddir(dir)) {
          const full = path.join(dir, child);
          if (safeIsDir(full)) next.push(full);
        }
      } else {
        const full = path.join(dir, segment);
        if (safeIsDir(full)) next.push(full);
      }
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); }
  catch (_err) { return []; }
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); }
  catch (_err) { return false; }
}

function countReplays(dir) {
  try {
    const entries = fs.readdirSync(dir);
    let n = 0;
    for (const name of entries) {
      if (name.endsWith(REPLAY_EXT)) n += 1;
    }
    return n;
  } catch (_err) {
    return 0;
  }
}

function resolveBase(baseKey) {
  if (baseKey === 'home') return os.homedir();
  return baseKey;
}

function scanReplayFolders() {
  const seen = new Set();
  const found = [];
  for (const source of COMMON_FOLDER_SOURCES) {
    const base = resolveBase(source.base);
    if (!safeIsDir(base)) continue;
    for (const dir of expandGlob(base, source.glob)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const replayCount = countReplays(dir);
      if (replayCount === 0) continue;
      found.push({
        path: dir,
        replay_count: replayCount,
        source: source.label,
      });
    }
  }
  found.sort((a, b) => b.replay_count - a.replay_count);
  return found;
}

function handleScanReplayFolders() {
  return (_req, res) => {
    try {
      const folders = scanReplayFolders();
      console.log(`[onboarding] scan-replay-folders ok n=${folders.length}`);
      res.status(HTTP_OK).json({ ok: true, folders });
    } catch (err) {
      console.error('[onboarding] scan-replay-folders failed:',
                    err && err.message);
      res.status(HTTP_INTERNAL).json({ ok: false, error: 'scan_failed' });
    }
  };
}

// --------------------------------------------------------------
// IDENTITY SCAN (Python helper)
// --------------------------------------------------------------

/**
 * Spawn identity_cli.py on the user's selected folder(s). Captures all
 * stdout, parses the single JSON object emitted on success, and
 * propagates structured errors. Streaming/progress is not used --
 * the helper finishes under a minute on a typical sample.
 *
 * @param {object} ctx Router context.
 * @param {Array<string>} folders Absolute folder paths (1 or more).
 * @param {number} sampleSize 1..IDENTITY_MAX_SAMPLE shared across folders.
 * @returns {Promise<object>} Parsed payload from the helper.
 */
function runIdentityCli(ctx, folders, sampleSize) {
  return new Promise((resolve, reject) => {
    const script = path.join(ctx.scriptsDir, 'identity_cli.py');
    if (!fs.existsSync(script)) {
      return reject(new Error('identity_cli_missing'));
    }
    const args = [script, '--sample-size', String(sampleSize)];
    for (const folder of folders) {
      args.push('--folder', folder);
    }
    const proc = spawn(ctx.pythonExe, args, {
      cwd: ctx.repoRoot,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_e) { /* best-effort */ }
      reject(new Error('identity_timeout'));
    }, IDENTITY_TIMEOUT_MS);
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(killer);
      const parsed = parseIdentityOutput(stdout);
      if (parsed) return resolve(parsed);
      reject(new Error(stderr.trim() || `identity_exit_${code}`));
    });
  });
}

function parseIdentityOutput(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed.split('\n').pop());
  } catch (_err) {
    return null;
  }
}

function handleScanIdentities(ctx) {
  return async (req, res) => {
    if (!isPlainObject(req.body)) return badBody(res, 'invalid_body');
    const folders = normalizeFolderList(req.body);
    if (folders.length === 0) return badBody(res, 'folder_required');
    const sample = Math.min(IDENTITY_MAX_SAMPLE,
        asPositiveInt(req.body.sample_size, IDENTITY_DEFAULT_SAMPLE));
    try {
      const payload = await runIdentityCli(ctx, folders, sample);
      const ok = payload && payload.ok === true;
      const summary = ok
        ? `n=${(payload.players || []).length} folders=${folders.length}`
        : `err=${payload && payload.error}`;
      console.log(`[onboarding] scan-identities ${ok ? 'ok' : 'fail'} ${summary}`);
      res.status(HTTP_OK).json(payload);
    } catch (err) {
      console.error('[onboarding] scan-identities failed:', err.message);
      res.status(HTTP_INTERNAL).json({ ok: false, error: err.message });
    }
  };
}

/**
 * Accept either ``folders: string[]`` (new) or ``folder: string`` (back-
 * compat with the original single-folder shape) and return a deduped
 * array of non-empty strings. Empty strings and non-strings are dropped.
 *
 * @param {object} body Parsed request body (already validated as object).
 * @returns {Array<string>} Possibly-empty array of folder paths.
 */
function normalizeFolderList(body) {
  const out = [];
  const seen = new Set();
  const raw = Array.isArray(body.folders) ? body.folders : [];
  for (const f of raw) {
    const s = asNonEmptyString(f);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  const single = asNonEmptyString(body.folder);
  if (single && !seen.has(single)) { seen.add(single); out.push(single); }
  return out;
}

// --------------------------------------------------------------
// TWITCH TEST
// --------------------------------------------------------------

/**
 * Validate a Twitch OAuth token by hitting /helix/users with it.
 * The Twitch IDs exposed back to the wizard are non-secret and useful
 * for the user to sanity-check ("yes, that's my login"). The token
 * itself is never echoed.
 */
async function validateTwitchToken(token, channel, fetchFn) {
  const headers = {
    Authorization: `Bearer ${stripOAuthPrefix(token)}`,
  };
  const params = channel ? `?login=${encodeURIComponent(channel)}` : '';
  const res = await fetchWithTimeout(fetchFn,
      `${TWITCH_USERS_URL}${params}`, { headers });
  if (!res.ok) {
    return { ok: false, error: `twitch_status_${res.status}` };
  }
  const body = await res.json().catch(() => null);
  const user = body && Array.isArray(body.data) ? body.data[0] : null;
  if (!user) return { ok: false, error: 'twitch_no_user' };
  return { ok: true, login: user.login, user_id: user.id };
}

function stripOAuthPrefix(token) {
  const t = String(token || '').trim();
  return t.toLowerCase().startsWith('oauth:') ? t.slice('oauth:'.length) : t;
}

function handleTestTwitch(ctx) {
  return async (req, res) => {
    if (!isPlainObject(req.body)) return badBody(res, 'invalid_body');
    const token = asNonEmptyString(req.body.oauth_token);
    if (!token) return badBody(res, 'oauth_token_required');
    const channel = asNonEmptyString(req.body.channel);
    try {
      const out = await validateTwitchToken(token, channel, ctx.fetch);
      const status = out.ok ? HTTP_OK : HTTP_UPSTREAM;
      console.log(`[onboarding] test/twitch ${out.ok ? 'ok' : 'fail'}`);
      res.status(status).json(out);
    } catch (err) {
      console.error('[onboarding] test/twitch threw:', err.message);
      res.status(HTTP_UPSTREAM)
          .json({ ok: false, error: 'twitch_unreachable' });
    }
  };
}

// --------------------------------------------------------------
// OBS TEST (raw obs-websocket v5 handshake)
// --------------------------------------------------------------

/**
 * Run a one-shot obs-websocket v5 handshake and resolve with the
 * negotiated server version. Closes the socket as soon as we get
 * Identified back. Auth math per the OBS WS v5 protocol:
 *     secret = base64(sha256(password + salt))
 *     auth   = base64(sha256(secret + challenge))
 *
 * @param {string} host
 * @param {number} port
 * @param {string|null} password
 * @returns {Promise<object>}
 */
function obsHandshake(host, port, password) {
  return new Promise((resolve) => {
    const url = `ws://${host}:${port}`;
    let settled = false;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (_err) {
      return resolve({ ok: false, error: 'obs_connect_failed' });
    }
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (_e) { /* best-effort */ }
      resolve(payload);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'obs_timeout' }),
      OBS_HANDSHAKE_TIMEOUT_MS,
    );
    socket.on('error', () => finish({ ok: false, error: 'obs_connect_failed' }));
    socket.on('close', () => clearTimeout(timer));
    socket.on('message', (raw) => {
      handleObsMessage(socket, password, raw, finish);
    });
  });
}

function handleObsMessage(socket, password, raw, finish) {
  let msg;
  try { msg = JSON.parse(raw.toString('utf8')); }
  catch (_err) { return finish({ ok: false, error: 'obs_bad_message' }); }
  if (msg.op === OBS_OPCODE_HELLO) {
    sendObsIdentify(socket, password, msg.d || {}, finish);
    return;
  }
  if (msg.op === OBS_OPCODE_IDENTIFIED) {
    finish({ ok: true, version: (msg.d && msg.d.negotiatedRpcVersion) || 1 });
  }
}

function sendObsIdentify(socket, password, hello, finish) {
  const auth = hello.authentication;
  const payload = { rpcVersion: OBS_RPC_VERSION };
  if (auth && auth.challenge && auth.salt) {
    if (!password) {
      finish({ ok: false, error: 'obs_password_required' });
      return;
    }
    payload.authentication = computeObsAuth(password, auth.salt, auth.challenge);
  }
  socket.send(JSON.stringify({ op: OBS_OPCODE_IDENTIFY, d: payload }));
}

function computeObsAuth(password, salt, challenge) {
  const secret = crypto.createHash('sha256')
      .update(password + salt).digest('base64');
  return crypto.createHash('sha256')
      .update(secret + challenge).digest('base64');
}

function handleTestObs() {
  return async (req, res) => {
    if (!isPlainObject(req.body)) return badBody(res, 'invalid_body');
    const host = asNonEmptyString(req.body.host) || '127.0.0.1';
    const port = asPositiveInt(req.body.port, 0);
    if (!port) return badBody(res, 'port_required');
    const password = typeof req.body.password === 'string'
        ? req.body.password : null;
    const out = await obsHandshake(host, port, password);
    const status = out.ok ? HTTP_OK : HTTP_UPSTREAM;
    console.log(`[onboarding] test/obs ${out.ok ? 'ok' : 'fail'}`);
    res.status(status).json(out);
  };
}

// --------------------------------------------------------------
// PULSE TEST
// --------------------------------------------------------------

const PULSE_REGION_LABEL = { 1: 'us', 2: 'eu', 3: 'kr', 5: 'cn', 6: 'sea' };

/**
 * Search SC2Pulse for characters whose name matches ``term``. Returns
 * up to a small fixed page of normalized results so the wizard can
 * render a pickable list -- the user typically has 1-3 matches across
 * regions and just picks the right one.
 *
 * SC2Pulse's search endpoint returns a flat array of characters with
 * an inner ``character`` object plus league/rating metadata; we flatten
 * it to one row per character for the UI.
 *
 * @param {string} term Name to search for.
 * @param {Function} fetchFn fetch implementation.
 * @returns {Promise<{ok: boolean, matches?: Array, error?: string}>}
 */
async function searchPulseCharacters(term, fetchFn) {
  const q = encodeURIComponent(term);
  const url = `${PULSE_API_ROOT}/character/search?term=${q}`;
  const res = await fetchWithTimeout(fetchFn, url, {});
  if (!res.ok) return { ok: false, error: `pulse_status_${res.status}` };
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) return { ok: false, error: 'pulse_bad_payload' };
  const matches = body
    .map(normalizePulseSearchHit)
    .filter((m) => m !== null)
    .slice(0, PULSE_SEARCH_MAX_RESULTS);
  return { ok: true, matches };
}

const PULSE_SEARCH_MAX_RESULTS = 25;

/**
 * Flatten one SC2Pulse search hit into the shape the wizard renders.
 * Returns null if the hit is missing required fields.
 */
function normalizePulseSearchHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const ch = pickHitCharacter(hit);
  const cid = ch && (ch.id || ch.characterId);
  if (!cid) return null;
  const ratingMax = (hit.ratingMax != null) ? hit.ratingMax
                  : (hit.previousStats && hit.previousStats.ratingMax)
                  || (hit.currentStats && hit.currentStats.ratingMax)
                  || null;
  const totalGames = (hit.totalGamesPlayed != null) ? hit.totalGamesPlayed
                  : (hit.previousStats && hit.previousStats.gamesPlayed)
                  || (hit.currentStats && hit.currentStats.gamesPlayed)
                  || null;
  return {
    pulse_id: String(cid),
    name: stripDiscriminator(ch.name),
    region: normalizePulseRegion(ch.region),
    rating_max: ratingMax,
    games_played: totalGames,
    league_max: hit.leagueMax != null ? hit.leagueMax : null,
  };
}

function pickHitCharacter(hit) {
  if (hit.character) return hit.character;
  if (hit.members) {
    if (Array.isArray(hit.members) && hit.members.length > 0) {
      return hit.members[0].character || null;
    }
    if (typeof hit.members === 'object' && hit.members.character) {
      return hit.members.character;
    }
  }
  return hit;
}

function handleSearchPulse(ctx) {
  return async (req, res) => {
    if (!isPlainObject(req.body)) return badBody(res, 'invalid_body');
    const term = asNonEmptyString(req.body.name);
    if (!term) return badBody(res, 'name_required');
    try {
      const out = await searchPulseCharacters(term, ctx.fetch);
      const status = out.ok ? HTTP_OK : HTTP_UPSTREAM;
      console.log(`[onboarding] search-pulse ${out.ok ? 'ok' : 'fail'}`
                  + ` n=${(out.matches || []).length}`);
      res.status(status).json(out);
    } catch (err) {
      console.error('[onboarding] search-pulse threw:', err.message);
      res.status(HTTP_UPSTREAM)
          .json({ ok: false, error: 'pulse_unreachable' });
    }
  };
}

async function lookupPulseCharacter(characterId, fetchFn) {
  const id = encodeURIComponent(characterId);
  // SC2Pulse /character/{id} returns an array: [character_obj] for valid
  // IDs, [] for unknown ones. Empty array is the "no such character"
  // signal.
  const url = `${PULSE_API_ROOT}/character/${id}`;
  const res = await fetchWithTimeout(fetchFn, url, {});
  if (!res.ok) return { ok: false, error: `pulse_status_${res.status}` };
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body) && (!body || typeof body !== 'object')) {
    return { ok: false, error: 'pulse_bad_payload' };
  }
  const ch = extractPulseCharacter(body);
  if (!ch) return { ok: false, error: 'pulse_no_character' };
  return {
    ok: true,
    pulse_id: String(characterId),
    name: stripDiscriminator(ch.name),
    region: normalizePulseRegion(ch.region),
    league: null,
  };
}

function stripDiscriminator(name) {
  if (typeof name !== 'string') return null;
  return name.split('#')[0] || name;
}

function extractPulseCharacter(body) {
  if (body == null) return null;
  // Shape: array of one (the /character/{id} endpoint).
  if (Array.isArray(body)) return body.length > 0 ? body[0] : null;
  if (typeof body !== 'object') return null;
  if (body.character && typeof body.character === 'object') return body.character;
  // members can be an array (some endpoints) or an object (others).
  if (Array.isArray(body.members) && body.members.length > 0) {
    const m = body.members[0];
    if (m && m.character && typeof m.character === 'object') return m.character;
  }
  if (body.members && typeof body.members === 'object'
      && body.members.character) return body.members.character;
  if (body.member && body.member.character) return body.member.character;
  if (body.id || body.battlenetId || body.name) return body;
  return null;
}

/**
 * Normalize a SC2Pulse region value to a lowercase 2-3 letter code.
 * The API uses numeric codes (1, 2, 3, 5, 6) on team payloads and
 * string codes ("US", "EU", "KR", "CN", "SEA") on character payloads.
 */
function normalizePulseRegion(region) {
  if (region == null) return null;
  if (typeof region === 'number') return PULSE_REGION_LABEL[region] || null;
  if (typeof region === 'string') {
    const v = region.toLowerCase();
    if (['us', 'eu', 'kr', 'cn', 'sea'].includes(v)) return v;
    return null;
  }
  return null;
}

function pickPulseLeague(body) {
  const teams = Array.isArray(body.teams) ? body.teams : [];
  let best = null;
  for (const t of teams) {
    const r = Number(t.rating);
    if (!Number.isFinite(r)) continue;
    if (best === null || r > best) best = r;
  }
  if (best !== null) return best;
  const ch = extractPulseCharacter(body);
  if (ch && Number.isFinite(Number(ch.ratingMax))) return Number(ch.ratingMax);
  return null;
}

function handleTestPulse(ctx) {
  return async (req, res) => {
    if (!isPlainObject(req.body)) return badBody(res, 'invalid_body');
    const ids = normalizePulseIdList(req.body);
    if (ids.length === 0) return badBody(res, 'character_id_required');
    try {
      const results = [];
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const r = await lookupPulseCharacter(id, ctx.fetch);
        results.push(r);
      }
      const allOk = results.every((r) => r.ok);
      const status = allOk ? HTTP_OK : HTTP_UPSTREAM;
      console.log(`[onboarding] test/pulse ${allOk ? 'ok' : 'fail'}`
                  + ` n=${ids.length}`);
      res.status(status).json({
        ok: allOk,
        results,
        error: allOk ? undefined
          : (results.find((r) => !r.ok) || {}).error || 'pulse_failed',
      });
    } catch (err) {
      console.error('[onboarding] test/pulse threw:', err.message);
      res.status(HTTP_UPSTREAM)
          .json({ ok: false, error: 'pulse_unreachable' });
    }
  };
}

function normalizePulseIdList(body) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(body.character_ids) ? body.character_ids : [];
  for (const v of arr) {
    const s = asNonEmptyString(v);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  const single = asNonEmptyString(body.character_id);
  if (single && !seen.has(single)) { seen.add(single); out.push(single); }
  return out;
}

// --------------------------------------------------------------
// START INITIAL BACKFILL
// --------------------------------------------------------------

function handleStartBackfill(ctx) {
  return async (req, res) => {
    const base = ctx.loopbackBase(req);
    const url = `${base}/api/analyzer/macro/backfill/start`;
    try {
      const upstream = await fetchWithTimeout(ctx.fetch, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await upstream.json().catch(() => ({}));
      const ok = upstream.ok && body && body.ok !== false;
      const status = ok ? HTTP_OK : HTTP_UPSTREAM;
      console.log(`[onboarding] start-initial-backfill ${ok ? 'ok' : 'fail'}`);
      res.status(status).json(ok
          ? { ok: true, started: true }
          : { ok: false, error: body.error || 'backfill_unavailable' });
    } catch (err) {
      console.error('[onboarding] start-initial-backfill threw:', err.message);
      res.status(HTTP_UPSTREAM)
          .json({ ok: false, error: 'backfill_unreachable' });
    }
  };
}

// --------------------------------------------------------------
// HTTP TIMEOUT WRAPPER
// --------------------------------------------------------------

function fetchWithTimeout(fetchFn, url, init) {
  const controller = (typeof AbortController === 'function')
      ? new AbortController() : null;
  const opts = { ...(init || {}) };
  if (controller) opts.signal = controller.signal;
  const timer = setTimeout(() => {
    if (controller) controller.abort();
  }, HTTP_TIMEOUT_MS);
  return fetchFn(url, opts).finally(() => clearTimeout(timer));
}

// --------------------------------------------------------------
// FACTORY
// --------------------------------------------------------------

/**
 * Build the onboarding sub-router.
 *
 * @param {object} opts
 *   - scriptsDir: absolute dir holding identity_cli.py
 *   - repoRoot: absolute dir to use as cwd when spawning python
 *   - pythonExe: name/path of the python interpreter
 *   - fetch: fetch implementation (node-fetch or globalThis.fetch)
 *   - loopbackBase: (req) => 'http://host:port' for in-process forward
 * @returns {express.Router}
 */
function createOnboardingRouter(opts) {
  const ctx = validateOpts(opts);
  const router = express.Router();
  router.post('/api/onboarding/scan-replay-folders', handleScanReplayFolders());
  router.post('/api/onboarding/scan-identities', handleScanIdentities(ctx));
  router.post('/api/onboarding/test/twitch', handleTestTwitch(ctx));
  router.post('/api/onboarding/test/obs', handleTestObs());
  router.post('/api/onboarding/test/pulse', handleTestPulse(ctx));
  router.post('/api/onboarding/search-pulse', handleSearchPulse(ctx));
  router.post('/api/onboarding/start-initial-backfill',
              handleStartBackfill(ctx));
  return router;
}

function validateOpts(opts) {
  if (!isPlainObject(opts)) {
    throw new Error('createOnboardingRouter requires opts');
  }
  const required = ['scriptsDir', 'repoRoot', 'pythonExe', 'fetch',
                    'loopbackBase'];
  for (const key of required) {
    if (!opts[key]) throw new Error(`createOnboardingRouter requires opts.${key}`);
  }
  return { ...opts };
}

module.exports = {
  createOnboardingRouter,
  // exported for tests
  scanReplayFolders,
  computeObsAuth,
  parseIdentityOutput,
  isPlainObject,
  normalizeFolderList,
  normalizePulseSearchHit,
  normalizePulseIdList,
  extractPulseCharacter,
};
