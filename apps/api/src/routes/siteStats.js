"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");

const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * Public, aggregate-only statistics. Presence is anonymous unless an actual
 * Clerk browser session is provided; body-supplied account IDs are ignored.
 * @param {{siteStats: import('../services/siteStats').SiteStatsService, auth: import('express').RequestHandler}} deps
 */
function buildSiteStatsRouter(deps) {
  const router = express.Router();
  const issuanceLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    skip: (/** @type {import('express').Request} */ req) =>
      Boolean(deps.siteStats.parseVisitorToken(req.body?.visitorToken)),
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
  const visitorLimiter = rateLimit({
    windowMs: 60_000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    skip: (/** @type {import('express').Request} */ req) =>
      !deps.siteStats.parseVisitorToken(req.body?.visitorToken),
    // Unsigned identifiers cannot create arbitrary per-visitor buckets.
    keyGenerator: (/** @type {import('express').Request} */ req) => {
      const id = deps.siteStats.parseVisitorToken(req.body?.visitorToken);
      return id ? deps.siteStats.hash(`rate-limit:${id}`) : `new:${req.ip}`;
    },
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: 6000,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
  router.get("/site/stats", readLimiter, async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(await deps.siteStats.counts());
    } catch (err) {
      next(err);
    }
  });

  router.post("/site/presence", express.json({ limit: "1kb" }), issuanceLimiter, visitorLimiter,
    (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (req.headers.authorization) return deps.auth(req, res, next);
      next();
    },
    async (req, res, next) => {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)
        || (body.visitorToken !== undefined && typeof body.visitorToken !== "string")) {
        res.status(400).json({ error: { code: "invalid_presence_request" } });
        return;
      }
      if (req.auth && req.auth.source !== "clerk") {
        res.status(403).json({ error: { code: "browser_session_required" } });
        return;
      }
      try {
        res.json(await deps.siteStats.recordPresence(body.visitorToken, req.auth?.clerkUserId || null));
      } catch (err) {
        next(err);
      }
    },
  );
  return router;
}

module.exports = { buildSiteStatsRouter };
