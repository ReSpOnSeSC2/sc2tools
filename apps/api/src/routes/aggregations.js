"use strict";

const express = require("express");
const { parseFilters, parseFiniteInt } = require("../util/parseQuery");
const { asOppMmrBucketWidth } = require("../services/trendsOppMmr");

/**
 * /v1 — analytics aggregations.
 *
 * @param {{
 *   aggregations: import('../services/types').AggregationsService,
 *   macroReport: import('../services/macroReport').MacroReportService,
 *   streak: import('../services/streak').StreakService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildAggregationsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/summary", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.summary(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/matchups", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.matchups(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/maps", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.maps(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // Cross-tab of (map, matchup): per-map win rate split by opponent
  // race. Backs the "Win rate by map by matchup" section of the Maps tab.
  router.get("/maps/matchups", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.mapMatchups(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // Diagnostic: every distinct value of the `map` field across the
  // user's games. Surfaces data-quality issues (e.g. an agent that
  // uploads the same map name for every replay) without filters or
  // grouping.
  router.get("/maps/diagnostic", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const items = await deps.aggregations.distinctMaps(userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/build-vs-strategy", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.buildVsStrategy(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/random-summary", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.randomSummary(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/timeseries", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "day").toLowerCase();
      /** @type {'day' | 'week' | 'month'} */
      const interval =
        intervalRaw === "week" || intervalRaw === "month"
          ? intervalRaw
          : "day";
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.timeseries(
          userId,
          { interval, tz },
          filters,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // Win rate vs each opponent race over time. Powers the Trends tab's
  // "matchup over time" small-multiples chart.
  router.get("/timeseries/matchups", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "week").toLowerCase();
      /** @type {'day' | 'week' | 'month'} */
      const interval =
        intervalRaw === "day" || intervalRaw === "month"
          ? intervalRaw
          : "week";
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.matchupTimeseries(
          userId,
          { interval, tz },
          filters,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // Day-of-week × hour-of-day heatmap. Powers the Trends tab's
  // "performance by time" view.
  router.get("/timeseries/day-hour", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.dayHourHeatmap(userId, { tz }, filters),
      );
    } catch (err) {
      next(err);
    }
  });

  // One filtered game-length response: WR buckets plus overall and
  // my-race-vs-opponent-race duration summaries for the Trends cards.
  router.get("/length-buckets", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.lengthBuckets(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // Per-day games + win-rate stream for the GitHub-style activity
  // calendar.
  router.get("/activity-calendar", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.activityCalendar(userId, { tz }, filters),
      );
    } catch (err) {
      next(err);
    }
  });

  // MMR progression: closing MMR per bucket, plus peak / trough /
  // latest scalars for the headline labels.
  router.get("/timeseries/mmr", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "day").toLowerCase();
      const interval =
        intervalRaw === "week" || intervalRaw === "month"
          ? intervalRaw
          : "day";
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.mmrProgression(
          userId,
          { interval, tz },
          filters,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // Tilt + within-session momentum (post-win vs post-loss WR + the
  // per-position curve). Reuses every global filter.
  router.get("/momentum", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const sessionGapMinutes = parseFiniteInt(req.query.session_gap_minutes);
      res.json(
        await deps.aggregations.momentum(userId, filters, { sessionGapMinutes }),
      );
    } catch (err) {
      next(err);
    }
  });

  // WR split by absolute opponent MMR, in clean 50-, 100-, 300- or
  // 500-MMR bands. ``bucket_width`` may be any supported width or
  // "auto" (also the fallback for a missing or unrecognised param);
  // auto picks 50 for tight ranges and 100 for wide ones. The
  // response carries the chosen width back so the client toggle
  // can highlight which width was used.
  router.get("/opp-mmr-buckets", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const bucketWidth = parseOppMmrBucketWidth(req.query.bucket_width);
      res.json(
        await deps.aggregations.oppMmrBuckets(userId, filters, { bucketWidth }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Drilldown behind a single opponent-MMR tile: the games whose
  // effective opponent MMR lands in [lo, hi). Honours the same global
  // filter set as the histogram so the count matches the tile exactly.
  router.get("/opp-mmr-buckets/games", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const lo = parseFiniteInt(req.query.lo);
      const hi = parseFiniteInt(req.query.hi);
      res.json(
        await deps.aggregations.oppMmrBucketGames(userId, filters, { lo, hi }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Per-(bucket, myBuild) counts. Client picks top-N and renders a
  // 100% stacked area so build mix evolution is legible.
  router.get("/timeseries/my-builds", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "week").toLowerCase();
      const interval =
        intervalRaw === "day" || intervalRaw === "month"
          ? intervalRaw
          : "week";
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.myBuildMixOverTime(
          userId,
          { interval, tz },
          filters,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // Per-(bucket, opponent.strategy) counts. Same shape as my-builds.
  router.get("/timeseries/opp-strategies", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "week").toLowerCase();
      const interval =
        intervalRaw === "day" || intervalRaw === "month"
          ? intervalRaw
          : "week";
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.oppStrategyMixOverTime(
          userId,
          { interval, tz },
          filters,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // Per-(bucket, map) WR. Client picks top-N maps by volume and
  // renders faceted sparklines.
  router.get("/timeseries/maps", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "week").toLowerCase();
      const interval =
        intervalRaw === "day" || intervalRaw === "month"
          ? intervalRaw
          : "week";
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.mapTrend(userId, { interval, tz }, filters),
      );
    } catch (err) {
      next(err);
    }
  });

  // Net MMR gained / lost per opponent race. Surfaces matchups that
  // bleed MMR even at parity WR.
  router.get("/mmr-by-matchup", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await deps.aggregations.netMmrByMatchup(userId, filters, { tz }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Opponent-level accepted MMR deltas behind each matchup race tile and
  // the Opponents tab. Uses the exact same full-history pairing semantics
  // as /mmr-by-matchup, with post-group search/sort/pagination controls.
  router.get("/mmr-by-matchup/opponents", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const raceRaw = req.query.opp_race ?? req.query.oppRace;
      const opponentRace = parseNetMmrOpponentRace(raceRaw);
      const search =
        typeof req.query.search === "string" ? req.query.search : "";
      const minPairs = parseFiniteInt(req.query.min_pairs);
      const sort =
        typeof req.query.sort === "string" ? req.query.sort : undefined;
      const order = parseSortOrder(req.query.order);
      const limit = parseFiniteInt(req.query.limit);
      const offset = parseFiniteInt(req.query.offset);
      res.json(
        await deps.aggregations.netMmrByOpponent(userId, filters, {
          opponentRace,
          search,
          minPairs,
          sort,
          order,
          limit,
          offset,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Macro-tab header: average macro score, coverage, and the most
  // expensive recurring leaks across the filtered game set. Reads the
  // slim games rows only (macroScore + top3Leaks), never the detail
  // store.
  router.get("/macro/summary", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.macroSummary(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // Macro Report — the Macro tab's aggregate body: win rate by score
  // bucket, the leak ledger (cost, with/without win rates, trend
  // halves), and avg-score segments by matchup / game length / build.
  // Same slim-row-only contract as /macro/summary.
  router.get("/macro/report", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.macroReport.report(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // Current consecutive same-result streak across the user's games.
  // Game-level (not day-bucketed) so a mixed day no longer drops a
  // mid-streak indicator to 0. See services/streak.js for the rationale.
  router.get("/streak", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.streak.current(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // The legacy /games endpoint that powered the Map Intel selector
  // (full filterable list, not the paginated cloud /games surface).
  router.get("/games-list", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const search =
        typeof req.query.search === "string" ? req.query.search : "";
      const sort =
        typeof req.query.sort === "string" ? req.query.sort : "date_desc";
      const limit = parseFiniteInt(req.query.limit);
      const offset = parseFiniteInt(req.query.offset);
      const resultBucket = pickResultBucket(req.query.result);
      res.json(
        await deps.aggregations.gamesList(userId, filters, {
          search,
          sort,
          limit,
          offset,
          resultBucket,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (!req.auth) throw httpError(401, "auth_required");
  return req.auth;
}

/** @param {unknown} raw @returns {'win' | 'loss' | undefined} */
function pickResultBucket(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "win" || s === "loss") return s;
  return undefined;
}

/** @param {unknown} raw @returns {'P'|'T'|'Z'|'R'|'U'|undefined} */
function parseNetMmrOpponentRace(raw) {
  const value = String(raw || "").trim().toUpperCase();
  if (
    value === "P"
    || value === "T"
    || value === "Z"
    || value === "R"
    || value === "U"
  ) {
    return value;
  }
  return undefined;
}

/** @param {unknown} raw @returns {'asc'|'desc'|undefined} */
function parseSortOrder(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value === "asc" || value === "desc" ? value : undefined;
}

/**
 * Parse the ``bucket_width`` query param for /opp-mmr-buckets.
 * Accepts any width the histogram supports; everything else — a
 * literal "auto", an unsupported number, junk — falls through to
 * ``"auto"`` so the service picks a sensible default from the data
 * range rather than erroring on a cosmetic parameter.
 *
 * The legal widths live next to the histogram itself
 * (``services/trendsOppMmr``), so a new bracket size is added in one
 * place instead of being kept in sync across two.
 *
 * @param {unknown} raw
 * @returns {import('../services/trendsOppMmr').OppMmrBucketWidth | "auto"}
 */
function parseOppMmrBucketWidth(raw) {
  return asOppMmrBucketWidth(raw) ?? "auto";
}

/** @param {number} status @param {string} code */
function httpError(status, code) {
  const err = new Error(code);
  /** @type {any} */ (err).status = status;
  /** @type {any} */ (err).code = code;
  return err;
}

module.exports = { buildAggregationsRouter };
