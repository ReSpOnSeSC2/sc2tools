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
  const docs = await deps.games
    .aggregate(lengthBucketsPipeline(match, deps.bucketSwitch()))
    .toArray();
  return shapeLengthBuckets(docs[0]);
}

/** @param {Record<string, any>} match @param {object} resultBucket */
function lengthBucketsPipeline(match, resultBucket) {
  return [
    { $match: match },
    // Old/incomplete rows may not carry a trustworthy replay duration.
    // Exclude them instead of fabricating a zero-minute game.
    { $match: { durationSec: { $type: "number", $gt: 0 } } },
    {
      $addFields: {
        _bucket: resultBucket,
        _myRace: raceLetterExpr("$myRace"),
        _oppRace: raceLetterExpr("$opponent.race"),
        _len: lengthBucketExpr(),
      },
    },
    {
      // One filtered scan powers all three views.
      $facet: {
        buckets: lengthDistributionFacet(),
        summary: lengthSummaryFacet(),
        matchups: lengthMatchupsFacet(),
      },
    },
  ];
}

function lengthBucketExpr() {
  return {
    $switch: {
      branches: [
        { case: { $lt: ["$durationSec", 3 * 60] }, then: "0–3m" },
        { case: { $lt: ["$durationSec", 6 * 60] }, then: "3–6m" },
        { case: { $lt: ["$durationSec", 9 * 60] }, then: "6–9m" },
        { case: { $lt: ["$durationSec", 12 * 60] }, then: "9–12m" },
        { case: { $lt: ["$durationSec", 15 * 60] }, then: "12–15m" },
        { case: { $lt: ["$durationSec", 20 * 60] }, then: "15–20m" },
        { case: { $lt: ["$durationSec", 25 * 60] }, then: "20–25m" },
      ],
      default: "25m+",
    },
  };
}

function lengthDistributionFacet() {
  return [
    {
      $group: {
        _id: "$_len",
        wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
        total: { $sum: 1 },
        avgSec: { $avg: "$durationSec" },
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
  ];
}

function lengthSummaryFacet() {
  return [{
    $group: {
      _id: null,
      games: { $sum: 1 },
      totalSec: { $sum: "$durationSec" },
      avgSec: { $avg: "$durationSec" },
      medianSec: percentileAccumulator(),
      longGames: longGameAccumulator(),
    },
  }];
}

function lengthMatchupsFacet() {
  return [
    {
      // Unknown race metadata cannot form a meaningful SC2 matchup.
      // Keep those games in buckets/summary, but not in this facet.
      $match: {
        _myRace: { $in: ["P", "T", "Z", "R"] },
        _oppRace: { $in: ["P", "T", "Z", "R"] },
      },
    },
    {
      $group: {
        _id: { myRace: "$_myRace", opponentRace: "$_oppRace" },
        games: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
        totalSec: { $sum: "$durationSec" },
        avgSec: { $avg: "$durationSec" },
        medianSec: percentileAccumulator(),
        avgWinSec: outcomeDurationAccumulator("win"),
        avgLossSec: outcomeDurationAccumulator("loss"),
        longGames: longGameAccumulator(),
      },
    },
    { $sort: { "_id.myRace": 1, "_id.opponentRace": 1 } },
  ];
}

function percentileAccumulator() {
  return {
    $percentile: {
      input: "$durationSec",
      p: [0.5],
      method: "approximate",
    },
  };
}

function longGameAccumulator() {
  return { $sum: { $cond: [{ $gte: ["$durationSec", 15 * 60] }, 1, 0] } };
}

/** @param {'win' | 'loss'} outcome */
function outcomeDurationAccumulator(outcome) {
  return {
    $avg: {
      $cond: [{ $eq: ["$_bucket", outcome] }, "$durationSec", null],
    },
  };
}

/** @param {Record<string, any> | undefined} raw */
function shapeLengthBuckets(raw) {
  const doc = raw || { buckets: [], summary: [], matchups: [] };
  const rows = Array.isArray(doc.buckets) ? doc.buckets : [];
  /** @type {Record<string, number>} */
  const order = {
    "0–3m": 0,
    "3–6m": 1,
    "6–9m": 2,
    "9–12m": 3,
    "12–15m": 4,
    "15–20m": 5,
    "20–25m": 6,
    "25m+": 7,
  };
  rows.sort((a, b) => (order[a.bucket] ?? 99) - (order[b.bucket] ?? 99));
  const summary = Array.isArray(doc.summary) ? doc.summary[0] : null;
  const games = positiveInt(summary && summary.games);
  return {
    buckets: rows.map((r) => ({
      ...r,
      winRate: r.total ? r.wins / r.total : 0,
      avgSec: roundedDuration(r.avgSec) || 0,
    })),
    summary: {
      games,
      totalSec: positiveInt(summary && summary.totalSec),
      avgSec: roundedDuration(summary && summary.avgSec),
      medianSec: percentileDuration(summary && summary.medianSec),
      longGameRate:
        games > 0 ? positiveInt(summary && summary.longGames) / games : 0,
    },
    matchups: (Array.isArray(doc.matchups) ? doc.matchups : []).map((r) => {
      const matchupGames = positiveInt(r.games);
      const myRace = raceLetter(r && r._id && r._id.myRace);
      const opponentRace = raceLetter(r && r._id && r._id.opponentRace);
      return {
        matchup: `${myRace}v${opponentRace}`,
        myRace,
        opponentRace,
        games: matchupGames,
        wins: positiveInt(r.wins),
        losses: positiveInt(r.losses),
        totalSec: positiveInt(r.totalSec),
        avgSec: roundedDuration(r.avgSec),
        medianSec: percentileDuration(r.medianSec),
        avgWinSec: roundedDuration(r.avgWinSec),
        avgLossSec: roundedDuration(r.avgLossSec),
        longGameRate:
          matchupGames > 0 ? positiveInt(r.longGames) / matchupGames : 0,
      };
    }),
  };
}

/**
 * Mongo expression: canonical first race letter, or U for missing/unknown.
 * @param {string} path
 * @returns {object}
 */
function raceLetterExpr(path) {
  const upper = { $toUpper: { $substrCP: [{ $ifNull: [path, ""] }, 0, 1] } };
  return {
    $cond: [{ $in: [upper, ["P", "T", "Z", "R"]] }, upper, "U"],
  };
}

/**
 * @param {unknown} raw
 * @returns {'P' | 'T' | 'Z' | 'R' | 'U'}
 */
function raceLetter(raw) {
  const letter = String(raw || "").trim().charAt(0).toUpperCase();
  return letter === "P" || letter === "T" || letter === "Z" || letter === "R"
    ? letter
    : "U";
}

/** @param {unknown} raw */
function roundedDuration(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** @param {unknown} raw */
function percentileDuration(raw) {
  return roundedDuration(Array.isArray(raw) ? raw[0] : raw);
}

/** @param {unknown} raw */
function positiveInt(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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
      // Sort newest-first so the limit truncates ancient history, not
      // the recent days the calendar actually paints. With the legacy
      // ascending sort, accounts with > ~2 years of daily activity
      // had every visible cell fall outside the kept window and
      // rendered as an all-grey grid even with thousands of games.
      { $sort: { _id: -1 } },
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
