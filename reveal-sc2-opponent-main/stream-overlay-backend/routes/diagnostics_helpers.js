/**
 * DIAGNOSTICS HELPERS (Stage 4)
 * ============================================================
 * Pure utility functions shared by every check in routes/diagnostics_checks.js
 * and the bundle streamer in routes/diagnostics_bundle.js. No express or
 * filesystem-mutation logic lives here -- read-only utilities only, so this
 * module is trivial to unit test in isolation.
 *
 * Example:
 *   const { redact, httpJson, runProcess } =
 *       require('./diagnostics_helpers');
 */

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

// ------------------------------------------------------------------
// CONSTANTS (reused by callers; freeze to prevent accidental mutation)
// ------------------------------------------------------------------

const STATUS_OK = 'ok';
const STATUS_WARN = 'warn';
const STATUS_ERR = 'err';
const STATUS_PENDING = 'pending';

const PROCESS_TIMEOUT_MS = 5000;
const HTTP_READ_TIMEOUT_MS = 8000;
const LOG_TAIL_BUFFER_BYTES = 64 * 1024;
const REDACT_PLACEHOLDER = '<redacted>';

const PII_REDACT_KEYS = Object.freeze([
  'battle_tag', 'character_id', 'account_id', 'pulse_character_ids',
  'twitch_channel', 'password', 'preferred_player_name_in_replays',
]);

const ENV_REDACT_KEYS = Object.freeze([
  'TWITCH_OAUTH_TOKEN', 'TWITCH_CLIENT_SECRET', 'OBS_PASSWORD',
]);

// ------------------------------------------------------------------
// RESULT BUILDER
// ------------------------------------------------------------------

/**
 * Build a uniform check result. Every public check returns one of these.
 *
 * Example:
 *   buildResult({ id: 'python', title: 'Python', status: 'ok',
 *                 summary: 'Python 3.12.4' });
 *
 * @param {object} fields
 * @returns {object}
 */
function buildResult(fields) {
  const { id, title, status, summary, detail, fix } = fields;
  const out = { id, title, status, summary };
  if (detail !== undefined) out.detail = detail;
  if (fix !== undefined) out.fix_action = fix;
  return out;
}

// ------------------------------------------------------------------
// JSON / FS HELPERS
// ------------------------------------------------------------------

/**
 * Read a JSON file, stripping a UTF-8 BOM. Returns null when missing.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

/**
 * Best-effort byte size of a file. Returns null on miss/error.
 *
 * @param {string} filePath
 * @returns {number|null}
 */
function statSizeOrNull(filePath) {
  try { return fs.statSync(filePath).size; }
  catch (_err) { return null; }
}

/**
 * ISO mtime of a file, or null on miss.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function statMtimeIsoOrNull(filePath) {
  try { return fs.statSync(filePath).mtime.toISOString(); }
  catch (_err) { return null; }
}

/**
 * Tail the last N lines of a text file (optionally filtered by regex).
 * Reads at most LOG_TAIL_BUFFER_BYTES from the end of the file.
 *
 * @param {string} filePath
 * @param {number} maxLines
 * @param {RegExp} [filterRegex]
 * @returns {string[]}
 */
function tailLines(filePath, maxLines, filterRegex) {
  if (!fs.existsSync(filePath)) return [];
  const sz = fs.statSync(filePath).size;
  const start = Math.max(0, sz - LOG_TAIL_BUFFER_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(sz - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const all = buf.toString('utf8').split(/\r?\n/);
    const filtered = filterRegex ? all.filter((l) => filterRegex.test(l)) : all;
    return filtered.filter((l) => l.length > 0).slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------------
// REDACTION
// ------------------------------------------------------------------

/**
 * Recursively redact PII keys from a deep clone of `value`. Used before
 * anything is written into the diagnostic-bundle zip.
 *
 * @param {*} value
 * @returns {*}
 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = PII_REDACT_KEYS.includes(k) ? REDACT_PLACEHOLDER : redact(v);
    }
    return out;
  }
  return value;
}

// ------------------------------------------------------------------
// SUBPROCESS
// ------------------------------------------------------------------

/**
 * Spawn a process, collect stdout/stderr, enforce a timeout. Always
 * uses list-form args; never shell=true.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
function runProcess(cmd, args, timeoutMs) {
  const ms = typeof timeoutMs === 'number' ? timeoutMs : PROCESS_TIMEOUT_MS;
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(cmd, args, { shell: false }); }
    catch (err) {
      resolve({ code: -1, stdout: '',
        stderr: String(err.message || err), timedOut: false });
      return;
    }
    runProcessAttach(proc, ms, resolve);
  });
}

/**
 * Wire stdout/stderr/error/close listeners onto a spawned process. Split
 * out so runProcess() stays under the 30-line target.
 *
 * @param {import('child_process').ChildProcess} proc
 * @param {number} ms
 * @param {function} resolve
 */
function runProcessAttach(proc, ms, resolve) {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch (_e) { /* ignore */ }
  }, ms);
  proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  proc.on('error', (err) => {
    clearTimeout(timer);
    resolve({ code: -1, stdout,
      stderr: stderr + String(err.message || err), timedOut });
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code: code === null ? -1 : code, stdout, stderr, timedOut });
  });
}

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------

/**
 * Fetch a URL with explicit read timeout. Always returns a normalized
 * shape -- never throws.
 *
 * @param {function} fetchImpl
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{ok:boolean,status:number,json:object|null,text:string,error:string|null}>}
 */
async function httpJson(fetchImpl, url, options) {
  const opts = options || {};
  const ctrl = new AbortController();
  const readMs = opts.readMs || HTTP_READ_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), readMs);
  try {
    const res = await fetchImpl(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      signal: ctrl.signal,
    });
    const text = await res.text();
    clearTimeout(timer);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not JSON */ }
    return { ok: res.ok, status: res.status, json, text, error: null };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, json: null, text: '',
      error: String(err.message || err) };
  }
}

// ------------------------------------------------------------------
// TCP
// ------------------------------------------------------------------

/**
 * Open a TCP connection. Resolves {ok:true} on connect; {ok:false,error}
 * otherwise. Used by the OBS reachability check.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean,error:string|null}>}
 */
function tcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_e) { /* ignore */ }
      resolve({ ok, error: error || null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, null));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (err) => finish(false, String(err.message || err)));
    try { sock.connect(port, host); }
    catch (err) { finish(false, String(err.message || err)); }
  });
}

// ------------------------------------------------------------------
// FORMATTERS
// ------------------------------------------------------------------

/**
 * Format a byte count as a short human string (e.g. "12.4 GB").
 *
 * @param {number} n
 * @returns {string}
 */
function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const decimals = (v >= 10 || i === 0) ? 0 : 1;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

module.exports = {
  // Status enum:
  STATUS_OK, STATUS_WARN, STATUS_ERR, STATUS_PENDING,
  // Constants:
  REDACT_PLACEHOLDER, PII_REDACT_KEYS, ENV_REDACT_KEYS,
  // Helpers:
  buildResult,
  readJsonOrNull, statSizeOrNull, statMtimeIsoOrNull, tailLines,
  redact,
  runProcess, httpJson, tcpReachable,
  formatBytes,
};
