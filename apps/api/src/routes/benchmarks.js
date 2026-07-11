"use strict";

const express = require("express");

/**
 * /v1/benchmarks — league-percentile benchmark tables.
 *
 * Serves the aggregate distributions the Macro tab (and later the
 * Skill Fingerprint) frame personal numbers against: "your macro score
 * is 38th percentile for Diamond PvZ". Tables are k-anonymous
 * aggregates (n >= 50 per band, no user data) computed nightly by
 * jobs/leaguePercentilesRecomputeJob.
 *
 * @param {{
 *   leaguePercentiles: import('../services/leaguePercentiles').LeaguePercentilesService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildBenchmarksRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/benchmarks", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const leagueId = Number.parseInt(String(req.query.leagueId ?? ""), 10);
      const matchup = String(req.query.matchup || "").trim();
      if (!Number.isFinite(leagueId) || !/^[PTZ]v[PTZ]$/.test(matchup)) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "leagueId (number) and matchup (e.g. PvZ) required",
          },
        });
        return;
      }
      const table = await deps.leaguePercentiles.lookup({ leagueId, matchup });
      if (!table) {
        // Not enough corpus for this band yet — the client renders
        // absolutes without the percentile framing.
        res.status(404).json({ error: { code: "not_enough_data" } });
        return;
      }
      res.json({ table });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildBenchmarksRouter };
