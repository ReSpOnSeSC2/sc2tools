"use strict";

/**
 * Build check-in ("build intent") routes. Every route authenticates itself
 * (``deps.auth`` per route, so unrelated ``/v1`` requests pay nothing),
 * answers ``Cache-Control: private, no-store`` and is rate limited per user
 * (``build-intent:<userId>``; live writes 30/min, other writes 60/min,
 * reads 120/min). ``via``/``origin`` come from the credential: device
 * tokens are the agent, Clerk sessions the web.
 *
 *   GET  /build-intents/options?matchup=PvZ   build list + record per build
 *        [&side=you|opponent]                 (opponent: the opponent's builds)
 *   GET  /build-intents/live/:gameKey         LiveState (404 not_found)
 *   PUT  /build-intents/live/:gameKey         register | declare | undeclare
 *                                             | release | postgame
 *   GET  /build-intents/pending?limit=10      pending queue (last 72 h)
 *   POST /build-intents/pending/dismiss       "No set build" for the queue
 *   GET  /games/:gameId/build-intent          GameIntentState
 *                                             (?include=options adds both lists)
 *   PUT  /games/:gameId/build-intent          confirm | skip | defer | notes
 *                                             | opponent; every action takes
 *                                             an optional opponentBuildKey
 *
 * Errors: ``{error: {code, message}}`` (+ ``gameId`` for already_bound,
 * ``reason`` for not_eligible). Request logs redact the live game key
 * (middleware/requestLogging.js): it holds both players' names.
 */

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { BUILD_INTENT, LIMITS } = require("../config/constants");
const { BuildIntentError } = require("../services/buildIntentCommon");
const {
  validateLiveIntentBody,
  validateGameIntentBody,
  parseMatchupParam,
  parseSideParam,
  parsePendingLimit,
  isValidGameKey,
} = require("../validation/buildIntent");

const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * @param {number} max requests per window
 * @returns {import('express').RequestHandler}
 */
function userLimiter(max) {
  return rateLimit({
    windowMs: BUILD_INTENT.RATE_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: BUILD_INTENT.RATE_LIMITER_MAX_KEYS }),
    // Internal account UUID (never a credential); IP only as a fallback.
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      `build-intent:${req.auth?.userId || req.ip || "anon"}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
}

/** @type {import('express').RequestHandler} */
function noStore(_req, res, next) {
  res.set("Cache-Control", "private, no-store");
  next();
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function sendError(res, status, code, message, extra) {
  res.status(status).json({ error: { code, message, ...(extra || {}) } });
}

/**
 * Wrap an async handler: coded check-in errors become their envelope,
 * anything else goes to the app error handler.
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} fn
 * @returns {import('express').RequestHandler}
 */
function handle(fn) {
  return (req, res, next) => {
    fn(req, res).catch((err) => {
      if (err instanceof BuildIntentError) {
        sendError(res, err.status, err.code, err.message, err.extra);
        return;
      }
      next(err);
    });
  };
}

/**
 * @param {import('express').Request} req
 * @returns {{ userId: string, source?: string }}
 */
function requireAuth(req) {
  if (!req.auth) throw new Error("auth_required");
  return req.auth;
}

/**
 * @param {unknown} gameId
 * @returns {gameId is string}
 */
function isValidGameId(gameId) {
  return typeof gameId === "string" && gameId.length > 0 && gameId.length <= LIMITS.GAME_ID_MAX_LENGTH;
}

/**
 * @typedef {{
 *   buildIntents: import('../services/buildIntents').BuildIntentsService,
 *   auth: import('express').RequestHandler,
 * }} BuildIntentsRouterDeps
 * @typedef {{
 *   reads: import('express').RequestHandler,
 *   writes: import('express').RequestHandler,
 *   liveWrites: import('express').RequestHandler,
 * }} Limiters
 */

/**
 * @param {BuildIntentsRouterDeps} deps
 */
function buildBuildIntentsRouter(deps) {
  const router = express.Router();
  /** @type {Limiters} */
  const limiters = {
    reads: userLimiter(BUILD_INTENT.RATE_READS),
    writes: userLimiter(BUILD_INTENT.RATE_WRITES),
    liveWrites: userLimiter(BUILD_INTENT.RATE_LIVE_WRITES),
  };
  registerQueueRoutes(router, deps, limiters);
  registerLiveRoutes(router, deps, limiters);
  registerGameRoutes(router, deps, limiters);
  return router;
}

/**
 * Options and the pending queue.
 * @param {import('express').Router} router
 * @param {BuildIntentsRouterDeps} deps
 * @param {Limiters} limiters
 */
function registerQueueRoutes(router, deps, limiters) {
  const service = deps.buildIntents;
  router.get("/build-intents/options", noStore, deps.auth, limiters.reads, handle(async (req, res) => {
    const auth = requireAuth(req);
    const matchup = parseMatchupParam(req.query.matchup);
    if (!matchup) {
      sendError(res, 400, "invalid_matchup", "matchup must look like PvZ.");
      return;
    }
    const side = parseSideParam(req.query.side);
    if (!side) {
      sendError(res, 400, "invalid_side", "side must be you or opponent.");
      return;
    }
    res.json(await service.getOptions(auth.userId, matchup, side));
  }));

  router.get("/build-intents/pending", noStore, deps.auth, limiters.reads, handle(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listPending(auth.userId, parsePendingLimit(req.query.limit)));
  }));

  router.post("/build-intents/pending/dismiss", noStore, deps.auth, limiters.writes, handle(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.dismissPending(auth.userId, auth));
  }));
}

/**
 * The live record of a game in progress (agent loading card, web).
 * @param {import('express').Router} router
 * @param {BuildIntentsRouterDeps} deps
 * @param {Limiters} limiters
 */
function registerLiveRoutes(router, deps, limiters) {
  const service = deps.buildIntents;
  router.get("/build-intents/live/:gameKey", noStore, deps.auth, limiters.reads, handle(async (req, res) => {
    const auth = requireAuth(req);
    const { gameKey } = req.params;
    if (!isValidGameKey(gameKey)) {
      sendError(res, 400, "invalid_game_key", "Invalid live game key.");
      return;
    }
    const state = await service.getLive(auth.userId, gameKey);
    if (!state) {
      sendError(res, 404, "not_found", "Live game not found.");
      return;
    }
    res.json(state);
  }));

  router.put("/build-intents/live/:gameKey", noStore, deps.auth, limiters.liveWrites, handle(async (req, res) => {
    const auth = requireAuth(req);
    const { gameKey } = req.params;
    if (!isValidGameKey(gameKey)) {
      sendError(res, 400, "invalid_game_key", "Invalid live game key.");
      return;
    }
    const body = validateLiveIntentBody(req.body);
    if (!body.valid) {
      sendError(res, 400, body.code, body.message);
      return;
    }
    res.json(await service.putLive(
      auth.userId,
      gameKey,
      /** @type {Parameters<typeof service.putLive>[2]} */ (body.value),
      auth,
    ));
  }));
}

/**
 * Check-in on a stored game.
 * @param {import('express').Router} router
 * @param {BuildIntentsRouterDeps} deps
 * @param {Limiters} limiters
 */
function registerGameRoutes(router, deps, limiters) {
  const service = deps.buildIntents;
  router.get("/games/:gameId/build-intent", noStore, deps.auth, limiters.reads, handle(async (req, res) => {
    const auth = requireAuth(req);
    const { gameId } = req.params;
    if (!isValidGameId(gameId)) {
      sendError(res, 404, "not_found", "Game not found.");
      return;
    }
    res.json(await service.getGameIntent(auth.userId, gameId, {
      includeOptions: req.query.include === "options",
    }));
  }));

  router.put("/games/:gameId/build-intent", noStore, deps.auth, limiters.writes, handle(async (req, res) => {
    const auth = requireAuth(req);
    const { gameId } = req.params;
    if (!isValidGameId(gameId)) {
      sendError(res, 404, "not_found", "Game not found.");
      return;
    }
    const body = validateGameIntentBody(req.body);
    if (!body.valid) {
      sendError(res, 400, body.code, body.message);
      return;
    }
    res.json(await service.putGameIntent(
      auth.userId,
      gameId,
      /** @type {Parameters<typeof service.putGameIntent>[2]} */ (body.value),
      auth,
    ));
  }));
}

module.exports = { buildBuildIntentsRouter };
