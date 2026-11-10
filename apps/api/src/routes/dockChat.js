"use strict";

const rateLimitModule = require("express-rate-limit");
const { sha256 } = require("../util/hash");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;
const PLATFORMS = ["twitch", "kick", "youtube", "tiktok"];

/** @param {string} platform @param {Record<string,any>} config */
function configured(platform, config) {
  const row = config[platform];
  return row?.enabled === true && Boolean(platform === "tiktok" ? row.username
    : platform === "kick" ? row.channel && row.chatroomId : row.channel);
}

/** @param {unknown} body */
function validMessage(body) {
  const value = /** @type {Record<string,any>|null} */ (body);
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => ["text", "platforms"].includes(key))
    && typeof value.text === "string" && value.text.trim() && value.text.length <= 500
    && !/[\p{Cc}]/u.test(value.text)
    && Array.isArray(value.platforms) && value.platforms.length > 0 && value.platforms.length <= 4
    && value.platforms.every((/** @type {unknown} */ platform) => typeof platform === "string" && PLATFORMS.includes(platform))
    && new Set(value.platforms).size === value.platforms.length);
}

/** @param {unknown} error */
function failureMessage(error) {
  const value = /** @type {any} */ (error);
  return value?.name === "PlatformChatError" || ["chat_bot_unavailable", "chat_message_invalid", "chat_queue_full"].includes(value?.code)
    ? value.message : "Could not confirm delivery. Check this platform's chat before sending again.";
}

/** A failed network acknowledgement does not prove that a write was rejected.
 * @param {unknown} error */
function failureStatus(error) {
  const value = /** @type {any} */ (error);
  const known = value?.name === "PlatformChatError"
    || ["chat_bot_unavailable", "chat_message_invalid", "chat_queue_full"].includes(value?.code);
  return !known || value.deliveryUnknown === true ? "unknown" : "failed";
}

/** @param {import('express').Router} router
 * @param {{tokenAuth:import('express').RequestHandler, limiter:import('express').RequestHandler,
 * users:{getPreferences:Function}, overlayTokens:import('../services/overlayTokens').OverlayTokensService,
 * platformChat?:import('../services/platformChat').PlatformChatService,
 * twitchChatBot?:import('../services/twitchChatBot').TwitchChatBotService}} deps */
function registerDockChatRoutes(router, deps) {
  const sendLimiter = rateLimit({ windowMs: 30_000, max: 6, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    /** @param {import('express').Request} req */
    keyGenerator: req => `dock-chat:${sha256(String(/** @type {any} */ (req).overlayUserId || req.params.token))}`,
    message: { error: { code: "chat_rate_limited", message: "Wait a moment before sending another message." } } });
  router.use("/multichat/:token/chat", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.get("/multichat/:token/chat", deps.limiter, deps.tokenAuth, async (req, res, next) => {
    try {
      const userId = String(/** @type {any} */ (req).overlayUserId);
      const config = await deps.users.getPreferences(userId, "multichat") || {};
      const statuses = deps.platformChat ? await deps.platformChat.status(userId, config) : PLATFORMS.map(platform => ({
        platform, available: false, maxLength: platform === "youtube" ? 200 : 500,
        reason: "Chat sending is unavailable. Open the platform's chat to reply.",
      }));
      const bot = deps.twitchChatBot?.chatStatus(userId, req.params.token, config.twitch?.channel || "");
      const current = await deps.overlayTokens.resolve(req.params.token);
      if (!current || current.userId !== userId) {
        res.status(401).json({ error: { code: "invalid_overlay_token" } }); return;
      }
      res.json({ platforms: statuses.map(row => !configured(row.platform, config) ? { ...row, available: false, reason: "Configure this platform in Chat & alerts first." }
        : row.platform === "twitch" && bot?.available ? bot : row) });
    } catch (error) { next(error); }
  });
  router.post("/multichat/:token/chat", deps.tokenAuth, sendLimiter, async (req, res, next) => {
    try {
      if (!validMessage(req.body)) {
        res.status(400).json({ error: { code: "chat_message_invalid", message: "Choose platforms and enter one chat message up to 500 characters." } }); return;
      }
      const owner = String(/** @type {any} */ (req).overlayUserId);
      const results = await deps.overlayTokens.withWrite(req.params.token, async () => {
        const current = await deps.overlayTokens.resolve(req.params.token);
        if (!current || current.userId !== owner) throw Object.assign(new Error("This Dock link changed."), { status: 401, code: "invalid_overlay_token" });
        const config = await deps.users.getPreferences(owner, "multichat") || {};
        const output = [];
        // Each platform is attempted once. Partial success must never replay a completed send.
        for (const platform of req.body.platforms) {
          try {
            const currentOwner = await deps.overlayTokens.resolve(req.params.token);
            if (!currentOwner || currentOwner.userId !== owner) { output.push({ platform, status: "failed", message: "This Dock link changed. Refresh the Dock before sending." }); continue; }
            if (!configured(platform, config)) { output.push({ platform, status: "failed", message: "Configure this platform in Chat & alerts first." }); continue; }
            const bot = platform === "twitch" && deps.twitchChatBot?.chatStatus(owner, req.params.token, config.twitch.channel);
            const result = bot && bot.available && deps.twitchChatBot ? deps.twitchChatBot.queueChat(owner, req.params.token, config.twitch.channel, req.body.text)
              : deps.platformChat ? await deps.platformChat.send(owner, platform, req.body.text.trim(), config)
              : { status: "failed", message: "Chat sending is unavailable. Open the platform's chat to reply." };
            output.push({ platform, ...result });
          } catch (error) { output.push({ platform, status: failureStatus(error), message: failureMessage(error) }); }
        }
        return output;
      });
      res.json({ results });
    } catch (error) { next(error); }
  });
}

module.exports = { registerDockChatRoutes };
