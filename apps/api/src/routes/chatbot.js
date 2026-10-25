"use strict";

const { createHash } = require("crypto");
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { sanitiseRequestUrl } = require("../middleware/requestLogging");

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
 *   commands?: import('../services/chatCommandService').ChatCommandService,
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

  router.get("/chatbot/:token/:command", limiter, async (req, res, next) => {
    if (!deps.commands) {
      // Compatibility for embedders using the original three-line service.
      const legacy = { opponent: "opponentLine", mmr: "mmrLine", build: "buildLine" };
      const method = /** @type {keyof typeof legacy} */ (req.params.command);
      if (!legacy[method]) { res.status(404).type("text").send("Unknown command."); return; }
      const produce = /** @type {any} */ (deps.chatbot)[legacy[method]].bind(deps.chatbot);
      return legacyLineHandler(produce, deps.logger)(req, res, next);
    }
    res.set("Cache-Control", "no-store").type("text/plain; charset=utf-8");
    try {
      const reply = await deps.commands.answer(req.params.token, { command: req.params.command,
        argument: typeof req.query.args === "string" ? req.query.args : "",
        user: typeof req.query.user === "string" ? req.query.user : "", platform: "nightbot" });
      if (!reply) { res.status(404).send("Unknown token."); return; }
      if (reply.status === "unknown") { res.status(404).send("Unknown command."); return; }
      if (!reply.text) { res.status(204).end(); return; }
      res.send(reply.text);
    } catch (error) {
      deps.logger?.warn({ err: error, path: sanitiseRequestUrl(req.path) }, "chatbot_line_failed");
      res.status(500).send("Temporarily unavailable.");
    }
  });

  return router;
}

const CHATBOT_RATE_LIMIT_PER_MIN = 30;

/** Original embedders retain plain-text error responses as well.
 * @param {(token:string)=>Promise<string|null>} produce @param {import('pino').Logger} [logger]
 * @returns {import('express').RequestHandler} */
function legacyLineHandler(produce, logger) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store").type("text/plain; charset=utf-8");
    try {
      const line = await produce(String(req.params.token || ""));
      if (line === null || line === undefined) { res.status(404).send("Unknown token."); return; }
      res.send(line);
    } catch (error) {
      logger?.warn({ err: error, path: sanitiseRequestUrl(req.path) }, "chatbot_line_failed");
      res.status(500).send("Temporarily unavailable.");
    }
  };
}

/** @param {unknown} value */
function hashLimiterCredential(value) {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("base64url");
}

module.exports = { buildChatbotRouter, CHATBOT_RATE_LIMIT_PER_MIN };
