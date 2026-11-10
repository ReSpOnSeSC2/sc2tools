"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");

/**
 * /v1/me/reanalysis — the owner's re-analysis center.
 *
 *   GET  /         cohorts with counts, the latest job, agent readiness
 *   POST /         {cohortId}  start a job (one active per owner)
 *   POST /pause    {jobId}
 *   POST /resume   {jobId}
 *   POST /cancel   {jobId}
 *
 * Signed-in web sessions only; the owner comes from authentication, never
 * the request. Responses are private and never cached.
 *
 * @param {{auth: import('express').RequestHandler, reanalysis: import('../services/reanalysis').ReanalysisService}} deps
 */
function buildReanalysisRouter(deps) {
  const router = express.Router();
  /** @type {import('express').RequestHandler} */
  const owner = (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.auth?.userId || req.auth.source !== "clerk") {
      res.status(403).json({ error: { code: "reanalysis_owner_session_required" } });
      return;
    }
    if (Object.keys(req.query).length) {
      res.status(400).json({ error: { code: "reanalysis_request_invalid" } });
      return;
    }
    next();
  };
  /** @param {number} limit */
  const limiter = (limit) => rateLimit({
    windowMs: 60_000, limit, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.userId), store: new BoundedRateLimitStore({ maxEntries: 4096 }),
  });
  /** @param {(userId: string, body: unknown) => Promise<unknown>} run @param {number} [status] */
  const handle = (run, status = 200) => /** @type {import('express').RequestHandler} */ (async (req, res, next) => {
    try { res.status(status).json(await run(String(req.auth?.userId), req.body)); } catch (error) { next(error); }
  });

  router.get("/", deps.auth, owner, limiter(60), handle((userId) => deps.reanalysis.overview(userId)));
  router.post("/", deps.auth, owner, limiter(10), handle((userId, body) => deps.reanalysis.start(userId, body), 201));
  for (const action of /** @type {const} */ (["pause", "resume", "cancel"])) {
    router.post(`/${action}`, deps.auth, owner, limiter(30), handle((userId, body) => deps.reanalysis.control(userId, action, body)));
  }
  return router;
}

module.exports = { buildReanalysisRouter };
