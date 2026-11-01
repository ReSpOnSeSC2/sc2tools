"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { validText } = require("../services/privateSearchText");
const { COMMUNITY_QUICK_LIMIT } = require("../services/communityQuickSearch");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;
const QUICK_KEYS = new Set(["view", "q", "limit"]);

/**
 * 2-80 code points and at most 320 bytes after outer trimming, with no control
 * or unpaired surrogate (the private search rule), else null.
 * @param {unknown} raw @returns {string|null}
 */
function quickText(raw) {
  if (typeof raw !== "string" || !validText(raw, raw.length)) return null;
  const q = raw.trim(), points = Array.from(q).length;
  return points >= 2 && points <= 80 && Buffer.byteLength(q, "utf8") <= 320 ? q : null;
}

/**
 * The query of a quick request, or null when it is not exactly
 * {view, q[, limit]} with a valid q and a limit of 1-8 (default 8).
 * @param {Record<string, unknown>} query
 * @returns {{q: string, limit: number}|null}
 */
function parseQuickQuery(query) {
  if (!Object.keys(query).every(key => QUICK_KEYS.has(key))) return null;
  const q = quickText(query.q), limit = query.limit;
  if (q === null) return null;
  if (limit === undefined) return { q, limit: COMMUNITY_QUICK_LIMIT };
  return typeof limit === "string" && /^[1-8]$/.test(limit) ? { q, limit: Number(limit) } : null;
}

/**
 * GET /community/builds?view=quick&q=<text>[&limit=1-8]: the signed-out quick-search
 * palette's Community builds (ADR 0069, 2026-11-01 amendment). Public and anonymous,
 * no shared cache, 120 a minute per IP, fixed error codes only. Any other request,
 * including one without view=quick, continues unchanged to the directory route.
 * Example: buildCommunityQuickSearchRouter(services.community) is the community router's base.
 * @param {Pick<import('../services/community').CommunityService, 'quickSearchPublic'>} community
 */
function buildCommunityQuickSearchRouter(community) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    /** @param {import('express').Request} req */
    keyGenerator: req => `community-quick:${req.ip || "unknown"}`,
    /** @param {import('express').Request} req */
    skip: req => req.query.view !== "quick",
    /** @param {import('express').Request} _req @param {import('express').Response} res */
    handler: (_req, res) => {
      res.status(429).set("Cache-Control", "no-store").json({ error: { code: "community_search_rate_limited" } });
    },
  });
  router.get("/community/builds", limiter, async (req, res, next) => {
    if (req.query.view !== "quick") { next(); return; }
    res.set("Cache-Control", "no-store");
    const parsed = parseQuickQuery(req.query);
    if (!parsed) {
      res.status(400).json({ error: { code: "community_search_invalid_request" } });
      return;
    }
    try {
      res.json(await community.quickSearchPublic(parsed.q, { limit: parsed.limit }));
    } catch (err) {
      // A database message can echo the search pattern; log and answer codes only.
      const failure = /** @type {{code?: unknown}} */ (err || {});
      req.log?.warn({ code: "community_search_unavailable", mongoCode: Number.isInteger(failure.code) ? failure.code : undefined },
        "community_quick_search_failed");
      res.status(503).json({ error: { code: "community_search_unavailable" } });
    }
  });
  return router;
}

module.exports = { buildCommunityQuickSearchRouter, _internals: { parseQuickQuery } };
