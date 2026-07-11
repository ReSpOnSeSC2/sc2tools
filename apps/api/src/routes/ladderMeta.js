"use strict";

const express = require("express");

/**
 * /v1/meta/ladder — the public Ladder Meta Radar report.
 *
 * Serves the effectiveness-weighted opener meta for one (league band,
 * matchup): the top openers by games with wins/losses/winrate, each
 * opener's prevalence, and week-over-week deltas. Rows are k-anonymous
 * aggregates (n >= MIN_SAMPLE per band, per-opener floor, no user data)
 * computed nightly by jobs/ladderMetaRecomputeJob.
 *
 * PUBLIC — no auth middleware. Unlike routes/benchmarks.js (which frames
 * a signed-in user's own numbers and is therefore authed), this is a
 * corpus-wide, SEO-facing report with nothing user-specific in it. It is
 * meant to be mounted with app.js's PUBLIC router bundle (alongside
 * routes/seasons.js and the public community GETs, BEFORE any router
 * that calls ``router.use(auth)``) so the marketing page at /meta can
 * render it server-side without a token. See lib/serverApi.getJson.
 *
 * @param {{
 *   ladderMeta: import('../services/ladderMeta').LadderMetaService,
 * }} deps
 */
function buildLadderMetaRouter(deps) {
  const router = express.Router();

  router.get("/meta/ladder", async (req, res, next) => {
    try {
      const leagueId = Number.parseInt(String(req.query.leagueId ?? ""), 10);
      const matchup = String(req.query.matchup || "").trim();
      if (!Number.isFinite(leagueId) || !/^[PTZ]v[PTZ]$/i.test(matchup)) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "leagueId (number) and matchup (e.g. PvZ) required",
          },
        });
        return;
      }
      const row = await deps.ladderMeta.lookup({ leagueId, matchup });
      if (!row) {
        // Not enough corpus for this (band, matchup) yet — the page
        // renders a friendly "not enough data" state.
        res.status(404).json({ error: { code: "not_enough_data" } });
        return;
      }
      res.json({ row });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildLadderMetaRouter };
