"use strict";

const { createHash } = require("crypto");
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * /v1/chatbot/:token/* — Nightbot / StreamElements / Fossabot
 * custom-API commands.
 *
 * A streamer adds e.g.
 *
 *   !opponent → $(urlfetch https://api.sc2tools.com/v1/chatbot/<overlayToken>/opponent)
 *
 * Chat bots can't attach Authorization headers, so the overlay token
 * IN THE PATH is the credential — the same trust model as the OBS
 * Browser Source URL. Every response is a single plain-text UTF-8
 * line (≤ 380 chars) so it drops straight into chat:
 *
 *   GET /chatbot/:token/opponent — live opponent (name, race,
 *     MMR/league, H2H, last-meeting note); falls back to the last
 *     game's opponent; "No opponent data yet." otherwise.
 *   GET /chatbot/:token/mmr      — current MMR + session delta +
 *     session W-L (same source as the overlay's session widget).
 *   GET /chatbot/:token/build    — the classifier's tag for the
 *     streamer's current/last opener.
 *
 * Unknown/revoked token → 404 plain "Unknown token.". Responses are
 * ``Cache-Control: no-store`` (Nightbot's own ~30 s urlfetch cache is
 * the intended caching layer). Per-token rate limit of 30/min — a
 * leaked overlay token can't use chat commands to hammer Mongo, and
 * legitimate bot traffic (a handful of commands, each cached ~30 s
 * bot-side) never gets close. Mirrors the per-key limiter idiom in
 * routes/publicReplay.js with the token path param as the key.
 *
 * @param {{
 *   chatbot: import('../services/chatbot').ChatbotService,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildChatbotRouter(deps) {
  const router = express.Router();

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "chatbot:global",
    store: new BoundedRateLimitStore({ maxEntries: 1 }),
  });

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: CHATBOT_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    /** @param {import('express').Request} req */
    keyGenerator: (req) => `chatbot:${hashLimiterCredential(
      (req.params && req.params.token) || "anon",
    )}`,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    /**
     * Plain-text 429 — a JSON blob would land verbatim in chat when a
     * bot forwards the body on non-200s.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    handler: (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.set("Content-Type", "text/plain; charset=utf-8");
      res.status(429).send("Rate limited. Try again in a minute.");
    },
  });

  router.use("/chatbot/:token", globalLimiter);

  /**
   * Shared GET handler wrapper: plain-text content type, no-store,
   * 404 for a null line (invalid/revoked token), 500 text (never a
   * JSON error envelope) on the unexpected-throw path.
   *
   * @param {(token: string) => Promise<string|null>} produce
   * @returns {import('express').RequestHandler}
   */
  const lineHandler = (produce) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", "text/plain; charset=utf-8");
    try {
      const line = await produce(String(req.params.token || ""));
      if (line === null || line === undefined) {
        res.status(404).send("Unknown token.");
        return;
      }
      res.status(200).send(line);
    } catch (err) {
      if (deps.logger && typeof deps.logger.warn === "function") {
        deps.logger.warn({ err, path: req.path }, "chatbot_line_failed");
      }
      res.status(500).send("Temporarily unavailable.");
    }
  };

  router.get(
    "/chatbot/:token/opponent",
    limiter,
    lineHandler((token) => deps.chatbot.opponentLine(token)),
  );
  router.get(
    "/chatbot/:token/mmr",
    limiter,
    lineHandler((token) => deps.chatbot.mmrLine(token)),
  );
  router.get(
    "/chatbot/:token/build",
    limiter,
    lineHandler((token) => deps.chatbot.buildLine(token)),
  );

  return router;
}

const CHATBOT_RATE_LIMIT_PER_MIN = 30;

/** @param {unknown} value */
function hashLimiterCredential(value) {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("base64url");
}

module.exports = { buildChatbotRouter, CHATBOT_RATE_LIMIT_PER_MIN };
