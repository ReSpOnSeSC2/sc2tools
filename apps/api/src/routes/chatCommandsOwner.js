"use strict";
const express = require("express");

/** Saved-settings preview is owner authenticated and never sends a chat message.
 * @param {{auth:import('express').RequestHandler,commands:import('../services/chatCommandService').ChatCommandService}} deps */
function buildChatCommandsOwnerRouter(deps) {
  const router = express.Router();
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
module.exports = { buildChatCommandsOwnerRouter };
