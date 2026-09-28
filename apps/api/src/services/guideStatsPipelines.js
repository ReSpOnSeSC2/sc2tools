"use strict";

/**
 * guide_stats aggregation pipelines — every heavy step of the nightly
 * guides rebuild runs INSIDE Mongo (services/guideStats.js only shapes
 * the small grouped rows these return):
 *
 *   - ``buildGamesPipeline(M)``: one pass over matchup M's slim ``games``
 *     rows. Starts with the indexed ``guideGamesMatch(M)`` (served by the
 *     partial ``guide_stats_build_opp_race`` index, db/connect.js), caps
 *     every user at GUIDE_USER_CELL_CAP games per build per era with a
 *     ``$setWindowFields`` rank, then ``$facet``s into every cell family.
 *   - the guide_samples pipelines live in services/guideStatsSamplePipelines.js
 *     and reuse this module's cap and floor stages.
 *
 * Privacy: distinct users are counted with ``$addToSet`` + ``$size``
 * inside Mongo, so userIds / userHashes never reach Node, and every
 * group is filtered to the CELL floor (GUIDE_CELL_MIN_GAMES games from
 * GUIDE_CELL_MIN_USERS users) before it leaves the server — a number
 * below the floor is never even read, let alone stored.
 */

const {
  GUIDE_CELL_MIN_GAMES,
  GUIDE_CELL_MIN_USERS,
  GUIDE_USER_CELL_CAP,
  GUIDE_LENGTH_BUCKETS,
} = require("../config/guides");
const { strategyNamesForMatchup } = require("../config/guideSlugs");
const { PATCH_ERAS, eraExpression } = require("../util/patchEra");
const {
  guideGamesMatch,
  leagueBandExpression,
  mmrBandExpression,
} = require("./guideRules");

/** Name of the partial games index every games pipeline starts on (db/connect.js). */
const GUIDE_GAMES_INDEX_NAME = "guide_stats_build_opp_race";
/** Name of the guide_samples aggregation index (db/connect.js). */
const GUIDE_SAMPLES_INDEX_NAME = "guide_samples_matchup_build_era";
/**
 * Per-aggregation time budget. Passed as both server ``maxTimeMS`` and
 * driver ``timeoutMS`` (CSOT, honoured by mongodb 6.13 on aggregate):
 * without ``timeoutMS`` the client's 30 s socket timer would kill a long
 * blocking ``$setWindowFields`` sort before the server budget.
 */
const GUIDE_PIPELINE_MAX_MS = 120000;
/** Same bound as validation/gameRecord.js / services/guideSamples.js. */
const MAP_MAX_CHARS = 200;
/** Macro scores are 0..100 (replay-engine analytics/macro_score.py). */
const MACRO_SCORE_MIN = 0;
const MACRO_SCORE_MAX = 100;
/**
 * The macro engine's fixed leak vocabulary (replay-engine
 * analytics/macro_score.py). Only these names can surface on a public
 * page: ``top3Leaks`` is uploader-supplied text, and an allowlist keeps a
 * handful of colluding accounts from publishing arbitrary strings.
 */
const GUIDE_LEAK_NAMES = Object.freeze([
  "Supply Blocked",
  "Inject Efficiency",
  "Chrono Efficiency",
  "MULE Efficiency",
  "Mineral Float",
]);
const RESULT_VICTORY = "Victory";
const RESULT_DEFEAT = "Defeat";

/**
 * Options for every guide aggregation. ``hint`` pins the plan to the
 * guide index so a plan-cache flip can never degrade the nightly run to a
 * race-wide scan.
 *
 * @param {string} hint index name
 * @returns {import('mongodb').AggregateOptions}
 */
function guideAggregateOptions(hint) {
  return {
    allowDiskUse: true,
    maxTimeMS: GUIDE_PIPELINE_MAX_MS,
    timeoutMS: GUIDE_PIPELINE_MAX_MS,
    hint,
  };
}

/** @returns {Record<string, any>} the CELL floor as a post-group ``$match`` */
function cellFloorMatch() {
  return { $match: { games: { $gte: GUIDE_CELL_MIN_GAMES }, users: { $gte: GUIDE_CELL_MIN_USERS } } };
}

/**
 * Cap every (user, build, era) partition at its GUIDE_USER_CELL_CAP most
 * recent rows (poisoning resistance).
 *
 * @param {string} userField
 * @param {string} buildField
 * @param {string} sortField most recent first
 * @returns {Record<string, any>[]}
 */
function perUserCapStages(userField, buildField, sortField) {
  return [
    {
      $setWindowFields: {
        partitionBy: { user: `$${userField}`, build: `$${buildField}`, era: "$era" },
        sortBy: { [sortField]: -1 },
        output: { capRank: { $documentNumber: {} } },
      },
    },
    { $match: { capRank: { $lte: GUIDE_USER_CELL_CAP } } },
  ];
}

/**
 * ``$group`` accumulators of one Cell (users as a set, sized later).
 *
 * @returns {Record<string, any>}
 */
function cellAccumulators() {
  return {
    games: { $sum: 1 },
    wins: { $sum: "$win" },
    losses: { $sum: "$loss" },
    users: { $addToSet: "$userId" },
  };
}

/**
 * Group → size the user set → CELL floor. ``idFields`` become top-level
 * fields of each output row.
 *
 * @param {Record<string, string>} idFields output field → input path
 * @param {Record<string, any>} [accumulators]
 * @returns {Record<string, any>[]}
 */
function cellGroupStages(idFields, accumulators = cellAccumulators()) {
  /** @type {Record<string, any>} */
  const project = { _id: 0, games: 1, users: { $size: "$users" } };
  for (const field of Object.keys(accumulators)) {
    if (field !== "users" && field !== "games") project[field] = 1;
  }
  for (const field of Object.keys(idFields)) project[field] = `$_id.${field}`;
  return [
    { $group: { _id: Object.fromEntries(Object.entries(idFields).map(([k, v]) => [k, `$${v}`])), ...accumulators } },
    { $project: project },
    cellFloorMatch(),
  ];
}

/** @returns {Record<string, any>} length-bucket key of ``$durationSec`` or null */
function lengthBucketExpression() {
  const branches = GUIDE_LENGTH_BUCKETS.map((bucket) => ({
    case: bucket.maxSec === null
      ? { $gte: ["$durationSec", bucket.minSec] }
      : { $and: [{ $gte: ["$durationSec", bucket.minSec] }, { $lt: ["$durationSec", bucket.maxSec] }] },
    then: bucket.key,
  }));
  return { $cond: [{ $isNumber: "$durationSec" }, { $switch: { branches, default: null } }, null] };
}

/** @returns {Record<string, any>} ``$map`` when it is a sane string, else null */
function mapExpression() {
  const length = { $strLenCP: "$map" };
  return {
    $cond: [
      { $eq: [{ $type: "$map" }, "string"] },
      { $cond: [{ $and: [{ $gt: [length, 0] }, { $lte: [length, MAP_MAX_CHARS] }] }, "$map", null] },
      null,
    ],
  };
}

/**
 * Opponent strategy when it may appear on a guide: not relabelled by a
 * private custom strategy and an exact catalog name of the matchup's
 * counters namespace. Everything else is null (not counted).
 *
 * @param {string} matchup
 * @returns {Record<string, any>}
 */
function strategyExpression(matchup) {
  return {
    $cond: [
      {
        $and: [
          { $eq: [{ $type: "$_customOpponentStrategySlug" }, "missing"] },
          { $in: ["$opponent.strategy", [...strategyNamesForMatchup(matchup)]] },
        ],
      },
      "$opponent.strategy",
      null,
    ],
  };
}

/** @returns {Record<string, any>} numeric macroScore in range, else null */
function macroScoreExpression() {
  return {
    $cond: [
      {
        $and: [
          { $isNumber: "$macroScore" },
          { $gte: ["$macroScore", MACRO_SCORE_MIN] },
          { $lte: ["$macroScore", MACRO_SCORE_MAX] },
        ],
      },
      "$macroScore",
      null,
    ],
  };
}

/** @returns {Record<string, any>} allowlisted leak names of the game (deduped) */
function leakNamesExpression() {
  return {
    $cond: [
      { $isArray: "$top3Leaks" },
      { $setIntersection: ["$top3Leaks.name", [...GUIDE_LEAK_NAMES]] },
      [],
    ],
  };
}

/**
 * Slim projection of one eligible game (the only fields any facet reads).
 *
 * @param {string} matchup
 * @returns {Record<string, any>}
 */
function gameProjection(matchup) {
  return {
    _id: 0,
    userId: 1,
    date: 1,
    build: "$myBuild",
    era: eraExpression(),
    win: { $cond: [{ $eq: ["$result", RESULT_VICTORY] }, 1, 0] },
    loss: { $cond: [{ $eq: ["$result", RESULT_DEFEAT] }, 1, 0] },
    leagueBand: leagueBandExpression(),
    mmrBand: mmrBandExpression(),
    map: mapExpression(),
    strategy: strategyExpression(matchup),
    bucket: lengthBucketExpression(),
    macroScore: macroScoreExpression(),
    leaks: leakNamesExpression(),
  };
}

/** @param {string} field @returns {Record<string, any>} */
function notNull(field) {
  return { $match: { [field]: { $ne: null } } };
}

/** @returns {Record<string, Record<string, any>[]>} the ``$facet`` spec */
function gamesFacets() {
  const byBuild = { era: "era", build: "build" };
  return {
    overall: cellGroupStages(byBuild),
    matchupTotals: cellGroupStages({ era: "era" }),
    leagueBands: [notNull("leagueBand"), ...cellGroupStages({ ...byBuild, value: "leagueBand" })],
    mmrBands: [notNull("mmrBand"), ...cellGroupStages({ ...byBuild, value: "mmrBand" })],
    maps: [notNull("map"), ...cellGroupStages({ ...byBuild, map: "map" })],
    mapTotals: [notNull("map"), ...cellGroupStages({ era: "era", map: "map" })],
    strategies: [notNull("strategy"), ...cellGroupStages({ ...byBuild, strategy: "strategy" })],
    strategyTotals: [notNull("strategy"), ...cellGroupStages({ era: "era", strategy: "strategy" })],
    lengths: [notNull("bucket"), ...cellGroupStages({ ...byBuild, bucket: "bucket" })],
    // Scored games (numeric macroScore) are also the leak denominator: the
    // engine only stamps a leak it penalised, so a scored game without one
    // was clean in that category (the services/macroReport.js semantics).
    macro: [
      notNull("macroScore"),
      ...cellGroupStages(byBuild, {
        games: { $sum: 1 },
        avgScore: { $avg: "$macroScore" },
        users: { $addToSet: "$userId" },
      }),
    ],
    leaks: [
      notNull("macroScore"),
      { $unwind: "$leaks" },
      ...cellGroupStages({ ...byBuild, name: "leaks" }, { games: { $sum: 1 }, users: { $addToSet: "$userId" } }),
    ],
  };
}

/**
 * The per-matchup games pipeline (see the module comment).
 *
 * Example: `db.games.aggregate(buildGamesPipeline("PvZ"), guideAggregateOptions(GUIDE_GAMES_INDEX_NAME))`.
 *
 * @param {string} matchup "PvZ" form
 * @returns {Record<string, any>[]}
 */
function buildGamesPipeline(matchup) {
  return [
    { $match: guideGamesMatch(matchup) },
    { $project: gameProjection(matchup) },
    { $match: { era: { $in: [...PATCH_ERAS] } } },
    ...perUserCapStages("userId", "build", "date"),
    { $facet: gamesFacets() },
  ];
}

module.exports = {
  GUIDE_GAMES_INDEX_NAME,
  GUIDE_SAMPLES_INDEX_NAME,
  GUIDE_PIPELINE_MAX_MS,
  GUIDE_LEAK_NAMES,
  RESULT_VICTORY,
  RESULT_DEFEAT,
  guideAggregateOptions,
  cellFloorMatch,
  perUserCapStages,
  buildGamesPipeline,
};
