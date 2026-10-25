"use strict";
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { sha256 } = require("../util/hash");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/** @param {{auth:import('express').RequestHandler,
 * automation:import('../services/twitchAutomation').TwitchAutomationService,
 * status:import('../services/twitchAutomationStatus').TwitchAutomationStatus,
 * tokens:import('../services/overlayTokens').OverlayTokensService}} deps */
function buildTwitchAutomationRouter(deps) {
  const router = express.Router();
  /** @param {string} lane @param {number} max @param {number} windowMs */
  const limiter = (lane, max, windowMs) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    /** @param {import('express').Request} req */
    keyGenerator: req => `twitch-automation:${lane}:${sha256(String(req.params.token || req.auth?.userId || ""))}` });
  router.use(["/me/twitch-automation", "/multichat/:token/twitch-automation"], (_req, res, next) => { res.set("Cache-Control", "private, no-store"); res.vary("Authorization"); next(); });
  router.get("/me/twitch-automation", deps.auth, limiter("settings", 12, 60_000), async (req, res, next) => {
    try {
      if (req.auth?.source !== "clerk") { res.status(403).json({ error: { code: "clerk_required" } }); return; }
      res.json(await deps.status.get(req.auth.userId, true));
    } catch (error) { next(error); }
  });
  /** @type {import('express').RequestHandler} */
  const tokenAuth = async (req, res, next) => {
    try {
      const owner = await deps.tokens.resolve(String(req.params.token));
      if (!owner) { res.status(401).json({ error: { code: await deps.tokens.isReplaced?.(String(req.params.token)) ? "overlay_token_replaced" : "invalid_overlay_token" } }); return; }
      res.locals.twitchOwner = owner.userId; next();
    } catch (error) { next(error); }
  };
  router.get("/multichat/:token/twitch-automation", tokenAuth, limiter("status", 1, 5000), async (req, res, next) => {
    try {
      const status = await deps.status.get(res.locals.twitchOwner, false);
      const owner = await deps.tokens.resolve(String(req.params.token));
      if (!owner || owner.userId !== res.locals.twitchOwner) { res.status(401).json({ error: { code: await deps.tokens.isReplaced?.(String(req.params.token)) ? "overlay_token_replaced" : "invalid_overlay_token" } }); return; }
      res.json({ current: status.current, reason: status.reason, serverEnabled: status.serverEnabled, predictionPermission: status.predictionPermission,
        rankedQueueSupported: status.rankedQueueSupported, capabilityReason: status.capabilityReason,
        predictionsEnabled: status.preferences.predictionsEnabled, markersEnabled: status.preferences.markersEnabled });
    } catch (error) { next(error); }
  });
  router.post("/multichat/:token/twitch-automation", tokenAuth, limiter("action", 6, 60_000), async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || Object.keys(body).some(key => !["action", "gameKey", "confirmed"].includes(key)) || !["cancel", "resolve"].includes(body.action)
        || typeof body.gameKey !== "string" || !body.gameKey || body.gameKey.length > 120 || /[\p{Cc}]/u.test(body.gameKey) || body.confirmed !== true) {
        res.status(400).json({ error: { code: "invalid_twitch_action", message: "Confirm a supported action for this prediction." } }); return;
      }
      const result = await deps.tokens.withWrite(String(req.params.token), async () => {
        const owner = await deps.tokens.resolve(String(req.params.token));
        if (!owner || owner.userId !== res.locals.twitchOwner) throw Object.assign(new Error("Overlay token changed."), { status: 401, code: "invalid_overlay_token" });
        return deps.automation.action(owner.userId, body.gameKey, body.action);
      });
      if (!result) { res.status(404).json({ error: { code: "twitch_prediction_unavailable" } }); return; }
      res.json({ current: { gameKey: body.gameKey, ...result } });
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { buildTwitchAutomationRouter };
