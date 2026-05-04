"use strict";

const express = require("express");

/**
 * /v1/me — sanity endpoint for the web app. Returns the user record
 * + last-sync timestamps so the SPA can render onboarding state.
 *
 * @param {{
 *   users: import('../services/types').UsersService,
 *   games: import('../services/types').GamesService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildMeRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/me", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.users.touch(auth.userId);
      const stats = await deps.games.stats(auth.userId);
      res.json({
        userId: auth.userId,
        source: auth.source,
        games: stats,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildMeRouter };
