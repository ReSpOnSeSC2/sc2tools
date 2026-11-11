"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { SHARE_TOKEN_RE } = require("../services/gameShares");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

// The review exchange's heavy-read and write budgets (routes/reviews.js).
const HEAVY_READ_LIMIT_PER_MIN = 120;
const VIEW_LIMIT_PER_MIN = 30;
const WRITE_LIMIT_PER_MIN = 60;
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Revocable single-game share links (services/gameShares.js).
 *
 * Signed in (Clerk browser session; agent device tokens are refused):
 *   POST   /games/:gameId/shares  — the game's live link, created on first use
 *   GET    /games/:gameId/shares  — the game's links, live and revoked
 *   DELETE /shares/:token         — revoke
 *
 * Public (no account; the token is the grant):
 *   GET  /shares/:token                       — the game's redacted analysis
 *   POST /shares/:token/views                 — count one page view
 *   GET  /shares/:token/map-playback          — legacy inline playback
 *   GET  /shares/:token/map-playback/manifest — segmented playback manifest
 *   GET  /shares/:token/map-playback/artifacts/:artifactId/segments/:index/link
 *        — a one-minute presigned storage URL for one segment
 *   GET  /shares/:token/map-playback/artifacts/:artifactId/segments/:index
 *        — the same bytes through the API, for browsers that cannot read
 *          storage directly
 *
 * Public reads are rate limited per client address AND token, so one busy
 * link (whose page every viewer renders through the same web server)
 * cannot exhaust every other link's budget. Responses are never cached:
 * revoking a link must end access at once. Mounted in the public bundle.
 *
 * @param {{
 *   gameShares: import('../services/gameShares').GameSharesService,
 *   auth: import('express').RequestHandler,
 *   heavyLimitPerMinute?: number,
 *   viewLimitPerMinute?: number,
 * }} deps
 */
function buildGameSharesRouter(deps) {
  if (!deps?.gameShares || typeof deps.auth !== "function") {
    throw new Error("buildGameSharesRouter: gameShares and auth required");
  }
  const router = express.Router();
  const limits = {
    heavy: perTokenLimiter("shares-heavy", deps.heavyLimitPerMinute || HEAVY_READ_LIMIT_PER_MIN),
    view: perTokenLimiter("shares-view", deps.viewLimitPerMinute || VIEW_LIMIT_PER_MIN),
    write: rateLimit({
      windowMs: 60_000,
      max: WRITE_LIMIT_PER_MIN,
      standardHeaders: true,
      legacyHeaders: false,
      store: new BoundedRateLimitStore({ maxEntries: 4096 }),
      keyGenerator: (/** @type {import('express').Request} */ req) => `shares-write:${req.auth?.userId || req.ip || "anon"}`,
      message: RATE_LIMITED,
    }),
  };
  mountOwnerRoutes(router, deps.gameShares, [deps.auth, browserOnly], limits.write);
  mountPublicRoutes(router, deps.gameShares, limits);
  return router;
}

/**
 * @param {import('express').Router} router
 * @param {import('../services/gameShares').GameSharesService} shares
 * @param {import('express').RequestHandler[]} owner
 * @param {import('express').RequestHandler} writeLimiter
 */
function mountOwnerRoutes(router, shares, owner, writeLimiter) {
  const viewer = (/** @type {import('express').Request} */ req) => String(req.auth?.userId);
  router.post("/games/:gameId/shares", ...owner, writeLimiter, handle(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const out = await shares.create(viewer(req), String(req.params.gameId || ""));
    res.status(out.created ? 201 : 200).json(out);
  }));
  router.get("/games/:gameId/shares", ...owner, handle(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(await shares.listForGame(viewer(req), String(req.params.gameId || "")));
  }));
  router.delete("/shares/:token", ...owner, writeLimiter, handle(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(await shares.revoke(viewer(req), String(req.params.token || "")));
  }));
}

/**
 * @param {import('express').Router} router
 * @param {import('../services/gameShares').GameSharesService} shares
 * @param {{heavy: import('express').RequestHandler, view: import('express').RequestHandler}} limits
 */
function mountPublicRoutes(router, shares, limits) {
  const read = [limits.heavy, publicHeaders];
  const segment = "/shares/:token/map-playback/artifacts/:artifactId/segments/:index";
  const token = (/** @type {import('express').Request} */ req) => String(req.params.token);
  router.get("/shares/:token", ...read, handle(async (req, res) => {
    res.json(await shares.analysis(token(req)));
  }));
  router.post("/shares/:token/views", limits.view, publicHeaders, handle(async (req, res) => {
    await shares.recordView(token(req));
    res.status(204).end();
  }));
  router.get("/shares/:token/map-playback", ...read, handle(async (req, res) => {
    res.json(await shares.playback(token(req)));
  }));
  router.get("/shares/:token/map-playback/manifest", ...read, handle(async (req, res) => {
    res.json(await shares.playbackManifest(token(req)));
  }));
  router.get(`${segment}/link`, ...read, validSegment, handle(async (req, res) => {
    res.json(await shares.segmentLink(token(req)));
  }));
  router.get(segment, ...read, validSegment, handle(async (req, res) => {
    const bytes = await shares.playbackSegment(token(req), String(req.params.artifactId), Number(req.params.index));
    res.type("application/json").send(bytes);
  }));
}

const RATE_LIMITED = Object.freeze({ error: { code: "rate_limited", message: "rate_limited" } });

/**
 * Per client address AND token: one busy link cannot exhaust another's.
 * @param {string} name @param {number} max
 */
function perTokenLimiter(name, max) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: (/** @type {import('express').Request} */ req) => `${name}:${req.ip}:${tokenKey(req.params.token)}`,
    message: RATE_LIMITED,
  });
}

/** Clerk browser sessions only; agent device tokens are refused.
 * @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next */
function browserOnly(req, res, next) {
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
}

/** Never cached or indexed; a malformed token never reaches the service.
 * @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next */
function publicHeaders(req, res, next) {
  res.set("Cache-Control", "private, no-store, max-age=0");
  res.set("X-Robots-Tag", "noindex, nofollow");
  if (!SHARE_TOKEN_RE.test(String(req.params.token || ""))) {
    res.status(404).json({ error: { code: "share_not_found", message: "This share link doesn't exist or was turned off." } });
    return;
  }
  next();
}

/** @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next */
function validSegment(req, res, next) {
  const index = Number(req.params.index);
  if (!SHA256_RE.test(String(req.params.artifactId || "")) || !Number.isInteger(index) || index < 0 || index > 511) {
    res.status(404).json({ error: { code: "playback_artifact_not_found", message: "No recorded playback." } });
    return;
  }
  next();
}

/**
 * The token's place in a rate-limit key: a short hash, so the bearer
 * token itself is never held in limiter state.
 *
 * @param {unknown} token
 */
function tokenKey(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url").slice(0, 16);
}

/**
 * Render the service's typed errors (status < 500) with their code; hand
 * everything else to the shared error handler.
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
        res.set("Cache-Control", "private, no-store");
        res.status(e.status).json({ error: { code: e.code, message: e.message || e.code } });
        return;
      }
      if (e && e.status === 503) res.set("Retry-After", "5");
      next(err);
    }
  };
}

module.exports = { buildGameSharesRouter, _internals: { tokenKey } };
