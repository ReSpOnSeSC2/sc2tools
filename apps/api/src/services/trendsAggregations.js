"use strict";

/**
 * Trends-tab aggregation helpers.
 *
 * Carved out of ``aggregations.js`` so the new charts (matchup-over-
 * time, day×hour heatmap, length buckets, activity calendar) can
 * grow independently without bloating the main aggregations service
 * past the project's per-file size budget.
 *
 * Every function takes the same ``deps`` shape — ``{ games }`` (the
 * Mongo collection) plus the standard ``{ pickInterval, pickTimezone,
 * gamesMatchStage, bucketSwitch }`` helpers — so the call sites in
 * ``AggregationsService`` stay one-liners.
 */

const { LIMITS } = require("../config/constants");

/**
 * @param {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 *   pickInterval: (raw: unknown) => 'day' | 'week' | 'month',
 *   pickTimezone: (raw: unknown) => string,
 * }} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 */
async function matchupTimeseries(deps, userId, opts, filters) {
  const interval = deps.pickInterval(opts && opts.interval);
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      {
        $addFields: {
          _oppRace: {
            $switch: {
              branches: [
                { case: { $eq: [{ $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } }, "P"] }, then: "P" },
                { case: { $eq: [{ $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } }, "T"] }, then: "T" },
                { case: { $eq: [{ $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } }, "Z"] }, then: "Z" },
                { case: { $eq: [{ $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } }, "R"] }, then: "R" },
              ],
              default: "U",
            },
          },
        },
      },
      {
        $group: {
          _id: {
            bucket: { $dateTrunc: { date: "$date", unit: interval, timezone } },
            race: "$_oppRace",
          },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { "_id.bucket": 1, "_id.race": 1 } },
      { $limit: LIMITS.TIMESERIES_MAX_BUCKETS * 5 },
      {
        $project: {
          _id: 0,
          bucket: "$_id.bucket",
          race: "$_id.race",
          wins: 1,
          losses: 1,
          total: 1,
        },
      },
    ])
    .toArray();
  return {
    interval,
    points: rows.map((r) => ({
      ...r,
      winRate: r.total ? r.wins / r.total : 0,
    })),
  };
}

/**
 * @param {Parameters<typeof matchupTimeseries>[0]} deps
 * @param {string} userId
 * @param {{tz?: string}} opts
 * @param {object} filters
 */
async function dayHourHeatmap(deps, userId, opts, filters) {
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      { $addFields: { _parts: { $dateToParts: { date: "$date", timezone } } } },
      {
        // Mongo's $dayOfWeek is 1=Sun … 7=Sat. Convert to a 0..6
        // Monday-first offset so the client can render M-T-W-T-F-S-S
        // top-to-bottom without translating again on the wire.
        $addFields: {
          _dow: {
            $mod: [
              {
                $add: [
                  {
                    $subtract: [
                      { $dayOfWeek: { date: "$date", timezone } },
                      2,
                    ],
                  },
                  7,
                ],
              },
              7,
            ],
          },
        },
      },
      {
        $group: {
          _id: { dow: "$_dow", hour: "$_parts.hour" },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          dow: "$_id.dow",
          hour: "$_id.hour",
          wins: 1,
          losses: 1,
          total: 1,
        },
      },
    ])
    .toArray();
  const totalGames = rows.reduce((acc, r) => acc + (r.total || 0), 0);
  return {
    timezone,
    cells: rows.map((r) => ({
      ...r,
      winRate: r.total ? r.wins / r.total : 0,
    })),
    totalGames,
  };
}

/**
 * @param {Parameters<typeof matchupTimeseries>[0]} deps
 * @param {string} userId
 * @param {object} filters
 */
async function lengthBuckets(deps, userId, filters) {
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      {
        $addFields: {
          _len: {
            $switch: {
              branches: [
                { case: { $lt: [{ $ifNull: ["$durationSec", 0] }, 8 * 60] }, then: "<8m" },
                { case: { $lt: [{ $ifNull: ["$durationSec", 0] }, 15 * 60] }, then: "8–15m" },
                { case: { $lt: [{ $ifNull: ["$durationSec", 0] }, 25 * 60] }, then: "15–25m" },
              ],
              default: "25m+",
            },
          },
        },
      },
      {
        $group: {
          _id: "$_len",
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
          avgSec: { $avg: { $ifNull: ["$durationSec", 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          bucket: "$_id",
          wins: 1,
          losses: 1,
          total: 1,
          avgSec: 1,
        },
      },
    ])
    .toArray();
  const order = { "<8m": 0, "8–15m": 1, "15–25m": 2, "25m+": 3 };
  rows.sort((a, b) => (order[a.bucket] ?? 99) - (order[b.bucket] ?? 99));
  return {
    buckets: rows.map((r) => ({
      ...r,
      winRate: r.total ? r.wins / r.total : 0,
      avgSec: Math.round(r.avgSec || 0),
    })),
  };
}

/**
 * @param {Parameters<typeof matchupTimeseries>[0]} deps
 * @param {string} userId
 * @param {{tz?: string}} opts
 * @param {object} filters
 */
async function activityCalendar(deps, userId, opts, filters) {
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$date", unit: "day", timezone } },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: LIMITS.TIMESERIES_MAX_BUCKETS * 2 },
      {
        $project: {
          _id: 0,
          day: "$_id",
          wins: 1,
          losses: 1,
          total: 1,
        },
      },
    ])
    .toArray();
  return {
    timezone,
    days: rows.map((r) => ({
      ...r,
      winRate: r.total ? r.wins / r.total : 0,
    })),
  };
}

module.exports = {
  matchupTimeseries,
  dayHourHeatmap,
  lengthBuckets,
  activityCalendar,
};
