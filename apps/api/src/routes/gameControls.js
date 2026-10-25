"use strict";
const express = require("express");
const { deleteConfirmation } = require("../config/gameControls.json");

/** @param {{auth:import('express').RequestHandler,controls:import('../services/gameControls').GameControlsService}} deps */
function buildGameControlsRouter(deps) {
  const router = express.Router();
  router.get("/games/hidden", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try { if (!req.auth) throw new Error("auth_required"); res.json(await deps.controls.hidden(req.auth.userId, { cursor: req.query.cursor })); }
    catch (err) { next(err); }
  });
  router.get("/game-accounts", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try { if (!req.auth) throw new Error("auth_required"); res.json(await deps.controls.accounts(req.auth.userId)); }
    catch (err) { next(err); }
  });
  router.patch("/games/:gameId", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (!req.auth) throw new Error("auth_required");
      const body = req.body;
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !["excluded", "reason"].includes(key))) {
        res.status(400).json({ error: { code: "invalid_game_control" } }); return;
      }
      const result = await deps.controls.setExcluded(req.auth.userId, String(req.params.gameId), body);
      if (!result) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.json(result);
    } catch (err) { next(err); }
  });
  router.delete("/games/:gameId", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (!req.auth) throw new Error("auth_required");
      if (req.body?.confirmation !== deleteConfirmation || Object.keys(req.body).some(key => key !== "confirmation")) {
        res.status(400).json({ error: { code: "delete_confirmation_required" } }); return;
      }
      const result = await deps.controls.deleteGame(req.auth.userId, String(req.params.gameId));
      if (!result) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.json(result);
    } catch (err) { next(err); }
  });
  return router;
}
module.exports = { buildGameControlsRouter };
