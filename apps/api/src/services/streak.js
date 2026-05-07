"use strict";

const { gamesMatchStage } = require("../util/parseQuery");

// Hard ceiling on the streak walk. A streak that genuinely runs longer
// than this is rare, and pulling 1k slim docs is the cap we accept on
// the current-streak hot path.
const STREAK_SCAN_LIMIT = 1000;

/**
 * StreakService — surfaces the user's current consecutive same-result
 * streak, computed at game-level (not day-level).
 *
 * Why this lives outside ``AggregationsService``:
 *   1. The aggregations file is already at the per-file size budget.
 *   2. Streak is a tiny, focused concern — a separate module keeps the
 *      pipeline obvious and the unit test surface narrow.
 *   3. Day-bucketed aggregations break streak math whenever a single
 *      day mixes wins and losses (which is most days for any active
 *      ladder player). The previous client-side reducer in
 *      ``DashboardKpiStrip`` walked /v1/timeseries day buckets and
 *      treated a mixed day as a hard break — so an 8-game day with one
 *      flip dropped the displayed streak to 0 even when the user was
 *      mid-streak. Walking individual games server-side is the only
 *      correct fix.
 */
class StreakService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Current win/loss streak across the user's filtered game history.
   *
   * Returns ``count: 0`` (and ``kind: null``) when the user has no
   * games yet, when every game in the filtered window is a tie, or
   * when the most recent game is a tie. The dashboard renders the
   * placeholder dash in those cases — the empty-state copy lives on
   * the client.
   *
   * @param {string} userId
   * @param {object} [filters]
   * @returns {Promise<{
   *   kind: 'win' | 'loss' | null,
   *   count: number,
   *   lastGameAt: string | null,
   * }>}
   */
  async current(userId, filters = {}) {
    const match = gamesMatchStage(userId, filters || {});
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        { $sort: { date: -1 } },
        { $limit: STREAK_SCAN_LIMIT },
        {
          $project: {
            _id: 0,
            result: { $ifNull: ["$result", ""] },
            date: 1,
          },
        },
      ])
      .toArray();
    return walkStreak(rows);
  }
}

/**
 * Walk pre-sorted (newest-first) game rows and count the consecutive
 * same-result trail. Ties (anything that isn't a win/loss) are skipped
 * because a tie shouldn't break a streak — it's not a real outcome.
 *
 * Exported for unit testing without spinning up Mongo.
 *
 * @param {Array<{result?: string|null, date?: Date|string|null}>} rows
 * @returns {{ kind: 'win'|'loss'|null, count: number, lastGameAt: string|null }}
 */
function walkStreak(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { kind: null, count: 0, lastGameAt: null };
  }
  /** @type {'win' | 'loss' | null} */
  let kind = null;
  let count = 0;
  /** @type {string | null} */
  let lastGameAt = null;
  for (const row of rows) {
    const tag = bucket(row && row.result);
    if (!tag) continue;
    if (kind === null) {
      kind = tag;
      count = 1;
      lastGameAt = isoDate(row.date);
      continue;
    }
    if (tag !== kind) break;
    count += 1;
  }
  return { kind, count, lastGameAt };
}

/** @param {unknown} raw @returns {'win' | 'loss' | null} */
function bucket(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s === "win" || s === "victory") return "win";
  if (s === "loss" || s === "defeat") return "loss";
  return null;
}

/** @param {Date | string | null | undefined} raw */
function isoDate(raw) {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

module.exports = { StreakService, walkStreak, STREAK_SCAN_LIMIT };
