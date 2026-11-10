"use strict";

const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");
const { isPlausibleMmr } = require("../util/leagueBands");

/**
 * The personal half of the Macro tab's Targets card (GET
 * /v1/benchmarks/targets). The league half is the cross-user aggregates
 * (/v1/benchmarks, /v1/benchmarks/timings); this service reads only the
 * signed-in player's own rows:
 *
 *   - matchup: the requested one, else the most played of the last
 *     RECENT_LIMIT ranked 1v1 games (with the counts, for a switcher);
 *   - medians of SQ, macro score, APM and game length over the last
 *     PERSONAL_LIMIT ranked 1v1 games in that matchup (slim rows);
 *   - current MMR: the latest replay-recorded rating, with its region;
 *   - average net MMR per game over the last NET_MMR_GAMES games of that
 *     account and ladder race, by trendsNetMmr.js's pairing rules (adjacent
 *     replay-recorded ratings, a swing of at most NET_MMR_MAX_DELTA, and a
 *     change whose sign agrees with the result);
 *   - own timing medians from the player's own guide samples, which is the
 *     same extraction as the league timing tables.
 *
 * Three bounded indexed reads; nothing is cached or written.
 */

const RECENT_LIMIT = 100;
const PERSONAL_LIMIT = 20;
const NET_MMR_GAMES = 30;
const NET_MMR_MAX_DELTA = 150;
const QUERY_MAX_TIME_MS = 3000;
const METRICS = Object.freeze(["spq", "macroScore", "apm", "durationSec"]);
const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);
const ONE_V_ONE = Object.freeze({ $or: [{ matchFormat: "1v1" }, { matchFormat: { $exists: false }, playerCount: 2 }] });

/** @param {unknown} raw @returns {"P"|"T"|"Z"|null} */
function raceLetter(raw) {
  const letter = typeof raw === "string" ? raw.trim().slice(0, 1).toUpperCase() : "";
  return RACE_LETTERS.includes(letter) ? /** @type {"P"|"T"|"Z"} */ (letter) : null;
}

/** @param {unknown} raw @returns {string | null} */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const m = /^([ptz])v([ptz])$/i.exec(raw.trim());
  return m ? `${m[1].toUpperCase()}v${m[2].toUpperCase()}` : null;
}

/** @param {Record<string, any>} row */
function matchupOf(row) {
  const mine = raceLetter(row.myRace);
  const theirs = raceLetter(row.opponent?.race);
  return mine && theirs ? `${mine}v${theirs}` : null;
}

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

/** @param {unknown} raw */
function resultSign(raw) {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value === "victory" || value === "win") return 1;
  if (value === "defeat" || value === "loss") return -1;
  return 0;
}

/** @param {Record<string, any>} row */
function trustedMmr(row) {
  return row.myMmrSource === "replay" && isPlausibleMmr(row.myMmr) ? /** @type {number} */ (row.myMmr) : null;
}

/** @param {Record<string, any>} row */
function partitionKey(row) {
  const race = raceLetter(row.myLadderRace ?? row.myRace);
  return typeof row.myToonHandle === "string" && row.myToonHandle && race ? `${row.myToonHandle}|${race}` : null;
}

/**
 * Average net MMR per game over the newest ``NET_MMR_GAMES`` rows of the
 * latest rated partition. ``rows`` are newest first.
 *
 * Example: ratings 4000 → 4020 (win) → 4004 (loss) → +2 per game over 2 pairs.
 *
 * @param {Record<string, any>[]} rows
 */
function netMmrPerGame(rows) {
  const anchor = rows.find((row) => trustedMmr(row) !== null && partitionKey(row));
  if (!anchor) return { pairs: 0, games: 0, perGame: null, window: NET_MMR_GAMES };
  const key = partitionKey(anchor);
  const chain = rows.filter((row) => partitionKey(row) === key).slice(0, NET_MMR_GAMES + 1).reverse();
  let pairs = 0;
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const before = trustedMmr(chain[i]);
    const after = trustedMmr(chain[i + 1]);
    const sign = resultSign(chain[i].result);
    if (before === null || after === null || sign === 0) continue;
    const delta = after - before;
    if (Math.abs(delta) > NET_MMR_MAX_DELTA) continue;
    // A win cannot lower, and a loss cannot raise, the next replay's rating.
    if ((sign > 0 && delta < 0) || (sign < 0 && delta > 0)) continue;
    pairs += 1;
    total += delta;
  }
  return {
    pairs,
    games: Math.max(0, chain.length - 1),
    perGame: pairs > 0 ? Math.round((total / pairs) * 10) / 10 : null,
    window: NET_MMR_GAMES,
  };
}

class LeagueTargetsService {
  /**
   * @param {{ games: import('mongodb').Collection }} db
   * @param {{
   *   timings: Pick<import('./leagueTimingPercentiles').LeagueTimingPercentilesService, "personal">,
   *   userHash: (userId: string) => string,
   * }} deps
   */
  constructor(db, deps) {
    this.games = db.games;
    this.timings = deps.timings;
    this.userHash = deps.userHash;
  }

  /**
   * @param {string} userId
   * @param {unknown} requestedMatchup
   */
  async personal(userId, requestedMatchup) {
    const base = { userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true }, isLadderGame: true, $and: [ONE_V_ONE] };
    const recent = await this.games.find(base, {
      projection: { _id: 0, date: 1, result: 1, myRace: 1, myLadderRace: 1, "opponent.race": 1, myMmr: 1,
        myMmrSource: 1, myToonHandle: 1 },
      maxTimeMS: QUERY_MAX_TIME_MS,
    }).sort({ date: -1, _id: -1 }).limit(RECENT_LIMIT).toArray();
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const row of recent) {
      const mu = matchupOf(row);
      if (mu) counts.set(mu, (counts.get(mu) || 0) + 1);
    }
    const matchups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([matchup, games]) => ({ matchup, games }));
    const matchup = normalizeMatchup(requestedMatchup) || matchups[0]?.matchup || null;
    const latest = recent.find((row) => trustedMmr(row) !== null) || null;
    const mmr = latest
      ? { current: trustedMmr(latest), at: latest.date instanceof Date ? latest.date.toISOString() : null,
        region: regionFromToonHandle(latest.myToonHandle) }
      : { current: null, at: null, region: null };
    const [rows, timings] = matchup
      ? await Promise.all([
        this.games.find({ ...base, myRace: new RegExp(`^${matchup[0]}`, "i"), "opponent.race": new RegExp(`^${matchup[2]}`, "i") }, {
          projection: { _id: 0, spq: 1, macroScore: 1, apm: 1, durationSec: 1 }, maxTimeMS: QUERY_MAX_TIME_MS,
        }).sort({ date: -1, _id: -1 }).limit(PERSONAL_LIMIT).toArray(),
        this.timings.personal(this.userHash(userId), matchup),
      ])
      : [[], null];
    /** @type {Record<string, {n: number, median: number | null}>} */
    const medians = {};
    for (const metric of METRICS) {
      const values = rows.map((row) => row[metric]).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
      medians[metric] = { n: values.length, median: median(values) };
    }
    return {
      matchup,
      matchups,
      sample: { n: rows.length, limit: PERSONAL_LIMIT },
      medians,
      mmr,
      netMmr: netMmrPerGame(recent),
      timings,
    };
  }
}

module.exports = { LeagueTargetsService, netMmrPerGame, PERSONAL_LIMIT, NET_MMR_GAMES };
