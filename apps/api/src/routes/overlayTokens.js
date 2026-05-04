"use strict";

const express = require("express");

/**
 * /v1/overlay-tokens — user's hosted-overlay tokens.
 * Public consumption of /overlay/<token> is served by the Next.js
 * frontend; the API only manages issuance + lookups.
 *
 * @param {{
 *   overlayTokens: import('../services/types').OverlayTokensService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildOverlayTokensRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/overlay-tokens", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const items = await deps.overlayTokens.list(auth.userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.post("/overlay-tokens", async (req, res, next) => {
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

  router.delete("/overlay-tokens/:token", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.overlayTokens.revoke(auth.userId, String(req.params.token));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildOverlayTokensRouter };
