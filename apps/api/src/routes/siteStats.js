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
  registerSiteReads(router, readLimiter, deps.siteStats);
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

/** @param {import('express').Router} router @param {import('express').RequestHandler} limit
 * @param {import('../services/siteStats').SiteStatsService} stats
 */
function registerSiteReads(router, limit, stats) {
  const { landing } = stats;
  /** @type {[string, () => Promise<unknown>, string][]} */
  const routes = [
    ["/site/stats", () => stats.counts(), "no-store"],
    ["/site/totals", () => landing.totals(), "public, s-maxage=3600"],
    ["/site/guide-trends", async () => ({ items: await landing.trends() }), "public, s-maxage=3600"],
    ["/site/community-builds", async () => ({ items: await landing.communityBuilds() }), "no-store"],
    ["/site/latest-answered", async () => ({ item: await landing.latestAnswered() }), "public, s-maxage=60"],
  ];
  for (const [path, read, cache] of routes) {
    router.get(path, limit, async (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      try {
        const data = await read();
        res.set("Cache-Control", cache).json(data);
      } catch (err) {
        next(err);
      }
    });
  }
}

module.exports = { buildSiteStatsRouter };
