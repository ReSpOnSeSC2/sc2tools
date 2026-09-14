"use strict";

const express = require("express");
const { parseFiniteInt } = require("../util/parseQuery");
const { asOppMmrBucketWidth } = require("../services/trendsOppMmr");
const { parseExplorerOptions } = require("../services/trendsExplorer");

/** This router is mounted behind buildAdminRouter's authentication and
 * administrator allowlist. It exposes no mutation or arbitrary service call.
 * @param {import('../services/adminGlobalTrends').AdminGlobalTrendsService} service */
function buildAdminGlobalTrendsRouter(service) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/players", handler((query) => service.players(query)));
  router.get("/filter-options", handler((query) => service.filterOptions(query)));
  router.get(["/trends/explorer/:view", "/trends/explorer/:view/games"], (req, res, next) => {
    handler((query) => {
      const opts = parseExplorerOptions(req.params.view, query);
      opts.games = req.path.endsWith("/games");
      return service.run("explorer", query, opts);
    })(req, res, next);
  });
  const routes = {
    "/timeseries": "timeseries",
    "/timeseries/mmr": "mmrProgression",
    "/timeseries/matchups": "matchupTimeseries",
    "/timeseries/day-hour": "dayHourHeatmap",
    "/length-buckets": "lengthBuckets",
    "/activity-calendar": "activityCalendar",
    "/momentum": "momentum",
    "/opp-mmr-buckets": "oppMmrBuckets",
    "/opp-mmr-buckets/games": "oppMmrBucketGames",
    "/timeseries/maps": "mapTrend",
    "/timeseries/my-builds": "myBuildMixOverTime",
    "/timeseries/opp-strategies": "oppStrategyMixOverTime",
    "/mmr-by-matchup": "netMmrByMatchup",
    "/mmr-by-matchup/opponents": "netMmrByOpponent",
  };
  for (const [path, method] of Object.entries(routes)) {
    router.get(path, handler((query) => service.run(method, query, options(query, method))));
  }
  return router;
}

/** @param {(query: Record<string, unknown>) => Promise<unknown>} action
 * @returns {import('express').RequestHandler} */
function handler(action) {
  return async (req, res, next) => {
    try { res.json(await action(req.query)); } catch (err) {
      const failure = /** @type {any} */ (err);
      if (failure?.code === 50 || failure?.codeName === "MaxTimeMSExpired"
        || ["MongoOperationTimeoutError", "MongoNetworkTimeoutError", "MongoNetworkError", "MongoServerSelectionError", "PoolClearedError", "MongoWaitQueueTimeoutError"].includes(failure?.name)
        || failure?.code === "global_trends_busy") {
        res.set("Retry-After", "5");
        res.status(503).json({ error: {
          code: "global_trends_busy", message: "Global Trends is taking longer than expected. Please try again shortly or narrow the player filters.",
        } });
        return;
      }
      next(err);
    }
  };
}

/** @param {Record<string, unknown>} q @param {string} method */
function options(q, method) {
  const defaultInterval = method === "timeseries" || method === "mmrProgression" ? "day" : "week";
  const interval = q.interval === "day" || q.interval === "week" || q.interval === "month" ? q.interval : defaultInterval;
  return {
    interval, tz: typeof q.tz === "string" ? q.tz : undefined,
    sessionGapMinutes: parseFiniteInt(q.session_gap_minutes),
    bucketWidth: asOppMmrBucketWidth(q.bucket_width) ?? "auto",
    lo: parseFiniteInt(q.lo), hi: parseFiniteInt(q.hi),
    opponentRace: typeof q.opp_race === "string" ? q.opp_race : undefined,
    myRace: typeof q.my_race === "string" ? q.my_race : undefined,
    groupByOwnRace: (method === "netMmrByMatchup" || method === "matchupTimeseries") && q.group_by === "matchup",
    search: typeof q.search === "string" ? q.search : "",
    minPairs: parseFiniteInt(q.min_pairs),
    sort: typeof q.sort === "string" ? q.sort : undefined,
    order: q.order === "asc" ? "asc" : "desc",
    limit: parseFiniteInt(q.limit), offset: parseFiniteInt(q.offset),
  };
}

module.exports = { buildAdminGlobalTrendsRouter };
