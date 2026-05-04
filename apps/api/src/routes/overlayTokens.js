"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * /v1/overlay-tokens — user's hosted-overlay tokens.
 * Public consumption of /overlay/<token> is served by the Next.js
 * frontend; the API only manages issuance + lookups.
 *
 * Also: POST /v1/overlay-events/live — agent-only, broadcasts a live
 * pre-game payload to the overlay socket room. Per-token rate-limited
 * so a leaked token can't DoS the cloud.
 *
 * @param {{
 *   overlayTokens: import('../services/types').OverlayTokensService,
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

  router.use(authed);
  return router;
}

module.exports = { buildOverlayTokensRouter };
