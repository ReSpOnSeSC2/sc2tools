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
 *   adminEvents?: {
 *     record: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
 *   } | null,
 * }} deps
 */
function buildAgentVersionRouter(deps) {
  const router = express.Router();
  const adminEvents = deps.adminEvents || null;

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

  /**
   * Public download-click beacon. The marketing page's DownloadCard
   * fires this with ``navigator.sendBeacon`` (or a keepalive fetch
   * fallback) immediately before the browser starts the GitHub-hosted
   * download. The response is intentionally tiny — clients don't
   * await it — so a slow Mongo path can never delay a user's
   * download. Best-effort: a failed insert returns 204 anyway so we
   * never leak a 500 onto the marketing surface.
   */
  router.post("/agent/download-event", async (req, res) => {
    try {
      if (adminEvents) {
        const body = (req.body && typeof req.body === "object") ? req.body : {};
        const platform = typeof body.platform === "string" ? body.platform : "";
        const version = typeof body.version === "string" ? body.version : "";
        const channel = typeof body.channel === "string" ? body.channel : "stable";
        const ip = pickClientIp(req);
        const userAgent = headerStr(req, "user-agent");
        const referer = headerStr(req, "referer");
        await adminEvents.record("agent_download", {
          platform,
          version,
          channel,
          ip,
          userAgent,
          referer,
        });
      }
      res.status(204).end();
    } catch {
      res.status(204).end();
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

/**
 * Pick the best-effort client IP from a request. Honours the
 * standard ``x-forwarded-for`` chain (Express's ``trust proxy``
 * setting normalises this to ``req.ip``) and falls back to the raw
 * socket address. The IP is masked to a /24 (or /64 for IPv6) inside
 * ``AdminEventsService`` before it lands in the feed.
 *
 * @param {import('express').Request} req
 */
function pickClientIp(req) {
  if (typeof req.ip === "string" && req.ip.length > 0) return req.ip;
  const fwd = headerStr(req, "x-forwarded-for");
  if (fwd) return fwd;
  const sock = /** @type {any} */ (req).socket;
  if (sock && typeof sock.remoteAddress === "string") return sock.remoteAddress;
  return "";
}

/**
 * @param {import('express').Request} req
 * @param {string} name
 */
function headerStr(req, name) {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return "";
}

module.exports = { buildAgentVersionRouter };
