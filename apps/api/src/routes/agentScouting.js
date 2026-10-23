"use strict";

const express = require("express");
const { buildScoutingBrief } = require("../services/agentScouting");
const { validateNotesBody } = require("./opponents");

/**
 * Device-only private scouting. The app's ordinary API rate limit applies to
 * both endpoints, exactly as it does to the web opponent-note route.
 * @param {{auth: import('express').RequestHandler,
 * broker: import('../services/liveGameBroker').LiveGameBroker,
 * opponents: import('../services/types').OpponentsService,
 * overlayLive?: import('../services/overlayLive').OverlayLiveService}} deps
 */
function buildAgentScoutingRouter(deps) {
  const router = express.Router();
  /** @type {import('express').RequestHandler} */
  const deviceOnly = (req, res, next) => {
    if (req.auth?.source !== "device") {
      res.status(403).json({ error: { code: "device_required" } });
      return;
    }
    next();
  };
  router.get("/agent/live/scouting", deps.auth, deviceOnly, (req, res) => {
    const auth = req.auth;
    if (!auth) throw new Error("auth_required");
    const gameKey = req.query.gameKey;
    if (typeof gameKey !== "string" || !gameKey || gameKey.length > 300) {
      res.status(400).json({ error: { code: "invalid_game_key" } });
      return;
    }
    const brief = buildScoutingBrief(deps.broker.latest(auth.userId));
    res.set("Cache-Control", "private, no-store");
    if (!brief || brief.gameKey !== gameKey) {
      res.status(404).json({ error: { code: "no_current_scouting" } });
      return;
    }
    res.json(brief);
  });
  router.put("/agent/opponents/:pulseId/notes", deps.auth, deviceOnly, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const errors = validateNotesBody(req.body);
      if (errors.length) {
        res.status(400).json({ error: { code: "bad_request", details: errors } });
        return;
      }
      const result = await deps.opponents.updateNotes(auth.userId, String(req.params.pulseId), req.body);
      if (!result) { res.status(404).json({ error: { code: "not_found" } }); return; }
      // Match the web route's invalidation, without adding a read or refresh.
      try { deps.overlayLive?.invalidateEnrichmentForOpponent(auth.userId, result.opponentName, result.pulseCharacterId); }
      catch { /* cache invalidation is advisory, as on the web note route */ }
      res.set("Cache-Control", "private, no-store").json({ notes: result.notes, notesReadAloud: result.notesReadAloud });
    } catch (err) { next(err); }
  });
  return router;
}
module.exports = { buildAgentScoutingRouter };
