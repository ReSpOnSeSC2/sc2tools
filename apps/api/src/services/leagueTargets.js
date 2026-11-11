"use strict";

const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");
const { isPlausibleMmr } = require("../util/leagueBands");
const { eraForGame } = require("../util/patchEra");
const { extractMilestones } = require("./guideSamples");
const { personalTimingSummary, PERSONAL_LIMIT } = require("./leagueTimingPercentiles");

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
 *   - current MMR: the latest replay-recorded rating for the matchup's
 *     ladder race, with its region;
 *   - average net MMR per game over the last NET_MMR_GAMES games of that
 *     account and ladder race, by trendsNetMmr.js's pairing rules (adjacent
 *     replay-recorded ratings, a swing of at most NET_MMR_MAX_DELTA, and a
 *     change whose sign agrees with the result);
 *   - timing medians from the same recent ranked games' own build logs,
 *     restricted to the newest game's era. They use the guide milestone
 *     definitions whether or not those games qualify for guide sampling.
 */

const RECENT_LIMIT = 100;
const NET_MMR_GAMES = 30;
const NET_MMR_MAX_DELTA = 150;
const QUERY_MAX_TIME_MS = 3000;
const METRICS = Object.freeze(["spq", "macroScore", "apm", "durationSec"]);
const RACE_MATCH = Object.freeze({ P: /^(P|Protoss)$/i, T: /^(T|Terran)$/i, Z: /^(Z|Zerg)$/i });
const RANDOM_RACE = /^(R|Random)$/i;
const ONE_V_ONE = Object.freeze({ $or: [{ matchFormat: "1v1" }, { matchFormat: { $exists: false }, playerCount: 2 }] });

/** @param {unknown} raw @returns {"P"|"T"|"Z"|null} */
function raceLetter(raw) {
  const race = typeof raw === "string" ? raw.trim() : "";
  return /** @type {"P"|"T"|"Z"|undefined} */ (Object.keys(RACE_MATCH).find((key) => RACE_MATCH[/** @type {"P"|"T"|"Z"} */ (key)].test(race))) ?? null;
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
function ladderRaceOf(row) {
  const race = row.myLadderRace ?? row.myRace;
  return typeof race === "string" && RANDOM_RACE.test(race.trim()) ? "R" : raceLetter(race);
}

/** The newest matching replay determines whether the concrete matchup was
 * played on its fixed-race ladder or on Random. Older rows may lack the
 * selected race, so ladderRaceOf uses the existing played-race fallback.
 * @param {Record<string, any>[]} rows @param {string|null} matchup */
function ratingRaceForMatchup(rows, matchup) {
  if (!matchup) return null;
  const mine = matchup[0];
  for (const row of rows) {
    if (matchupOf(row) !== matchup) continue;
    const race = ladderRaceOf(row);
    if (race === mine || race === "R") return race;
  }
  return mine;
}

/** @param {Record<string, any>} row */
function partitionKey(row) {
  const race = ladderRaceOf(row);
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
  const anchor = rows.find((row) => trustedMmr(row) !== null);
  const key = anchor && partitionKey(anchor);
  if (!key) return { pairs: 0, games: 0, perGame: null, window: NET_MMR_GAMES };
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

/** @param {Record<string,any>[]} rows @param {string} matchup
 * @param {string} userId @param {Pick<import('./gameDetails').GameDetailsService,'findMany'>} details */
async function personalTimings(rows, matchup, userId, details) {
  const era = eraForGame(rows[0] || {});
  const selected = era ? rows.filter((row) => eraForGame(row) === era) : [];
  const ids = selected.filter((row) => !Array.isArray(row.buildLog)).map((row) => row.gameId);
  const logs = ids.length ? await details.findMany(userId, ids, { fields: ["buildLog"], concurrency: 2 }) : new Map();
  const milestones = selected.flatMap((row) => {
    const ownLog = Array.isArray(row.buildLog) ? row.buildLog : logs.get(row.gameId)?.buildLog;
    const extracted = extractMilestones(ownLog, /** @type {"P"|"T"|"Z"} */ (matchup[0]));
    return extracted ? [extracted] : [];
  });
  return personalTimingSummary(matchup, era, milestones);
}

class LeagueTargetsService {
  /**
   * @param {{ games: import('mongodb').Collection }} db
   * @param {Pick<import('./gameDetails').GameDetailsService,'findMany'>} gameDetails
   */
  constructor(db, gameDetails) {
    this.games = db.games;
    this.gameDetails = gameDetails;
  }

  /**
   * @param {string} userId
   * @param {unknown} requestedMatchup
   * @param {boolean} [includeTimings]
   */
  async personal(userId, requestedMatchup, includeTimings = true) {
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
    const ladderRace = ratingRaceForMatchup(recent, matchup);
    const ratingRows = ladderRace ? recent.filter((row) => ladderRaceOf(row) === ladderRace) : [];
    const latest = ratingRows.find((row) => trustedMmr(row) !== null);
    const mmr = {
      current: latest ? trustedMmr(latest) : null,
      at: latest?.date instanceof Date ? latest.date.toISOString() : null,
      region: latest ? regionFromToonHandle(latest.myToonHandle) : null,
      ladderRace,
    };
    const mine = /** @type {"P"|"T"|"Z"} */ (matchup?.[0]);
    const theirs = /** @type {"P"|"T"|"Z"} */ (matchup?.[2]);
    const timingFields = includeTimings ? { gameId: 1, date: 1, gameBuild: 1, gameVersion: 1, buildLog: 1 } : {};
    const rows = matchup ? await this.games.find({ ...base, myRace: RACE_MATCH[mine], "opponent.race": RACE_MATCH[theirs] }, {
      projection: { _id: 0, spq: 1, macroScore: 1, apm: 1, durationSec: 1, ...timingFields }, maxTimeMS: QUERY_MAX_TIME_MS,
    }).sort({ date: -1, _id: -1 }).limit(PERSONAL_LIMIT).toArray() : [];
    const timings = matchup && includeTimings ? await personalTimings(rows, matchup, userId, this.gameDetails) : null;
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
      netMmr: netMmrPerGame(ratingRows),
      timings,
    };
  }
}

module.exports = { LeagueTargetsService, netMmrPerGame, PERSONAL_LIMIT, NET_MMR_GAMES };
