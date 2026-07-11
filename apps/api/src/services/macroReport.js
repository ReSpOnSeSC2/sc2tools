"use strict";

const { gamesMatchStage } = require("../util/parseQuery");

/**
 * Macro Report aggregations — the data layer behind the Macro tab's
 * GET /v1/macro/report endpoint.
 *
 * Everything here reads ONLY the slim ``games`` rows (macroScore,
 * top3Leaks, spq, result, opponent.race, myBuild, durationSec, date),
 * never the heavy detail store — same contract as macroSummary. That
 * keeps the whole report a single aggregation round-trip regardless of
 * where the per-game breakdown blobs live (Mongo or R2).
 *
 * The report answers aggregate questions the per-game drill-down
 * can't:
 *   - Does macro correlate with winning? (win rate by score bucket)
 *   - Which leak category costs the most, and is it improving?
 *     (leak ledger with current-vs-previous-half trend)
 *   - Where does macro collapse? (avg score + WR by matchup /
 *     game-length / build segments)
 *
 * Leak semantics: the agent stamps at most one leak per category per
 * game (Supply Blocked, Mineral Float, and one race mechanic — see
 * replay-engine/analytics/macro_score.py), and only categories that
 * actually incurred a penalty. A scored game with no ``top3Leaks``
 * entry for a category therefore means the game was clean in that
 * category, which is what makes the with/without win-rate split
 * honest. Win rates use wins/total over the segment (ties count in
 * the denominator), matching the convention used by /v1/timeseries.
 */

/** Score-bucket edges. Mirrors lib/macro.ts score tones on the SPA
 *  (≥75 success, 50–74 warning, <50 danger) at decile granularity. */
const SCORE_BUCKETS = [
  { key: "lt60", label: "< 60", min: null, max: 60 },
  { key: "60s", label: "60–69", min: 60, max: 70 },
  { key: "70s", label: "70–79", min: 70, max: 80 },
  { key: "80s", label: "80–89", min: 80, max: 90 },
  { key: "90plus", label: "90+", min: 90, max: null },
];

/** Game-length bucket edges in seconds. */
const DURATION_BUCKETS = [
  { key: "lt6", label: "< 6 min", min: null, max: 360 },
  { key: "6to10", label: "6–10 min", min: 360, max: 600 },
  { key: "10to14", label: "10–14 min", min: 600, max: 840 },
  { key: "14to20", label: "14–20 min", min: 840, max: 1200 },
  { key: "20plus", label: "20+ min", min: 1200, max: null },
];

/** Max build segments returned (top by games played). */
const BUILD_SEGMENT_LIMIT = 8;

/** Trend halves need at least this many scored games AND this much
 *  calendar span to be worth showing; below either threshold the
 *  report returns ``trend: null`` and the SPA hides the deltas
 *  instead of charting noise. */
const TREND_MIN_SCORED_GAMES = 10;
const TREND_MIN_SPAN_MS = 7 * 24 * 3600 * 1000;

/** Win/loss bucketing $switch — same normalisation the analytics
 *  aggregations use ("Victory"/"win" → win, "Defeat"/"loss" → loss,
 *  ties → null). Kept local so this service has no dependency on
 *  aggregations.js internals. */
function resultBucketSwitch() {
  const lowered = { $toLower: { $ifNull: ["$result", ""] } };
  return {
    $switch: {
      branches: [
        { case: { $eq: [lowered, "victory"] }, then: "win" },
        { case: { $eq: [lowered, "win"] }, then: "win" },
        { case: { $eq: [lowered, "defeat"] }, then: "loss" },
        { case: { $eq: [lowered, "loss"] }, then: "loss" },
      ],
      default: null,
    },
  };
}

class MacroReportService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {string} userId
   * @param {object} filters parsed global-filter-bar object
   */
  async report(userId, filters) {
    return macroReport({ games: this.db.games }, userId, filters);
  }
}

/**
 * @param {{games: import('mongodb').Collection}} deps
 * @param {string} userId
 * @param {object} filters parsed global-filter-bar object
 */
async function macroReport(deps, userId, filters) {
  const match = gamesMatchStage(userId, filters);

  // Pre-pass: date extremes of the SCORED games inside the filter, to
  // anchor the current-vs-previous trend halves. One indexed query;
  // also tells us cheaply whether there is anything to report on.
  const [extremes] = await deps.games
    .aggregate([
      { $match: { ...match, macroScore: { $type: "number" } } },
      {
        $group: {
          _id: null,
          minDate: { $min: "$date" },
          maxDate: { $max: "$date" },
          scored: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const scored = extremes?.scored || 0;
  const splitDate = trendSplitDate(extremes);

  /** @type {Record<string, Array<Record<string, any>>>} */
  const facets = {
    coverage: [
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          scored: {
            $sum: { $cond: [{ $isNumber: "$macroScore" }, 1, 0] },
          },
        },
      },
    ],
    scoredOverall: [
      { $match: { macroScore: { $type: "number" } } },
      {
        $group: {
          _id: null,
          games: { $sum: 1 },
          wins: winSum(),
          losses: lossSum(),
          avgScore: { $avg: "$macroScore" },
        },
      },
    ],
    scoreBuckets: [
      { $match: { macroScore: { $type: "number" } } },
      { $addFields: { _scoreBucket: scoreBucketSwitch() } },
      {
        $group: {
          _id: "$_scoreBucket",
          games: { $sum: 1 },
          wins: winSum(),
          losses: lossSum(),
          avgScore: { $avg: "$macroScore" },
        },
      },
    ],
    leaks: [
      { $match: { macroScore: { $type: "number" }, top3Leaks: { $type: "array" } } },
      { $unwind: "$top3Leaks" },
      {
        $group: {
          _id: { $ifNull: ["$top3Leaks.name", "Unknown"] },
          games: { $sum: 1 },
          wins: winSum(),
          losses: lossSum(),
          totalMinerals: { $sum: numOrZero("$top3Leaks.mineral_cost") },
          totalPenalty: { $sum: numOrZero("$top3Leaks.penalty") },
        },
      },
    ],
    matchup: segmentFacet({
      $cond: [
        { $eq: [{ $ifNull: ["$opponent.race", ""] }, ""] },
        "Unknown",
        { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
      ],
    }),
    duration: segmentFacet(durationBucketSwitch()),
    build: [
      {
        $match: {
          macroScore: { $type: "number" },
          myBuild: { $type: "string", $nin: ["", null] },
        },
      },
      {
        $group: {
          _id: "$myBuild",
          games: { $sum: 1 },
          wins: winSum(),
          losses: lossSum(),
          avgScore: { $avg: "$macroScore" },
        },
      },
      { $sort: { games: -1, _id: 1 } },
      { $limit: BUILD_SEGMENT_LIMIT },
    ],
  };

  // Current-vs-previous halves: per-leak mineral cost per game, plus
  // the overall average score, for the trend arrows. Only built when
  // the sample is big enough to mean something.
  if (splitDate && scored >= TREND_MIN_SCORED_GAMES) {
    facets.halves = [
      { $match: { macroScore: { $type: "number" } } },
      {
        $addFields: {
          _half: {
            $cond: [{ $gte: ["$date", splitDate] }, "curr", "prev"],
          },
        },
      },
      {
        $group: {
          _id: "$_half",
          games: { $sum: 1 },
          avgScore: { $avg: "$macroScore" },
        },
      },
    ];
    facets.leakHalves = [
      { $match: { macroScore: { $type: "number" }, top3Leaks: { $type: "array" } } },
      {
        $addFields: {
          _half: {
            $cond: [{ $gte: ["$date", splitDate] }, "curr", "prev"],
          },
        },
      },
      { $unwind: "$top3Leaks" },
      {
        $group: {
          _id: {
            half: "$_half",
            name: { $ifNull: ["$top3Leaks.name", "Unknown"] },
          },
          totalMinerals: { $sum: numOrZero("$top3Leaks.mineral_cost") },
        },
      },
    ];
  }

  const [doc] = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: resultBucketSwitch() } },
      { $facet: facets },
    ])
    .toArray();

  return shapeReport(doc, { splitDate, scored });
}

// ---------------- pipeline fragments ----------------

function winSum() {
  return { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } };
}

function lossSum() {
  return { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } };
}

/** @param {string} path Mongo field path, e.g. ``"$top3Leaks.penalty"``. */
function numOrZero(path) {
  return { $cond: [{ $isNumber: path }, path, 0] };
}

/** $switch assigning each scored game its score-bucket key. */
function scoreBucketSwitch() {
  return {
    $switch: {
      branches: SCORE_BUCKETS.map((b) => ({
        case: {
          $and: [
            ...(b.min !== null ? [{ $gte: ["$macroScore", b.min] }] : []),
            ...(b.max !== null ? [{ $lt: ["$macroScore", b.max] }] : []),
          ],
        },
        then: b.key,
      })),
      default: "lt60",
    },
  };
}

/** $switch assigning each game its duration-bucket key. ``durationSec``
 *  may be absent on very old rows — those land in the shortest bucket,
 *  which is also where sub-30s "too short" games live. */
function durationBucketSwitch() {
  const dur = { $ifNull: ["$durationSec", 0] };
  return {
    $switch: {
      branches: DURATION_BUCKETS.map((b) => ({
        case: {
          $and: [
            ...(b.min !== null ? [{ $gte: [dur, b.min] }] : []),
            ...(b.max !== null ? [{ $lt: [dur, b.max] }] : []),
          ],
        },
        then: b.key,
      })),
      default: "lt6",
    },
  };
}

/** Shared segment sub-pipeline: scored games grouped by ``keyExpr``.
 *  @param {Record<string, any>} keyExpr Mongo aggregation expression. */
function segmentFacet(keyExpr) {
  return [
    { $match: { macroScore: { $type: "number" } } },
    {
      $group: {
        _id: keyExpr,
        games: { $sum: 1 },
        wins: winSum(),
        losses: lossSum(),
        avgScore: { $avg: "$macroScore" },
      },
    },
  ];
}

// ---------------- response shaping ----------------

/**
 * Midpoint of the scored-games date span, or null when the span is too
 * short for halves to mean anything.
 *
 * @param {{minDate?: Date, maxDate?: Date} | undefined} extremes
 * @returns {Date | null}
 */
function trendSplitDate(extremes) {
  const min = toDate(extremes?.minDate);
  const max = toDate(extremes?.maxDate);
  if (!min || !max) return null;
  const span = max.getTime() - min.getTime();
  if (span < TREND_MIN_SPAN_MS) return null;
  return new Date(min.getTime() + span / 2);
}

/** @param {unknown} v @returns {Date | null} */
function toDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** @param {unknown} v @returns {number | null} */
function round1(v) {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.round(v * 10) / 10
    : null;
}

/** @param {number} wins @param {number} total @returns {number | null} */
function rate(wins, total) {
  return total > 0 ? Math.round((wins / total) * 1000) / 1000 : null;
}

/**
 * Turn the raw $facet output into the wire shape the SPA consumes.
 *
 * @param {Record<string, any[]> | undefined} doc
 * @param {{splitDate: Date | null, scored: number}} ctx
 */
function shapeReport(doc, ctx) {
  const coverage = doc?.coverage?.[0] || { total: 0, scored: 0 };
  const overall = doc?.scoredOverall?.[0] || null;

  const bucketRows = new Map(
    (doc?.scoreBuckets || []).map((r) => [r._id, r]),
  );
  const scoreBuckets = SCORE_BUCKETS.map((b) => {
    const r = bucketRows.get(b.key);
    return {
      key: b.key,
      label: b.label,
      min: b.min,
      max: b.max,
      games: r?.games || 0,
      wins: r?.wins || 0,
      losses: r?.losses || 0,
      winRate: rate(r?.wins || 0, r?.games || 0),
      avgScore: round1(r?.avgScore),
    };
  });

  // Per-leak current/previous minerals-per-game for the trend arrows.
  const halves = new Map((doc?.halves || []).map((r) => [r._id, r]));
  const leakHalves = new Map();
  for (const r of doc?.leakHalves || []) {
    const name = r._id?.name || "Unknown";
    const half = r._id?.half;
    if (half !== "curr" && half !== "prev") continue;
    const entry = leakHalves.get(name) || {};
    entry[half] = r.totalMinerals || 0;
    leakHalves.set(name, entry);
  }
  const currGames = halves.get("curr")?.games || 0;
  const prevGames = halves.get("prev")?.games || 0;

  const scoredGames = overall?.games || 0;
  const scoredWins = overall?.wins || 0;
  const leaks = (doc?.leaks || [])
    .map((r) => {
      const name = r._id || "Unknown";
      const games = r.games || 0;
      const gamesWithout = Math.max(0, scoredGames - games);
      const lh = leakHalves.get(name);
      const currPerGame =
        currGames > 0 && lh ? (lh.curr || 0) / currGames : null;
      const prevPerGame =
        prevGames > 0 && lh ? (lh.prev || 0) / prevGames : null;
      return {
        name,
        games,
        share: rate(games, scoredGames),
        totalMinerals: Math.round(r.totalMinerals || 0),
        mineralsPerGame:
          games > 0 ? Math.round((r.totalMinerals || 0) / games) : 0,
        avgPenalty: games > 0 ? round1((r.totalPenalty || 0) / games) : null,
        wins: r.wins || 0,
        losses: r.losses || 0,
        winRateWith: rate(r.wins || 0, games),
        winRateWithout: rate(scoredWins - (r.wins || 0), gamesWithout),
        // Mineral cost averaged over ALL scored games in each half (not
        // just affected games) so "you stopped having this leak" reads
        // as improvement instead of vanishing from the denominator.
        trend:
          currPerGame !== null || prevPerGame !== null
            ? {
                currentPerGame: round1(currPerGame),
                previousPerGame: round1(prevPerGame),
                deltaPerGame:
                  currPerGame !== null && prevPerGame !== null
                    ? round1(currPerGame - prevPerGame)
                    : null,
              }
            : null,
      };
    })
    .sort((a, b) => b.totalMinerals - a.totalMinerals);

  const segments = {
    matchup: shapeSegments(doc?.matchup, (id) =>
      id === "Unknown" ? "vs Unknown" : `vs ${id}`,
    ),
    duration: shapeDurationSegments(doc?.duration),
    build: shapeSegments(doc?.build, (id) => String(id)),
  };

  return {
    ok: true,
    gamesTotal: coverage.total || 0,
    gamesScored: coverage.scored || 0,
    avgScore: round1(overall?.avgScore),
    winRate: rate(scoredWins, scoredGames),
    scoreBuckets,
    leaks,
    segments,
    trend:
      ctx.splitDate && (currGames > 0 || prevGames > 0)
        ? {
            splitDate: ctx.splitDate.toISOString(),
            currentGames: currGames,
            previousGames: prevGames,
            currentAvgScore: round1(halves.get("curr")?.avgScore),
            previousAvgScore: round1(halves.get("prev")?.avgScore),
          }
        : null,
  };
}

/**
 * @param {Array<Record<string, any>> | undefined} rows
 * @param {(id: unknown) => string} labelOf
 */
function shapeSegments(rows, labelOf) {
  return (rows || [])
    .map((r) => ({
      key: String(r._id),
      label: labelOf(r._id),
      games: r.games || 0,
      wins: r.wins || 0,
      losses: r.losses || 0,
      winRate: rate(r.wins || 0, r.games || 0),
      avgScore: round1(r.avgScore),
    }))
    .sort((a, b) => b.games - a.games);
}

/** Duration segments keep the canonical bucket order, zero-filled.
 *  @param {Array<Record<string, any>> | undefined} rows */
function shapeDurationSegments(rows) {
  const byKey = new Map((rows || []).map((r) => [r._id, r]));
  return DURATION_BUCKETS.map((b) => {
    const r = byKey.get(b.key);
    return {
      key: b.key,
      label: b.label,
      games: r?.games || 0,
      wins: r?.wins || 0,
      losses: r?.losses || 0,
      winRate: rate(r?.wins || 0, r?.games || 0),
      avgScore: round1(r?.avgScore),
    };
  });
}

module.exports = {
  MacroReportService,
  SCORE_BUCKETS,
  DURATION_BUCKETS,
};
