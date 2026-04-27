/**
 * DIAGNOSTICS BUNDLE STREAMER (Stage 4)
 * ============================================================
 * Streams a redacted .zip "support bundle" containing:
 *
 *   profile.redacted.json     -- profile.json with PII keys masked
 *   config.redacted.json      -- config.json with secrets masked
 *   diagnostics.json          -- the 13 check results plus runtime metadata
 *   replay_errors.tail.log    -- last 64KB of data/replay_errors.log
 *   analyzer.tail.log         -- last 64KB of data/analyzer.log
 *
 * `archiver` is required lazily so a missing devDependency only breaks
 * the bundle endpoint, not the live diagnostics page.
 *
 * Example:
 *   const { streamBundle } = require('./diagnostics_bundle');
 *   await streamBundle(res, deps, checks);
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REDACT_PLACEHOLDER, ENV_REDACT_KEYS,
  redact, readJsonOrNull,
} = require('./diagnostics_helpers');

const PROFILE_FILE = 'profile.json';
const CONFIG_FILE = 'config.json';
const REPLAY_ERRORS_LOG = 'replay_errors.log';
const ANALYZER_LOG = 'analyzer.log';

const HTTP_INTERNAL = 500;
const LOG_TAIL_BUFFER_BYTES = 64 * 1024;
const ZIP_COMPRESSION_LEVEL = 9;

/**
 * Stream the bundle to the client. Always re-runs the checks (no cache)
 * so the bundle reflects the moment the user clicked the button.
 *
 * @param {import('express').Response} res
 * @param {object} deps
 * @param {object[]} checks
 * @returns {Promise<void>}
 */
async function streamBundle(res, deps, checks) {
  let archiver;
  try { archiver = require('archiver'); }
  catch (_err) {
    res.status(HTTP_INTERNAL).json({
      error: 'archiver_missing',
      message: 'archiver is not installed. Run `npm install` from '
        + 'stream-overlay-backend/ and try again.' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    'attachment; filename="sc2tools-diagnostics.zip"');
  const archive = archiver('zip', { zlib: { level: ZIP_COMPRESSION_LEVEL } });
  archive.on('error', (err) => { try { res.destroy(err); } catch (_e) {} });
  archive.pipe(res);
  appendBundleEntries(archive, deps, checks);
  await archive.finalize();
}

/**
 * Append every file the bundle contains. Mutates `archive`.
 *
 * @param {object} archive
 * @param {object} deps
 * @param {object[]} checks
 */
function appendBundleEntries(archive, deps, checks) {
  const profile = readBundleJson(path.join(deps.dataDir, PROFILE_FILE));
  const config = readBundleJson(path.join(deps.dataDir, CONFIG_FILE));
  archive.append(JSON.stringify(redact(profile), null, 2),
    { name: 'profile.redacted.json' });
  archive.append(JSON.stringify(redact(config), null, 2),
    { name: 'config.redacted.json' });
  archive.append(JSON.stringify(buildDiagnosticsManifest(deps, checks), null, 2),
    { name: 'diagnostics.json' });
  appendLogTail(archive, path.join(deps.dataDir, REPLAY_ERRORS_LOG),
    'replay_errors.tail.log');
  appendLogTail(archive, path.join(deps.dataDir, ANALYZER_LOG),
    'analyzer.tail.log');
}

/**
 * Compose the runtime manifest stored as diagnostics.json in the bundle.
 *
 * @param {object} deps
 * @param {object[]} checks
 * @returns {object}
 */
function buildDiagnosticsManifest(deps, checks) {
  const envSlice = ENV_REDACT_KEYS.reduce((acc, k) => {
    acc[k] = deps.env[k] ? REDACT_PLACEHOLDER : null;
    return acc;
  }, {});
  return {
    generated_at: new Date().toISOString(),
    node_version: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    env_redacted: envSlice,
    checks,
  };
}

/**
 * Read a JSON bundle source file. Falls back to {} on a missing file
 * or a parse error so the bundle always emits a valid, redacted JSON
 * for every entry.
 *
 * @param {string} filePath
 * @returns {object}
 */
function readBundleJson(filePath) {
  try {
    const v = readJsonOrNull(filePath);
    return v && typeof v === 'object' ? v : {};
  } catch (_err) {
    return {};
  }
}

/**
 * Append the trailing 64KB of a log file to the archive (or a stub
 * notice when the file is missing).
 *
 * @param {object} archive
 * @param {string} src
 * @param {string} entryName
 */
function appendLogTail(archive, src, entryName) {
  if (!fs.existsSync(src)) {
    archive.append(`# ${path.basename(src)} did not exist at bundle time`,
      { name: entryName });
    return;
  }
  const sz = fs.statSync(src).size;
  const start = Math.max(0, sz - LOG_TAIL_BUFFER_BYTES);
  archive.append(fs.createReadStream(src, { start, end: sz }),
    { name: entryName });
}

module.exports = {
  streamBundle,
  // Exported for tests:
  _internals: {
    appendBundleEntries, appendLogTail, buildDiagnosticsManifest,
    readBundleJson,
  },
};
