"use strict";
const express = require("express");
const { LIMITS } = require("../config/constants");
const { PlatformIntegrationError } = require("../services/platformIntegrations");
const { parsePlatform } = require("./platformIntegrations");
const { savedClipName, savedClipRecorder } = require("../services/streamSavedClip");

/** Narrow user-owned control API. Accepts paired agents or signed-in users.
 * Provider credentials stay in services; no route accepts a user/channel ID.
 * @param {{auth:import('express').RequestHandler,
 * integrations:import('../services/platformIntegrations').PlatformIntegrationsService,
 * titleSession?:(userId:string, gameId?:string)=>Promise<unknown>,
 * streamingTitles:import('../services/streamingTitles').StreamingTitlesService,
 * streamingChannel?:import('../services/streamingChannel').StreamingChannelService,
 * streamGuardian?:import('../services/streamGuardian').StreamGuardianService,
 * engagement?:import('../services/multichatEngagement').MultichatEngagementService,
 * overlayTokens?:import('../services/overlayTokens').OverlayTokensService}} deps
 */
function buildAgentStreamingRouter({ auth, integrations, streamingTitles, streamingChannel, titleSession, streamGuardian, engagement, overlayTokens }) {
  const router = express.Router();
  const recordSavedClip = engagement && overlayTokens ? savedClipRecorder({ engagement, overlayTokens }) : null;
  router.get("/agent/streaming/session", auth, async (req, res, next) => {
    try {
      const userId = requireAccount(req);
      const gameId = req.query.gameId;
      if (Object.keys(req.query).some(key => key !== "gameId")
        || (gameId !== undefined && (typeof gameId !== "string" || !gameId || gameId !== gameId.trim()
          || gameId.length > LIMITS.GAME_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(gameId)))) {
        throw new PlatformIntegrationError(400, "stream_session_request_invalid", "Session statistics accept only one synced game ID for the paired account.");
      }
      if (!titleSession) throw new Error("session unavailable");
      res.set("Cache-Control", "no-store");
      res.json(await titleSession(userId, gameId));
    } catch (error) { next(safeFailure(error)); }
  });
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
  router.post("/agent/streaming/tags", auth, channelHandler(streamingChannel, ["platform", "tags", "previous"],
    (service, userId, body) => service.setTags(userId, body.platform, body.tags, body.previous ?? [])));
  router.post("/agent/streaming/category", auth, channelHandler(streamingChannel, ["platform"],
    (service, userId, body) => service.ensureCategory(userId, body.platform)));
  router.post("/agent/streaming/guardian", auth, (req, res, next) => {
    try {
      const userId = requireAccount(req);
      const body = req.body;
      if (!streamGuardian) throw new Error("guardian unavailable");
      if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.warnings)
        || Object.keys(body).some((key) => key !== "warnings")) {
        throw new PlatformIntegrationError(400, "stream_guardian_request_invalid", "Send only the list of warnings that are active now.");
      }
      res.set("Cache-Control", "no-store");
      res.json({ warnings: streamGuardian.publish(userId, body.warnings).warnings });
    } catch (error) { next(safeFailure(error)); }
  });
  router.post("/agent/streaming/clip", auth, async (req, res, next) => {
    try {
      const userId = requireAccount(req);
      const body = req.body;
      const name = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => key === "name")
        ? savedClipName(body.name) : null;
      if (name === null) {
        throw new PlatformIntegrationError(400, "stream_clip_request_invalid", "Send only the name of the saved clip, one line of text.");
      }
      if (!recordSavedClip) throw new Error("clips unavailable");
      res.set("Cache-Control", "no-store");
      res.json({ listed: await recordSavedClip(userId, name) });
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

/** Channel operations answer with a receipt, so a failed tag or category call
 * never turns into an HTTP error the title path could trip over.
 * @param {import('../services/streamingChannel').StreamingChannelService|undefined} service
 * @param {string[]} fields
 * @param {(service:import('../services/streamingChannel').StreamingChannelService, userId:string, body:Record<string, unknown>)=>Promise<unknown>} run */
function channelHandler(service, fields, run) {
  return async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
    try {
      const userId = requireAccount(req);
      const body = req.body;
      if (!service || !body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some((key) => !fields.includes(key))) {
        throw new PlatformIntegrationError(400, "stream_channel_request_invalid", "Use only the documented channel fields.");
      }
      res.set("Cache-Control", "no-store");
      res.json(await run(service, userId, body));
    } catch (error) { next(safeFailure(error)); }
  };
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
