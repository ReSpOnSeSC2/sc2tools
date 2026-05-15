"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

/**
 * /v1/mmr-stats/* — MMR-bracketed analytics over the user's build
 * library and detected opponent strategies. Powers the new Build /
 * Strategy charts that show how win rates shift across the MMR
 * ladder, plus the build-aging curve and per-build MMR progression
 * views.
 *
 * Every route composes with the global filter set (date / race /
 * map / region / MMR min-max / exclude-too-short) via the shared
 * ``parseFilters`` helper, so the new charts honour the FilterBar
 * just like the rest of the analyzer.
 *
 * @param {{
 *   buildsMmrStats: import('../services/buildsMmrStats').BuildsMmrStatsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildBuildsMmrStatsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  // Win rate per (myBuild, my-MMR bucket).
  router.get("/mmr-stats/builds", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(
        await deps.buildsMmrStats.buildWinRateByMmr(userId, filters, {
          bucketWidth: req.query.bucket_width,
          mmrDelta: req.query.mmr_delta,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Win rate per (opponent.strategy, opponent-MMR bucket).
  router.get("/mmr-stats/strategies", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(
        await deps.buildsMmrStats.oppStrategyWinRateByMmr(userId, filters, {
          bucketWidth: req.query.bucket_width,
          mmrDelta: req.query.mmr_delta,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Build × opponent-strategy heatmap with a per-cell bucket.
  router.get("/mmr-stats/build-vs-strategy", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(
        await deps.buildsMmrStats.buildVsStrategyByMmr(userId, filters, {
          bucketWidth: req.query.bucket_width,
          mmrDelta: req.query.mmr_delta,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Per-build learning curve — win rate by Nth play.
  router.get("/mmr-stats/aging-curve", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(
        await deps.buildsMmrStats.buildAgingCurve(userId, filters, {
          mmrDelta: req.query.mmr_delta,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // Per-build MMR-over-time series.
  router.get("/mmr-stats/progression", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(
        await deps.buildsMmrStats.mmrProgressionByBuild(userId, filters, {
          mmrDelta: req.query.mmr_delta,
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
  if (!req.auth) {
    const err = new Error("auth_required");
    /** @type {any} */ (err).status = 401;
    throw err;
  }
  return req.auth;
}

module.exports = { buildBuildsMmrStatsRouter };
