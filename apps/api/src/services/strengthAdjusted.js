"use strict";

const { ladderExpression, ratingsExpression } = require("./mmrExpectation");
const { RULES, validatedAnchors, performanceRating } = require("./mmrExpectationMath");
const { wilsonInterval } = require("../util/wilson");

/** @typedef {import('./mmrExpectationMath').Calibration|null} Curve */
/** @param {number} probability */
const logOdds = probability => Math.log(probability) - Math.log1p(-probability);

/** Same bounded piecewise-linear curve/continuous Elo tails as expectedWin.
 * Mongo does the per-game sum in the existing grouping pass; it never returns
 * a user's entire replay history to Node for this calculation.
 * @param {Curve} curve @returns {object} */
function expectationExpression(curve) {
  const anchors = validatedAnchors(curve), scale = Math.LN10 / RULES.eloScale;
  const sigmoid = (/** @type {object|number} */ exponent) => ({ $divide: [1, { $add: [1, { $exp: exponent }] }] });
  const difference = { $subtract: ["$opponent.mmr", "$myMmr"] };
  if (!anchors) return sigmoid({ $multiply: [difference, scale] });
  const first = anchors[0], last = anchors[anchors.length - 1];
  /** @type {import('mongodb').Document[]} */
  const branches = [{ case: { $lt: [difference, first.diff] }, then: sigmoid({ $subtract: [{ $multiply: [{ $subtract: [difference, first.diff] }, scale] }, logOdds(first.probability)] }) }];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    branches.push({ case: { $lte: [difference, b.diff] }, then: { $add: [a.probability, { $multiply: [{ $subtract: [difference, a.diff] }, (b.probability - a.probability) / (b.diff - a.diff)] }] } });
  }
  return { $switch: { branches, default: sigmoid({ $subtract: [{ $multiply: [{ $subtract: [difference, last.diff] }, scale] }, logOdds(last.probability)] }) } };
}

const STRENGTH_PROJECTION = { ratedGames: 1, ratedWins: 1, expectedWins: 1, _opponentTotal: 1, excludedNoMmr: 1 };

function strengthAccumulators() {
  return {
    ratedGames: { $sum: { $cond: ["$_strengthRated", 1, 0] } },
    ratedWins: { $sum: { $cond: [{ $and: ["$_strengthRated", { $eq: ["$_bucket", "win"] }] }, 1, 0] } },
    expectedWins: { $sum: "$_strengthExpected" },
    _opponentTotal: { $sum: { $cond: ["$_strengthRated", "$opponent.mmr", 0] } },
    excludedNoMmr: { $sum: { $cond: [{ $and: ["$_strengthCohort", { $not: ["$_strengthRated"] }] }, 1, 0] } },
  };
}

/** Extend only W/L groups and their projections, including named facets.
 * The original raw totals and existing filters remain intact. Derived
 * strength fields use decided ranked 1v1 only and publish explicit coverage.
 * @param {import('mongodb').Document[]} stages @returns {import('mongodb').Document[]} */
function extendGroups(stages) {
  let grouped = false;
  return stages.map(stage => {
    if (stage.$facet) return { $facet: Object.fromEntries(Object.entries(stage.$facet).map(([key, value]) => [key, extendGroups(/** @type {import('mongodb').Document[]} */ (value))])) };
    if (stage.$group?.wins && stage.$group?.total) { grouped = true; return { $group: { ...stage.$group, ...strengthAccumulators() } }; }
    if (stage.$project && grouped) { grouped = false; return { $project: { ...stage.$project, ...STRENGTH_PROJECTION } }; }
    return stage;
  });
}

/** Must be called on the existing scoped pipeline beginning with $match.
 * @param {import('mongodb').Document[]} stages @param {Curve} curve */
function strengthPipeline(stages, curve) {
  return [stages[0],
    { $addFields: { _strengthCohort: { $and: [ladderExpression(), { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "defeat", "win", "loss"]] }] } } },
    { $addFields: { _strengthRated: { $and: ["$_strengthCohort", ratingsExpression()] } } },
    { $addFields: { _strengthExpected: { $cond: ["$_strengthRated", expectationExpression(curve), null] } } },
    ...extendGroups(stages.slice(1))];
}

/** Explicit coverage makes arithmetic honest when only part of a row has
 * paired replay-time ratings. A 0%/100% sample has no finite rating estimate.
 * @param {Record<string,any>} row @param {Curve} curve @returns {Record<string,any>} */
function finishStrength(row, curve) {
  const { _opponentTotal = 0, ...rest } = row;
  const ratedGames = row.ratedGames || 0, ratedWins = row.ratedWins || 0;
  const expectedWins = ratedGames ? row.expectedWins : null;
  return { ...rest, ratedGames, ratedWins, expectedWins,
    winsAboveExpected: ratedGames ? ratedWins - expectedWins : null,
    perfRating: ratedGames ? performanceRating(_opponentTotal / ratedGames, ratedWins, ratedGames, curve) : null,
    winRateRange: wilsonInterval(row.wins || 0, row.total || 0),
    ratedWinRateRange: wilsonInterval(ratedWins, ratedGames),
    excludedNoMmr: row.excludedNoMmr || 0,
    excludedIneligible: Math.max(0, (row.total || 0) - ratedGames - (row.excludedNoMmr || 0)),
    expectation: { method: curve ? "calibrated" : "elo", eloScale: RULES.eloScale, sampleGames: curve?.sampleGames || 0, supportedBins: curve?.supportedBins || 0 },
  };
}

/** At most 16 race pairs x 50 scalar samples; no replay names, ids, details,
 * or unbounded $push. Includes missing-MMR games so coverage stays visible. */
function matchupRatingStages() {
  return [
    { $match: { _strengthCohort: true, date: { $type: "date" } } },
    { $group: { _id: { myRace: "$_myRace", race: "$_oppRace" }, totalGames: { $sum: 1 }, samples: { $topN: { n: 50, sortBy: { date: -1, gameId: -1 }, output: { date: "$date", win: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] }, opponent: "$opponent.mmr", rated: "$_strengthRated", expected: "$_strengthExpected" } } } } },
    { $sort: { "_id.myRace": 1, "_id.race": 1 } },
  ];
}

/** @typedef {{date:Date,win:number,opponent:number,rated:boolean,expected:number|null}} RatingSample */
/** @param {RatingSample[]} samples @param {Curve} curve */
function summarizeRatingWindow(samples, curve) {
  const rated = samples.filter(sample => sample.rated);
  return finishStrength({ wins: samples.reduce((n, sample) => n + sample.win, 0), total: samples.length,
    ratedGames: rated.length, ratedWins: rated.reduce((n, sample) => n + sample.win, 0),
    expectedWins: rated.reduce((n, sample) => n + (sample.expected || 0), 0),
    _opponentTotal: rated.reduce((n, sample) => n + sample.opponent, 0), excludedNoMmr: samples.length - rated.length,
  }, curve);
}

/** Rolling ten-game performance estimates over each pair's latest 50
 * decided ladder games. Missing ratings are excluded explicitly; all-win or
 * all-loss windows remain null instead of drawing a fictional finite point.
 * @param {Record<string,any>} row @param {Curve} curve */
function shapeMatchupRating(row, curve) {
  const samples = /** @type {RatingSample[]} */ ([...(row.samples || [])].reverse());
  return { myRace: row._id.myRace, race: row._id.race, matchup: `${row._id.myRace}v${row._id.race}`,
    totalGames: row.totalGames, sampleGames: samples.length, windowGames: 10,
    ...summarizeRatingWindow(samples, curve),
    points: samples.map((sample, index) => {
      const summary = summarizeRatingWindow(samples.slice(Math.max(0, index - 9), index + 1), curve);
      return { date: sample.date, games: summary.total, ratedGames: summary.ratedGames, excludedNoMmr: summary.excludedNoMmr, perfRating: summary.perfRating };
    }),
  };
}

module.exports = { strengthPipeline, finishStrength, expectationExpression, strengthAccumulators, STRENGTH_PROJECTION, matchupRatingStages, shapeMatchupRating };
