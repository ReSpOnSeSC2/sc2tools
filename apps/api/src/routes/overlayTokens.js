"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const { OverlayLiveService } = require("../services/overlayLive");

/**
 * /v1/overlay-tokens — user's hosted-overlay tokens.
 * Public consumption of /overlay/<token> is served by the Next.js
 * frontend; the API only manages issuance + lookups.
 *
 * Also:
 *   POST /v1/overlay-events/live  — agent-only, broadcasts a live
 *     pre-game payload to the overlay socket room. Per-token
 *     rate-limited so a leaked token can't DoS the cloud.
 *   POST /v1/overlay-events/test  — Clerk-authed (web user only),
 *     fires a synthetic ``overlay:live`` payload tailored to a single
 *     widget so the streamer can validate their OBS layout without a
 *     ladder game. Uses the same per-token rate limiter as the live
 *     route — a Test-button mash can't flood the socket either.
 *
 * @param {{
 *   overlayTokens: import('../services/types').OverlayTokensService,
 *   overlayLive?: import('../services/overlayLive').OverlayLiveService,
 *   auth: import('express').RequestHandler,
 *   io?: import('socket.io').Server,
 * }} deps
 */
function buildOverlayTokensRouter(deps) {
  const router = express.Router();

  // Routes that need normal auth.
  const authed = express.Router();
  authed.use(deps.auth);

  authed.get("/overlay-tokens", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const items = await deps.overlayTokens.list(auth.userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  authed.post("/overlay-tokens", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const label = (req.body?.label || "").toString().slice(0, 60);
      const created = await deps.overlayTokens.create(auth.userId, label);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  authed.delete("/overlay-tokens/:token", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.overlayTokens.revoke(auth.userId, String(req.params.token));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  authed.patch(
    "/overlay-tokens/:token/widgets",
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const widget = String(req.body?.widget || "");
        const enabled = Boolean(req.body?.enabled);
        if (!widget) {
          res.status(400).json({
            error: { code: "bad_request", message: "widget required" },
          });
          return;
        }
        const token = String(req.params.token);
        const result = await deps.overlayTokens.setWidgetEnabled(
          auth.userId,
          token,
          widget,
          enabled,
        );
        // Push the new config to the live overlay so OBS toggles
        // visibility without a page reload.
        if (deps.io) {
          deps.io.to(`overlay:${token}`).emit("overlay:config", {
            enabledWidgets: result.enabledWidgets,
          });
        }
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Per-token rate limit on live overlay events. A leaked token
  // shouldn't be able to fan out hundreds of messages per second to
  // the overlay's socket room; 10/sec is plenty for the legitimate
  // pre-game / post-game / MMR-delta cadence (one of each per game).
  const overlayEventLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: 100, // 10/sec average
    standardHeaders: true,
    legacyHeaders: false,
    /** @param {import('express').Request} req */
    keyGenerator: (req) => {
      const tok = req.body?.token || req.query?.token || "anon";
      return `overlay-event:${tok}`;
    },
  });

  authed.post(
    "/overlay-events/live",
    overlayEventLimiter,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const token = String(req.body?.token || "");
        if (!token) {
          res.status(400).json({
            error: { code: "bad_request", message: "token required" },
          });
          return;
        }
        const owns = await deps.overlayTokens.tokenBelongsToUser(
          auth.userId,
          token,
        );
        if (!owns) {
          res.status(404).json({
            error: { code: "not_found", message: "overlay token not found" },
          });
          return;
        }
        const payload = req.body?.payload;
        if (deps.io) {
          deps.io.to(`overlay:${token}`).emit("overlay:live", payload || {});
        }
        res.status(202).json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // Reuses the live-route limiter so a Test-button mash can't flood the
  // overlay socket either. Note: only requests with the *real* widget
  // intent path through here; the rate-limit key is the overlay token
  // so a malicious caller spamming the route can't impact a different
  // streamer's overlay even at full burst.
  authed.post(
    "/overlay-events/test",
    overlayEventLimiter,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const token = String(req.body?.token || "");
        if (!token) {
          res.status(400).json({
            error: { code: "bad_request", message: "token required" },
          });
          return;
        }
        const owns = await deps.overlayTokens.tokenBelongsToUser(
          auth.userId,
          token,
        );
        if (!owns) {
          res.status(404).json({
            error: { code: "not_found", message: "overlay token not found" },
          });
          return;
        }
        // ``widget`` is optional — omitted means "fire a payload that
        // lights up every panel at once" so the streamer can validate
        // the whole layout in one shot. When present, we narrow the
        // payload to just that widget's fields so neighbouring panels
        // stay quiet during a per-widget probe.
        const widget = req.body?.widget
          ? String(req.body.widget)
          : undefined;
        const payload = OverlayLiveService.buildSamplePayload(widget);
        // Stamp the test flag so the overlay clients can cap every
        // widget — including the normally-persistent session/topbuilds
        // panels — at a short visibility timer. Without this a Test
        // fire would pin sample data to the scene until the streamer
        // refreshed the Browser Source.
        payload.isTest = true;
        if (deps.io) {
          deps.io.to(`overlay:${token}`).emit("overlay:live", payload);
          // Single-widget Test for the session card needs a
          // ``overlay:session`` event too — that's the only widget
          // wired off the dedicated socket event rather than
          // ``overlay:live.session``. The same sample payload's
          // session block is reused so the W-L count is consistent
          // with whatever the streamer just clicked, with the test
          // flag forwarded so the widget puts itself on a timer.
          if ((!widget || widget === "session") && payload.session) {
            deps.io.to(`overlay:${token}`).emit(
              "overlay:session",
              { ...payload.session, isTest: true },
            );
          }
        }
        res.status(202).json({ ok: true, widget: widget || "all" });
      } catch (err) {
        next(err);
      }
    },
  );

  router.use(authed);
  return router;
}

module.exports = { buildOverlayTokensRouter };
