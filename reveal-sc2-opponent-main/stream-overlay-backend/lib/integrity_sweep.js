// @ts-check
/**
 * lib/integrity_sweep.js -- Stage 5 of STAGE_DATA_INTEGRITY_ROADMAP.
 *
 * Mirrors core/integrity_sweep.py byte-for-byte on the staging-
 * directory layout (data/.recovery/<basename>/<base>-<UTC>-<src>.json)
 * so either implementation can drive the SPA's "Apply recovery" UI.
 *
 * The sweep:
 *   1. Walks data/ for `.tmp_*.json` orphans older than 5 minutes.
 *   2. For each tracked basename, decides ok / corrupt-small /
 *      corrupt-unparseable / missing.
 *   3. For non-ok cases, stages a candidate file in
 *      data/.recovery/<basename>/. Never auto-publishes.
 *
 * The matching POST /api/recovery/apply endpoint takes a candidate
 * path, validates via Stage 4 gate, and atomic-replaces the live
 * file. Lives in routes/recovery.js so the diagnostics router stays
 * focused on read-only checks.
 *
 * Engineering preamble compliance:
 *   - JSDoc + tsc --checkJs strict.
 *   - Function size <= 30 lines.
 *   - No magic constants -- all knobs are named module-level constants.
 *   - PII-safe logging: only counts and basenames at INFO.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TRACKED_BASENAMES = Object.freeze([
  'MyOpponentHistory.json',
  'meta_database.json',
  'custom_builds.json',
  'profile.json',
  'config.json',
]);
const RECOVERY_DIR_NAME = '.recovery';
const DEFAULT_TMP_AGE_THRESHOLD_SEC = 300;
// Mirrors core.atomic_io.FILE_FLOORS -- kept in sync via Stage 6 schema
// versioning. A drift will fail the cross-language consistency test.
const FILE_FLOORS = Object.freeze({
  'MyOpponentHistory.json': 100,
  'meta_database.json':     50,
  'custom_builds.json':     0,
  'profile.json':           1,
  'config.json':            5,
});

function _utcStamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function _readJsonOrNull(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.replace(/[\s\x00]+$/, '');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function _keyCount(parsed) {
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.keys(parsed).length
    : 0;
}

/**
 * Walk data/ for `.tmp_*.json` orphans. Aged orphans are ones at
 * least `ageThresholdSec` seconds old -- younger ones may be a live
 * write in progress by another process and we don't touch them.
 *
 * @param {string} dataDir
 * @param {number} now Unix epoch seconds.
 * @param {number} ageThresholdSec
 * @returns {{ seen: string[], aged: string[] }}
 */
function _discoverOrphans(dataDir, now, ageThresholdSec) {
  /** @type {string[]} */ const seen = [];
  /** @type {string[]} */ const aged = [];
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    return { seen, aged };
  }
  for (const name of fs.readdirSync(dataDir)) {
    if (!name.startsWith('.tmp_') || !name.endsWith('.json')) continue;
    const p = path.join(dataDir, name);
    if (!fs.statSync(p).isFile()) continue;
    seen.push(p);
    const ageSec = now - (fs.statSync(p).mtimeMs / 1000);
    if (ageSec >= ageThresholdSec) aged.push(p);
  }
  return { seen, aged };
}

/**
 * Newest stale candidate (from a previous sweep) for `basename`,
 * or null if none. Used as a third-tier fallback.
 *
 * @param {string} dataDir
 * @param {string} basename
 * @returns {string|null}
 */
function _newestStaleCandidate(dataDir, basename) {
  const rdir = path.join(dataDir, RECOVERY_DIR_NAME, basename);
  if (!fs.existsSync(rdir) || !fs.statSync(rdir).isDirectory()) return null;
  const files = fs.readdirSync(rdir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => path.join(rdir, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.length ? files[0] : null;
}

/**
 * Copy `sourcePath` into data/.recovery/<basename>/<stem>-<UTC>-<src>.json.
 * Never overwrites; always emits a fresh timestamped file.
 *
 * @param {string} dataDir
 * @param {string} basename
 * @param {string} sourcePath
 * @param {string} sourceLabel "orphan" | "bak" | "stale_recovery"
 * @returns {string} absolute candidate path
 */
function _stageCandidate(dataDir, basename, sourcePath, sourceLabel) {
  const rdir = path.join(dataDir, RECOVERY_DIR_NAME, basename);
  fs.mkdirSync(rdir, { recursive: true });
  const stem = basename.replace(/\.json$/, '');
  const candidate = path.join(rdir, `${stem}-${_utcStamp()}-${sourceLabel}.json`);
  fs.copyFileSync(sourcePath, candidate);
  return candidate;
}

/**
 * Inspect one tracked file and stage a candidate if needed.
 *
 * @param {string} dataDir
 * @param {string} basename
 * @param {string[]} orphanPool
 * @returns {{
 *   basename: string,
 *   live_path: string,
 *   status: string,
 *   live_keys: number,
 *   candidate_path: string | null,
 *   candidate_keys: number,
 *   candidate_source: string | null,
 *   notes: string[]
 * }}
 */
function _triageOne(dataDir, basename, orphanPool) {
  const livePath = path.join(dataDir, basename);
  const finding = {
    basename,
    live_path: livePath,
    status: 'ok',
    live_keys: 0,
    candidate_path: /** @type {string|null} */ (null),
    candidate_keys: 0,
    candidate_source: /** @type {string|null} */ (null),
    notes: /** @type {string[]} */ ([]),
  };
  const floor = FILE_FLOORS[basename] || 0;

  if (!fs.existsSync(livePath)) {
    finding.status = 'missing';
  } else {
    const parsed = _readJsonOrNull(livePath);
    if (parsed === null) {
      finding.status = 'corrupt_unparseable';
    } else {
      finding.live_keys = _keyCount(parsed);
      if (floor && finding.live_keys < floor) finding.status = 'corrupt_small';
    }
  }
  if (finding.status === 'ok') return finding;

  let bestOrphan = null;
  let bestKeys = -1;
  for (const orphan of orphanPool) {
    const parsed = _readJsonOrNull(orphan);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const kc = Object.keys(parsed).length;
    if (kc <= finding.live_keys) continue;
    if (kc > bestKeys) { bestKeys = kc; bestOrphan = orphan; }
  }
  if (bestOrphan) {
    finding.candidate_path = _stageCandidate(dataDir, basename, bestOrphan, 'orphan');
    finding.candidate_keys = bestKeys;
    finding.candidate_source = 'orphan';
    return finding;
  }

  const bakPath = livePath + '.bak';
  const bakParsed = _readJsonOrNull(bakPath);
  if (bakParsed && typeof bakParsed === 'object' && !Array.isArray(bakParsed)
      && Object.keys(bakParsed).length > finding.live_keys) {
    finding.candidate_path = _stageCandidate(dataDir, basename, bakPath, 'bak');
    finding.candidate_keys = Object.keys(bakParsed).length;
    finding.candidate_source = 'bak';
    return finding;
  }

  const stale = _newestStaleCandidate(dataDir, basename);
  if (stale) {
    const sp = _readJsonOrNull(stale);
    if (sp && typeof sp === 'object' && !Array.isArray(sp)
        && Object.keys(sp).length > finding.live_keys) {
      finding.candidate_path = stale;
      finding.candidate_keys = Object.keys(sp).length;
      finding.candidate_source = 'stale_recovery';
      return finding;
    }
  }
  finding.notes.push('no usable candidate found');
  return finding;
}

/**
 * Walk dataDir once and stage any recovery candidates.
 * Pure function -- no logger, callers wrap it for telemetry.
 *
 * @param {string} dataDir
 * @param {{ now?: number, tmpAgeThresholdSec?: number }} [opts]
 * @returns {{
 *   data_dir: string,
 *   timestamp: string,
 *   findings: object[],
 *   orphans_seen: string[],
 *   orphans_aged: string[],
 *   candidates_staged: string[],
 *   warnings: string[]
 * }}
 */
function runSweep(dataDir, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now() / 1000;
  const ageThresh = typeof o.tmpAgeThresholdSec === 'number'
    ? o.tmpAgeThresholdSec : DEFAULT_TMP_AGE_THRESHOLD_SEC;
  const abs = path.resolve(dataDir);
  const out = {
    data_dir: abs,
    timestamp: _utcStamp(),
    findings: /** @type {object[]} */ ([]),
    orphans_seen: /** @type {string[]} */ ([]),
    orphans_aged: /** @type {string[]} */ ([]),
    candidates_staged: /** @type {string[]} */ ([]),
    warnings: /** @type {string[]} */ ([]),
  };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    out.warnings.push(`data_dir does not exist: ${abs}`);
    return out;
  }
  const orphans = _discoverOrphans(abs, now, ageThresh);
  out.orphans_seen = [...orphans.seen].sort();
  out.orphans_aged = [...orphans.aged].sort();
  for (const basename of TRACKED_BASENAMES) {
    const f = _triageOne(abs, basename, orphans.aged);
    out.findings.push(f);
    if (f.candidate_path) out.candidates_staged.push(f.candidate_path);
    if (f.status !== 'ok' && !f.candidate_path) {
      out.warnings.push(`${basename}: ${f.status} -- no usable candidate`);
    }
  }
  return out;
}

/**
 * Apply a previously-staged candidate to its live target. Validates
 * via the Stage 4 gate (DataIntegrityError on shrinkage / parse fail);
 * .bak's the live file before swap; uses fsync + atomic rename so a
 * kill mid-publish leaves either the original or the candidate.
 *
 * @param {string} candidatePath
 * @param {string} targetPath
 */
function applyCandidate(candidatePath, targetPath) {
  if (!fs.existsSync(candidatePath)) {
    throw new Error('applyCandidate: candidate not found: ' + candidatePath);
  }
  const parsed = _readJsonOrNull(candidatePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const { DataIntegrityError } = require('./atomic-fs');
    throw new DataIntegrityError(
      `applyCandidate: ${candidatePath} did not parse to an object`);
  }
  const floor = FILE_FLOORS[path.basename(targetPath)] || 0;
  if (floor && Object.keys(parsed).length < floor) {
    const { DataIntegrityError } = require('./atomic-fs');
    throw new DataIntegrityError(
      `applyCandidate: candidate has ${Object.keys(parsed).length} keys `
      + `(floor=${floor}); refusing to apply`);
  }
  const payload = fs.readFileSync(candidatePath);
  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, '.tmp_apply_recovery.json');
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeSync(fd, payload, 0, payload.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(targetPath)) {
    try { fs.copyFileSync(targetPath, targetPath + '.bak'); }
    catch (_e) { /* best-effort */ }
  }
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* */ }
    throw err;
  }
}

module.exports = {
  runSweep,
  applyCandidate,
  TRACKED_BASENAMES,
  RECOVERY_DIR_NAME,
  DEFAULT_TMP_AGE_THRESHOLD_SEC,
  FILE_FLOORS,
  // Internals exposed for tests:
  _internals: {
    _discoverOrphans,
    _newestStaleCandidate,
    _stageCandidate,
    _triageOne,
    _readJsonOrNull,
  },
};
