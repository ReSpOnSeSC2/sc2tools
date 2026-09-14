"use strict";

const express = require("express");
const { parseFiniteInt } = require("../util/parseQuery");
const { asOppMmrBucketWidth } = require("../services/trendsOppMmr");

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
    try { res.json(await action(req.query)); } catch (err) { next(err); }
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
    search: typeof q.search === "string" ? q.search : "",
    minPairs: parseFiniteInt(q.min_pairs),
    sort: typeof q.sort === "string" ? q.sort : undefined,
    order: q.order === "asc" ? "asc" : "desc",
    limit: parseFiniteInt(q.limit), offset: parseFiniteInt(q.offset),
  };
}

module.exports = { buildAdminGlobalTrendsRouter };
