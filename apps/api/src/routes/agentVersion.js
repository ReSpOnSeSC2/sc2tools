"use strict";

const express = require("express");
const { compareVersions } = require("../services/agentVersion");

/**
 * /v1/agent/version, /v1/agent/releases — installer feed.
 *
 * GET /v1/agent/version is the only PUBLIC route here: the agent
 * polls it on startup before it has a device token. It accepts
 * `?channel=stable&platform=windows&current=0.1.4` and replies with
 * either {update_available: false} or the latest release artifact
 * metadata.
 *
 * Publishing new releases is admin-only. The route requires a shared
 * `X-Admin-Token` header that matches `process.env.AGENT_RELEASE_ADMIN_TOKEN`.
 *
 * @param {{
 *   agentVersion: import('../services/types').AgentVersionService,
 *   adminToken?: string | null,
 * }} deps
 */
function buildAgentVersionRouter(deps) {
  const router = express.Router();

  router.get("/agent/version", async (req, res, next) => {
    try {
      const channel = String(req.query.channel || "stable");
      const platform = String(req.query.platform || "windows");
      const current = String(req.query.current || "0.0.0");
      const release = /** @type {any} */ (
        await deps.agentVersion.latest({ channel, platform })
      );
      if (!release) {
        res.json({ ok: true, channel, platform, update_available: false });
        return;
      }
      const cmp = compareVersions(current, release.version);
      const updateAvailable = cmp < 0;
      res.json({
        ok: true,
        channel,
        platform,
        update_available: updateAvailable,
        current,
        latest: release.version,
        publishedAt: release.publishedAt,
        releaseNotes: release.releaseNotes,
        minSupportedVersion: release.minSupportedVersion,
        artifact: release.artifact,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/agent/releases", async (req, res, next) => {
    try {
      const channel = String(req.query.channel || "stable");
      res.json({
        ok: true,
        channel,
        items: await deps.agentVersion.history({ channel }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agent/releases", async (req, res, next) => {
    try {
      requireAdmin(req, deps.adminToken);
      const result = await deps.agentVersion.publish(req.body || {});
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * @param {import('express').Request} req
 * @param {string | null | undefined} expected
 */
function requireAdmin(req, expected) {
  if (!expected) {
    const err = new Error("admin_token_not_configured");
    /** @type {any} */ (err).status = 503;
    throw err;
  }
  const provided = req.headers["x-admin-token"];
  if (typeof provided !== "string" || !timingSafeEqual(provided, expected)) {
    const err = new Error("invalid_admin_token");
    /** @type {any} */ (err).status = 401;
    throw err;
  }
}

/** @param {string} a @param {string} b */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const crypto = require("crypto");
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { buildAgentVersionRouter };
