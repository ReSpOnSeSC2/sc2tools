"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { validateReviewInput } = require("../validation/review");
const { REVIEW_ID_RE } = require("../services/reviews");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const READ_LIMIT_PER_MIN = 240;
const HEAVY_READ_LIMIT_PER_MIN = 120;
const WRITE_LIMIT_PER_MIN = 60;
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * /v1/reviews — the Replay Review Exchange (docs/reviews.md).
 *
 * Public (no sign-in; a valid Bearer only personalises the response):
 *   GET  /reviews                           — board (hot|new|top, filters, cursor)
 *   GET  /reviews/leaderboard               — weekly reviewer leaderboard (opt-in names)
 *   GET  /reviews/sitemap                   — indexable review ids for the web sitemap
 *   GET  /reviews/:id                       — request + thread + viewer capabilities, redacted
 *   GET  /reviews/:id/og                    — minimal redacted OG-card payload
 *   GET  /reviews/:id/analysis              — scoped grant: THIS game's analysis, redacted
 *   GET  /reviews/:id/analysis/map-playback           — legacy inline playback (allow-listed)
 *   GET  /reviews/:id/analysis/map-playback/manifest  — segmented playback manifest
 *   GET  /reviews/:id/analysis/map-playback/artifacts/:artifactId/segments/:index
 *
 * Signed in (Clerk browser session; agent device tokens are refused):
 *   POST   /reviews                                — create from your own gameId
 *   GET    /reviews/for-me                         — "Requests you can help with"
 *   POST   /reviews/:id/close | /report
 *   POST   /reviews/:id/comments
 *   PATCH  /reviews/:id/comments/:cid              — 15-minute edit window
 *   DELETE /reviews/:id/comments/:cid              — "[deleted]" when it has replies
 *   POST   /reviews/:id/comments/:cid/{helpful,best,upvote,report,block}
 *   GET    /me/reviews | /me/reviewer ; PATCH /me/reviewer
 *   GET    /me/review-blocks ; DELETE /me/review-blocks/:blockId
 *
 * Rollout: ``reviewsEnabled`` is "off" (every route 404s), "admins"
 * (only platform admins see anything) or "on". The router mounts in the
 * public bundle and applies auth per route.
 *
 * @param {{
 *   reviews: import('../services/reviews').ReviewsService,
 *   reputation: import('../services/reviewerReputation').ReviewerReputationService,
 *   auth: import('express').RequestHandler,
 *   isAdmin: (req: import('express').Request) => boolean,
 *   rollout: "off" | "admins" | "on",
 *   readLimitPerMinute?: number,
 * }} deps
 */
function buildReviewsRouter(deps) {
  const router = express.Router();
  const readMax = deps.readLimitPerMinute || READ_LIMIT_PER_MIN;
  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: readMax,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: (/** @type {import('express').Request} */ req) => `reviews-read:${req.ip}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
  const heavyLimiter = rateLimit({
    windowMs: 60_000,
    max: Math.min(readMax, HEAVY_READ_LIMIT_PER_MIN),
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: (/** @type {import('express').Request} */ req) => `reviews-heavy:${req.ip}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: WRITE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      `reviews-write:${req.auth?.userId || req.ip || "anon"}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  /**
   * Public routes read the viewer when a token is present but never fail
   * because of one: a stale token just means "anonymous".
   *
   * @type {import('express').RequestHandler}
   */
  const lenientAuth = (req, res, next) => {
    if (!req.headers.authorization) {
      next();
      return;
    }
    deps.auth(req, res, (err) => {
      if (err) delete req.auth;
      next();
    });
  };

  /** @type {import('express').RequestHandler} */
  const gate = (req, res, next) => {
    if (deps.rollout === "on") return next();
    if (deps.rollout === "admins" && deps.isAdmin(req)) return next();
    res.set("Cache-Control", "no-store");
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
  };

  /** @type {import('express').RequestHandler} */
  const browserOnly = (req, res, next) => {
    if (!req.auth || req.auth.source !== "clerk") {
      res.status(req.auth ? 403 : 401).json({
        error: {
          code: req.auth ? "browser_session_required" : "auth_required",
          message: req.auth ? "Sign in on the website to do this." : "Sign in to do this.",
        },
      });
      return;
    }
    next();
  };

  /** @type {import('express').RequestHandler} */
  const validId = (req, res, next) => {
    if (!REVIEW_ID_RE.test(String(req.params.id || ""))) {
      res.status(404).json({ error: { code: "review_not_found", message: "This review doesn't exist or was removed." } });
      return;
    }
    if (req.params.cid !== undefined && !REVIEW_ID_RE.test(String(req.params.cid))) {
      res.status(404).json({ error: { code: "comment_not_found", message: "That comment doesn't exist." } });
      return;
    }
    next();
  };

  /**
   * While the rollout is "off" every route 404s before auth runs, so a
   * signed-out probe gets the same 404 as a missing page (not a 401 that
   * hints the feature exists).
   *
   * @type {import('express').RequestHandler}
   */
  const offGate = (req, res, next) => {
    if (deps.rollout !== "off") return next();
    res.set("Cache-Control", "no-store");
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
  };

  const pub = [readLimiter, lenientAuth, gate];
  const signedIn = [offGate, deps.auth, gate, browserOnly, writeLimiter];

  /** @param {import('express').Request} req */
  const viewerOf = (req) => ({
    userId: req.auth?.userId || null,
    isAdmin: deps.isAdmin(req),
    source: req.auth?.source,
  });

  /**
   * @param {import('express').Request} req
   * @returns {{userId: string, isAdmin: boolean, source: string}}
   */
  const signedViewer = (req) => ({
    userId: String(req.auth?.userId),
    isAdmin: deps.isAdmin(req),
    source: String(req.auth?.source),
  });

  // ── Public ───────────────────────────────────────────────────────
  router.get("/reviews", ...pub, handle(async (req, res) => {
    publicCache(res, 60);
    res.json(await deps.reviews.board({
      sort: first(req.query.sort),
      matchup: first(req.query.matchup),
      band: first(req.query.band),
      tag: first(req.query.tag),
      unanswered: first(req.query.unanswered),
      cursor: first(req.query.cursor),
      limit: first(req.query.limit),
    }));
  }));

  router.get("/reviews/leaderboard", ...pub, handle(async (_req, res) => {
    publicCache(res, 60);
    res.json(await deps.reputation.weeklyLeaderboard());
  }));

  router.get("/reviews/sitemap", ...pub, handle(async (_req, res) => {
    publicCache(res, 300);
    res.json(await deps.reviews.sitemap());
  }));

  router.get("/reviews/for-me", ...signedIn, handle(async (req, res) => {
    privateNoStore(res);
    res.json(await deps.reviews.forReviewer(signedViewer(req).userId));
  }));

  router.get("/reviews/:id", ...pub, validId, handle(async (req, res) => {
    const viewer = viewerOf(req);
    const page = await deps.reviews.page(String(req.params.id), viewer);
    if (viewer.userId) privateNoStore(res);
    else publicCache(res, 30);
    res.json(page);
  }));

  router.get("/reviews/:id/og", ...pub, validId, handle(async (req, res) => {
    publicCache(res, 300);
    res.json(await deps.reviews.ogSummary(String(req.params.id)));
  }));

  router.get("/reviews/:id/analysis", heavyLimiter, ...pub, validId, handle(async (req, res) => {
    // Short shared cache: closing the request revokes the grant, and a
    // revocation must not linger in caches for long.
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.json(await deps.reviews.analysis(String(req.params.id)));
  }));

  router.get("/reviews/:id/analysis/map-playback", heavyLimiter, ...pub, validId, handle(async (req, res) => {
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.json(await deps.reviews.playback(String(req.params.id)));
  }));

  router.get("/reviews/:id/analysis/map-playback/manifest", heavyLimiter, ...pub, validId, handle(async (req, res) => {
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.json(await deps.reviews.playbackManifest(String(req.params.id)));
  }));

  router.get(
    "/reviews/:id/analysis/map-playback/artifacts/:artifactId/segments/:index",
    heavyLimiter,
    ...pub,
    validId,
    handle(async (req, res) => {
      const artifactId = String(req.params.artifactId || "");
      const index = Number(req.params.index);
      if (!SHA256_RE.test(artifactId) || !Number.isInteger(index) || index < 0 || index > 511) {
        throw notFoundError();
      }
      const bytes = await deps.reviews.playbackSegment(String(req.params.id), artifactId, index);
      // Content-addressed and immutable, but browser-only: a closed
      // request must stop being served by shared caches.
      res.set("Cache-Control", "private, max-age=3600");
      res.type("application/json").send(bytes);
    }),
  );

  // ── Signed in ────────────────────────────────────────────────────
  router.post("/reviews", ...signedIn, handle(async (req, res) => {
    const parsed = validateReviewInput("create", req.body);
    if (!parsed.valid) return invalid(res, parsed.errors);
    res.status(201).json(await deps.reviews.create(signedViewer(req).userId, parsed.value));
  }));

  router.post("/reviews/:id/close", validId, ...signedIn, handle(async (req, res) => {
    res.json(await deps.reviews.close(String(req.params.id), signedViewer(req)));
  }));

  router.post("/reviews/:id/report", validId, ...signedIn, handle(async (req, res) => {
    const parsed = validateReviewInput("report", req.body);
    if (!parsed.valid) return invalid(res, parsed.errors);
    const out = await deps.reviews.report(String(req.params.id), null, signedViewer(req), reportInput(parsed.value));
    res.status(202).json({ ok: true, alreadyReported: Boolean(out && out.alreadyReported) });
  }));

  router.post("/reviews/:id/comments", validId, ...signedIn, handle(async (req, res) => {
    const parsed = validateReviewInput("comment", req.body);
    if (!parsed.valid) return invalid(res, parsed.errors);
    res.status(201).json(await deps.reviews.addComment(String(req.params.id), signedViewer(req), parsed.value));
  }));

  router.patch("/reviews/:id/comments/:cid", validId, ...signedIn, handle(async (req, res) => {
    const parsed = validateReviewInput("commentEdit", req.body);
    if (!parsed.valid) return invalid(res, parsed.errors);
    res.json(await deps.reviews.editComment(
      String(req.params.id),
      String(req.params.cid),
      signedViewer(req),
      parsed.value,
    ));
  }));

  router.delete("/reviews/:id/comments/:cid", validId, ...signedIn, handle(async (req, res) => {
    res.json(await deps.reviews.deleteComment(String(req.params.id), String(req.params.cid), signedViewer(req)));
  }));

  router.post("/reviews/:id/comments/:cid/helpful", validId, ...signedIn, handle(async (req, res) => {
    res.json(await deps.reviews.setHelpful(String(req.params.id), String(req.params.cid), signedViewer(req), flag(req.body)));
  }));

  router.post("/reviews/:id/comments/:cid/best", validId, ...signedIn, handle(async (req, res) => {
    res.json(await deps.reviews.setBest(String(req.params.id), String(req.params.cid), signedViewer(req), flag(req.body)));
  }));

  router.post("/reviews/:id/comments/:cid/upvote", validId, ...signedIn, handle(async (req, res) => {
    res.json(await deps.reviews.setUpvote(String(req.params.id), String(req.params.cid), signedViewer(req), flag(req.body)));
  }));

  router.post("/reviews/:id/comments/:cid/report", validId, ...signedIn, handle(async (req, res) => {
    const parsed = validateReviewInput("report", req.body);
    if (!parsed.valid) return invalid(res, parsed.errors);
    const out = await deps.reviews.report(String(req.params.id), String(req.params.cid), signedViewer(req), reportInput(parsed.value));
    res.status(202).json({ ok: true, alreadyReported: Boolean(out && out.alreadyReported) });
  }));

  router.post("/reviews/:id/comments/:cid/block", validId, ...signedIn, handle(async (req, res) => {
    res.json(await deps.reviews.blockAuthor(String(req.params.id), String(req.params.cid), signedViewer(req)));
  }));

  router.get("/me/reviews", ...signedIn, handle(async (req, res) => {
    privateNoStore(res);
    res.json(await deps.reviews.mine(signedViewer(req).userId));
  }));

  router.get("/me/reviewer", ...signedIn, handle(async (req, res) => {
    privateNoStore(res);
    res.json(await deps.reputation.me(signedViewer(req).userId));
  }));

  router.patch("/me/reviewer", ...signedIn, handle(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const keys = Object.keys(body);
    if (
      keys.length === 0
      || keys.some((k) => k !== "leaderboardOptIn" && k !== "weeklyDigest")
      || keys.some((k) => typeof body[k] !== "boolean")
    ) {
      return invalid(res, ["body must contain boolean leaderboardOptIn and/or weeklyDigest"]);
    }
    const userId = signedViewer(req).userId;
    if (typeof body.leaderboardOptIn === "boolean") await deps.reputation.setLeaderboardOptIn(userId, body.leaderboardOptIn);
    if (typeof body.weeklyDigest === "boolean") await deps.reputation.setDigestOptOut(userId, !body.weeklyDigest);
    res.json(await deps.reputation.me(userId));
  }));

  router.get("/me/review-blocks", ...signedIn, handle(async (req, res) => {
    privateNoStore(res);
    res.json(await deps.reviews.listBlocks(signedViewer(req).userId));
  }));

  router.delete("/me/review-blocks/:blockId", ...signedIn, handle(async (req, res) => {
    const blockId = String(req.params.blockId || "");
    if (!REVIEW_ID_RE.test(blockId)) throw notFoundError();
    res.json(await deps.reviews.unblock(signedViewer(req).userId, blockId));
  }));

  return router;
}

/**
 * Async handler that renders the service's typed errors (status < 500)
 * with their machine code and any extra ``details`` (e.g. the existing
 * request id on ``review_exists``); everything else goes to the shared
 * error handler.
 *
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} fn
 * @returns {import('express').RequestHandler}
 */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e && typeof e.status === "number" && e.status < 500 && typeof e.code === "string") {
        if (e.status === 404 || e.status === 410) res.set("Cache-Control", "no-store");
        res.status(e.status).json({
          error: { code: e.code, message: e.message || e.code, ...(e.details ? { meta: e.details } : {}) },
        });
        return;
      }
      if (e && e.status === 503) res.set("Retry-After", "5");
      next(err);
    }
  };
}

/** @param {import('express').Response} res @param {string[]} errors */
function invalid(res, errors) {
  res.status(400).json({ error: { code: "invalid_review_input", message: errors[0] || "Invalid input.", details: errors } });
}

/** @param {Record<string, any>} value */
function reportInput(value) {
  return { reason: String(value.reason), note: typeof value.note === "string" ? value.note : "" };
}

/** @param {unknown} body */
function flag(body) {
  const value = body && typeof body === "object" ? /** @type {any} */ (body).value : undefined;
  return value !== false;
}

/** @param {unknown} value */
function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** @param {import('express').Response} res @param {number} seconds */
function publicCache(res, seconds) {
  res.set("Cache-Control", `public, max-age=0, s-maxage=${seconds}`);
  res.set("Vary", "Authorization");
}

/** @param {import('express').Response} res */
function privateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

function notFoundError() {
  return Object.assign(new Error("Not found."), { status: 404, code: "not_found" });
}

module.exports = { buildReviewsRouter };
