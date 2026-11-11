"use strict";

const express = require("express");
const { parseCohortQuery } = require("../services/classifierQuality");

/**
 * /v1/admin/classifier — check-in correction aggregates (docs/classifier-quality.md).
 * Mounted beneath the parent's authenticated admin gate. Read-only: the
 * console's only write is the existing audited "Run now" on the
 * classifier-quality job (POST /v1/admin/jobs/classifier-quality/run).
 *
 *   GET /            newest snapshot narrowed by ?axis=&matchup=&engine=
 *   GET /samples     ?axis=&matchup=&detected=&declared= — up to 20 recent
 *                    games behind one published pair, identity-free
 *
 * @param {{ classifierQuality: import('../services/classifierQuality').ClassifierQualityService }} deps
 */
function buildAdminClassifierRouter(deps) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.get("/", async (req, res, next) => {
    try { res.json(await deps.classifierQuality.consoleView(parseCohortQuery(req.query))); }
    catch (error) { next(error); }
  });
  router.get("/samples", async (req, res, next) => {
    try {
      const pair = /** @type {any} */ (parseCohortQuery(req.query, { requirePair: true }));
      res.json(await deps.classifierQuality.samples(pair));
    } catch (error) { next(error); }
  });
  return router;
}

/**
 * Public, cacheable trust lines for /definitions: released preset labels
 * only, each with at least the k-floor of distinct users. Counts, no ids.
 *
 * @param {Pick<import('../services/classifierQuality').ClassifierQualityService, 'publicTrust'>} classifierQuality
 */
function buildClassifierTrustRouter(classifierQuality) {
  const router = express.Router();
  router.get("/classifier-quality/labels", async (_req, res, next) => {
    try {
      res.set("Cache-Control", "public, max-age=3600, stale-if-error=86400");
      res.json(await classifierQuality.publicTrust());
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { buildAdminClassifierRouter, buildClassifierTrustRouter };
