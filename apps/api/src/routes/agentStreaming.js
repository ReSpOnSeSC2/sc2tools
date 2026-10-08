"use strict";
const express = require("express");
const { PlatformIntegrationError } = require("../services/platformIntegrations");
const { parsePlatform } = require("./platformIntegrations");

/** Narrow user-owned control API. Accepts paired agents or signed-in users.
 * Provider credentials stay in services; no route accepts a user/channel ID.
 * @param {{auth:import('express').RequestHandler,
 * integrations:import('../services/platformIntegrations').PlatformIntegrationsService,
 * streamingTitles:import('../services/streamingTitles').StreamingTitlesService}} deps
 */
function buildAgentStreamingRouter({ auth, integrations, streamingTitles }) {
  const router = express.Router();
  router.get("/agent/streaming/status", auth, async (req, res, next) => {
    try {
      const userId = requireAccount(req);
      res.set("Cache-Control", "no-store");
      res.json(await streamingTitles.status(userId));
    } catch (error) { next(safeFailure(error)); }
  });
  router.post("/agent/streaming/title", auth, async (req, res, next) => {
    try {
      const userId = requireAccount(req);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some((key) => !["title", "platforms"].includes(key))) {
        throw new PlatformIntegrationError(400, "stream_title_request_invalid", "Use only a title and optional platform selection.");
      }
      res.set("Cache-Control", "no-store");
      res.json(await streamingTitles.updateTitle(userId, body.title, body.platforms));
    } catch (error) { next(safeFailure(error)); }
  });
  router.post("/agent/streaming/:platform/connect", auth, async (req, res, next) => {
    try {
      const userId = requireAccount(req);
      const platform = parsePlatform(req.params.platform);
      if (req.body && (Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
        throw new PlatformIntegrationError(400, "stream_connect_request_invalid", "Account connection does not accept identity or credential fields.");
      }
      res.set("Cache-Control", "no-store");
      res.json(await integrations.begin(userId, platform, { purpose: "streaming" }));
    } catch (error) { next(safeFailure(error)); }
  });
  return router;
}

/** @param {import('express').Request} req */
function requireAccount(req) {
  if (!req.auth?.userId || !["device", "clerk"].includes(req.auth.source)) {
    throw new PlatformIntegrationError(401, "auth_required", "Pair the agent with your SC2Tools account first.");
  }
  return String(req.auth.userId);
}

/** @param {unknown} error */
function safeFailure(error) {
  return error instanceof PlatformIntegrationError ? error
    : new PlatformIntegrationError(503, "streaming_operation_unavailable", "The streaming operation is unavailable. Check status before retrying.");
}

module.exports = { buildAgentStreamingRouter };
