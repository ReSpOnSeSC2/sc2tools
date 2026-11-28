"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { LadderVodsService, LadderVodsError } = require("../services/ladderVods");
const { buildTwitchVideoChannelResolver } = require("../services/twitchVideoChannels");

const LADDER_VODS_RATE_LIMIT_PER_MIN = 60;
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=60";

/** @type {Record<"invalid_search" | "busy" | "unavailable", { status: number, message: string }>} */
const FAILURES = {
  invalid_search: { status: 400, message: "That search is not one the finder offers" },
  busy: { status: 503, message: "Too many searches are waiting. Try again in a few seconds" },
  unavailable: { status: 503, message: "The ladder VOD search is unavailable right now" },
};

/**
 * The finder as the app runs it: the SC2Pulse search with the server's Twitch
 * app credentials naming each VOD's channel. The gate is the service's.
 *
 * @param {{
 *   config: { platformIntegrations?: { twitch?: { clientId?: string, clientSecret?: string, redirectUri?: string } | null } | null },
 *   logger: { warn?: (fields: object, message: string) => void },
 * }} deps
 */
function ladderVodsFromDeps({ config, logger }) {
  const { clientId, clientSecret, redirectUri } = config.platformIntegrations?.twitch || {};
  const credentials = clientId && clientSecret ? { clientId, clientSecret, redirectUri: redirectUri || "" } : null;
  return new LadderVodsService({ resolveChannels: buildTwitchVideoChannelResolver({ credentials }), log: logger });
}

/**
 * GET /v1/ladder-vods: recent ladder games with a Twitch VOD that opens at the
 * game. PUBLIC and read-only. While the finder's gate is off it answers
 * `{ available: false }` and nothing reaches SC2Pulse. Results name the
 * streamer's channel and never the other player (ADR 0075).
 *
 * @param {{
 *   ladderVods: Pick<LadderVodsService, 'search'>,
 *   rateLimitPerMinute?: number,
 * }} deps
 */
function buildLadderVodsRouter(deps) {
  if (typeof deps?.ladderVods?.search !== "function") {
    throw new Error("buildLadderVodsRouter: ladderVods service required");
  }
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: deps.rateLimitPerMinute || LADDER_VODS_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get("/ladder-vods", limiter, async (req, res, next) => {
    try {
      const answer = await deps.ladderVods.search(req.query);
      res.set("Cache-Control", CACHE_CONTROL);
      res.json(answer);
    } catch (err) {
      if (!(err instanceof LadderVodsError)) {
        next(err);
        return;
      }
      const { status, message } = FAILURES[err.code];
      if (err.code === "busy") res.set("Retry-After", "5");
      res.status(status).json({ error: { code: `ladder_vods_${err.code}`, message } });
    }
  });

  return router;
}

module.exports = { buildLadderVodsRouter, ladderVodsFromDeps };
