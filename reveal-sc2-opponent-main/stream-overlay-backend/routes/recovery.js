// @ts-check
'use strict';

/**
 * routes/recovery.js -- Stage 5 of STAGE_DATA_INTEGRITY_ROADMAP.
 *
 * Two endpoints powering the SPA's "Apply recovery" UI:
 *
 *   GET  /api/recovery        -> { candidates: [...], orphans: [...], findings: [...] }
 *      Re-runs the integrity sweep and reports the current state. Cheap;
 *      the SPA polls this view every time the user opens the page.
 *
 *   POST /api/recovery/apply  -> { applied: { from: ..., to: ... } }
 *      Body: { "candidate_path": "...", "target_path": "..." (optional) }
 *      Promotes a previously-staged candidate to its live target via
 *      the Stage 4 atomic publish + validate-before-rename gate.
 *
 * Production characteristics:
 *   - The candidate path is always validated to live UNDER
 *     <dataDir>/.recovery/. We refuse anything outside that subtree
 *     so a malicious or buggy SPA can't cause an arbitrary file copy.
 *   - The target path defaults to <dataDir>/<basename>.json with
 *     basename derived from the candidate's parent dir; explicit
 *     `target_path` is honoured but is also validated to live in
 *     <dataDir>.
 *   - Apply runs through Stage 4's atomic write + shrinkage floor
 *     so a corrupted candidate cannot replace a healthy live file.
 *   - PII-safe: only basenames + counts go into the JSON response.
 *
 * Mounted by index.js once Stage 5 lands; tested in
 * __tests__/recovery.test.js.
 *
 * @example
 *   const { createRecoveryRouter } = require('./routes/recovery');
 *   app.use(createRecoveryRouter({ dataDir: '/abs/path/to/data' }));
 */

const path = require('path');
const express = require('express');
const fs = require('fs');

const integritySweep = require('../lib/integrity_sweep');
const { DataIntegrityError } = require('../lib/atomic-fs');
const metrics = require('../lib/data_integrity_metrics');

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL = 500;

/**
 * Resolve a possibly-relative path to absolute, then assert it is
 * under `root`. Returns the absolute path on success; throws Error
 * on path traversal so the route handler can return 400.
 *
 * @param {string} inputPath
 * @param {string} root
 * @returns {string}
 */
function _resolveUnderRoot(inputPath, root) {
  const abs = path.resolve(inputPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path is outside data dir');
  }
  return abs;
}

/**
 * Compute a sensible default target path from a candidate path.
 * Candidates live under <dataDir>/.recovery/<basename.json>/...; the
 * default target is <dataDir>/<basename.json>.
 *
 * @param {string} candidate
 * @param {string} dataDir
 * @returns {string}
 */
function _defaultTarget(candidate, dataDir) {
  const recoveryRoot = path.join(dataDir, integritySweep.RECOVERY_DIR_NAME);
  const rel = path.relative(recoveryRoot, candidate);
  // rel = "<basename.json>/<stem>-<UTC>-<src>.json"
  const baseDir = rel.split(path.sep)[0];
  if (!baseDir) throw new Error('candidate not under .recovery/');
  return path.join(dataDir, baseDir);
}

/**
 * Express router factory. Pass the absolute path of the data dir.
 *
 * @param {{ dataDir: string }} options
 * @returns {express.Router}
 */
function createRecoveryRouter(options) {
  if (!options || !options.dataDir) {
    throw new Error('createRecoveryRouter: dataDir is required');
  }
  const dataDir = path.resolve(options.dataDir);
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/api/recovery', (_req, res) => {
    try {
      const report = integritySweep.runSweep(dataDir);
      // Strip absolute paths down to basenames in the response so we
      // don't leak server-side filesystem layout to the SPA. Internal
      // candidate paths are echoed back to the SPA exactly so it can
      // post them straight back to /apply -- they are already gated
      // by the under-root check at apply time.
      const sanitized = {
        timestamp: report.timestamp,
        orphans_seen: report.orphans_seen.map((p) => path.basename(p)),
        orphans_aged: report.orphans_aged.map((p) => path.basename(p)),
        warnings: report.warnings,
        findings: report.findings.map((f) => ({
          basename: f.basename,
          status: f.status,
          live_keys: f.live_keys,
          candidate_keys: f.candidate_keys,
          candidate_source: f.candidate_source,
          // The candidate path is the only field we expose verbatim
          // (because the SPA sends it back to /apply). Already
          // root-checked above by the sweep's _stageCandidate.
          candidate_path: f.candidate_path,
        })),
      };
      res.json(sanitized);
    } catch (err) {
      res.status(HTTP_INTERNAL).json({
        error: 'sweep_failed', message: String(err && err.message || err),
      });
    }
  });

  router.post('/api/recovery/apply', (req, res) => {
    const body = req.body || {};
    const candidatePath = body.candidate_path;
    const explicitTarget = body.target_path;

    if (typeof candidatePath !== 'string' || !candidatePath) {
      res.status(HTTP_BAD_REQUEST).json({
        error: 'missing_candidate_path',
      });
      return;
    }

    let absCandidate;
    let absTarget;
    try {
      absCandidate = _resolveUnderRoot(candidatePath, dataDir);
      const recoveryRoot = path.join(dataDir, integritySweep.RECOVERY_DIR_NAME);
      if (!absCandidate.startsWith(recoveryRoot + path.sep)) {
        throw new Error('candidate must live under .recovery/');
      }
      absTarget = explicitTarget
        ? _resolveUnderRoot(explicitTarget, dataDir)
        : _defaultTarget(absCandidate, dataDir);
    } catch (err) {
      res.status(HTTP_FORBIDDEN).json({
        error: 'invalid_path', message: String(err && err.message || err),
      });
      return;
    }

    if (!fs.existsSync(absCandidate)) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'candidate_not_found' });
      return;
    }

    try {
      integritySweep.applyCandidate(absCandidate, absTarget);
      metrics.counterInc('recovery_applied', {
        basename: path.basename(absTarget),
      });
      res.json({
        applied: {
          from: path.relative(dataDir, absCandidate),
          to: path.relative(dataDir, absTarget),
        },
      });
    } catch (err) {
      const status = err instanceof DataIntegrityError
        ? HTTP_BAD_REQUEST : HTTP_INTERNAL;
      metrics.error(
        err instanceof DataIntegrityError
          ? 'recovery_apply_integrity'
          : 'recovery_apply_failed',
        { detail: { target: path.basename(absTarget), message: err.message } },
      );
      res.status(status).json({
        error: err instanceof DataIntegrityError ? 'integrity_violation'
          : 'apply_failed',
        message: String(err && err.message || err),
      });
    }
  });

  // Stage 7 of STAGE_DATA_INTEGRITY_ROADMAP -- metrics endpoint for
  // the SPA's "write health" dashboard widget.
  router.get('/api/data-integrity/metrics', (_req, res) => {
    res.json(metrics.snapshot());
  });

  return router;
}

module.exports = {
  createRecoveryRouter,
  _internals: { _resolveUnderRoot, _defaultTarget },
};
