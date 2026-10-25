"use strict";
const express = require("express");
const { parseFilters } = require("../util/parseQuery");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;
/** @param {{rivals:import('../services/rivals').RivalsService,auth:import('express').RequestHandler}} deps */
function buildRivalsRouter(deps) {
  const router = express.Router();
  const limit = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, store: new BoundedRateLimitStore({ maxEntries: 4096 }), keyGenerator: (/** @type {import('express').Request} */ req) => req.auth?.userId || "signed-out", message: { error: { code: "rivals_rate_limited", message: "Please wait a moment before refreshing rival details." } } });
  router.post("/rivals/summary", deps.auth, limit, async (req,res,next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.rivals.summary(req.auth.userId, req.body?.groups, parseFilters(req.query)));
    } catch (error) { next(error); }
  });
  router.get("/opponents/:pulseId/rival-key", deps.auth, async (req,res,next) => {
    try {
      if (!req.auth) throw new Error("auth_required");
      const id = String(req.params.pulseId);
      res.set("Cache-Control", "private, no-store");
      const result = id.length <= 160 ? await deps.rivals.identityKeys(req.auth.userId, id) : null;
      if (!result) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.json(result);
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { buildRivalsRouter };
