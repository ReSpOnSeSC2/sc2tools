"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { computeDossierExtras } = require("./buildDossier");
const { hydrateDossierTimings } = require("./buildDossierTimingSample");
const { readCommunityTimings } = require("./buildCommunityTimings");
const { planFacets, finishPlan, planGroupFields, planHeldRate } = require("./buildPlanSurvival");
const { strengthPipeline, finishStrength } = require("./strengthAdjusted");
const { OPPONENT_RACE_GROUP, OPPONENT_RACE_PROJECT } = require("../util/opponentRaceCounts");
const {
  BUILD_INTENT_LABEL_PROJECTION,
  COUNTED_BY_CHECKIN_EXPR,
  OPP_COUNTED_BY_CHECKIN_EXPR,
  PLANNED_GAME_EXPR,
  AGREES_WITH_DETECTOR_MATCH,
} = require("./buildIntentShape");
const { agreesWithDetector } = require("./buildIntentReaders");

const DOSSIER_PROJECTION = {
  _id: 0,
  gameId: 1,
  date: 1,
  // Patch era, with ``date`` (util/patchEra): DNA timings' 8- vs 12-worker
  // build durations.
  gameVersion: 1,
  gameBuild: 1,
  result: 1,
  map: 1,
  myRace: 1,
  myBuild: 1,
  durationSec: 1,
  macroScore: 1,
  apm: 1,
  spq: 1,
  opponent: 1,
  // Build check-in labels: median timings describe the build's shape, so
  // they use only games whose replay agrees with the label.
  _customBuildSlug: 1,
  ...BUILD_INTENT_LABEL_PROJECTION,
};

const BUCKET_BRANCHES = [
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "victory"] }, then: "win" },
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "win"] }, then: "win" },
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "defeat"] }, then: "loss" },
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "loss"] }, then: "loss" },
];

/**
 * BuildsService — analytics over the `myBuild` field.
 *
 * Replaces the legacy in-memory `builds(filters)` and
 * `buildDetail(name, filters)` from
 * `stream-overlay-backend/analyzer.js`. Two shapes:
 *
 *   list(userId, filters)          → ranked list with W/L/winRate.
 *   detail(userId, name, filters)  → drilldown with last 50 games and
 *                                    matchup / map / strategy slices.
 *
 * ``myBuild`` is the effective label: a confirmed build check-in counts
 * toward the declared build. ``checkins`` says how many games count only
 * because of one, and recent rows carry ``planned`` for them. Opponent
 * strategy rows (``oppStrategies``, a build's ``byStrategy``) do the same
 * for corrected opponent builds on ``opponent.strategy``.
 */
class BuildsService {
  /** @param {{games: import('mongodb').Collection,guideStats?:import('mongodb').Collection}} db
   * @param {{mmrExpectation?:Pick<import('./mmrExpectation').MmrExpectationService,'curve'>,
   * gameDetails?:Pick<import('./gameDetails').GameDetailsService,'findMany'>}} [opts] */
  constructor(db, opts = {}) {
    this.db = db;
    this.mmrExpectation = opts.mmrExpectation;
    this.gameDetails = opts.gameDetails;
  }

  /**
   * @param {string} userId
   * @param {object} filters
   */
  async list(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const curve = await this.mmrExpectation?.curve() || null;
    const rows = await this.db.games
      .aggregate(strengthPipeline([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $group: {
            _id: { $ifNull: ["$myBuild", "Unknown"] },
            wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
            total: { $sum: 1 },
            checkins: { $sum: COUNTED_BY_CHECKIN_EXPR },
            ...planGroupFields(),
            lastPlayed: { $max: "$date" },
            ...OPPONENT_RACE_GROUP,
          },
        },
        {
          $project: {
            _id: 0,
            name: "$_id",
            wins: 1,
            losses: 1,
            total: 1,
            checkins: 1,
            planDeclared: 1,
            planHeld: 1,
            lastPlayed: 1,
            myMatchups: OPPONENT_RACE_PROJECT,
            winRate: {
              $cond: [{ $gt: ["$total", 0] }, { $divide: ["$wins", "$total"] }, 0],
            },
          },
        },
        { $sort: { total: -1 } },
      ], curve))
      .toArray();
    return rows.map(row => {
      const result = finishStrength(row, curve);
      result.planHeldRate = planHeldRate(row);
      return result;
    });
  }

  /**
   * @param {string} userId
   * @param {string} name
   * @param {object} filters
   * @returns {Promise<object | null>}
   */
  async detail(userId, name, filters) {
    if (!name) return null;
    const baseMatch = { ...gamesMatchStage(userId, filters), myBuild: name };
    const resumedMatch = {
      ...gamesMatchStage(userId, filters),
      isResumedFromReplay: true,
      myBuild: name,
    };
    const cursor = this.db.games.aggregate([
      { $match: baseMatch },
      { $addFields: { _bucket: bucketSwitch() } },
      {
        $facet: {
          ...planFacets("$_bucket"),
          totals: [
            {
              $group: {
                _id: null,
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: {
                  $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
                },
                total: { $sum: 1 },
                checkins: { $sum: COUNTED_BY_CHECKIN_EXPR },
                lastPlayed: { $max: "$date" },
              },
            },
          ],
          byMatchup: [
            {
              $group: {
                _id: {
                  $cond: [
                    { $eq: [{ $ifNull: ["$opponent.race", ""] }, ""] },
                    "vs Unknown",
                    {
                      $concat: [
                        "vs ",
                        { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
                      ],
                    },
                  ],
                },
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
                total: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                name: "$_id",
                wins: 1,
                losses: 1,
                total: 1,
              },
            },
            { $sort: { total: -1 } },
          ],
          byMap: [
            {
              $group: {
                _id: { $ifNull: ["$map", "Unknown"] },
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
                total: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                name: "$_id",
                wins: 1,
                losses: 1,
                total: 1,
              },
            },
            { $sort: { total: -1 } },
          ],
          byStrategy: [
            {
              $group: {
                _id: { $ifNull: ["$opponent.strategy", "Unknown"] },
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
                total: { $sum: 1 },
                checkins: { $sum: OPP_COUNTED_BY_CHECKIN_EXPR },
              },
            },
            {
              $project: {
                _id: 0,
                name: "$_id",
                wins: 1,
                losses: 1,
                total: 1,
                checkins: 1,
              },
            },
            { $sort: { total: -1 } },
          ],
          recent: [
            { $sort: { date: -1 } },
            { $limit: 50 },
            {
              $project: {
                _id: 0,
                gameId: 1,
                date: 1,
                map: { $ifNull: ["$map", ""] },
                opponent: { $ifNull: ["$opponent.displayName", ""] },
                opp_race: { $ifNull: ["$opponent.race", ""] },
                opp_strategy: { $ifNull: ["$opponent.strategy", null] },
                result: 1,
                duration: { $ifNull: ["$durationSec", 0] },
                macroScore: { $ifNull: ["$macroScore", null] },
                planned: PLANNED_GAME_EXPR,
              },
            },
          ],
        },
      },
    ]);
    const [doc] = await cursor.toArray();
    const [resumedCount, resumedGames] = await Promise.all([
      this.db.games.countDocuments(resumedMatch),
      this.db.games
        .find(resumedMatch, { projection: DOSSIER_PROJECTION })
        .sort({ date: -1 })
        .limit(50)
        .toArray(),
    ]);
    const totals = doc?.totals?.[0] || {
      wins: 0,
      losses: 0,
      total: 0,
      checkins: 0,
      lastPlayed: null,
    };
    if (!totals.total && !resumedCount) return null;
    const dossierGames = totals.total
      ? await this.db.games
        .find(baseMatch, { projection: DOSSIER_PROJECTION })
        .sort({ date: -1 })
        .toArray()
      : [];
    const timingCandidates = totals.total ? await this.db.games.find({ $and: [baseMatch, AGREES_WITH_DETECTOR_MATCH] },
      { projection: DOSSIER_PROJECTION }).sort({ date: -1 }).limit(25).toArray() : [];
    const timingGames = await hydrateDossierTimings({ games: this.db.games, details: this.gameDetails }, userId, timingCandidates);
    const extras = computeDossierExtras(dossierGames, { timingGames: timingGames.filter(agreesWithDetector) });
    return {
      name,
      plan: finishPlan(doc),
      communityTimings: await readCommunityTimings(this.db.guideStats, name, timingGames),
      timingSampleGames: timingGames.filter(game => game.buildLog.length > 0 || game.oppBuildLog.length > 0).length,
      timingSampleSelected: timingGames.length,
      timingSampleLimit: 25,
      timingsTruncated: totals.total > 25,
      totals: { ...totals, winRate: totals.total ? totals.wins / totals.total : 0 },
      byMatchup: addWinRates(doc?.byMatchup || []),
      byMap: addWinRates(doc?.byMap || []),
      byStrategy: addWinRates(doc?.byStrategy || []),
      recent: doc?.recent || [],
      resumedCount,
      resumedRecent: resumedGames.map(toResumedRecent),
      ...extras,
    };
  }

  /**
   * Detected opponent strategies sorted by frequency. A corrected opponent
   * build counts toward the declared strategy; ``checkins`` says how many
   * games count only because of a correction.
   *
   * @param {string} userId
   * @param {object} filters
   */
  async oppStrategies(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const curve = await this.mmrExpectation?.curve() || null;
    const rows = await this.db.games
      .aggregate(strengthPipeline([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $group: {
            _id: { $ifNull: ["$opponent.strategy", "Unknown"] },
            wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
            total: { $sum: 1 },
            checkins: { $sum: OPP_COUNTED_BY_CHECKIN_EXPR },
          },
        },
        {
          $project: {
            _id: 0,
            name: "$_id",
            wins: 1,
            losses: 1,
            total: 1,
            checkins: 1,
            winRate: {
              $cond: [{ $gt: ["$total", 0] }, { $divide: ["$wins", "$total"] }, 0],
            },
          },
        },
        { $sort: { total: -1 } },
      ], curve))
      .toArray();
    return rows.map(row => finishStrength(row, curve));
  }
}

function bucketSwitch() {
  return { $switch: { branches: BUCKET_BRANCHES, default: null } };
}

/** @param {Array<Record<string, any>>} rows */
function addWinRates(rows) {
  return rows.map(
    /** @param {Record<string, any>} row */ (row) => ({
      ...row,
      winRate: row.total ? row.wins / row.total : 0,
    }),
  );
}

/** @param {Record<string, any>} game */
function toResumedRecent(game) {
  return {
    gameId: game.gameId,
    date: game.date,
    map: game.map || "",
    opponent: game.opponent?.displayName || "",
    opp_race: game.opponent?.race || "",
    opp_strategy: game.opponent?.strategy || null,
    result: game.result,
    duration: game.durationSec || 0,
    macroScore: game.macroScore ?? null,
    isResumedFromReplay: true,
  };
}

module.exports = { BuildsService };
