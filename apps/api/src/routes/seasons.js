"use strict";

const express = require("express");

/**
 * /v1/seasons — public read of the SC2 ladder season catalog.
 *
 * Public on purpose: the catalog is the same for every user, the SPA
 * needs it before the user is signed in (the "Get the agent" landing
 * page wants to render season copy), and SC2Pulse itself serves the
 * raw data without auth.
 *
 * @param {{ seasons: import('../services/seasons').SeasonsService }} deps
 */
function buildSeasonsRouter(deps) {
  const router = express.Router();

  router.get("/seasons", async (_req, res, next) => {
    try {
      const payload = await deps.seasons.list();
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildSeasonsRouter };
