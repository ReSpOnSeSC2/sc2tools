"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const LIVE_STREAMS_RATE_LIMIT_PER_MIN = 120;

/**
 * GET /v1/live-streams: every StarCraft II stream that is live now on Twitch
 * and Kick, most viewers first. PUBLIC and read-only; the list is the
 * server's cached copy (about a minute old), so visitors never reach a
 * provider. Answers 503 only when every configured platform failed and no
 * earlier list is left to show.
 *
 * @param {{
 *   liveStreams: Pick<import('../services/liveStreams').LiveStreamsService, 'list'>,
 *   rateLimitPerMinute?: number,
 * }} deps
 */
function buildLiveStreamsRouter(deps) {
  if (typeof deps?.liveStreams?.list !== "function") {
    throw new Error("buildLiveStreamsRouter: liveStreams service required");
  }
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: deps.rateLimitPerMinute || LIVE_STREAMS_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get("/live-streams", limiter, async (_req, res, next) => {
    try {
      const snapshot = await deps.liveStreams.list();
      const states = Object.values(snapshot.platforms);
      if (states.includes("error") && !states.some(state => state === "ok" || state === "stale")) {
        res.status(503).json({
          error: { code: "live_streams_unavailable", message: "Live stream lists are unavailable right now" },
        });
        return;
      }
      res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=30");
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildLiveStreamsRouter };
