"use strict";

const { gamesMatchStage } = require("../util/parseQuery");

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
 */
class BuildsService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {string} userId
   * @param {object} filters
   */
  async list(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    return this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $group: {
            _id: { $ifNull: ["$myBuild", "Unknown"] },
            wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
            total: { $sum: 1 },
            lastPlayed: { $max: "$date" },
          },
        },
        {
          $project: {
            _id: 0,
            name: "$_id",
            wins: 1,
            losses: 1,
            total: 1,
            lastPlayed: 1,
            winRate: {
              $cond: [{ $gt: ["$total", 0] }, { $divide: ["$wins", "$total"] }, 0],
            },
          },
        },
        { $sort: { total: -1 } },
      ])
      .toArray();
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
    const cursor = this.db.games.aggregate([
      { $match: baseMatch },
      { $addFields: { _bucket: bucketSwitch() } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: {
                  $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
                },
                total: { $sum: 1 },
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
              },
            },
          ],
        },
      },
    ]);
    const [doc] = await cursor.toArray();
    const totals = doc?.totals?.[0];
    if (!totals || !totals.total) return null;
    return {
      name,
      totals: { ...totals, winRate: totals.total ? totals.wins / totals.total : 0 },
      byMatchup: addWinRates(doc.byMatchup || []),
      byMap: addWinRates(doc.byMap || []),
      byStrategy: addWinRates(doc.byStrategy || []),
      recent: doc.recent || [],
    };
  }

  /**
   * Detected opponent strategies sorted by frequency.
   *
   * @param {string} userId
   * @param {object} filters
   */
  async oppStrategies(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    return this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $group: {
            _id: { $ifNull: ["$opponent.strategy", "Unknown"] },
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
            winRate: {
              $cond: [{ $gt: ["$total", 0] }, { $divide: ["$wins", "$total"] }, 0],
            },
          },
        },
        { $sort: { total: -1 } },
      ])
      .toArray();
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

module.exports = { BuildsService };
