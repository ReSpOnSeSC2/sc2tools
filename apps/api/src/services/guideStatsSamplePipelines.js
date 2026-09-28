"use strict";

/**
 * guide_stats aggregation pipelines over ``guide_samples`` (milestone
 * timings and army snapshots) — the samples half of the nightly guides
 * rebuild; the games half is services/guideStatsPipelines.js.
 *
 * Three separate aggregations per matchup, each starting with the indexed
 * ``{ matchup, buildKey, era }`` ``$match`` and the same per-user cap as
 * the games pipeline (GUIDE_USER_CELL_CAP samples per userHash, build and
 * era): totals (light, ``$facet``), milestones and army (each ``$push``es
 * value arrays, so they stay out of a shared 16 MB ``$facet`` document).
 *
 * Quantiles are exact: values are ``$sortArray``-ed and interpolated
 * linearly with ``$arrayElemAt`` (numpy's default "linear" method), so
 * only numbers leave Mongo. Distinct users are ``$addToSet`` + ``$size``
 * of userHash inside Mongo, and every row is floor-filtered before it is
 * returned.
 */

const { GUIDE_CELL_MIN_GAMES, GUIDE_ARMY_CHECKPOINTS_SEC } = require("../config/guides");
const { buildNamesForMatchup } = require("../config/guideSlugs");
const { PATCH_ERAS } = require("../util/patchEra");
const {
  RESULT_VICTORY,
  RESULT_DEFEAT,
  cellFloorMatch,
  perUserCapStages,
} = require("./guideStatsPipelines");

const QUANTILE_P25 = 0.25;
const QUANTILE_MEDIAN = 0.5;
const QUANTILE_P75 = 0.75;

/**
 * The per-user cap's order key, most recent = greatest: the day the game
 * was played, not when its sample was written (the backfill writes newest
 * games first), with rows from before ``playedOn`` existed falling back to
 * their capture time. ``gameHash`` is appended so equal days keep the same
 * rows at the cap boundary on every run (``$documentNumber`` takes a
 * single sort key, hence one sortable string: ISO date + "|" + hash).
 *
 * @returns {Record<string, any>}
 */
function recencyKey() {
  return {
    $concat: [
      { $dateToString: { date: { $ifNull: ["$playedOn", "$createdAt"] } } },
      "|",
      { $ifNull: ["$gameHash", ""] },
    ],
  };
}

/**
 * Indexed ``$match`` + per-user cap over one matchup's guide_samples.
 *
 * @param {string} matchup
 * @param {Record<string, any>} projection extra projected fields
 * @returns {Record<string, any>[]}
 */
function sampleBaseStages(matchup, projection) {
  return [
    {
      $match: {
        matchup,
        buildKey: { $in: [...buildNamesForMatchup(matchup)] },
        era: { $in: [...PATCH_ERAS] },
        userHash: { $type: "string" },
      },
    },
    {
      $project: {
        _id: 0,
        userHash: 1,
        era: 1,
        build: "$buildKey",
        recency: recencyKey(),
        ...projection,
      },
    },
    ...perUserCapStages("userHash", "build", "recency"),
  ];
}

/**
 * @param {string} field object field of the sample
 * @returns {Record<string, any>} ``$objectToArray`` of it, or [] when not an object
 */
function objectEntries(field) {
  return { $objectToArray: { $cond: [{ $eq: [{ $type: field }, "object"] }, field, {}] } };
}

/**
 * Linear-interpolation quantile of an already sorted numeric array.
 *
 * @param {string} sortedField e.g. "$times"
 * @param {number} p 0..1
 * @returns {Record<string, any>}
 */
function quantileExpression(sortedField, p) {
  const at = (/** @type {any} */ index) => ({ $arrayElemAt: [sortedField, { $toInt: index }] });
  return {
    $let: {
      vars: { n: { $size: sortedField } },
      in: {
        $cond: [
          { $eq: ["$$n", 0] },
          null,
          {
            $let: {
              vars: { pos: { $multiply: [p, { $subtract: ["$$n", 1] }] } },
              in: {
                $add: [
                  at({ $floor: "$$pos" }),
                  {
                    $multiply: [
                      { $subtract: [at({ $ceil: "$$pos" }), at({ $floor: "$$pos" })] },
                      { $subtract: ["$$pos", { $floor: "$$pos" }] },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

/** @param {string} field @returns {Record<string, any>} */
function sortedAscending(field) {
  return { $sortArray: { input: field, sortBy: 1 } };
}

/**
 * Per (era, build): samples and distinct users; per (era, build,
 * checkpoint): samples carrying that army checkpoint. Light (no ``$push``).
 *
 * @param {string} matchup
 * @returns {Record<string, any>[]}
 */
function buildSampleTotalsPipeline(matchup) {
  const checkpoints = GUIDE_ARMY_CHECKPOINTS_SEC.map(String);
  const sized = { games: 1, users: { $size: "$users" } };
  return [
    ...sampleBaseStages(matchup, { checkpoints: { $map: { input: objectEntries("$army"), in: "$$this.k" } } }),
    {
      $facet: {
        builds: [
          { $group: { _id: { era: "$era", build: "$build" }, games: { $sum: 1 }, users: { $addToSet: "$userHash" } } },
          { $project: { _id: 0, era: "$_id.era", build: "$_id.build", ...sized } },
          cellFloorMatch(),
        ],
        checkpoints: [
          { $unwind: "$checkpoints" },
          { $match: { checkpoints: { $in: checkpoints } } },
          {
            $group: {
              _id: { era: "$era", build: "$build", checkpoint: "$checkpoints" },
              games: { $sum: 1 },
              users: { $addToSet: "$userHash" },
            },
          },
          {
            $project: { _id: 0, era: "$_id.era", build: "$_id.build", checkpoint: "$_id.checkpoint", ...sized },
          },
          cellFloorMatch(),
        ],
      },
    },
  ];
}

/**
 * Winner / loser split of one pushed value.
 *
 * @param {string} flag "$win" | "$loss"
 * @param {string} value
 * @returns {Record<string, any>}
 */
function pushWhen(flag, value) {
  return { $push: { $cond: [flag, value, "$$REMOVE"] } };
}

/** @param {string} flag @returns {Record<string, any>} */
function usersWhen(flag) {
  return { $addToSet: { $cond: [flag, "$userHash", "$$REMOVE"] } };
}

/**
 * Per (era, build, milestone key): games, users, exact p25/median/p75 of
 * the recorded times, plus the winner and loser medians (each with its
 * own games/users so the caller can apply the floor to both sides).
 *
 * @param {string} matchup
 * @returns {Record<string, any>[]}
 */
function buildSampleMilestonesPipeline(matchup) {
  return [
    ...sampleBaseStages(matchup, {
      win: { $eq: ["$result", RESULT_VICTORY] },
      loss: { $eq: ["$result", RESULT_DEFEAT] },
      milestone: objectEntries("$milestones"),
    }),
    { $unwind: "$milestone" },
    { $match: { "milestone.v": { $type: "number", $gte: 0 } } },
    {
      $group: {
        _id: { era: "$era", build: "$build", key: "$milestone.k" },
        times: { $push: "$milestone.v" },
        users: { $addToSet: "$userHash" },
        winTimes: pushWhen("$win", "$milestone.v"),
        winUsers: usersWhen("$win"),
        lossTimes: pushWhen("$loss", "$milestone.v"),
        lossUsers: usersWhen("$loss"),
      },
    },
    { $match: { [`times.${GUIDE_CELL_MIN_GAMES - 1}`]: { $exists: true } } },
    {
      $set: {
        times: sortedAscending("$times"),
        winTimes: sortedAscending("$winTimes"),
        lossTimes: sortedAscending("$lossTimes"),
      },
    },
    {
      $project: {
        _id: 0,
        era: "$_id.era",
        build: "$_id.build",
        key: "$_id.key",
        games: { $size: "$times" },
        users: { $size: "$users" },
        p25: quantileExpression("$times", QUANTILE_P25),
        median: quantileExpression("$times", QUANTILE_MEDIAN),
        p75: quantileExpression("$times", QUANTILE_P75),
        winGames: { $size: "$winTimes" },
        winUsers: { $size: "$winUsers" },
        winMedian: quantileExpression("$winTimes", QUANTILE_MEDIAN),
        lossGames: { $size: "$lossTimes" },
        lossUsers: { $size: "$lossUsers" },
        lossMedian: quantileExpression("$lossTimes", QUANTILE_MEDIAN),
      },
    },
    cellFloorMatch(),
  ];
}

/**
 * Per (era, build, checkpoint, unit): samples fielding the unit, their
 * distinct users and the exact median count among them.
 *
 * @param {string} matchup
 * @returns {Record<string, any>[]}
 */
function buildSampleArmyPipeline(matchup) {
  return [
    ...sampleBaseStages(matchup, { checkpoint: objectEntries("$army") }),
    { $unwind: "$checkpoint" },
    { $match: { "checkpoint.k": { $in: GUIDE_ARMY_CHECKPOINTS_SEC.map(String) } } },
    { $project: { era: 1, build: 1, userHash: 1, checkpoint: "$checkpoint.k", unit: objectEntries("$checkpoint.v") } },
    { $unwind: "$unit" },
    { $match: { "unit.v": { $type: "number", $gt: 0 } } },
    {
      $group: {
        _id: { era: "$era", build: "$build", checkpoint: "$checkpoint", unit: "$unit.k" },
        counts: { $push: "$unit.v" },
        users: { $addToSet: "$userHash" },
      },
    },
    { $match: { [`counts.${GUIDE_CELL_MIN_GAMES - 1}`]: { $exists: true } } },
    { $set: { counts: sortedAscending("$counts") } },
    {
      $project: {
        _id: 0,
        era: "$_id.era",
        build: "$_id.build",
        checkpoint: "$_id.checkpoint",
        unit: "$_id.unit",
        games: { $size: "$counts" },
        users: { $size: "$users" },
        median: quantileExpression("$counts", QUANTILE_MEDIAN),
      },
    },
    cellFloorMatch(),
  ];
}

module.exports = {
  buildSampleTotalsPipeline,
  buildSampleMilestonesPipeline,
  buildSampleArmyPipeline,
};
