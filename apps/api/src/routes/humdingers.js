"use strict";

const express = require("express");

const PRIVATE = "private, no-store";

/**
 * Humdingers account saves and play reports for the /play/humdingers host
 * page (ADR 0102, 0103), and the chunks of each visit's run tape (ADR 0113).
 * Every route needs a signed-in website account; desktop agent device tokens
 * cannot read or write game saves or tapes.
 * @param {{humdingers: import('../services/humdingers').HumdingersService, auth: import('express').RequestHandler}} deps
 */
function buildHumdingersRouter(deps) {
  const router = express.Router();
  const player = [deps.auth, requireWebsiteAccount];

  router.get("/me/humdingers/saves", ...player, async (req, res, next) => {
    try {
      res.set("Cache-Control", PRIVATE).json({ saves: await deps.humdingers.listSaves(userIdOf(req)) });
    } catch (error) { next(error); }
  });

  router.put("/me/humdingers/saves/:slot", ...player, async (req, res, next) => {
    try {
      res.set("Cache-Control", PRIVATE).json({ save: await deps.humdingers.putSave(userIdOf(req), req.params.slot, req.body) });
    } catch (error) {
      const err = /** @type {any} */ (error);
      // The newer copy lets the host page write it back to the player's browser.
      if (err?.status === 409 && err.save) {
        res.status(409).set("Cache-Control", PRIVATE).json({ error: { code: err.code, message: err.message }, save: err.save });
        return;
      }
      next(error);
    }
  });

  router.delete("/me/humdingers/saves/:slot", ...player, async (req, res, next) => {
    try {
      res.set("Cache-Control", PRIVATE).json(await deps.humdingers.deleteSave(userIdOf(req), req.params.slot));
    } catch (error) { next(error); }
  });

  router.post("/me/humdingers/plays", ...player, async (req, res, next) => {
    try {
      await deps.humdingers.recordPlay(userIdOf(req), req.body);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  // One chunk of the visit's run tape, under the visit's play session id.
  router.post("/me/humdingers/tapes/:session", ...player, async (req, res, next) => {
    try {
      res.set("Cache-Control", PRIVATE);
      await deps.humdingers.putTapeChunk(userIdOf(req), req.params.session, req.body);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}

/** @type {import('express').RequestHandler} */
function requireWebsiteAccount(req, res, next) {
  const auth = /** @type {any} */ (req).auth;
  if (!auth || auth.source !== "clerk" || typeof auth.userId !== "string" || !auth.userId) {
    res.status(403).json({ error: { code: "website_account_required", message: "Sign in on the website to play." } });
    return;
  }
  next();
}

/** @param {import('express').Request} req @returns {string} */
function userIdOf(req) {
  return /** @type {any} */ (req).auth.userId;
}

module.exports = { buildHumdingersRouter };
