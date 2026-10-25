"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { navigationIdentity } = require("./gameNeighbors");
const { overrideActive, BUILD_INTENT_LABEL_PROJECTION } = require("./buildIntentShape");
const { MIN_SAMPLE } = require("./leaguePercentiles");

const METRICS = Object.freeze(["macroScore", "apm", "spq", "durationSec"]);
const PERSONAL_LIMIT = 50;
const TIMING_LIMIT = 25;
const TIMING_MIN_SAMPLE = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 200;
const TIMING_CACHE_LIMIT = 1000;
const MAX_CONTEXT_WORK = 4;
const CONTEXT_INDEX = Object.freeze({ userId: 1, date: -1, _id: -1 });
const TOWNHALL = Object.freeze({ P: "Nexus", T: "CommandCenter", Z: "Hatchery" });
const RACE_MATCH = Object.freeze({ P: /^(P|Protoss)$/i, T: /^(T|Terran)$/i, Z: /^(Z|Zerg)$/i });
const CURRENT_FIELDS = Object.freeze({ _id: 0, gameId: 1, date: 1, myRace: 1, myBuild: 1,
  _customBuildSlug: 1, "opponent.race": 1, "opponent.leagueId": 1,
  macroScore: 1, apm: 1, spq: 1, durationSec: 1, ...BUILD_INTENT_LABEL_PROJECTION });

/** @param {unknown} raw @returns {'P'|'T'|'Z'|null} */
function raceLetter(raw) {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^(P|PROTOSS|T|TERRAN|Z|ZERG)$/.test(value) ? /** @type {'P'|'T'|'Z'} */ (value[0]) : null;
}

/** @param {unknown} raw */
function finite(raw) { return typeof raw === "number" && Number.isFinite(raw) ? raw : null; }

/** One owner's earlier ranked 1v1s; missing canonical ladder flags stay out.
 * @param {string} userId @param {Record<string,any>} current */
function priorMatch(userId, current) {
  const mine = raceLetter(current.myRace), theirs = raceLetter(current.opponent?.race);
  if (!mine || !theirs || !(current.date instanceof Date) || !Number.isFinite(current.date.getTime())) return null;
  const match = gamesMatchStage(userId, { mapPool: "ladder", gameSize: "1v1", until: current.date });
  // Upload race strings are bounded but not enum-constrained. Prefix filters
  // alone would count arbitrary legacy values such as "Psionic" as Protoss.
  match.myRace = RACE_MATCH[mine];
  match["opponent.race"] = RACE_MATCH[theirs];
  return match;
}

/** @param {Record<string,any>} match */
function personalPipeline(match) {
  /** @type {Record<string,any>} */
  const group = { _id: null, n: { $sum: 1 } };
  for (const metric of METRICS) {
    group[metric] = { $percentile: { input: `$${metric}`, p: [0.25, 0.5, 0.75], method: "approximate" } };
    group[`${metric}_n`] = { $sum: { $cond: [{ $isNumber: `$${metric}` }, 1, 0] } };
  }
  return [{ $match: match }, { $sort: { date: -1, _id: -1 } }, { $limit: PERSONAL_LIMIT },
    { $project: { macroScore: 1, apm: 1, spq: 1, durationSec: 1 } }, { $group: group }];
}

/** @param {Record<string,any>|undefined} row */
function personalShape(row) {
  /** @type {Record<string,any>} */
  const metrics = {};
  for (const metric of METRICS) {
    const values = row?.[metric];
    const n = row?.[`${metric}_n`] ?? 0;
    metrics[metric] = { n, median: n ? finite(values?.[1]) : null,
      p25: n ? finite(values?.[0]) : null, p75: n ? finite(values?.[2]) : null };
  }
  return { n: row?.n ?? 0, limit: PERSONAL_LIMIT, metrics };
}

/** Keep only the first constructed natural, matching the autopsy's 10s
 * starting-base exclusion. Raw logs are discarded after each bounded read.
 * @param {unknown} log @param {string} townhall */
function naturalSeconds(log, townhall) {
  if (!Array.isArray(log)) return null;
  let first = Infinity;
  for (const line of log) {
    if (typeof line !== "string") continue;
    const m = /^\[(\d+):(\d{2})\]\s+(\w+)/.exec(line);
    if (!m || m[3] !== townhall || Number(m[2]) >= 60) continue;
    const seconds = Number(m[1]) * 60 + Number(m[2]);
    if (seconds > 10 && seconds < first) first = seconds;
  }
  return Number.isFinite(first) ? first : null;
}

/** @param {number[]} values */
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

class GameContextService {
  /** @param {{games:import('mongodb').Collection}} db
   * @param {{leaguePercentiles:import('./leaguePercentiles').LeaguePercentilesService,
   * gameDetails?:import('./gameDetails').GameDetailsService, now?:()=>number}} opts */
  constructor(db, opts) {
    this.db = db;
    this.leaguePercentiles = opts.leaguePercentiles;
    this.gameDetails = opts.gameDetails;
    this.now = opts.now || Date.now;
    /** @type {Map<string,{at:number,value:Record<string,any>}>} */
    this.cache = new Map();
    /** @type {Map<string,{at:number,value:number|null}>} Natural scalars only;
     * neighboring game pages reuse overlapping samples without rereading R2. */
    this.timingCache = new Map();
    /** @type {Map<string,Promise<Record<string,any>>>} */
    this.inflight = new Map();
  }

  /** The owner lookup always precedes cache access, including after erasure.
   * @param {string} userId @param {string} gameId */
  async get(userId, gameId) {
    const owner = navigationIdentity(userId), id = navigationIdentity(gameId);
    if (!owner || !id) return null;
    const current = await this.db.games.findOne({ userId: owner, gameId: id, isResumedFromReplay: { $ne: true } }, { projection: CURRENT_FIELDS });
    if (!current) return null;
    const match = priorMatch(owner, current);
    const mine = raceLetter(current.myRace), theirs = raceLetter(current.opponent?.race);
    const matchup = mine && theirs ? `${mine}v${theirs}` : null;
    // A check-in's effective label owns the cohort, even when detection differs.
    const build = overrideActive(current) ? current.buildIntent.build : { name: current.myBuild, slug: current._customBuildSlug };
    const key = JSON.stringify([owner, id, current.date, current.myRace, current.opponent?.race,
      build?.name, build?.slug, current.opponent?.leagueId,
      ...METRICS.map((metric) => current[metric])]);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.inflight.size >= MAX_CONTEXT_WORK) throw Object.assign(new Error("Game comparisons are busy; try again shortly."), { status: 503, code: "game_context_busy" });
    const work = this.compute(owner, current, match, matchup, build).then((value) => {
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value || "");
      this.cache.set(key, { at: this.now(), value });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /** @param {string} owner @param {Record<string,any>} current
   * @param {Record<string,any>|null} match @param {string|null} matchup
   * @param {{name?:unknown,slug?:unknown}|null} build */
  async compute(owner, current, match, matchup, build) {
    // Strictly earlier: the current replay and later uploads never teach its baseline.
    if (match) match.date = { $lt: current.date };
    const tablePromise = matchup ? this.leaguePercentiles.lookup({ leagueId: current.opponent?.leagueId, matchup }) : Promise.resolve(null);
    const rowsPromise = match ? this.db.games.aggregate(personalPipeline(match), { hint: CONTEXT_INDEX, maxTimeMS: 5000 }).toArray() : Promise.resolve([]);
    const [table, rows, expansion] = await Promise.all([tablePromise, rowsPromise, this.expansions(owner, current, match, build)]);
    /** @type {Record<string,number|null>} */
    const percentiles = {};
    for (const metric of METRICS) percentiles[metric] = table ? this.leaguePercentiles.percentileOf(table, metric, current[metric]) : null;
    return { matchup, personal: { ...personalShape(rows[0]), expansionTimings: expansion.timings,
      expansionSample: expansion.n, expansionLimit: TIMING_LIMIT, expansionMinSample: TIMING_MIN_SAMPLE, build: typeof build?.name === "string" ? build.name : null },
    league: table && table.n >= MIN_SAMPLE ? { table, percentiles } : null };
  }

  /** Bounded dossier-style timing sample. One projected detail at a time, no
   * opponent logs, corpus scans, or full dossier/count aggregations.
   * @param {string} owner @param {Record<string,any>} current
   * @param {Record<string,any>|null} match @param {{name?:unknown,slug?:unknown}|null} build */
  async expansions(owner, current, match, build) {
    const townhall = /** @type {Record<string,string>} */ (TOWNHALL)[raceLetter(current.myRace) || ""];
    const name = navigationIdentity(build?.name), slug = navigationIdentity(build?.slug);
    if (!match || !townhall || !name) return { timings: {}, n: 0 };
    const candidates = await this.db.games.find({ ...match, ...(slug ? { _customBuildSlug: slug } : { myBuild: name, _customBuildSlug: { $in: [null, ""] } }) }, {
      projection: { _id: 0, gameId: 1 }, hint: CONTEXT_INDEX, maxTimeMS: 5000,
    }).sort({ date: -1, _id: -1 }).limit(TIMING_LIMIT).toArray();
    const values = [];
    for (const game of candidates) {
      const id = navigationIdentity(game.gameId);
      if (!id) continue;
      const key = JSON.stringify([owner, id, townhall]);
      const hit = this.timingCache.get(key);
      if (hit && this.now() - hit.at < CACHE_TTL_MS) {
        if (hit.value !== null) values.push(hit.value);
        continue;
      }
      const detail = this.gameDetails ? await this.gameDetails.findMany(owner, [id], { fields: ["buildLog"], concurrency: 1 }) : new Map();
      let log = detail.get(id)?.buildLog;
      if (!Array.isArray(log)) log = (await this.db.games.findOne({ userId: owner, gameId: id }, { projection: { _id: 0, buildLog: 1 } }))?.buildLog;
      const value = naturalSeconds(log, townhall);
      if (this.timingCache.size >= TIMING_CACHE_LIMIT) this.timingCache.delete(this.timingCache.keys().next().value || "");
      this.timingCache.set(key, { at: this.now(), value });
      if (value !== null) values.push(value);
    }
    return { timings: values.length >= TIMING_MIN_SAMPLE ? { [townhall]: median(values) } : {}, n: values.length };
  }
}

module.exports = { GameContextService, personalPipeline, naturalSeconds, PERSONAL_LIMIT, TIMING_LIMIT, TIMING_MIN_SAMPLE };
