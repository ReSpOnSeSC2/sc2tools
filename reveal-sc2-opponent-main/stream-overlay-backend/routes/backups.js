/**
 * BACKUPS ROUTER
 * ============================================================
 * Express sub-router that owns the snapshot/restore lifecycle of
 * the install's data files (data/meta_database.json, profile.json,
 * config.json, MyOpponentHistory.json, custom_builds.json).
 *
 * Settings UI (Stage 2.3 / 2.4) calls these endpoints from the
 * Backups tab so the user can:
 *
 *   * see every snapshot already on disk (matching *.backup-*,
 *     *.broken-*, *.pre-*, *.bak-* against an allow-listed base),
 *   * snapshot the live meta-DB on demand,
 *   * restore a snapshot back over the live file, with a safety
 *     pre-restore snapshot taken automatically first,
 *   * delete an old snapshot.
 *
 * Hard rules honored here:
 *   - Atomic writes (write -> fsync -> rename), mirroring
 *     persistMetaDb in analyzer.js. Crash-safe.
 *   - Strict allow-list of base filenames. No /api/backups call can
 *     touch a file outside that list.
 *   - Strict safe-name regex on every filename in the URL or body.
 *     Rejects path separators, `..`, and any non-printable input.
 *   - No PII ever logged. Logs operation + base + kind only; never
 *     opens a snapshot's contents.
 *   - Factory-built (createBackupsRouter({ dataDir })) so jest can
 *     point it at a tmp directory.
 *
 * Example:
 *   const { createBackupsRouter } = require('./routes/backups');
 *   app.use(createBackupsRouter({ dataDir: path.join(ROOT, 'data') }));
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

// ------------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------------

/**
 * Files the router is allowed to snapshot or restore. Anything not
 * in this list is rejected with HTTP 400 invalid_base. Keep this
 * list short and review every addition.
 */
const ALLOWED_BASES = Object.freeze([
  'meta_database.json',
  'MyOpponentHistory.json',
  'profile.json',
  'config.json',
  'custom_builds.json',
]);

/**
 * Recognised backup filename suffix kinds. Order matters because
 * the parser walks them top-down and stops at the first match.
 *
 *   backup       - explicit user-triggered snapshot
 *   broken       - auto-saved before destructive recovery (the
 *                  analyzer renames a corrupt file to .broken-* so
 *                  the next start can rebuild from scratch)
 *   pre          - auto-saved before a migration (e.g. pre-chrono-fix-,
 *                  pre-chain-counting-, pre-stage22-bak)
 *   bak          - generic numeric backup written by older tooling
 *                  (profile.json.bak-1777307689)
 *   pre-restore  - emitted by THIS router before /restore overwrites
 *                  the live file. Listed under the "pre" kind.
 */
const BACKUP_KINDS = Object.freeze(['backup', 'broken', 'pre', 'bak']);

/**
 * Filename regex applied to every name we accept from the user
 * (URL :name or body.snapshot). Letters, digits, dot, dash,
 * underscore. No slash, no backslash, no .., no whitespace.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL = 500;

const ALLOWED_BASES_SET = new Set(ALLOWED_BASES);

// ------------------------------------------------------------------
// FILENAME PARSING
// ------------------------------------------------------------------

/**
 * Decompose a snapshot filename into its base + kind + label, or
 * return null when the name does not match a known backup shape.
 *
 * Example:
 *   parseSnapshotName('meta_database.json.pre-chrono-fix-20260427-021758')
 *     -> { base: 'meta_database.json', kind: 'pre',
 *          label: 'chrono-fix-20260427-021758' }
 *
 *   parseSnapshotName('profile.json.bak-1777307689')
 *     -> { base: 'profile.json', kind: 'bak', label: '1777307689' }
 *
 *   parseSnapshotName('meta_database.json') -> null
 *
 * @param {string} name Filename without directory.
 * @returns {{base: string, kind: string, label: string}|null}
 */
function parseSnapshotName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  for (const kind of BACKUP_KINDS) {
    const sep = `.${kind}-`;
    const idx = name.indexOf(sep);
    if (idx <= 0) continue;
    const base = name.slice(0, idx);
    const label = name.slice(idx + sep.length);
    if (label.length === 0) continue;
    if (!ALLOWED_BASES_SET.has(base)) continue;
    return { base, kind, label };
  }
  return null;
}

/**
 * Build a UTC timestamp safe for use inside a filename.
 *
 * Example:
 *   timestampLabel(new Date('2026-04-27T18:30:45Z'))
 *     -> '20260427T183045Z'
 *
 * @param {Date} now Defaults to current time.
 * @returns {string}
 */
function timestampLabel(now) {
  const d = now instanceof Date ? now : new Date();
  const iso = d.toISOString();              // 2026-04-27T18:30:45.123Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ------------------------------------------------------------------
// FILESYSTEM HELPERS
// ------------------------------------------------------------------

/**
 * stat a file; return { size, mtime } or null if it does not exist.
 *
 * @param {string} filePath Absolute path.
 * @returns {{size: number, mtime: Date}|null}
 */
function statOrNull(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return { size: st.size, mtime: st.mtime };
  } catch (_) {
    return null;
  }
}

/**
 * Atomically copy a source file to a destination via tmp + fsync +
 * rename. Crash-safe: a torn copy never replaces the destination.
 *
 * @param {string} srcPath Absolute source.
 * @param {string} destPath Absolute destination.
 * @returns {void}
 */
function atomicCopyFile(srcPath, destPath) {
  const tmp = `${destPath}.tmp`;
  fs.copyFileSync(srcPath, tmp);
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, destPath);
}

/**
 * Build the response object for a backup file. Reads stat, never
 * opens contents. Safe to call on multi-hundred-MB snapshots.
 *
 * @param {string} dataDir Absolute data directory.
 * @param {string} name Filename within dataDir.
 * @returns {object|null} Snapshot descriptor, or null if missing /
 *                        not a recognised backup name.
 */
function describeSnapshot(dataDir, name) {
  const parsed = parseSnapshotName(name);
  if (!parsed) return null;
  const st = statOrNull(path.join(dataDir, name));
  if (!st) return null;
  return {
    name,
    base: parsed.base,
    kind: parsed.kind,
    label: parsed.label,
    size: st.size,
    modified_iso: st.mtime.toISOString(),
  };
}

// ------------------------------------------------------------------
// VALIDATION
// ------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Confirm a name looks like a safe filename and decompose it.
 * Rejects empty, path-separator-bearing, or non-backup names.
 *
 * @param {string} name Untrusted string.
 * @returns {{ok: true, parsed: object}|{ok: false, error: string}}
 */
function validateBackupName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'name_required' };
  }
  if (!SAFE_NAME.test(name)) {
    return { ok: false, error: 'invalid_name' };
  }
  const parsed = parseSnapshotName(name);
  if (!parsed) {
    return { ok: false, error: 'not_a_backup' };
  }
  return { ok: true, parsed };
}

/**
 * Confirm a base filename is in the allow list.
 *
 * @param {string} base Filename without directory.
 * @returns {boolean}
 */
function isAllowedBase(base) {
  return typeof base === 'string' && ALLOWED_BASES_SET.has(base);
}

// ------------------------------------------------------------------
// LIST HANDLER
// ------------------------------------------------------------------

/**
 * GET /api/backups -> { backups: [...] }
 *
 * Lists every file in dataDir whose name parses as a recognised
 * backup of an allow-listed base. Sorted newest first by mtime.
 */
function handleList(dataDir) {
  return (_req, res) => {
    let entries;
    try {
      entries = fs.readdirSync(dataDir);
    } catch (err) {
      console.error(`[backups] list failed: ${err.code || err.message}`);
      return res.status(HTTP_INTERNAL).json({ error: 'io_failed' });
    }
    const snapshots = entries
      .map((name) => describeSnapshot(dataDir, name))
      .filter((entry) => entry !== null)
      .sort((a, b) => b.modified_iso.localeCompare(a.modified_iso));
    console.log(`[backups] list n=${snapshots.length}`);
    return res.status(HTTP_OK).json({ backups: snapshots });
  };
}

// ------------------------------------------------------------------
// CREATE HANDLER
// ------------------------------------------------------------------

/**
 * POST /api/backups/create body { base?: string }
 *
 * Snapshots a single allow-listed base file to
 * `<base>.backup-<UTC-timestamp>` via atomic copy. Defaults to
 * meta_database.json since that's the file the wizard's "Snapshot
 * before doing X" affordance most often targets.
 */
function handleCreate(dataDir, clock) {
  return (req, res) => {
    const body = req.body || {};
    if (!isPlainObject(body)) {
      return res.status(HTTP_BAD_REQUEST).json({ error: 'invalid_body' });
    }
    const base = typeof body.base === 'string' && body.base
      ? body.base : 'meta_database.json';
    if (!isAllowedBase(base)) {
      return res.status(HTTP_BAD_REQUEST).json({ error: 'invalid_base' });
    }
    const basePath = path.join(dataDir, base);
    if (!statOrNull(basePath)) {
      return res.status(HTTP_NOT_FOUND).json({ error: 'base_not_found' });
    }
    const stamp = timestampLabel(clock());
    const snapshotName = `${base}.backup-${stamp}`;
    const snapshotPath = path.join(dataDir, snapshotName);
    try {
      atomicCopyFile(basePath, snapshotPath);
    } catch (err) {
      console.error(
        `[backups] create failed base=${base} kind=backup: ${err.code || err.message}`
      );
      return res.status(HTTP_INTERNAL).json({ error: 'io_failed' });
    }
    const desc = describeSnapshot(dataDir, snapshotName);
    console.log(`[backups] create base=${base} kind=backup size=${desc.size}`);
    return res.status(HTTP_OK).json({ snapshot: desc });
  };
}

// ------------------------------------------------------------------
// RESTORE HANDLER
// ------------------------------------------------------------------

/**
 * POST /api/backups/restore body { snapshot: string }
 *
 * Two-step flow:
 *   1. Snapshot the CURRENT live file to <base>.pre-restore-<ts>
 *      so the user can undo the restore if it was a mistake.
 *   2. Atomically copy <snapshot> -> <base>.
 *
 * Returns the pre-restore snapshot's descriptor along with the
 * restore acknowledgement so the UI can offer 'Undo' immediately.
 */
function handleRestore(dataDir, clock) {
  return (req, res) => {
    const body = req.body || {};
    if (!isPlainObject(body)) {
      return res.status(HTTP_BAD_REQUEST).json({ error: 'invalid_body' });
    }
    const check = validateBackupName(body.snapshot);
    if (!check.ok) {
      return res.status(HTTP_BAD_REQUEST).json({ error: check.error });
    }
    const { parsed } = check;
    const snapshotPath = path.join(dataDir, body.snapshot);
    if (!statOrNull(snapshotPath)) {
      return res.status(HTTP_NOT_FOUND).json({ error: 'snapshot_not_found' });
    }
    const basePath = path.join(dataDir, parsed.base);
    const safetyName = `${parsed.base}.pre-restore-${timestampLabel(clock())}`;
    return runRestore({ dataDir, basePath, snapshotPath, safetyName, parsed }, res);
  };
}

/**
 * Inner helper for handleRestore -- splits the IO so the outer
 * handler stays under the 30-line target and complexity stays low.
 */
function runRestore({ dataDir, basePath, snapshotPath, safetyName, parsed }, res) {
  const safetyPath = path.join(dataDir, safetyName);
  let safetyDesc = null;
  try {
    if (statOrNull(basePath)) {
      atomicCopyFile(basePath, safetyPath);
      safetyDesc = describeSnapshot(dataDir, safetyName);
    }
    atomicCopyFile(snapshotPath, basePath);
  } catch (err) {
    console.error(
      `[backups] restore failed base=${parsed.base}: ${err.code || err.message}`
    );
    return res.status(HTTP_INTERNAL).json({ error: 'io_failed' });
  }
  console.log(
    `[backups] restore base=${parsed.base} from_kind=${parsed.kind} safety=${safetyDesc ? 'yes' : 'none'}`
  );
  return res.status(HTTP_OK).json({
    restored: parsed.base,
    pre_restore_snapshot: safetyDesc,
  });
}

// ------------------------------------------------------------------
// DELETE HANDLER
// ------------------------------------------------------------------

/**
 * DELETE /api/backups/:name
 *
 * Refuses non-backup filenames. The route param is validated via the
 * same SAFE_NAME regex + parseSnapshotName allow-list as restore so
 * a malicious caller can never reach a non-backup file from this
 * route.
 */
function handleDelete(dataDir) {
  return (req, res) => {
    const check = validateBackupName(req.params.name);
    if (!check.ok) {
      const status = check.error === 'not_a_backup'
        ? HTTP_CONFLICT
        : HTTP_BAD_REQUEST;
      return res.status(status).json({ error: check.error });
    }
    const target = path.join(dataDir, req.params.name);
    if (!statOrNull(target)) {
      return res.status(HTTP_NOT_FOUND).json({ error: 'snapshot_not_found' });
    }
    try {
      fs.unlinkSync(target);
    } catch (err) {
      console.error(
        `[backups] delete failed name=${req.params.name}: ${err.code || err.message}`
      );
      return res.status(HTTP_INTERNAL).json({ error: 'io_failed' });
    }
    console.log(
      `[backups] delete base=${check.parsed.base} kind=${check.parsed.kind}`
    );
    return res.status(HTTP_OK).json({ deleted: req.params.name });
  };
}

// ------------------------------------------------------------------
// FACTORY
// ------------------------------------------------------------------

/**
 * Build the backups sub-router. Call once at startup.
 *
 * Example:
 *   app.use(createBackupsRouter({
 *     dataDir: path.join(ROOT, 'data'),
 *   }));
 *
 * @param {{ dataDir: string, clock?: () => Date }} opts
 *   `dataDir` -- absolute directory containing live data files and
 *                their snapshots.
 *   `clock`   -- optional injectable clock for deterministic tests.
 *                Defaults to () => new Date().
 * @returns {express.Router}
 */
function createBackupsRouter(opts) {
  if (!opts || typeof opts.dataDir !== 'string' || !opts.dataDir) {
    throw new Error('createBackupsRouter requires opts.dataDir');
  }
  const dataDir = opts.dataDir;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const router = express.Router();
  router.get('/api/backups', handleList(dataDir));
  router.post('/api/backups/create', handleCreate(dataDir, clock));
  router.post('/api/backups/restore', handleRestore(dataDir, clock));
  router.delete('/api/backups/:name', handleDelete(dataDir));
  return router;
}

module.exports = {
  createBackupsRouter,
  // Exported for unit tests / shared use.
  ALLOWED_BASES,
  BACKUP_KINDS,
  SAFE_NAME,
  parseSnapshotName,
  timestampLabel,
  validateBackupName,
  isAllowedBase,
  describeSnapshot,
  atomicCopyFile,
};
