"use strict";
const express = require("express");
const rateLimit = require("express-rate-limit").rateLimit;
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { sha256 } = require("../util/hash");
const { ChatOwnerReplies, readReplyEvent } = require("../services/chatOwnerReplies");
const { PlatformChatService } = require("../services/platformChat");

/** Saved-settings preview is owner authenticated and never sends a chat message.
 * @param {{auth:import('express').RequestHandler,commands:import('../services/chatCommandService').ChatCommandService,
 * replies?:import('../services/chatOwnerReplies').ChatOwnerReplies}} deps */
function buildChatCommandsOwnerRouter(deps) {
  const router = express.Router();
  const replyLimiter = rateLimit({
    windowMs: 30_000, max: 6, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    keyGenerator: req => sha256(req.auth?.userId || "missing-owner"),
    message: { error: { code: "chat_rate_limited", message: "Wait a moment before sending another reply." } },
  });
  router.post("/me/chat-commands/reply", (_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  }, deps.auth, replyLimiter, async (req, res, next) => {
    try {
      if (!req.auth) { res.status(401).json({ error: { code: "auth_required" } }); return; }
      if (!deps.replies) { res.status(503).json({ error: { code: "chat_commands_unavailable" } }); return; }
      const event = readReplyEvent(req.body);
      if (!event) { res.status(400).json({ error: { code: "invalid_chat_command" } }); return; }
      const result = await deps.replies.send(req.auth.userId, event);
      res.json(result);
    } catch (error) { next(error); }
  });
  router.post("/me/chat-commands/try", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (!req.auth) throw new Error("auth_required");
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.token !== "string" || body.token.length > 512 ||
        typeof body.command !== "string" || body.command.length > 25 ||
        (body.argument !== undefined && (typeof body.argument !== "string" || body.argument.length > 80)) ||
        (body.user !== undefined && (typeof body.user !== "string" || body.user.length > 80))) {
        res.status(400).json({ error: { code: "invalid_chat_command" } }); return;
      }
      const reply = await deps.commands.answer(body.token, { command: body.command, argument: body.argument,
        platform: body.platform, user: body.user || "viewer", onStream: body.onStream === true }, { previewOwner: req.auth.userId });
      if (!reply) { res.status(404).json({ error: { code: "overlay_token_not_found" } }); return; }
      res.json(reply);
    } catch (error) { next(error); }
  });
  return router;
}

/** Mount the owner routes and return the same provider sender for the Dock.
 * @param {import('express').Express} app @param {string} prefix @param {import('express').RequestHandler} auth
 * @param {{platformIntegrations:import('../services/platformIntegrations').PlatformIntegrationsService,
 *   overlayTokens:import('../services/overlayTokens').OverlayTokensService, users:import('../services/users').UsersService,
 *   chatCommands:import('../services/chatCommandService').ChatCommandService}} services */
function mountChatCommandsOwnerRoutes(app, prefix, auth, { platformIntegrations, overlayTokens, users, chatCommands }) {
  const platformChat = new PlatformChatService({ integrations: platformIntegrations });
  const replies = new ChatOwnerReplies({ overlayTokens, users, commands: chatCommands, platformChat });
  app.use(prefix, buildChatCommandsOwnerRouter({ auth, commands: chatCommands, replies }));
  return platformChat;
}

module.exports = { buildChatCommandsOwnerRouter, mountChatCommandsOwnerRoutes };
