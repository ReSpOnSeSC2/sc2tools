"use strict";
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { sha256 } = require("../util/hash");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { readOverlayPresence } = require("../services/overlayPresence");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/** @param {{auth:import('express').RequestHandler,overlayTokens:Pick<import('../services/types').OverlayTokensService,'resolve'|'tokenBelongsToUser'>,io?:import('socket.io').Server,liveGameBroker?:import('../services/liveGameBroker').LiveGameBroker}} deps */
function buildOverlayPresenceRouter(deps) {
  const router = express.Router();
  router.use(["/overlay-tokens/:token/presence", "/multichat/:token/presence"], (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  const limiter = rateLimit({ windowMs: 5000, max: 1, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    /** @param {import('express').Request} req */
    keyGenerator: req => `overlay-presence:${sha256(String(req.params.token))}`,
  });
  /** @type {import('express').RequestHandler} */
  const owned = async (req, res, next) => {
    try {
      if (!req.auth || !await deps.overlayTokens.tokenBelongsToUser(req.auth.userId, String(req.params.token))) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.locals.presenceUserId = req.auth.userId; next();
    } catch (error) { next(error); }
  };
  /** Counts-only Dock access uses its existing bearer credential, never a
   * Clerk session or a caller-supplied owner. Revoke stops future reads.
   * @type {import('express').RequestHandler} */
  const dock = async (req, res, next) => {
    try {
      const owner = await deps.overlayTokens.resolve(String(req.params.token));
      if (!owner) { res.status(401).json({ error: { code: "invalid_overlay_token" } }); return; }
      res.locals.presenceUserId = owner.userId; next();
    } catch (error) { next(error); }
  };
  /** @param {boolean} countsOnly @returns {import('express').RequestHandler} */
  const respond = countsOnly => async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const snapshot = await readOverlayPresence(deps.io, String(req.params.token), res.locals.presenceUserId, deps.liveGameBroker);
      res.json(countsOnly ? { surfaces: Object.fromEntries(Object.entries(snapshot.surfaces).map(([id, value]) => [id, value.count])), totalSources: snapshot.totalSources, sampledAt: snapshot.sampledAt } : snapshot);
    } catch (error) { next(error); }
  };
  // Ownership/token validation happens before admission: strangers cannot
  // spend this token's five-second budget. Both views share one limiter.
  router.get("/overlay-tokens/:token/presence", deps.auth, owned, limiter, respond(false));
  router.get("/multichat/:token/presence", dock, limiter, respond(true));
  return router;
}
module.exports = { buildOverlayPresenceRouter };
