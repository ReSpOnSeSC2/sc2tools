"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { myLadderRaceExpr } = require("./trendsRegionExpr");
const { bucketSwitch, pickInterval, pickTimezone } = require("./aggregations");
const { LIMITS } = require("../config/constants");

/** Aggregate bucket closes with one vote per active account/ladder race.
 * Upload volume cannot overweight one player and no difference is taken
 * between unrelated players. No per-player series are returned: that payload
 * could grow past Mongo's single-document limit on a global dataset.
 * @param {import('./aggregations').AggregationsService} agg
 * @param {string} scope @param {object} filters @param {Record<string, any>} opts */
async function globalMmrProgression(agg, scope, filters, opts) {
  const requested = pickInterval(opts.interval);
  const timezone = pickTimezone(opts.tz);
  const match = gamesMatchStage(scope, filters);
  const interval = await fitGlobalInterval(agg.db.games, match, requested);
  const [doc] = await agg.db.games.aggregate([
    { $match: match },
    { $addFields: {
      _bucket: bucketSwitch(), _ladderRace: myLadderRaceExpr(),
      _hasAccount: { $ne: ["$_globalToon", ""] },
      _ranked: { $and: [{ $eq: ["$isLadderGame", true] }, { $eq: ["$playerCount", 2] }] },
    } },
    { $addFields: { _eligible: { $and: ["$_globalTrustedMmr", "$_hasAccount"] } } },
    { $facet: {
      coverage: [{ $group: {
        _id: null,
        filteredGames: { $sum: 1 },
        eligibleGames: { $sum: { $cond: ["$_eligible", 1, 0] } },
        missingAccountGames: { $sum: { $cond: ["$_hasAccount", 0, 1] } },
        excludedNonRanked1v1Games: { $sum: { $cond: ["$_ranked", 0, 1] } },
        missingLadderRaceGames: { $sum: { $cond: [{ $in: ["$_ladderRace", ["P", "T", "Z", "R"]] }, 0, 1] } },
      } }, { $project: { _id: 0 } }],
      points: [
        { $match: { _eligible: true } },
        { $sort: { date: 1, gameId: 1 } },
        { $group: {
          _id: { player: "$_globalPlayerId", race: "$_ladderRace", bucket: { $dateTrunc: { date: "$date", unit: interval, timezone } } },
          openMmr: { $first: "$myMmr" }, closeMmr: { $last: "$myMmr" },
          minMmr: { $min: "$myMmr" }, maxMmr: { $max: "$myMmr" },
          total: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
        } },
        { $group: {
          _id: "$_id.bucket", openMmr: { $avg: "$openMmr" }, closeMmr: { $avg: "$closeMmr" },
          minMmr: { $min: "$minMmr" }, maxMmr: { $max: "$maxMmr" },
          total: { $sum: "$total" }, wins: { $sum: "$wins" }, losses: { $sum: "$losses" },
          activeSeries: { $sum: 1 },
        } },
        { $sort: { _id: 1 } },
        { $project: {
          _id: 0, bucket: "$_id", openMmr: 1, closeMmr: 1, minMmr: 1, maxMmr: 1,
          avgMmr: "$closeMmr", total: 1, wins: 1, losses: 1, activeSeries: 1,
        } },
      ],
    } },
  ]).toArray();
  const points = doc?.points || [];
  const coverage = doc?.coverage?.[0] || {
    filteredGames: 0, eligibleGames: 0, missingAccountGames: 0, excludedNonRanked1v1Games: 0, missingLadderRaceGames: 0,
  };
  const peak = points.reduce((/** @type {any} */ best, /** @type {any} */ p) => !best || p.closeMmr > best.closeMmr ? p : best, null);
  const trough = points.reduce((/** @type {any} */ best, /** @type {any} */ p) => !best || p.closeMmr < best.closeMmr ? p : best, null);
  const scalar = (/** @type {any} */ p) => p ? { bucket: p.bucket, mmr: p.closeMmr } : null;
  return {
    interval, timezone, points, coverage, aggregate: "mean-active-account-race",
    series: [], accounts: [], regions: [], mixedSeries: false,
    peak: scalar(peak), trough: scalar(trough), latest: scalar(points.at(-1)),
  };
}

/** All global time series widen together; unlike single-player cross-tabs,
 * their number of maps/accounts is unbounded and must never truncate totals.
 * @param {import('mongodb').Collection} games @param {object} match
 * @param {'day'|'week'|'month'} requested */
async function fitGlobalInterval(games, match, requested) {
  if (requested === "month") return requested;
  const [range] = await games.aggregate([
    { $match: match }, { $group: { _id: null, first: { $min: "$date" }, last: { $max: "$date" } } },
  ]).toArray();
  if (!range?.first || !range?.last) return requested;
  const days = (range.last.getTime() - range.first.getTime()) / 86400000;
  if (days / 7 > LIMITS.TIMESERIES_MAX_BUCKETS) return "month";
  if (requested === "day" && days > LIMITS.TIMESERIES_MAX_BUCKETS) return "week";
  return requested;
}

module.exports = { globalMmrProgression, fitGlobalInterval };
