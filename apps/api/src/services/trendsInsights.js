"use strict";

/**
 * Trends-tab "Player Insight" aggregations.
 *
 * Carved off from ``trendsAggregations.js`` so the deeper-signal
 * charts added in v0.5.x (MMR progression, tilt/momentum, skill
 * spread, build/strategy mix, map trends, net-MMR-by-matchup) stay
 * separate from the original basic time-series helpers. Same
 * ``deps`` contract as its sibling — ``{ games, gamesMatchStage,
 * bucketSwitch, pickInterval, pickTimezone }`` — so call sites in
 * ``AggregationsService`` remain one-liners.
 *
 * Pipelines lean on ``$setWindowFields`` / ``$shift`` (Mongo 5.0+,
 * available on the production driver pinned to mongodb@6.13). They
 * never reach into the heavy ``game_details`` blob: every signal is
 * derived from the slim ``games`` row alone.
 */

const { LIMITS } = require("../config/constants");

const RESULT_VICTORY = ["victory", "win"];
const RESULT_DEFEAT = ["defeat", "loss"];

/** Default gap that separates one ladder session from the next. */
const SESSION_GAP_MINUTES = 90;
/** Cap the within-session position bins — beyond this it's noise. */
const MAX_SESSION_POSITIONS = 12;
/** Spread bucket boundaries for "Skill spread" WR — opp − my MMR. */
const SPREAD_BUCKETS = [
  { id: "lt_-150", label: "≤-150", lo: -Infinity, hi: -150 },
  { id: "-150_-50", label: "-150 to -50", lo: -150, hi: -50 },
  { id: "-50_50", label: "±50", lo: -50, hi: 50 },
  { id: "50_150", label: "+50 to +150", lo: 50, hi: 150 },
  { id: "gt_150", label: "≥+150", lo: 150, hi: Infinity },
];

/**
 * @typedef {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 *   pickInterval: (raw: unknown) => 'day' | 'week' | 'month',
 *   pickTimezone: (raw: unknown) => string,
 * }} Deps
 */

/**
 * MMR progression over time. One point per bucket (day/week/month),
 * with the closing MMR (the most recent valid myMmr in the bucket)
 * plus min/max so the client can paint a band when bucket size
 * collapses several games into one mark.
 *
 * Output also carries the peak / trough / latest scalars so the
 * client can label them without scanning the series itself.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 */
async function mmrProgression(deps, userId, opts, filters) {
  const interval = deps.pickInterval(opts && opts.interval);
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games
    .aggregate([
      { $match: { ...match, myMmr: { $type: "number" } } },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      { $sort: { date: 1 } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$date", unit: interval, timezone } },
          // $last after $sort:asc gives the most recent MMR in the bucket.
          closeMmr: { $last: "$myMmr" },
          openMmr: { $first: "$myMmr" },
          minMmr: { $min: "$myMmr" },
          maxMmr: { $max: "$myMmr" },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: LIMITS.TIMESERIES_MAX_BUCKETS },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          bucket: "$_id",
          openMmr: 1,
          closeMmr: 1,
          minMmr: 1,
          maxMmr: 1,
          wins: 1,
          losses: 1,
          total: 1,
        },
      },
    ])
    .toArray();
  return { interval, points: rows, ...summarize(rows) };
}

/** @param {Array<{closeMmr: number, minMmr: number, maxMmr: number, bucket: Date}>} rows */
function summarize(rows) {
  if (!rows || rows.length === 0) {
    return { peak: null, trough: null, latest: null };
  }
  let peak = rows[0];
  let trough = rows[0];
  for (const r of rows) {
    if (r.maxMmr > peak.maxMmr) peak = r;
    if (r.minMmr < trough.minMmr) trough = r;
  }
  return {
    peak: { bucket: peak.bucket, mmr: peak.maxMmr },
    trough: { bucket: trough.bucket, mmr: trough.minMmr },
    latest: {
      bucket: rows[rows.length - 1].bucket,
      mmr: rows[rows.length - 1].closeMmr,
    },
  };
}

/**
 * Tilt + within-session momentum. Returns the user's WR after a win
 * vs after a loss (sequential, same-session only), plus a per-
 * position curve so the client can plot "WR by game number in the
 * session" — the headline answer to "do you tilt, or warm up?".
 *
 * Session = consecutive games separated by less than
 * ``SESSION_GAP_MINUTES`` of clock time. Games matching the global
 * filter set drive sessioning, so "weekend only" filtered correctly
 * means weekend sessions only.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {{ sessionGapMinutes?: number }} [opts]
 */
async function momentum(deps, userId, filters, opts = {}) {
  const gap = sanitizeGapMinutes(opts.sessionGapMinutes);
  const match = deps.gamesMatchStage(userId, filters);
  const pipeline = momentumPipeline(deps, match, gap);
  const [doc] = await deps.games.aggregate(pipeline).toArray();
  const post = (doc && doc.post) || [];
  const positions = (doc && doc.positions) || [];
  const baseline = (doc && doc.baseline && doc.baseline[0]) || null;
  return shapeMomentum({ post, positions, baseline, gap });
}

/** @param {Deps} deps @param {object} match @param {number} gapMinutes */
function momentumPipeline(deps, match, gapMinutes) {
  const gapMs = gapMinutes * 60 * 1000;
  return [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    { $sort: { date: 1 } },
    ...sequentialContext(gapMs),
    { $facet: momentumFacet() },
  ];
}

/**
 * Window-field stages that decorate each game row with previous-
 * game context (gap to previous game, previous result, session id,
 * and within-session position).
 *
 * @param {number} gapMs
 */
function sequentialContext(gapMs) {
  return [
    {
      $setWindowFields: {
        sortBy: { date: 1 },
        output: {
          _prevDate: { $shift: { output: "$date", by: -1, default: null } },
          _prevResult: { $shift: { output: "$_bucket", by: -1, default: null } },
        },
      },
    },
    {
      $addFields: {
        _gapMs: { $cond: [{ $eq: ["$_prevDate", null] }, null, { $subtract: ["$date", "$_prevDate"] }] },
      },
    },
    {
      $addFields: {
        _sessionBreak: { $cond: [{ $or: [{ $eq: ["$_gapMs", null] }, { $gt: ["$_gapMs", gapMs] }] }, 1, 0] },
        _post: {
          $cond: [
            { $or: [{ $eq: ["$_prevDate", null] }, { $gt: ["$_gapMs", gapMs] }] },
            null,
            "$_prevResult",
          ],
        },
      },
    },
    {
      $setWindowFields: {
        sortBy: { date: 1 },
        output: {
          _sessionId: { $sum: "$_sessionBreak", window: { documents: ["unbounded", "current"] } },
        },
      },
    },
    {
      $setWindowFields: {
        partitionBy: "$_sessionId",
        sortBy: { date: 1 },
        output: { _pos: { $documentNumber: {} } },
      },
    },
  ];
}

/** $facet branches for the momentum pipeline — split out so the */
/* main pipeline reads as a 5-step flow. */
function momentumFacet() {
  const wlAgg = {
    wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
    losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
    total: { $sum: 1 },
  };
  return {
    post: [
      { $match: { _post: { $in: ["win", "loss"] } } },
      { $group: { _id: "$_post", ...wlAgg } },
    ],
    positions: [
      { $match: { _pos: { $lte: MAX_SESSION_POSITIONS } } },
      { $group: { _id: "$_pos", ...wlAgg } },
      { $sort: { _id: 1 } },
    ],
    baseline: [{ $group: { _id: null, ...wlAgg } }],
  };
}

/** @param {{post: any[], positions: any[], baseline: any, gap: number}} args */
function shapeMomentum({ post, positions, baseline, gap }) {
  const winRow = post.find((r) => r._id === "win") || { wins: 0, losses: 0, total: 0 };
  const lossRow = post.find((r) => r._id === "loss") || { wins: 0, losses: 0, total: 0 };
  return {
    sessionGapMinutes: gap,
    baseline: baseline
      ? {
          wins: baseline.wins,
          losses: baseline.losses,
          total: baseline.total,
          winRate: baseline.total ? baseline.wins / baseline.total : 0,
        }
      : { wins: 0, losses: 0, total: 0, winRate: 0 },
    postWin: {
      wins: winRow.wins,
      losses: winRow.losses,
      total: winRow.total,
      winRate: winRow.total ? winRow.wins / winRow.total : 0,
    },
    postLoss: {
      wins: lossRow.wins,
      losses: lossRow.losses,
      total: lossRow.total,
      winRate: lossRow.total ? lossRow.wins / lossRow.total : 0,
    },
    sessionPositions: positions.map((r) => ({
      pos: r._id,
      wins: r.wins,
      losses: r.losses,
      total: r.total,
      winRate: r.total ? r.wins / r.total : 0,
    })),
  };
}

/**
 * Win rate split by the spread between opponent's MMR and your MMR
 * at game time. Reveals whether you over- or under-perform vs
 * higher / lower-rated opponents.
 *
 * Only games where BOTH ``myMmr`` and ``opponent.mmr`` are numeric
 * are included; everything else falls into a separate ``unknown``
 * bucket the client can choose to hide.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 */
async function skillSpread(deps, userId, filters) {
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games.aggregate(skillSpreadPipeline(deps, match)).toArray();
  return shapeSkillSpread(rows);
}

function skillSpreadPipeline(deps, match) {
  return [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    {
      $addFields: {
        _spread: {
          $cond: [
            // $isNumber matches every numeric BSON type (int, long,
            // double, decimal). The aggregation-expression form of
            // $type would force us to enumerate them and is easy to
            // get subtly wrong — the agent stores opponent.mmr as
            // int(...) so a literal "double" comparison silently
            // dropped every game.
            { $and: [{ $isNumber: "$myMmr" }, { $isNumber: "$opponent.mmr" }] },
            { $subtract: ["$opponent.mmr", "$myMmr"] },
            null,
          ],
        },
      },
    },
    { $addFields: { _spreadBucket: spreadBucketSwitch() } },
    {
      $group: {
        _id: "$_spreadBucket",
        wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
        total: { $sum: 1 },
        avgSpread: { $avg: "$_spread" },
      },
    },
  ];
}

function shapeSkillSpread(rows) {
  const byId = new Map(rows.map((r) => [r._id, r]));
  const unknownRow = byId.get("unknown");
  return {
    buckets: SPREAD_BUCKETS.map((b) => {
      const r = byId.get(b.id);
      return {
        id: b.id,
        label: b.label,
        wins: r ? r.wins : 0,
        losses: r ? r.losses : 0,
        total: r ? r.total : 0,
        winRate: r && r.total ? r.wins / r.total : 0,
        avgSpread: r && r.avgSpread != null ? Math.round(r.avgSpread) : null,
      };
    }),
    unknown: unknownRow
      ? { total: unknownRow.total, wins: unknownRow.wins, losses: unknownRow.losses }
      : { total: 0, wins: 0, losses: 0 },
  };
}

function spreadBucketSwitch() {
  return {
    $switch: {
      branches: [
        { case: { $eq: ["$_spread", null] }, then: "unknown" },
        { case: { $lt: ["$_spread", -150] }, then: "lt_-150" },
        { case: { $lt: ["$_spread", -50] }, then: "-150_-50" },
        { case: { $lt: ["$_spread", 50] }, then: "-50_50" },
        { case: { $lt: ["$_spread", 150] }, then: "50_150" },
      ],
      default: "gt_150",
    },
  };
}

/**
 * Categorical mix over time. Used by:
 *   - my-build mix      (field = "$myBuild")
 *   - opp-strategy mix  (field = "$opponent.strategy")
 *
 * Returns ``{ interval, points: [{ bucket, key, total, wins, losses }] }``
 * — one row per (bucket, key) pair. Top-N selection and "Other"
 * roll-up happen client-side so the user can re-rank without a refetch.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 * @param {{ field: string, fallback?: string }} cfg
 */
async function mixOverTime(deps, userId, opts, filters, cfg) {
  const interval = deps.pickInterval(opts && opts.interval);
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const fallback = cfg.fallback || "Unknown";
  const rows = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      {
        $group: {
          _id: {
            bucket: { $dateTrunc: { date: "$date", unit: interval, timezone } },
            key: { $ifNull: [`$${cfg.field}`, fallback] },
          },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { "_id.bucket": 1, total: -1 } },
      { $limit: LIMITS.TIMESERIES_MAX_BUCKETS * 12 },
      {
        $project: {
          _id: 0,
          bucket: "$_id.bucket",
          key: "$_id.key",
          wins: 1,
          losses: 1,
          total: 1,
        },
      },
    ])
    .toArray();
  return { interval, points: rows };
}

/**
 * Per-map win-rate over time. Returns one row per (bucket, map)
 * pair; the client picks top-N maps by play volume and renders
 * faceted sparklines.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 */
async function mapTrend(deps, userId, opts, filters) {
  return mixOverTime(deps, userId, opts, filters, {
    field: "map",
    fallback: "Unknown",
  });
}

/**
 * Net MMR change per opponent race. For every consecutive pair of
 * games (within the filtered set) where BOTH carry a numeric
 * ``myMmr``, attribute the delta (next.myMmr − this.myMmr) to the
 * opponent race of the FIRST game in the pair.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 */
async function netMmrByMatchup(deps, userId, filters) {
  const match = deps.gamesMatchStage(userId, filters);
  const rows = await deps.games
    .aggregate([
      { $match: { ...match, myMmr: { $type: "number" } } },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      { $sort: { date: 1 } },
      {
        $setWindowFields: {
          sortBy: { date: 1 },
          output: {
            _nextMyMmr: { $shift: { output: "$myMmr", by: 1, default: null } },
          },
        },
      },
      { $match: { _nextMyMmr: { $type: "number" } } },
      {
        $addFields: {
          _delta: { $subtract: ["$_nextMyMmr", "$myMmr"] },
          _oppRace: oppRaceSwitch(),
        },
      },
      {
        $group: {
          _id: "$_oppRace",
          netMmr: { $sum: "$_delta" },
          games: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          avgDelta: { $avg: "$_delta" },
        },
      },
      { $sort: { netMmr: -1 } },
    ])
    .toArray();
  return {
    matchups: rows.map((r) => ({
      race: r._id,
      netMmr: Math.round(r.netMmr),
      avgDelta: Math.round(r.avgDelta * 10) / 10,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      winRate: r.games ? r.wins / r.games : 0,
    })),
  };
}

function oppRaceSwitch() {
  return {
    $switch: {
      branches: [
        { case: oppRaceFirstChar("P"), then: "P" },
        { case: oppRaceFirstChar("T"), then: "T" },
        { case: oppRaceFirstChar("Z"), then: "Z" },
        { case: oppRaceFirstChar("R"), then: "R" },
      ],
      default: "U",
    },
  };
}

function oppRaceFirstChar(letter) {
  return {
    $eq: [
      { $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } },
      letter,
    ],
  };
}

function sanitizeGapMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SESSION_GAP_MINUTES;
  // Clamp to a sane range — anything less than 15 minutes splits the
  // same Zerg ranked queue into bogus mini-sessions, anything past
  // 8 hours merges yesterday + today.
  return Math.max(15, Math.min(480, Math.round(n)));
}

module.exports = {
  mmrProgression,
  momentum,
  skillSpread,
  mixOverTime,
  mapTrend,
  netMmrByMatchup,
  SESSION_GAP_MINUTES,
  MAX_SESSION_POSITIONS,
  SPREAD_BUCKETS,
  RESULT_VICTORY,
  RESULT_DEFEAT,
};
