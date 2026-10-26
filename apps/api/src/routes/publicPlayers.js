"use strict";
const express = require("express");
const RateLimitModule = require("express-rate-limit");
const rateLimit = /** @type {any} */ (RateLimitModule).default || RateLimitModule;

/** Each surface has its own explicit consent gate. No router-wide auth.
 * @param {{players:import('../services/publicPlayer').PublicPlayerService,preferences:import('../services/publicPlayerPreferences').PublicPlayerPreferencesService,auth:import('express').RequestHandler,rateLimitPerMinute?:number}} deps */
function buildPublicPlayersRouter(deps) {
  const router = express.Router();
  const limit = rateLimit({ windowMs: 60_000, max: deps.rateLimitPerMinute || 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (/** @type {import('express').Request} */ req) => `${req.ip}:${String(req.params.slug || "").toLowerCase()}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } } });
  router.get("/public/players-sitemap", limit, async (_req, res, next) => {
    try { res.set("Cache-Control", "no-store"); res.json(await deps.players.sitemap()); } catch (error) { next(error); }
  });
  router.get("/public/players/:slug", limit, async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      const value = await deps.players.get(String(req.params.slug));
      if (!value) return res.status(404).json({ error: { code: "profile_not_found", message: "This player page is private or doesn't exist." } });
      res.json(value);
    } catch (error) { next(error); }
  });
  router.get("/me/public-profile", deps.auth, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store"); res.json(await deps.preferences.get(owner(req))); } catch (error) { next(error); }
  });
  router.get("/me/public-profile/slug", deps.auth, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store"); res.json(await deps.preferences.availability(owner(req), req.query.slug)); } catch (error) { next(error); }
  });
  router.put("/me/public-profile", deps.auth, (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (req.auth?.source !== "clerk") {
      res.status(403).json({ error: { code: "clerk_required", message: "Change public-profile settings on the website." } });
      return;
    }
    next();
  }, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store"); res.json(await deps.preferences.set(owner(req), req.body)); } catch (error) { next(error); }
  });
  return router;
}
/** @param {import('express').Request} req */
function owner(req) { if (!req.auth) throw Object.assign(new Error("auth_required"), { status: 401 }); return req.auth.userId; }
module.exports = { buildPublicPlayersRouter };
