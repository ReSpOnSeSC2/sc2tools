"use strict";

/** @param {import('express').Router} router
 * @param {{gameContext?:import('../services/gameContext').GameContextService}} deps */
function registerGameContextRoute(router, deps) {
  router.get("/games/:gameId/context", async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (!req.auth) throw new Error("auth_required");
      const context = await deps.gameContext?.get(req.auth.userId, String(req.params.gameId));
      if (!context) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.json(context);
    } catch (error) { next(error); }
  });
}

module.exports = { registerGameContextRoute };
