// @ts-check
/**
 * ATOMIC FILE WRITES
 * ============================================================
 * Single source of truth for the write-tmp + fsync + rename
 * pattern that Hard Rule #4 in the master preamble mandates for
 * every data/* mutation. Centralising the pattern here lets every
 * caller share one battle-tested implementation -- no more
 * scattered fs.writeFileSync calls leaving partial bytes on
 * crash, no more r+ open modes that silently preserve old length
 * and pad the new content with NULs.
 *
 * Three primitives, one for each common write payload:
 *   atomicWriteJson(path, data)       -- pretty-printed JSON
 *   atomicWriteString(path, str, opts) -- arbitrary text
 *   atomicWriteBuffer(path, buf, opts) -- arbitrary binary
 *
 * All three follow the same sequence:
 *   1. Write payload to <path>.tmp with a FRESH 'w' descriptor
 *      (truncates any existing tmp -- never r+).
 *   2. fsync the descriptor so the bytes hit the platter, not
 *      just the page cache.
 *   3. Close the descriptor.
 *   4. Rename tmp -> path. POSIX guarantees rename atomicity on
 *      the same filesystem; on Windows, NTFS provides equivalent
 *      semantics for non-cross-volume renames.
 *
 * The 'w' flag is essential -- it truncates on open. The classic
 * partial-write failure mode we hit during this engineering pass
 * was an r+ open that wrote 34 bytes of new JSON then left 1177
 * bytes of stale data behind because the file's previous length
 * was preserved. 'w' makes that physically impossible.
 *
 * On any error, the .tmp file is best-effort cleaned up so the
 * directory doesn't accumulate junk. Errors propagate -- callers
 * are expected to wrap in their own structured handling.
 *
 * Engineering preamble compliance:
 *   - Functions <= 30 lines.
 *   - Type hints via JSDoc, validated by tsc --checkJs in CI.
 *   - No magic numbers; all options have named defaults.
 *   - Narrow catches; no swallowed exceptions.
 *
 * Example:
 *   const { atomicWriteJson } = require('./lib/atomic-fs');
 *   atomicWriteJson('/data/profile.json', { version: 1, ... });
 */

'use strict';

const fs = require('fs');

const TMP_SUFFIX = '.tmp';
const DEFAULT_JSON_INDENT = 2;
const DEFAULT_ENCODING = 'utf8';

/**
 * Write a JSON-serialisable value to disk atomically.
 *
 * Example:
 *   atomicWriteJson('/data/config.json', { version: 1, ui: {} });
 *
 * @param {string} filePath Absolute destination path.
 * @param {unknown} data    JSON.stringify-able value.
 * @param {{indent?: number}} [options]
 * @returns {void}
 */
function atomicWriteJson(filePath, data, options) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('atomicWriteJson: filePath must be a non-empty string');
  }
  const indent = options && typeof options.indent === 'number'
    ? options.indent : DEFAULT_JSON_INDENT;
  const json = JSON.stringify(data, null, indent);
  atomicWriteString(filePath, json);
}

/**
 * Write an arbitrary string to disk atomically.
 *
 * Example:
 *   atomicWriteString('/data/character_ids.txt', '1-S2-1-267727');
 *
 * @param {string} filePath Absolute destination path.
 * @param {string} value Text payload.
 * @param {{encoding?: BufferEncoding, mode?: number}} [options]
 * @returns {void}
 */
function atomicWriteString(filePath, value, options) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('atomicWriteString: filePath must be a non-empty string');
  }
  if (typeof value !== 'string') {
    throw new TypeError('atomicWriteString: value must be a string');
  }
  const encoding = (options && options.encoding) || DEFAULT_ENCODING;
  const buf = Buffer.from(value, encoding);
  atomicWriteBuffer(filePath, buf, options);
}

/**
 * Write an arbitrary binary payload to disk atomically.
 *
 * Example:
 *   atomicWriteBuffer('/data/cache/map.png', pngBytes, { mode: 0o644 });
 *
 * @param {string} filePath Absolute destination path.
 * @param {Buffer} buffer   Binary payload.
 * @param {{mode?: number}} [options] Optional file mode for the final file.
 * @returns {void}
 */
function atomicWriteBuffer(filePath, buffer, options) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('atomicWriteBuffer: filePath must be a non-empty string');
  }
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('atomicWriteBuffer: buffer must be a Buffer');
  }
  const tmp = filePath + TMP_SUFFIX;
  // 'w' truncates; never use 'r+' -- that's how the partial-write
  // null-padding bug from this engineering pass happened.
  const fd = fs.openSync(tmp, 'w', (options && options.mode) || 0o644);
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup so a failed rename doesn't leave junk.
    try { fs.unlinkSync(tmp); } catch (_e) { /* tmp may be gone */ }
    throw err;
  }
}

/**
 * Quarantine a corrupt file by renaming it with a timestamped
 * .broken-<ts> suffix. Used by readers that detect bad shape on
 * disk so the next write doesn't blindly overwrite something the
 * user might want to recover.
 *
 * Example:
 *   const quarantined = quarantineCorruptFile('/data/queue.json', 'parse_error');
 *
 * @param {string} filePath Absolute path to quarantine.
 * @param {string} [reason] Short tag included in the new filename.
 * @returns {string} Absolute path of the quarantined file.
 */
function quarantineCorruptFile(filePath, reason) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('quarantineCorruptFile: filePath required');
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const tag = reason ? '-' + String(reason).replace(/[^a-z0-9]/gi, '') : '';
  const dest = `${filePath}.broken${tag}-${stamp}`;
  fs.renameSync(filePath, dest);
  return dest;
}

module.exports = {
  atomicWriteJson,
  atomicWriteString,
  atomicWriteBuffer,
  quarantineCorruptFile,
  // Constants exported for tests + tools that need to recognise tmp files.
  TMP_SUFFIX,
};
