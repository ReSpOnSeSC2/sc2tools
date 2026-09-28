"use strict";

/**
 * POST /v1/games/exists — which of these game ids does the caller already
 * have stored?
 *
 * The in-browser importer calls this before parsing a folder so replays the
 * server already holds are skipped locally (parsing costs seconds of CPU per
 * replay; this lookup is one index-backed query). Registered inside
 * ``buildGamesRouter`` — whose ``router.use(auth)`` already authenticated the
 * caller — and declared before any ``/games/:gameId`` route.
 *
 *   request:  { gameIds: string[] }   (1..500 ids, each 1..200 chars)
 *   200:      { existing: string[] }  (subset, first-seen input order, deduped)
 *   400:      { error: { code: "invalid_request", details } }
 *   403:      { error: { code: "clerk_auth_required" } }  (device tokens)
 *   429:      { error: { code: "rate_limited" } }         (60/min per user)
 */

const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { validateGamesExistsRequest } = require("../validation/gamesExists");
const { LIMITS } = require("../config/constants");

const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const GAMES_EXISTS_WINDOW_MS = 60 * 1000;
const GAMES_EXISTS_MAX_PER_WINDOW = 60;
// One bucket per active user; bounded so a burst of accounts cannot grow
// the in-process limiter without limit.
const GAMES_EXISTS_LIMITER_MAX_KEYS = 4096;

/**
 * @typedef {{ existingGameIds(userId: string, gameIds: string[]): Promise<string[]> }} ExistingGamesLookup
 */

/**
 * Attach POST /games/exists to an authenticated games router.
 *
 * Example:
 *   const router = express.Router();
 *   router.use(auth);
 *   registerGamesExistsRoute(router, { games });
 *
 * @param {import('express').Router} router router with auth already applied
 * @param {{ games: ExistingGamesLookup }} deps
 */
function registerGamesExistsRoute(router, deps) {
  const limiter = rateLimit({
    windowMs: GAMES_EXISTS_WINDOW_MS,
    max: GAMES_EXISTS_MAX_PER_WINDOW,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: GAMES_EXISTS_LIMITER_MAX_KEYS }),
    // Internal account UUID (never a credential); IP only as a fallback.
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      `games-exists:${req.auth?.userId || req.ip || "anon"}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
  router.post(
    "/games/exists",
    noStore,
    requireClerkSession,
    limiter,
    (req, res, next) => {
      handleGamesExists(req, res, deps.games).catch(next);
    },
  );
}

/**
 * Every response of this route is per-user and must never be cached.
 * @type {import('express').RequestHandler}
 */
function noStore(_req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

/**
 * The browser importer is the only intended caller; device tokens (the
 * desktop agent) have their own dedupe path and are refused.
 * @type {import('express').RequestHandler}
 */
function requireClerkSession(req, res, next) {
  if (req.auth && req.auth.source === "clerk") {
    next();
    return;
  }
  res.status(403).json({
    error: {
      code: "clerk_auth_required",
      message: "This endpoint requires a signed-in browser session.",
    },
  });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {ExistingGamesLookup} games
 */
async function handleGamesExists(req, res, games) {
  const auth = req.auth;
  if (!auth) throw new Error("auth_required");
  const validation = validateGamesExistsRequest(req.body);
  if (!validation.valid) {
    res.status(400).json({
      error: {
        code: "invalid_request",
        message: `gameIds must be 1-${LIMITS.GAMES_EXISTS_MAX_IDS} non-empty strings `
          + `of at most ${LIMITS.GAME_ID_MAX_LENGTH} characters.`,
        details: validation.errors,
      },
    });
    return;
  }
  const requested = Array.from(new Set(validation.value.gameIds));
  const found = new Set(await games.existingGameIds(auth.userId, requested));
  res.status(200).json({ existing: requested.filter((id) => found.has(id)) });
}

module.exports = {
  registerGamesExistsRoute,
  GAMES_EXISTS_MAX_PER_WINDOW,
};
