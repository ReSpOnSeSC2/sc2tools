"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const {
  parseBucketWidth,
  bucketFor,
  bracketLabel,
} = require("../util/mmrBracketing");

/**
 * SnapshotCohortService — resolves a "cohort" (the comparison set of
 * games to compute percentile bands against) and aggregates per-tick
 * winner / loser bands for the snapshot drilldown view.
 *
 * Cohort resolution walks four tiers in descending specificity. The
 * first tier with at least ``K_ANON_MIN`` games wins. Tier-1 is the
 * tightest comparison ("Protoss Robo Opener vs Zerg Hatch First at
 * 4400-MMR"); tier-4 is the cold-start floor ("all PvZ games at
 * 4400-MMR"). The selected tier ships in the response so the UI can
 * tell the user how specific their comparison is.
 *
 * Bands are computed per (tick, side, metric, result). For each
 * 30-second tick we compute P25 / P50 / P75 / P90 over the winners
 * (and separately the losers) so the chart can show two ribbons.
 * Ticks where neither side has at least ``MIN_TICK_SAMPLES`` games
 * are dropped — anything thinner is too noisy to draw.
 *
 * No-mock contract: every band is computed from real game records in
 * the games + game_details collections; an empty cohort yields a
 * ``cohort_too_small`` error rather than fabricated zero-rows.
 */

const TICK_SECONDS = 30;
const MAX_TICK_SECONDS = 20 * 60;
const NUM_TICKS = MAX_TICK_SECONDS / TICK_SECONDS + 1;
const K_ANON_MIN = 8;
const MIN_TICK_SAMPLES = 6;

const METRICS = Object.freeze([
  "army_value",
  "army_supply",
  "workers",
  "bases",
  "income_min",
  "income_gas",
]);

const BASE_UNITS = Object.freeze({
  P: new Set(["Nexus"]),
  T: new Set(["CommandCenter", "OrbitalCommand", "PlanetaryFortress"]),
  Z: new Set(["Hatchery", "Lair", "Hive"]),
});

class SnapshotCohortService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   snapshotCohorts: import('mongodb').Collection,
   * }} db
   * @param {{
   *   gameDetails: import('./gameDetails').GameDetailsService,
   *   logger?: import('pino').Logger,
   * }} deps
   */
  constructor(db, deps) {
    this.db = db;
    this.gameDetails = deps.gameDetails;
    this.logger = deps.logger;
  }

  /**
   * Resolve the cohort for a query: tries tiers 1→4 until one has
   * enough games to pass the k-anon floor. Returns the cohort key,
   * the tier number, and the matching slim games (no heavy fields
   * loaded — caller does that selectively).
   *
   * @param {{
   *   userId?: string,
   *   scope: 'mine'|'community'|'both',
   *   myBuild?: string,
   *   myRace?: string,
   *   oppRace?: string,
   *   oppOpening?: string,
   *   mmrBucket?: number,
   *   mapId?: string,
   * }} query
   * @returns {Promise<{
   *   cohortKey: string,
   *   cohortTier: 1|2|3|4,
   *   sampleSize: number,
   *   scope: string,
   *   games: Array<object>,
   * } | { cohortKey: string, sampleSize: number, scope: string, tooSmall: true }>}
   */
  async resolveCohort(query) {
    for (const tier of /** @type {(1|2|3|4)[]} */ ([1, 2, 3, 4])) {
      const match = this._matchFor(tier, query);
      if (!match) continue;
      const games = await this.db.games
        .find(match, {
          projection: {
            _id: 0,
            userId: 1,
            gameId: 1,
            result: 1,
            myBuild: 1,
            myRace: 1,
            durationSec: 1,
            map: 1,
            opponent: 1,
            myMmr: 1,
          },
        })
        .limit(2000)
        .toArray();
      if (games.length >= K_ANON_MIN) {
        return {
          cohortKey: canonicalCohortKey(tier, query),
          cohortTier: tier,
          sampleSize: games.length,
          scope: query.scope,
          games,
        };
      }
    }
    return {
      cohortKey: canonicalCohortKey(4, query),
      sampleSize: 0,
      scope: query.scope,
      tooSmall: true,
    };
  }

  /**
   * Aggregate per-tick winner / loser bands across a cohort. Loads
   * the heavy ``macroBreakdown`` blob for each game (batched per
   * user since gameDetails is partitioned by user) and walks every
   * tick to push values onto winner / loser arrays before computing
   * percentiles in O(n log n) per tick.
   *
   * @param {Array<object>} cohortGames slim rows from ``resolveCohort``
   * @returns {Promise<{
   *   ticks: Array<{
   *     t: number,
   *     my: Record<string, BandRow>,
   *     opp: Record<string, BandRow>,
   *   }>,
   * }>}
   */
  async aggregateBands(cohortGames) {
    const detailsByGameId = await this._loadDetails(cohortGames);
    const bins = makeEmptyBins();
    for (const game of cohortGames) {
      const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
      if (!detail || !detail.macroBreakdown) continue;
      const isWin = resultOf(game) === "win";
      const myRace = raceLetter(game.myRace);
      const oppRace = raceLetter(game.opponent?.race);
      const myEvents = detail.macroBreakdown.stats_events || [];
      const oppEvents = detail.macroBreakdown.opp_stats_events || [];
      const timeline = detail.macroBreakdown.unit_timeline || [];
      pushIntoBins(bins.my, myEvents, timeline, "my", myRace, isWin);
      pushIntoBins(bins.opp, oppEvents, timeline, "opp", oppRace, isWin);
    }
    return { ticks: foldBinsToTicks(bins) };
  }

  /**
   * @private
   * @param {1|2|3|4} tier
   * @param {object} query
   * @returns {Record<string, any>|null}
   */
  _matchFor(tier, query) {
    /** @type {Record<string, any>} */
    const match = {};
    if (query.scope === "mine") {
      if (!query.userId) return null;
      match.userId = query.userId;
    }
    if (query.mapId) match.map = query.mapId;
    if (typeof query.mmrBucket === "number") {
      const width = parseBucketWidth(undefined);
      match.myMmr = { $gte: query.mmrBucket, $lt: query.mmrBucket + width };
    }
    const myRace = raceLetter(query.myRace);
    const oppRace = raceLetter(query.oppRace);
    if (tier === 1) {
      if (!query.myBuild || !myRace || !oppRace || !query.oppOpening) {
        return null;
      }
      match.myBuild = query.myBuild;
      match.myRace = raceRegex(myRace);
      match["opponent.race"] = raceRegex(oppRace);
      match["opponent.opening"] = query.oppOpening;
    } else if (tier === 2) {
      if (!query.myBuild || !myRace || !oppRace) return null;
      match.myBuild = query.myBuild;
      match.myRace = raceRegex(myRace);
      match["opponent.race"] = raceRegex(oppRace);
    } else if (tier === 3) {
      if (!query.myBuild || !myRace || !oppRace) return null;
      match.myBuild = query.myBuild;
      match.myRace = raceRegex(myRace);
      match["opponent.race"] = raceRegex(oppRace);
    } else {
      if (!myRace || !oppRace) return null;
      match.myRace = raceRegex(myRace);
      match["opponent.race"] = raceRegex(oppRace);
    }
    return match;
  }

  /**
   * @private
   * @param {Array<object>} games
   * @returns {Promise<Map<string, object>>}
   */
  async _loadDetails(games) {
    const byUser = new Map();
    for (const g of games) {
      let arr = byUser.get(g.userId);
      if (!arr) {
        arr = [];
        byUser.set(g.userId, arr);
      }
      arr.push(g.gameId);
    }
    const merged = new Map();
    for (const [userId, gameIds] of byUser) {
      const map = await this.gameDetails.findMany(userId, gameIds);
      for (const [gameId, detail] of map) {
        merged.set(`${userId}:${gameId}`, detail);
      }
    }
    return merged;
  }
}

/**
 * @typedef {{
 *   p25w: number, p50w: number, p75w: number, p90w: number,
 *   p25l: number, p50l: number, p75l: number, p90l: number,
 *   sampleWinners: number, sampleLosers: number,
 * }} BandRow
 */

function makeEmptyBins() {
  /** @type {Record<string, Record<string, {winners: number[], losers: number[]}>>} */
  const my = {};
  /** @type {Record<string, Record<string, {winners: number[], losers: number[]}>>} */
  const opp = {};
  for (let i = 0; i < NUM_TICKS; i += 1) {
    const t = i * TICK_SECONDS;
    my[t] = {};
    opp[t] = {};
    for (const m of METRICS) {
      my[t][m] = { winners: [], losers: [] };
      opp[t][m] = { winners: [], losers: [] };
    }
  }
  return { my, opp };
}

/**
 * @param {Record<string, Record<string, {winners: number[], losers: number[]}>>} target
 * @param {Array<any>} events
 * @param {Array<any>} timeline
 * @param {'my'|'opp'} side
 * @param {string|null} race
 * @param {boolean} isWin
 */
function pushIntoBins(target, events, timeline, side, race, isWin) {
  for (const ev of events) {
    const t = roundToTick(ev?.time ?? ev?.t);
    if (t === null || !target[t]) continue;
    pushMetric(target[t].army_value, ev.army_value, isWin);
    pushMetric(target[t].army_supply, ev.food_used, isWin);
    pushMetric(target[t].workers, ev.workers_active_count, isWin);
    pushMetric(target[t].income_min, ev.minerals_collection_rate, isWin);
    pushMetric(target[t].income_gas, ev.gas_collection_rate, isWin);
  }
  for (const frame of timeline) {
    const t = roundToTick(frame?.time ?? frame?.t);
    if (t === null || !target[t]) continue;
    const units = frame?.[side];
    if (!units || typeof units !== "object") continue;
    const baseCount = countBases(units, race);
    pushMetric(target[t].bases, baseCount, isWin);
  }
}

/**
 * @param {Record<string, any>} units
 * @param {string|null} race
 */
function countBases(units, race) {
  const names = race ? BASE_UNITS[/** @type {'P'|'T'|'Z'} */ (race)] : null;
  if (!names) {
    let total = 0;
    for (const r of ["P", "T", "Z"]) {
      const set = BASE_UNITS[/** @type {'P'|'T'|'Z'} */ (r)];
      for (const n of set) {
        total += Number(units[n]) || 0;
      }
    }
    return total;
  }
  let total = 0;
  for (const n of names) {
    total += Number(units[n]) || 0;
  }
  return total;
}

/**
 * @param {{winners: number[], losers: number[]}} bucket
 * @param {unknown} raw
 * @param {boolean} isWin
 */
function pushMetric(bucket, raw, isWin) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return;
  (isWin ? bucket.winners : bucket.losers).push(v);
}

/**
 * @param {ReturnType<typeof makeEmptyBins>} bins
 */
function foldBinsToTicks(bins) {
  /** @type {Array<{t:number, my:Record<string,BandRow>, opp:Record<string,BandRow>}>} */
  const out = [];
  for (let i = 0; i < NUM_TICKS; i += 1) {
    const t = i * TICK_SECONDS;
    const my = collapseSide(bins.my[t]);
    const opp = collapseSide(bins.opp[t]);
    if (!hasUsableMetric(my) && !hasUsableMetric(opp)) continue;
    out.push({ t, my, opp });
  }
  return out;
}

/**
 * @param {Record<string, {winners: number[], losers: number[]}>} sideBucket
 * @returns {Record<string, BandRow>}
 */
function collapseSide(sideBucket) {
  /** @type {Record<string, BandRow>} */
  const out = {};
  for (const m of METRICS) {
    const b = sideBucket[m];
    // BOTH ribbons must have enough samples to draw a meaningful
    // comparison. If only winners (or only losers) reach the floor,
    // we drop the metric — a single-sided ribbon misleads the user
    // into thinking the cohort has a comparison it doesn't have.
    if (b.winners.length < MIN_TICK_SAMPLES || b.losers.length < MIN_TICK_SAMPLES) {
      continue;
    }
    out[m] = bandFor(b.winners, b.losers);
  }
  return out;
}

/**
 * @param {Record<string, BandRow>} side
 */
function hasUsableMetric(side) {
  return Object.keys(side).length > 0;
}

/**
 * @param {number[]} winners
 * @param {number[]} losers
 * @returns {BandRow}
 */
function bandFor(winners, losers) {
  const w = [...winners].sort((a, b) => a - b);
  const l = [...losers].sort((a, b) => a - b);
  return {
    p25w: percentile(w, 0.25),
    p50w: percentile(w, 0.5),
    p75w: percentile(w, 0.75),
    p90w: percentile(w, 0.9),
    p25l: percentile(l, 0.25),
    p50l: percentile(l, 0.5),
    p75l: percentile(l, 0.75),
    p90l: percentile(l, 0.9),
    sampleWinners: w.length,
    sampleLosers: l.length,
  };
}

/** Linear-interpolation percentile on a sorted array. */
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}

/** @param {unknown} raw */
function roundToTick(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const t = Math.round(n / TICK_SECONDS) * TICK_SECONDS;
  if (t > MAX_TICK_SECONDS) return null;
  return t;
}

/** @param {unknown} raw */
function raceLetter(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const h = raw.charAt(0).toUpperCase();
  if (h === "P" || h === "T" || h === "Z") return h;
  return null;
}

/** @param {string} letter */
function raceRegex(letter) {
  return new RegExp(`^${letter}`, "i");
}

/** @param {object} game */
function resultOf(game) {
  const r = String(game.result || "").toLowerCase();
  if (r === "victory" || r === "win") return "win";
  if (r === "defeat" || r === "loss") return "loss";
  return null;
}

/**
 * Canonical (deterministic) cohort key. Same inputs produce the same
 * string so two callers asking for the same comparison hit the same
 * cache row. Empty / undefined inputs collapse to ``*`` so the key
 * shape is stable across tiers.
 *
 * @param {number} tier
 * @param {object} query
 */
function canonicalCohortKey(tier, query) {
  const parts = [
    `tier=${tier}`,
    `scope=${query.scope}`,
    `myBuild=${query.myBuild || "*"}`,
    `myRace=${raceLetter(query.myRace) || "*"}`,
    `oppRace=${raceLetter(query.oppRace) || "*"}`,
    `oppOpening=${query.oppOpening || "*"}`,
    `mmrBucket=${
      typeof query.mmrBucket === "number" ? query.mmrBucket : "*"
    }`,
    `mapId=${query.mapId || "*"}`,
  ];
  return parts.join("|");
}

module.exports = {
  SnapshotCohortService,
  METRICS,
  K_ANON_MIN,
  MIN_TICK_SAMPLES,
  TICK_SECONDS,
  MAX_TICK_SECONDS,
  NUM_TICKS,
  canonicalCohortKey,
  percentile,
  roundToTick,
  raceLetter,
  resultOf,
  countBases,
  bracketLabel,
  bucketFor,
};
