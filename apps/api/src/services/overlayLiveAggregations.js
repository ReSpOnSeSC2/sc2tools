"use strict";

const { attachOpponentIdsToFilter } = require("../util/opponentIdentity");

/**
 * Mongo-aggregation helpers backing the OverlayLiveService.
 *
 * Extracted from ``overlayLive.js`` to keep that file under the
 * project's 800-line ceiling. Each function takes the games /
 * opponents collections explicitly so the helpers stay testable in
 * isolation; the ``OverlayLiveService`` class methods remain the
 * public surface and delegate here.
 *
 * The aggregations themselves are unchanged — same pipelines, same
 * projections, same identity-precedence rules.
 */

function bucketResult(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "win";
  if (s === "loss" || s === "defeat") return "loss";
  return null;
}

/**
 * Format a duration in seconds as `m:ss`. Matches the SPA's
 * `formatMatchDuration` for the scouting card's recent-games list.
 *
 * @param {number} sec
 * @returns {string}
 */
function formatLengthText(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Title-case an internal result tag for the scouting widget's chip
 * text. The SPA stored "Win" / "Loss" / "Tie" — we map the cloud's
 * "Victory" / "Defeat" to those so the widget can stay rendering-only.
 *
 * @param {string|undefined|null} raw
 * @returns {"Win"|"Loss"|"Tie"|null}
 */
function chipResult(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "Win";
  if (s === "loss" || s === "defeat") return "Loss";
  if (s === "tie") return "Tie";
  return null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk the most recent games and report the current win/loss run.
 * Returns null when the streak count is below 3 — the widget hides
 * itself anyway, no point pushing a payload it'll discard.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @returns {Promise<{kind: 'win'|'loss', count: number} | null>}
 */
async function computeStreak(games, userId) {
  const recent = await games
    .find({ userId }, { projection: { _id: 0, result: 1, date: 1 } })
    .sort({ date: -1 })
    .limit(20)
    .toArray()
    .catch(() => []);
  if (recent.length === 0) return null;
  /** @type {'win'|'loss'|null} */
  let kind = null;
  let count = 0;
  for (const r of recent) {
    const b = bucketResult(r.result);
    if (!b) continue;
    if (kind === null) {
      kind = b;
      count = 1;
      continue;
    }
    if (b !== kind) break;
    count += 1;
  }
  if (kind && count >= 3) return { kind, count };
  return null;
}

/**
 * Find the most recently dated game (other than ``excludeGameId``)
 * for this user that carries a numeric ``myMmr``. Used to compute the
 * MMR delta for the just-uploaded game.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} [excludeGameId]
 * @param {Date|string} [beforeDate]
 * @returns {Promise<number|null>}
 */
async function previousGameMmr(games, userId, excludeGameId, beforeDate) {
  /** @type {Record<string, any>} */
  const filter = {
    userId,
    myMmr: { $type: "number" },
  };
  if (excludeGameId) filter.gameId = { $ne: excludeGameId };
  if (beforeDate) {
    const d = beforeDate instanceof Date ? beforeDate : new Date(beforeDate);
    if (!Number.isNaN(d.getTime())) filter.date = { $lte: d };
  }
  const prev = await games
    .find(filter, { projection: { _id: 0, myMmr: 1, date: 1 } })
    .sort({ date: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);
  if (prev.length === 0) return null;
  const m = Number(prev[0].myMmr);
  return Number.isFinite(m) ? m : null;
}

/**
 * Last N games against this opponent in this matchup, newest first.
 * Excludes the just-uploaded game so the scouting widget shows
 * *prior* meetings — the current game is what the streamer is about
 * to play, surfaced through the match-result/post-game widgets.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {Record<string, any>} opp
 * @param {string|undefined} myRace
 * @param {string|undefined} oppRace
 * @param {string|undefined} excludeGameId
 */
async function recentGamesForOpponent(games, userId, opp, myRace, oppRace, excludeGameId) {
  if (!opp) return [];
  /** @type {Record<string, any>} */
  const filter = { userId };
  const attached = attachOpponentIdsToFilter(filter, {
    pulseId: opp.pulseId,
    pulseCharacterId: opp.pulseCharacterId,
  });
  if (!attached) {
    if (opp.displayName) {
      filter["opponent.displayName"] = opp.displayName;
    } else {
      return [];
    }
  }
  if (excludeGameId) filter.gameId = { $ne: excludeGameId };
  if (myRace) {
    filter.myRace = { $regex: `^${escapeRegex(String(myRace).charAt(0))}`, $options: "i" };
  }
  if (oppRace) {
    filter["opponent.race"] = {
      $regex: `^${escapeRegex(String(oppRace).charAt(0))}`,
      $options: "i",
    };
  }
  const rows = await games
    .find(filter, {
      projection: {
        _id: 0,
        result: 1,
        durationSec: 1,
        map: 1,
        myBuild: 1,
        "opponent.strategy": 1,
        "opponent.race": 1,
        date: 1,
      },
    })
    .sort({ date: -1 })
    .limit(5)
    .toArray()
    .catch(() => []);
  /** @type {Array<{result: 'Win'|'Loss'|'Tie', lengthText: string, map?: string, myBuild?: string, oppBuild?: string, oppRace?: string, date?: string}>} */
  const out = [];
  for (const r of rows) {
    const chip = chipResult(r.result);
    if (!chip) continue;
    /** @type {{result: 'Win'|'Loss'|'Tie', lengthText: string, map?: string, myBuild?: string, oppBuild?: string, oppRace?: string, date?: string}} */
    const row = {
      result: chip,
      lengthText: formatLengthText(Number(r.durationSec) || 0),
    };
    if (r.map) row.map = String(r.map);
    if (r.myBuild) row.myBuild = String(r.myBuild);
    if (r.opponent && r.opponent.strategy) row.oppBuild = String(r.opponent.strategy);
    if (r.opponent && r.opponent.race) row.oppRace = String(r.opponent.race);
    if (r.date instanceof Date) row.date = r.date.toISOString();
    else if (typeof r.date === "string") row.date = r.date;
    out.push(row);
  }
  return out;
}

/**
 * Top ``myBuild`` rows for a matchup, sorted by total games.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} myRace
 * @param {string} oppRace
 */
async function topBuildsForMatchup(games, userId, myRace, oppRace) {
  if (!myRace || !oppRace) return [];
  const myInitial = String(myRace).charAt(0).toUpperCase();
  const oppInitial = String(oppRace).charAt(0).toUpperCase();
  /** @type {any[]} */
  const pipeline = [
    {
      $match: {
        userId,
        myBuild: { $type: "string", $ne: "" },
        $expr: {
          $and: [
            { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, myInitial] },
            { $eq: [{ $toUpper: { $substrCP: ["$opponent.race", 0, 1] } }, oppInitial] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$myBuild",
        wins: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] },
              1,
              0,
            ],
          },
        },
        total: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 3 },
  ];
  const rows = await games.aggregate(pipeline).toArray().catch(() => []);
  return rows.map((r) => ({
    name: String(r._id),
    total: r.total || 0,
    winRate: r.total > 0 ? (r.wins || 0) / r.total : 0,
  }));
}

/**
 * Streamer's best ``myBuild`` against a specific opponent strategy
 * inside a matchup. Used by the "Best Answer" widget.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} myRace
 * @param {string} oppRace
 * @param {string} strategy
 */
async function bestAnswerVsStrategy(games, userId, myRace, oppRace, strategy) {
  if (!strategy) return null;
  const myInitial = String(myRace).charAt(0).toUpperCase();
  const oppInitial = String(oppRace).charAt(0).toUpperCase();
  /** @type {any[]} */
  const pipeline = [
    {
      $match: {
        userId,
        myBuild: { $type: "string", $ne: "" },
        "opponent.strategy": strategy,
        $expr: {
          $and: [
            { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, myInitial] },
            { $eq: [{ $toUpper: { $substrCP: ["$opponent.race", 0, 1] } }, oppInitial] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$myBuild",
        wins: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] },
              1,
              0,
            ],
          },
        },
        total: { $sum: 1 },
      },
    },
    // 3-game floor protects against "100% in a 1-game sample" noise.
    { $match: { total: { $gte: 3 } } },
    { $sort: { wins: -1, total: -1 } },
    { $limit: 1 },
  ];
  const rows = await games.aggregate(pipeline).toArray().catch(() => []);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    build: String(r._id),
    total: r.total || 0,
    winRate: r.total > 0 ? (r.wins || 0) / r.total : 0,
  };
}

/**
 * Top opening shares (by share-of-encounters) the streamer has seen
 * from opponents in this matchup. Used by the "Meta snapshot" widget.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} myRace
 * @param {string} oppRace
 */
async function metaForMatchup(games, userId, myRace, oppRace) {
  if (!myRace || !oppRace) return [];
  const myInitial = String(myRace).charAt(0).toUpperCase();
  const oppInitial = String(oppRace).charAt(0).toUpperCase();
  /** @type {any[]} */
  const pipeline = [
    {
      $match: {
        userId,
        "opponent.strategy": { $type: "string", $ne: "" },
        $expr: {
          $and: [
            { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, myInitial] },
            { $eq: [{ $toUpper: { $substrCP: ["$opponent.race", 0, 1] } }, oppInitial] },
          ],
        },
      },
    },
    { $group: { _id: "$opponent.strategy", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ];
  const rows = await games.aggregate(pipeline).toArray().catch(() => []);
  if (rows.length === 0) return [];
  const total = rows.reduce((acc, r) => acc + (r.count || 0), 0);
  if (total === 0) return [];
  return rows.map((r) => ({
    name: String(r._id),
    share: (r.count || 0) / total,
  }));
}

module.exports = {
  bucketResult,
  chipResult,
  formatLengthText,
  escapeRegex,
  computeStreak,
  previousGameMmr,
  recentGamesForOpponent,
  topBuildsForMatchup,
  bestAnswerVsStrategy,
  metaForMatchup,
};
