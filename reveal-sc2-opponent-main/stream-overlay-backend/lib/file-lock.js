// @ts-check
/**
 * file-lock.js -- cross-process lock primitive for the data/ directory.
 *
 * Mirrors core/file_lock.py byte-for-byte on the lockfile contract so
 * the Python replay watcher, the Node stream-overlay backend, and the
 * PowerShell live-phase scanner all coordinate on the same lockfiles.
 * See the Python module's top docstring for the full rationale.
 *
 * Lockfile shape (data/.locks/<safe-name>.lock):
 *
 *   { "pid":   <number>,
 *     "host":  "<hostname>",
 *     "lang":  "node" | "python" | "ps",
 *     "platform": "<os>",
 *     "since": <epoch_ms>,
 *     "stamp": "<ISO8601>" }
 *
 * Acquisition uses fs.openSync(path, 'wx') which has the same
 * O_CREAT|O_EXCL semantics as the Python side. Stale detection
 * compares the holder PID against `process.kill(pid, 0)` and the
 * lock age against the configured threshold.
 *
 * Engineering preamble compliance:
 *   - JSDoc + tsc --checkJs strict.
 *   - Function size <= 30 lines, no magic constants.
 *   - Best-effort logging; never throws on release failure.
 *   - Opt-out via SC2TOOLS_DATA_LOCK_ENABLED=0 for emergency rollback.
 *
 * Example:
 *   const { withFileLock } = require('./file-lock');
 *   await withFileLock('data/MyOpponentHistory.json', async () => {
 *     // safe to atomic-write here
 *   });
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_SEC = 30;
const DEFAULT_STALE_AFTER_SEC = 30;
const DEFAULT_BACKOFF_INITIAL_MS = 5;
const DEFAULT_BACKOFF_MAX_MS = 250;

const LOCK_DIR_NAME = '.locks';
const LOCK_SUFFIX = '.lock';
const ENABLE_ENV_VAR = 'SC2TOOLS_DATA_LOCK_ENABLED';
const DISABLE_VALUE = '0';
const LANG_TAG = 'node';

/**
 * Map a target filename to a deterministic lockfile basename. Matches
 * the Python implementation so cross-language coordination works.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function safeLockName(targetPath) {
  let base = path.basename(targetPath);
  for (const strip of ['.bak', '.tmp_restore']) {
    if (base.endsWith(strip)) base = base.slice(0, -strip.length);
  }
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe + LOCK_SUFFIX;
}

/**
 * Resolve (and create) the lock directory adjacent to the target file.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function resolveLockDir(targetPath) {
  const parent = path.dirname(path.resolve(targetPath));
  const lockDir = path.join(parent, LOCK_DIR_NAME);
  fs.mkdirSync(lockDir, { recursive: true });
  return lockDir;
}

/**
 * Best-effort liveness probe via signal 0. Same semantics as
 * `kill -0 PID` -- doesn't actually deliver a signal, just tests
 * whether the OS would accept one.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Parse the lockfile metadata. Returns null on missing / corrupt.
 *
 * @param {string} lockPath
 * @returns {object|null}
 */
function readLockMeta(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

/**
 * Build OUR holder metadata. Used both at acquisition time and at
 * release-verify time.
 *
 * @returns {{pid: number, host: string, lang: string, platform: string,
 *            since: number, stamp: string}}
 */
function makeLockMeta() {
  return {
    pid: process.pid,
    host: os.hostname(),
    lang: LANG_TAG,
    platform: process.platform,
    since: Date.now(),
    stamp: new Date().toISOString().replace(/\.\d{3}/, ''),
  };
}

/**
 * Atomic O_EXCL create. Returns true if WE created the file, false
 * when it already exists.
 *
 * @param {string} lockPath
 * @param {object} meta
 * @returns {boolean}
 */
function tryCreateLockfile(lockPath, meta) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    const payload = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
    fs.writeSync(fd, payload, 0, payload.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Decide whether the current holder is stale. A null meta (file
 * unreadable) counts as stale.
 *
 * @param {object|null} meta
 * @param {number} staleAfterSec
 * @returns {boolean}
 */
function isStale(meta, staleAfterSec) {
  if (!meta) return true;
  if (!isPidAlive(meta.pid)) return true;
  if (typeof meta.since === 'number') {
    const ageSec = (Date.now() - meta.since) / 1000;
    if (ageSec >= staleAfterSec) return true;
  }
  return false;
}

/**
 * Attempt to remove a stale lockfile. Returns true on success or when
 * the file is already gone; false if the metadata changed under us
 * (another acquirer is now legitimately holding it).
 *
 * @param {string} lockPath
 * @param {object|null} expected
 * @returns {boolean}
 */
function tryStealLock(lockPath, expected) {
  const current = readLockMeta(lockPath);
  if (current === null) return true;
  // `expected === null` means our caller's first read of the holder
  // metadata failed — typically because the holder was mid-write and
  // the file was briefly opened with FileShare.None (PowerShell), or
  // an antivirus held the bytes for a tick. If the second read NOW
  // returns a valid holder, that holder is healthy; we MUST NOT steal.
  // Loop and let the next iteration re-evaluate staleness with a
  // clean read. Without this guard, a sharing-violation transient on
  // a fresh lockfile causes lost updates across processes.
  if (expected === null) return false;
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    return false;
  }
}

/**
 * Promise-friendly sleep with exponential backoff capped at
 * DEFAULT_BACKOFF_MAX_MS.
 *
 * @param {number} attempt
 * @returns {Promise<void>}
 */
function backoffSleep(attempt) {
  const delayMs = Math.min(
    DEFAULT_BACKOFF_INITIAL_MS * (2 ** attempt),
    DEFAULT_BACKOFF_MAX_MS,
  );
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

class FileLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileLockTimeoutError';
  }
}

function isDisabled() {
  return process.env[ENABLE_ENV_VAR] === DISABLE_VALUE;
}

/**
 * Release a lock if-and-only-if the on-disk metadata still matches
 * what we wrote. If a stale-steal swapped a different holder in, we
 * stay out of their way.
 *
 * On Windows, another process briefly holding a read handle on our
 * lockfile (liveness check, antivirus indexer) makes DeleteFile fail
 * with a sharing violation -- surfaced to libuv as EBUSY/EACCES/EPERM.
 * Retry a few times with brief sleeps so we don't leak the lockfile;
 * on POSIX this loop is a no-op because unlink succeeds on the first
 * try regardless of open handles.
 *
 * @param {string} lockPath
 * @param {object} ours
 */
function releaseOwned(lockPath, ours) {
  const current = readLockMeta(lockPath);
  if (current === null) return;
  if (current.pid !== ours.pid || current.since !== ours.since) {
    process.stderr.write(
      `[file-lock] release skipped: holder changed under us `
      + `(${current.pid} != ours ${ours.pid})\n`,
    );
    return;
  }
  const TRANSIENT_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);
  const MAX_ATTEMPTS = 6;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.unlinkSync(lockPath);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      lastErr = err;
      if (!err || !TRANSIENT_CODES.has(err.code)) break;
      const ms = Math.min(5 * (1 << attempt), 80);
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // intentional empty body — sync sleep so callers stay sync
      }
    }
  }
  if (lastErr) {
    process.stderr.write(`[file-lock] release error: ${lastErr.message}\n`);
  }
}

/**
 * Acquire the lock, run `fn`, release. Always releases on the way out
 * even if `fn` throws.
 *
 * @template T
 * @param {string} targetPath
 * @param {() => Promise<T> | T} fn
 * @param {Object} [opts]
 * @param {number} [opts.timeoutSec]
 * @param {number} [opts.staleAfterSec]
 * @returns {Promise<T>}
 */
async function withFileLock(targetPath, fn, opts) {
  if (isDisabled()) {
    return await fn();
  }
  const timeoutSec = (opts && opts.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const staleAfterSec = (opts && opts.staleAfterSec) || DEFAULT_STALE_AFTER_SEC;
  const lockDir = resolveLockDir(targetPath);
  const lockPath = path.join(lockDir, safeLockName(targetPath));
  const meta = makeLockMeta();
  const deadline = Date.now() + timeoutSec * 1000;
  let attempt = 0;
  let lastSeen = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (tryCreateLockfile(lockPath, meta)) {
      try {
        return await fn();
      } finally {
        releaseOwned(lockPath, meta);
      }
    }

    const observed = readLockMeta(lockPath);
    if (isStale(observed, staleAfterSec)) {
      tryStealLock(lockPath, observed);
      attempt = 0;
      lastSeen = null;
      continue;
    }

    if (Date.now() >= deadline) {
      const holderPid = observed && observed.pid ? observed.pid : '?';
      throw new FileLockTimeoutError(
        `file-lock: timeout after ${timeoutSec}s waiting on ${lockPath}; `
        + `current holder pid=${holderPid}`,
      );
    }

    if (JSON.stringify(observed) !== JSON.stringify(lastSeen)) {
      attempt = 0;
      lastSeen = observed;
    } else {
      attempt += 1;
    }
    await backoffSleep(attempt);
  }
}

/**
 * Synchronous variant for hot paths that already block (atomic-fs
 * writers run synchronously). Implementation is a tight while-loop
 * with `Atomics.wait`-style sleeps via `setTimeout`-equivalent
 * busy-waiting: we use a small synchronous sleep helper so callers
 * don't need to be async.
 *
 * @template T
 * @param {string} targetPath
 * @param {() => T} fn
 * @param {Object} [opts]
 * @param {number} [opts.timeoutSec]
 * @param {number} [opts.staleAfterSec]
 * @returns {T}
 */
function withFileLockSync(targetPath, fn, opts) {
  if (isDisabled()) {
    return fn();
  }
  // Stage 7: count + measure lock acquisition. Best-effort require()
  // so a partial install doesn't block the lock.
  let metrics = null;
  try { metrics = require('./data_integrity_metrics'); } catch (_e) { /* */ }
  const _basename = path.basename(targetPath);
  const timeoutSec = (opts && opts.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const staleAfterSec = (opts && opts.staleAfterSec) || DEFAULT_STALE_AFTER_SEC;
  const lockDir = resolveLockDir(targetPath);
  const lockPath = path.join(lockDir, safeLockName(targetPath));
  const meta = makeLockMeta();
  const deadline = Date.now() + timeoutSec * 1000;
  let attempt = 0;
  let lastSeen = null;
  let contended = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (tryCreateLockfile(lockPath, meta)) {
      if (metrics) {
        metrics.counterInc('lock_acquired', { basename: _basename });
        if (contended) metrics.counterInc('lock_contended', { basename: _basename });
      }
      try {
        return fn();
      } finally {
        releaseOwned(lockPath, meta);
      }
    }
    contended = true;
    const observed = readLockMeta(lockPath);
    if (isStale(observed, staleAfterSec)) {
      tryStealLock(lockPath, observed);
      attempt = 0;
      lastSeen = null;
      continue;
    }
    if (Date.now() >= deadline) {
      if (metrics) metrics.counterInc('lock_timeout', { basename: _basename });
      const holderPid = observed && observed.pid ? observed.pid : '?';
      throw new FileLockTimeoutError(
        `file-lock: timeout after ${timeoutSec}s waiting on ${lockPath}; `
        + `current holder pid=${holderPid}`,
      );
    }
    if (JSON.stringify(observed) !== JSON.stringify(lastSeen)) {
      attempt = 0;
      lastSeen = observed;
    } else {
      attempt += 1;
    }
    sleepSyncMs(Math.min(
      DEFAULT_BACKOFF_INITIAL_MS * (2 ** attempt),
      DEFAULT_BACKOFF_MAX_MS,
    ));
  }
}

/**
 * Block the event loop for `ms` milliseconds. Used only by
 * withFileLockSync; never on a hot Express request path. The atomic-
 * fs writers run on background ticks (Pulse polling, replay webhook
 * persist) so blocking is acceptable -- a 250ms ceiling keeps it from
 * stacking up.
 *
 * @param {number} ms
 */
function sleepSyncMs(ms) {
  const end = Date.now() + ms;
  // Simple busy wait so we don't import any native binding. The
  // backoff caps at 250ms so worst-case CPU usage is bounded.
  while (Date.now() < end) {
    // intentional empty body
  }
}

module.exports = {
  withFileLock,
  withFileLockSync,
  FileLockTimeoutError,
  // Internals exposed for unit tests only.
  _internals: {
    safeLockName,
    resolveLockDir,
    isPidAlive,
    readLockMeta,
    makeLockMeta,
    tryCreateLockfile,
    isStale,
    tryStealLock,
    releaseOwned,
  },
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_STALE_AFTER_SEC,
  ENABLE_ENV_VAR,
};
