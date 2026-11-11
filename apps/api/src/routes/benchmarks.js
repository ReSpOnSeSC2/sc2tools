"use strict";

const express = require("express");

const MATCHUP_RE = /^[PTZ]v[PTZ]$/;
const ERAS = new Set(["after", "before"]);

/**
 * /v1/benchmarks — league-percentile benchmark tables.
 *
 * Serves the aggregate distributions the Macro tab (and later the
 * Skill Fingerprint) frame personal numbers against: "your macro score
 * is 38th percentile for Diamond PvZ". Tables are k-anonymous
 * aggregates (n >= 50 per band, no user data) computed nightly by
 * jobs/leaguePercentilesRecomputeJob.
 *
 *   GET /benchmarks?leagueId&matchup          slim-row metric deciles
 *   GET /benchmarks/timings?leagueId&matchup&era
 *                                             build-timing deciles from
 *                                             guide_samples (same floor)
 *   GET /benchmarks/targets?matchup&timings   the caller's own side of the
 *                                             Targets card (private)
 *
 * @param {{
 *   leaguePercentiles: import('../services/leaguePercentiles').LeaguePercentilesService,
 *   leagueTimings?: import('../services/leagueTimingPercentiles').LeagueTimingPercentilesService,
 *   leagueTargets?: import('../services/leagueTargets').LeagueTargetsService,
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
      if (!Number.isFinite(leagueId) || !MATCHUP_RE.test(matchup)) {
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

  router.get("/benchmarks/timings", (req, res, next) => sendTimings(deps, req, res).catch(next));
  router.get("/benchmarks/targets", (req, res, next) => sendTargets(deps, req, res).catch(next));

  return router;
}

/**
 * GET /benchmarks/timings — one band's build-timing deciles, 404 below the
 * k-anonymity floor exactly like /benchmarks.
 *
 * @param {Parameters<typeof buildBenchmarksRouter>[0]} deps
 * @param {import('express').Request} req @param {import('express').Response} res
 */
async function sendTimings(deps, req, res) {
  if (!req.auth) throw new Error("auth_required");
  const leagueId = Number(req.query.leagueId);
  const matchup = String(req.query.matchup || "").trim();
  const era = String(req.query.era || "after");
  if (!Number.isInteger(leagueId) || leagueId < 0 || leagueId > 6 || !MATCHUP_RE.test(matchup) || !ERAS.has(era)) {
    res.status(400).json({ error: { code: "bad_request", message: "leagueId (0-6), matchup (e.g. PvZ) and era (after|before) required" } });
    return;
  }
  const table = deps.leagueTimings ? await deps.leagueTimings.lookup({ leagueId, matchup, era }) : null;
  if (!table) {
    res.status(404).json({ error: { code: "not_enough_data" } });
    return;
  }
  res.json({ table });
}

/**
 * GET /benchmarks/targets — the caller's own medians, MMR and timings.
 * Private to the caller and never stored by a shared cache.
 *
 * @param {Parameters<typeof buildBenchmarksRouter>[0]} deps
 * @param {import('express').Request} req @param {import('express').Response} res
 */
async function sendTargets(deps, req, res) {
  const auth = req.auth;
  if (!auth) throw new Error("auth_required");
  res.set("Cache-Control", "private, no-store");
  if (!deps.leagueTargets) {
    res.status(503).json({ error: { code: "targets_unavailable" } });
    return;
  }
  const raw = typeof req.query.matchup === "string" ? req.query.matchup.trim() : "";
  if (raw && !MATCHUP_RE.test(raw)) {
    res.status(400).json({ error: { code: "bad_request", message: "matchup must look like PvZ" } });
    return;
  }
  res.json(await deps.leagueTargets.personal(auth.userId, raw || null, req.query.timings !== "0"));
}

module.exports = { buildBenchmarksRouter };
