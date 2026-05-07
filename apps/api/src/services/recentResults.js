"use strict";

const { gamesMatchStage } = require("../util/parseQuery");

const RECENT_RESULTS_PER_BUCKET = 10;

/**
 * Per-bucket "form sparkline" attachment helpers used by the maps and
 * matchups aggregations. Both surfaces want the same `recent: ('win'|
 * 'loss')[]` field on every row, computed as the last N decided games
 * inside each bucket newest-first.
 *
 * Sharing the helpers keeps the SQL-style query off the AggregationsService
 * (which is at the per-file size budget), and lets ``SpatialService.maps``
 * reuse the exact same shape so the SPA's Map Intel and Battlefield tabs
 * agree on what "recent" means.
 */

/**
 * Attach `recent[]` to each row, grouping the user's filtered games by
 * matchup label ("vs P", "vs Z", ...).
 *
 * @param {{games: import('mongodb').Collection}} db
 * @param {string} userId
 * @param {object} filters
 * @param {Array<{name: string} & Record<string, any>>} rows
 */
async function attachRecentByMatchup(db, userId, filters, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const match = gamesMatchStage(userId, filters);
  const grouped = await db.games
    .aggregate([
      { $match: match },
      { $sort: { date: -1 } },
      {
        $project: {
          _id: 0,
          result: 1,
          matchup: matchupLabelExpr(),
        },
      },
      {
        $group: {
          _id: "$matchup",
          results: { $push: "$result" },
        },
      },
    ])
    .toArray();
  return mergeRecent(rows, grouped);
}

/**
 * Attach `recent[]` to each row, grouping the user's filtered games by
 * map name (using "Unknown" for games with no map field, mirroring the
 * grouping used by mapFacet / spatial.maps).
 *
 * @param {{games: import('mongodb').Collection}} db
 * @param {string} userId
 * @param {object} filters
 * @param {Array<{name: string} & Record<string, any>>} rows
 */
async function attachRecentByMap(db, userId, filters, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const match = gamesMatchStage(userId, filters);
  const grouped = await db.games
    .aggregate([
      { $match: match },
      { $sort: { date: -1 } },
      {
        $project: {
          _id: 0,
          result: 1,
          mapName: { $ifNull: ["$map", "Unknown"] },
        },
      },
      {
        $group: {
          _id: "$mapName",
          results: { $push: "$result" },
        },
      },
    ])
    .toArray();
  return mergeRecent(rows, grouped);
}

/**
 * Build the matchup label expression used by both /v1/matchups and
 * the recent attachment for matchups, so they group by the same key.
 *
 * @returns {object}
 */
function matchupLabelExpr() {
  return {
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
  };
}

/**
 * Merge a `[{ _id, results }]` group output back onto the original rows
 * by `name`. Bucketed results are normalised to `'win' | 'loss'` and
 * truncated to the per-bucket cap (oldest dropped first).
 *
 * @param {Array<{name: string} & Record<string, any>>} rows
 * @param {Array<{_id?: string, results?: any[]}>} grouped
 */
function mergeRecent(rows, grouped) {
  /** @type {Map<string, Array<'win' | 'loss'>>} */
  const byName = new Map();
  for (const r of grouped || []) {
    if (!r || !Array.isArray(r.results)) continue;
    /** @type {Array<'win' | 'loss'>} */
    const out = [];
    for (const raw of r.results) {
      const tag = bucket(raw);
      if (!tag) continue;
      out.push(tag);
      if (out.length >= RECENT_RESULTS_PER_BUCKET) break;
    }
    if (typeof r._id === "string") byName.set(r._id, out);
  }
  return rows.map((row) => ({
    ...row,
    recent: byName.get(row.name) || [],
  }));
}

/** @param {unknown} raw @returns {'win' | 'loss' | null} */
function bucket(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s === "win" || s === "victory") return "win";
  if (s === "loss" || s === "defeat") return "loss";
  return null;
}

module.exports = {
  RECENT_RESULTS_PER_BUCKET,
  attachRecentByMatchup,
  attachRecentByMap,
  matchupLabelExpr,
  mergeRecent,
};
