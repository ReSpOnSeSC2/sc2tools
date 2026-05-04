"use strict";

const express = require("express");

/**
 * /v1/device-pairings — agent ↔ web pairing handshake.
 *
 * Auth split:
 *   - /start  no auth      (new agent kicks off, has no token yet)
 *   - /poll   no auth      (agent polls until a user claims; the code is the secret)
 *   - /claim  Clerk JWT    (signed-in user binds the code to themselves)
 *   - /devices            Clerk JWT    (list/revoke)
 *
 * @param {{
 *   pairings: import('../services/types').DevicePairingsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildDevicePairingsRouter(deps) {
  const router = express.Router();

  router.post("/device-pairings/start", async (_req, res, next) => {
    try {
      const result = await deps.pairings.start();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/device-pairings/:code", async (req, res, next) => {
    try {
      const result = await deps.pairings.poll(String(req.params.code));
      const status = result.status === "ready" ? 200 : 202;
      res.status(status).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/device-pairings/claim", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const code = req.body?.code;
      if (!code || typeof code !== "string") {
        res.status(400).json({
          error: { code: "bad_request", message: "code required" },
        });
        return;
      }
      await deps.pairings.claim(auth.userId, code);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/devices", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const items = await deps.pairings.listDevices(auth.userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/devices/:tokenHash", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.pairings.revoke(auth.userId, String(req.params.tokenHash));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildDevicePairingsRouter };
