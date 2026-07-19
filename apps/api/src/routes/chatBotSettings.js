"use strict";

const express = require("express");

/**
 * /v1/me/chatbot — the Twitch chat bot's settings surface.
 *
 * Deliberately NOT part of the generic /me/preferences/:type family:
 * the stored blob contains the bot account's OAuth token, which must
 * never be echoed back (the generic route returns preferences
 * verbatim) and must never ride the token-authed overlay config
 * (Browser Sources are shareable). GET returns a masked view with
 * ``hasToken``; PUT keeps the stored token when the client omits it
 * or sends the mask placeholder, so "toggle a checkbox and save"
 * never wipes credentials.
 *
 * @param {{
 *   auth: import('express').RequestHandler,
 *   users: {getPreferences: Function, updatePreferences: Function},
 *   twitchChatBot: import('../services/twitchChatBot').TwitchChatBotService,
 * }} deps
 */
function buildChatBotSettingsRouter(deps) {
  const router = express.Router();

  /** @param {Record<string, any>} cfg @param {string} userId */
  const maskedView = (cfg, userId) => ({
    enabled: cfg.enabled === true,
    username: typeof cfg.username === "string" ? cfg.username : "",
    channel: typeof cfg.channel === "string" ? cfg.channel : "",
    replyCommands: cfg.replyCommands !== false,
    announceOracle: cfg.announceOracle !== false,
    announceLevelUps: cfg.announceLevelUps !== false,
    hasToken: typeof cfg.token === "string" && cfg.token.length > 0,
    status: deps.twitchChatBot.status(userId),
  });

  router.get("/me/chatbot", deps.auth, async (req, res, next) => {
    try {
      const auth = /** @type {any} */ (req).auth;
      if (!auth) throw new Error("auth_required");
      const cfg = await deps.users.getPreferences(auth.userId, "chatbot");
      res.json(maskedView(cfg || {}, auth.userId));
    } catch (err) {
      next(err);
    }
  });

  router.put("/me/chatbot", deps.auth, async (req, res, next) => {
    try {
      const auth = /** @type {any} */ (req).auth;
      if (!auth) throw new Error("auth_required");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const prev = (await deps.users.getPreferences(auth.userId, "chatbot")) || {};
      const rawToken = typeof body.token === "string" ? body.token.trim() : "";
      // "" or the mask placeholder = keep what's stored.
      const keepStored = rawToken === "" || /^[•*]+$/.test(rawToken);
      const cleanUser = (/** @type {unknown} */ v) =>
        typeof v === "string" && /^[A-Za-z0-9_]{2,26}$/.test(v.trim())
          ? v.trim()
          : "";
      const username = cleanUser(body.username);
      const next_ = {
        enabled: body.enabled === true,
        username,
        channel: cleanUser(body.channel) || username,
        token: keepStored
          ? typeof prev.token === "string"
            ? prev.token
            : ""
          : rawToken.replace(/^oauth:/i, "").slice(0, 120),
        replyCommands: body.replyCommands !== false,
        announceOracle: body.announceOracle !== false,
        announceLevelUps: body.announceLevelUps !== false,
      };
      if (next_.enabled && (!next_.username || !next_.token)) {
        res.status(400).json({
          error: {
            code: "chatbot_incomplete",
            message: "Bot username and an OAuth token are required to enable the bot.",
          },
        });
        return;
      }
      await deps.users.updatePreferences(auth.userId, "chatbot", next_);
      await deps.twitchChatBot.configure(auth.userId, next_);
      res.json(maskedView(next_, auth.userId));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildChatBotSettingsRouter };
