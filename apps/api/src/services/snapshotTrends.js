"use strict";

const {
  METRICS,
  TICK_SECONDS,
  raceLetter,
  resultOf,
} = require("./snapshotCohort");
const { classifyPosition } = require("./snapshotCompare");

/**
 * SnapshotTrendsService — pattern detection across a user's last N
 * games. Used by the ``/snapshots/trends`` page to surface
 * "recurring weaknesses" (tick ranges where being behind on a
 * particular metric correlates with losing) and "strengths"
 * (mirror image: being ahead on a metric correlates with winning
 * even when other dimensions are mixed).
 *
 * The aggregation is conditional probability:
 *
 *   P(loss | metric score ≤ -1 in [t_lo, t_hi])
 *
 * A high conditional with enough occurrences flags a recurring
 * weakness; the inverse with metric score ≥ +1 flags a strength.
 * Ranges below the occurrence floor are dropped — we only surface
 * patterns the player can act on, not statistical accidents.
 *
 * Bands are pulled per game via a shared cohort resolver passed in
 * at construction time, so the trends page sees the same band data
 * the snapshot drilldown does.
 */

const DEFAULT_LAST_N = 20;
const MAX_LAST_N = 200;
const MIN_OCCURRENCES = 5;
const WEAKNESS_THRESHOLD = 0.6;
const STRENGTH_THRESHOLD = 0.6;

const TICK_RANGES = Object.freeze([
  [0, 180],
  [180, 360],
  [360, 540],
  [540, 720],
  [720, 900],
  [900, 1200],
]);

class SnapshotTrendsService {
  /**
   * @param {{ games: import('mongodb').Collection }} db
   * @param {{
   *   gameDetails: import('./gameDetails').GameDetailsService,
   *   cohort: import('./snapshotCohort').SnapshotCohortService,
   * }} deps
   */
  constructor(db, deps) {
    this.db = db;
    this.gameDetails = deps.gameDetails;
    this.cohort = deps.cohort;
  }

  /**
   * Find recurring weaknesses + strengths across the user's last N
   * games. Aggregates per-tick score classifications into the six
   * canonical tick ranges then computes conditional loss/win rates
   * inside each (range, metric) bucket.
   *
   * @param {string} userId
   * @param {{ lastN?: number, matchup?: string, mmrBucket?: number }} opts
   * @returns {Promise<{
   *   userId: string,
   *   gameCount: number,
   *   recurringWeaknesses: Array<{ tickRange: [number, number], metric: string, lossesWhenBehind: number, occurrences: number }>,
   *   strengths: Array<{ tickRange: [number, number], metric: string, winsWhenAhead: number, occurrences: number }>,
   * }>}
   */
  async findTrends(userId, opts = {}) {
    const lastN = clampN(opts.lastN);
    const matchup = parseMatchup(opts.matchup);
    const match = { userId };
    if (matchup) {
      match.myRace = new RegExp(`^${matchup.my}`, "i");
      match["opponent.race"] = new RegExp(`^${matchup.opp}`, "i");
    }
    if (typeof opts.mmrBucket === "number") {
      match.myMmr = { $gte: opts.mmrBucket, $lt: opts.mmrBucket + 200 };
    }
    const games = await this.db.games
      .find(match, {
        projection: {
          _id: 0,
          userId: 1,
          gameId: 1,
          result: 1,
          myRace: 1,
          myBuild: 1,
          opponent: 1,
          date: 1,
        },
      })
      .sort({ date: -1 })
      .limit(lastN)
      .toArray();
    if (games.length === 0) {
      return {
        userId,
        gameCount: 0,
        recurringWeaknesses: [],
        strengths: [],
      };
    }
    const tally = makeTallyMap();
    for (const game of games) {
      await this._accumulateGame(game, tally);
    }
    return {
      userId,
      gameCount: games.length,
      recurringWeaknesses: extractWeaknesses(tally),
      strengths: extractStrengths(tally),
    };
  }

  /**
   * @private
   * @param {object} game
   * @param {Tally} tally
   */
  async _accumulateGame(game, tally) {
    const cohort = await this.cohort.resolveCohort({
      userId: game.userId,
      scope: "community",
      myBuild: game.myBuild,
      myRace: game.myRace,
      oppRace: game.opponent?.race,
      oppOpening: game.opponent?.opening,
    });
    if (cohort.tooSmall) return;
    const bands = await this.cohort.aggregateBands(cohort.games);
    const detail = await this.gameDetails.findOne(game.userId, game.gameId);
    if (!detail || !detail.macroBreakdown) return;
    const isWin = resultOf(game) === "win";
    const events = indexByTime(detail.macroBreakdown.stats_events);
    const timeline = indexByTime(detail.macroBreakdown.unit_timeline);
    const myRace = raceLetter(game.myRace);
    for (const bandRow of bands.ticks) {
      const ev = events.get(bandRow.t);
      const frame = timeline.get(bandRow.t);
      if (!ev && !frame) continue;
      const values = {
        army_value: numOrNull(ev?.army_value),
        army_supply: numOrNull(ev?.food_used),
        workers: numOrNull(ev?.workers_active_count),
        bases: frame?.my && myRace ? countBasesShim(frame.my, myRace) : null,
        income_min: numOrNull(ev?.minerals_collection_rate),
        income_gas: numOrNull(ev?.gas_collection_rate),
      };
      for (const metric of METRICS) {
        const v = values[metric];
        const band = bandRow.my?.[metric];
        if (v === null || !band) continue;
        const score = classifyPosition(v, band);
        const rangeIdx = rangeIndexFor(bandRow.t);
        if (rangeIdx === -1) continue;
        const key = `${rangeIdx}|${metric}`;
        let row = tally.get(key);
        if (!row) {
          row = { behindAndLost: 0, behindTotal: 0, aheadAndWon: 0, aheadTotal: 0 };
          tally.set(key, row);
        }
        if (score <= -1) {
          row.behindTotal += 1;
          if (!isWin) row.behindAndLost += 1;
        }
        if (score >= 1) {
          row.aheadTotal += 1;
          if (isWin) row.aheadAndWon += 1;
        }
      }
    }
  }
}

/**
 * @typedef {Map<string, { behindAndLost: number, behindTotal: number, aheadAndWon: number, aheadTotal: number }>} Tally
 */

function makeTallyMap() {
  /** @type {Tally} */
  return new Map();
}

/**
 * @param {Tally} tally
 */
function extractWeaknesses(tally) {
  /** @type {Array<any>} */
  const out = [];
  for (const [key, row] of tally) {
    if (row.behindTotal < MIN_OCCURRENCES) continue;
    const rate = row.behindAndLost / row.behindTotal;
    if (rate < WEAKNESS_THRESHOLD) continue;
    const [rangeIdx, metric] = key.split("|");
    out.push({
      tickRange: TICK_RANGES[Number(rangeIdx)],
      metric,
      lossesWhenBehind: rate,
      occurrences: row.behindTotal,
    });
  }
  out.sort((a, b) => b.lossesWhenBehind - a.lossesWhenBehind);
  return out;
}

/**
 * @param {Tally} tally
 */
function extractStrengths(tally) {
  /** @type {Array<any>} */
  const out = [];
  for (const [key, row] of tally) {
    if (row.aheadTotal < MIN_OCCURRENCES) continue;
    const rate = row.aheadAndWon / row.aheadTotal;
    if (rate < STRENGTH_THRESHOLD) continue;
    const [rangeIdx, metric] = key.split("|");
    out.push({
      tickRange: TICK_RANGES[Number(rangeIdx)],
      metric,
      winsWhenAhead: rate,
      occurrences: row.aheadTotal,
    });
  }
  out.sort((a, b) => b.winsWhenAhead - a.winsWhenAhead);
  return out;
}

/** @param {number} t */
function rangeIndexFor(t) {
  for (let i = 0; i < TICK_RANGES.length; i += 1) {
    const [lo, hi] = TICK_RANGES[i];
    if (t >= lo && t < hi) return i;
  }
  return -1;
}

/** @param {Array<any>|undefined} arr */
function indexByTime(arr) {
  /** @type {Map<number, any>} */
  const out = new Map();
  if (!Array.isArray(arr)) return out;
  for (const ev of arr) {
    const raw = Number(ev?.time ?? ev?.t);
    if (!Number.isFinite(raw)) continue;
    const t = Math.round(raw / TICK_SECONDS) * TICK_SECONDS;
    out.set(t, ev);
  }
  return out;
}

/** @param {unknown} raw */
function numOrNull(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function countBasesShim(units, race) {
  const map = { P: ["Nexus"], T: ["CommandCenter", "OrbitalCommand", "PlanetaryFortress"], Z: ["Hatchery", "Lair", "Hive"] };
  const names = map[race];
  if (!names) return 0;
  let total = 0;
  for (const n of names) total += Number(units[n]) || 0;
  return total;
}

/** @param {unknown} raw */
function clampN(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LAST_N;
  return Math.min(Math.floor(n), MAX_LAST_N);
}

/** @param {unknown} raw e.g. "PvZ" */
function parseMatchup(raw) {
  if (typeof raw !== "string" || raw.length < 3) return null;
  const m = raw.toUpperCase().match(/^([PTZ])V([PTZ])$/);
  if (!m) return null;
  return { my: m[1], opp: m[2] };
}

module.exports = {
  SnapshotTrendsService,
  TICK_RANGES,
  rangeIndexFor,
  extractWeaknesses,
  extractStrengths,
  MIN_OCCURRENCES,
  WEAKNESS_THRESHOLD,
};
