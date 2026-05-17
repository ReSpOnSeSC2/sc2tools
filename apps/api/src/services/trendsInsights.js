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
/** Bucket widths offered by the opponent-MMR histogram. */
const OPP_MMR_BUCKET_WIDTHS = [50, 100];
/** Range threshold (in MMR) below which 50-wide bins read cleaner. */
const OPP_MMR_AUTO_WIDTH_CUTOFF = 500;
/** Safety cap so a malformed payload can't fan out to thousands of bins. */
const OPP_MMR_MAX_BUCKETS = 80;

/**
 * Maximum gap between two consecutive MMR-tagged games for the
 * pre-match → pre-match delta to plausibly reflect the FIRST game's
 * outcome alone. Beyond ~6 hours the user's almost certainly resumed
 * in a fresh session — and any games they played in between that
 * didn't carry myMmr (older agent versions, unranked, missing
 * scaled_rating) would silently bleed into the attributed delta.
 * Setting this to "session" tightens it too far for streamers who
 * queue one last game an hour after dinner; 6 hours is the smallest
 * cap that still keeps a single sitting together.
 */
const NET_MMR_MAX_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Hard cap on the per-game pre-match → pre-match delta we trust as
 * attributable to ONE matchup. A real SC2 1v1 swing tops out around
 * ±60 MMR; anything past ±150 is almost certainly a race switch into
 * a different ladder (Protoss main dipping into Random),
 * a season soft-reset, or a stretch of unrecorded games inflating
 * the diff. Excluding these pairs is the difference between
 * "100% WR vs Protoss but the chart says -213" and a chart the user
 * can trust.
 */
const NET_MMR_MAX_DELTA = 150;

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
/**
 * Win rate bucketed by **absolute opponent MMR**, in clean 50- or
 * 100-MMR bands.
 *
 * Bucket width is either picked explicitly (``opts.bucketWidth``
 * = 50 or 100) or auto-chosen from the actual opponent-MMR spread
 * in the filtered data: tight ranges (≤500 MMR end-to-end) get
 * 50-wide bins so the picture has detail, wider ranges get 100-wide
 * bins so the chart doesn't fan out into 30+ thin bars. Either way
 * the response is self-describing — the chosen width is returned so
 * the client can label its toggle accurately.
 *
 * Games with no ``opponent.mmr`` are split into an ``unknown``
 * rollup the client can surface as a caption (never silently
 * dropped). Numeric guard uses ``$isNumber`` so int, long, double,
 * and decimal BSON types all match — the agent stores the field
 * as ``int(opp.mmr)`` so a literal type-name check would miss
 * every row (see PR #286).
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {{ bucketWidth?: number | "auto" }} [opts]
 */
async function oppMmrBuckets(deps, userId, filters, opts = {}) {
  const match = deps.gamesMatchStage(userId, filters);
  const width = await resolveOppMmrBucketWidth(deps, match, opts.bucketWidth);
  const facet = await deps.games.aggregate(oppMmrPipeline(deps, match, width)).toArray();
  return shapeOppMmrBuckets(facet[0], width);
}

/**
 * Pick the bin width. Honours an explicit ``50`` / ``100`` from
 * the caller; for ``"auto"`` or anything unrecognised, queries
 * the data range and picks the cleaner default.
 *
 * @param {Deps} deps
 * @param {object} match
 * @param {number | "auto" | undefined} requested
 */
async function resolveOppMmrBucketWidth(deps, match, requested) {
  if (requested === 50 || requested === 100) return requested;
  const rows = await deps.games
    .aggregate([
      { $match: { ...match, "opponent.mmr": { $type: "number" } } },
      {
        $group: {
          _id: null,
          mn: { $min: "$opponent.mmr" },
          mx: { $max: "$opponent.mmr" },
        },
      },
    ])
    .toArray();
  const extremes = rows && rows[0];
  if (!extremes || typeof extremes.mn !== "number" || typeof extremes.mx !== "number") {
    return 100;
  }
  const span = extremes.mx - extremes.mn;
  return span <= OPP_MMR_AUTO_WIDTH_CUTOFF ? 50 : 100;
}

/**
 * Pipeline that fans games into absolute-MMR bins of ``width``
 * plus an unknown rollup, in one $facet so the response is one
 * round trip.
 */
function oppMmrPipeline(deps, match, width) {
  return [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    {
      $facet: {
        bins: [
          { $match: { "opponent.mmr": { $type: "number" } } },
          {
            $addFields: {
              _bin: { $multiply: [{ $floor: { $divide: ["$opponent.mmr", width] } }, width] },
            },
          },
          {
            $group: {
              _id: "$_bin",
              wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
              losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
              total: { $sum: 1 },
              avgMmr: { $avg: "$opponent.mmr" },
              minMmr: { $min: "$opponent.mmr" },
              maxMmr: { $max: "$opponent.mmr" },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: OPP_MMR_MAX_BUCKETS },
        ],
        unknown: [
          {
            $match: {
              $or: [
                { "opponent.mmr": { $exists: false } },
                { "opponent.mmr": null },
                { "opponent.mmr": { $not: { $type: "number" } } },
              ],
            },
          },
          {
            $group: {
              _id: null,
              wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
              losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
              total: { $sum: 1 },
            },
          },
        ],
      },
    },
  ];
}

function shapeOppMmrBuckets(facet, width) {
  const binRows = (facet && facet.bins) || [];
  const unknownRow = (facet && facet.unknown && facet.unknown[0]) || null;
  const buckets = binRows.map((r) => ({
    lo: r._id,
    hi: r._id + width,
    label: `${r._id}–${r._id + width - 1}`,
    wins: r.wins,
    losses: r.losses,
    total: r.total,
    winRate: r.total ? r.wins / r.total : 0,
    avgMmr: r.avgMmr != null ? Math.round(r.avgMmr) : null,
    minMmr: r.minMmr ?? null,
    maxMmr: r.maxMmr ?? null,
  }));
  return {
    bucketWidth: width,
    buckets,
    unknown: unknownRow
      ? { total: unknownRow.total, wins: unknownRow.wins, losses: unknownRow.losses }
      : { total: 0, wins: 0, losses: 0 },
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
 * MMR-tagged games (within the filtered set) where the gap and the
 * delta both look like a single ladder game, attribute the delta
 * (next.myMmr − this.myMmr) to the opponent race of the FIRST game.
 *
 * Two guards keep the chart honest:
 *
 *   1. Time gap ≤ ``NET_MMR_MAX_GAP_MS``. When ``next`` is hours or
 *      days after ``this``, the user almost certainly played other
 *      games in between that didn't carry myMmr (older agent
 *      version, missing scaled_rating, filter excluded them, etc.).
 *      Attributing that whole MMR drift to one matchup is how
 *      "100% WR vs Protoss" ends up reading "−213".
 *   2. |delta| ≤ ``NET_MMR_MAX_DELTA``. Single-game ladder swings
 *      max out near ±60. Anything past 150 is a race-pool switch, a
 *      season reset, or a recording gap — never a single match.
 *
 * Pairs that fail either guard are dropped: ``games`` reflects only
 * the trustable pairs, so the WR shown next to the net-MMR number
 * is computed over the same cohort that produced the number.
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
            _nextDate: { $shift: { output: "$date", by: 1, default: null } },
          },
        },
      },
      { $match: { _nextMyMmr: { $type: "number" } } },
      {
        $addFields: {
          _delta: { $subtract: ["$_nextMyMmr", "$myMmr"] },
          _gapMs: { $subtract: ["$_nextDate", "$date"] },
          _oppRace: oppRaceSwitch(),
        },
      },
      {
        $match: {
          _gapMs: { $gte: 0, $lte: NET_MMR_MAX_GAP_MS },
          _delta: { $gte: -NET_MMR_MAX_DELTA, $lte: NET_MMR_MAX_DELTA },
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
  oppMmrBuckets,
  mixOverTime,
  mapTrend,
  netMmrByMatchup,
  SESSION_GAP_MINUTES,
  MAX_SESSION_POSITIONS,
  OPP_MMR_BUCKET_WIDTHS,
  OPP_MMR_AUTO_WIDTH_CUTOFF,
  NET_MMR_MAX_GAP_MS,
  NET_MMR_MAX_DELTA,
  RESULT_VICTORY,
  RESULT_DEFEAT,
};
