"use strict";

const express = require("express");
const { isLadderMetaMmrBand } = require("../util/mmrBracketing");

/**
 * /v1/meta/ladder — the public Ladder Meta Radar report.
 *
 * Serves the effectiveness-weighted opener meta for one opponent League
 * or MMR band plus matchup: the top openers by games with
 * wins/losses/winrate, each opener's prevalence, and week-over-week
 * deltas. Rows are k-anonymous aggregates (n >= MIN_SAMPLE per band,
 * per-opener floor, no user data) computed nightly by
 * jobs/ladderMetaRecomputeJob.
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
      const params = parseLadderMetaQuery(req.query);
      if (!params) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message:
              "axis (league|mmr), numeric band, and matchup (e.g. PvZ) required",
          },
        });
        return;
      }
      const row = await deps.ladderMeta.lookup(params);
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

/**
 * Parse the canonical dual-axis contract, or the legacy leagueId form when
 * neither canonical key is present. Partial canonical requests are invalid
 * rather than silently falling back to a different league row.
 *
 * @param {Record<string, unknown>} query
 * @returns {{bandType: "league" | "mmr", band: number, matchup: string} | null}
 */
function parseLadderMetaQuery(query) {
  const matchup = scalarString(query.matchup);
  if (!matchup || !/^[PTZ]v[PTZ]$/i.test(matchup)) return null;

  const canonical = query.axis !== undefined || query.band !== undefined;
  if (!canonical) {
    const band = strictInteger(query.leagueId);
    return band === null ? null : { bandType: "league", band, matchup };
  }

  const axis = scalarString(query.axis);
  const band = strictInteger(query.band);
  if ((axis !== "league" && axis !== "mmr") || band === null) return null;
  if (axis === "mmr" && !isLadderMetaMmrBand(band)) return null;
  return { bandType: axis, band, matchup };
}

/** @param {unknown} raw @returns {string | null} */
function scalarString(raw) {
  return typeof raw === "string" ? raw.trim() : null;
}

/** @param {unknown} raw @returns {number | null} */
function strictInteger(raw) {
  const value = scalarString(raw);
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

module.exports = { buildLadderMetaRouter, parseLadderMetaQuery };
