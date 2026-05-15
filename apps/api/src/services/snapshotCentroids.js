"use strict";

const {
  TICK_SECONDS,
  NUM_TICKS,
  MIN_TICK_SAMPLES,
  roundToTick,
  resultOf,
} = require("./snapshotCohort");

/**
 * SnapshotCentroidsService — composition (per-unit count) analytics
 * for the snapshot drilldown.
 *
 * Two pieces:
 *
 *   1. ``computeCentroids(cohortGames, details)`` — for each tick,
 *      the mean per-unit count across winners and (separately)
 *      losers. The user's deck at each tick is then compared
 *      against the winner centroid via:
 *
 *        - cosine similarity (single-number summary "how close to
 *          a winner's deck am I at this tick")
 *        - per-unit deltas sorted by |delta| (the table view "you
 *          have 2 extra Stalkers, 3 fewer Probes than winners")
 *
 *   2. ``computeDeltas(unitsByTick, centroids)`` — fold the user's
 *      per-tick unit vectors into delta rows for the UI table.
 *
 * Centroids only emit a tick row when at least MIN_TICK_SAMPLES
 * games on that side contributed — anything thinner is too noisy to
 * draw a comparison against. The per-unit median (not mean) is
 * exposed alongside the centroid mean since the chart legend reads
 * better with whole-number medians ("winners had 4 Stalkers") than
 * with fractional means.
 */

class SnapshotCentroidsService {
  /**
   * Compute winner / loser centroids per tick for the user's side
   * AND the opponent's side. Returns one record per side per tick,
   * each carrying the mean and median per unit name.
   *
   * @param {Array<object>} cohortGames slim rows (carry result, races)
   * @param {Map<string, object>} detailsByGameId keyed ``${userId}:${gameId}``
   * @returns {{
   *   my: Map<number, { winnerCentroid: Record<string, number>, loserCentroid: Record<string, number>, winnerMedian: Record<string, number> }>,
   *   opp: Map<number, { winnerCentroid: Record<string, number>, loserCentroid: Record<string, number>, winnerMedian: Record<string, number> }>,
   * }}
   */
  computeCentroids(cohortGames, detailsByGameId) {
    const myBuckets = makeUnitBuckets();
    const oppBuckets = makeUnitBuckets();
    for (const game of cohortGames) {
      const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
      if (!detail || !detail.macroBreakdown) continue;
      const timeline = detail.macroBreakdown.unit_timeline;
      if (!Array.isArray(timeline)) continue;
      const isWin = resultOf(game) === "win";
      for (const frame of timeline) {
        const t = roundToTick(frame?.time ?? frame?.t);
        if (t === null) continue;
        accumulateUnits(myBuckets, t, frame?.my, isWin);
        accumulateUnits(oppBuckets, t, frame?.opp, isWin);
      }
    }
    return {
      my: foldUnitBuckets(myBuckets),
      opp: foldUnitBuckets(oppBuckets),
    };
  }

  /**
   * For one game's per-tick unit vectors, compute the delta table
   * (mine vs winner-centroid) plus the cosine similarity to the
   * winner centroid. Returns one record per tick the cohort
   * covered.
   *
   * @param {Map<number, Record<string, number>>} myUnitsByTick
   * @param {Map<number, Record<string, number>>} oppUnitsByTick
   * @param {ReturnType<SnapshotCentroidsService['computeCentroids']>} centroids
   * @returns {Map<number, {
   *   my: Array<{unit:string,mine:number,cohortWinnerMedian:number,delta:number,percentile:number}>,
   *   opp: Array<{unit:string,mine:number,cohortWinnerMedian:number,delta:number,percentile:number}>,
   *   mySimilarity: number,
   *   oppSimilarity: number,
   * }>}
   */
  computeDeltas(myUnitsByTick, oppUnitsByTick, centroids) {
    /** @type {Map<number, any>} */
    const out = new Map();
    for (let i = 0; i < NUM_TICKS; i += 1) {
      const t = i * TICK_SECONDS;
      const myCentroid = centroids.my.get(t);
      const oppCentroid = centroids.opp.get(t);
      if (!myCentroid && !oppCentroid) continue;
      const myUnits = myUnitsByTick.get(t) || {};
      const oppUnits = oppUnitsByTick.get(t) || {};
      out.set(t, {
        my: deltaRows(myUnits, myCentroid),
        opp: deltaRows(oppUnits, oppCentroid),
        mySimilarity: cosineSimilarity(myUnits, myCentroid?.winnerCentroid),
        oppSimilarity: cosineSimilarity(oppUnits, oppCentroid?.winnerCentroid),
      });
    }
    return out;
  }
}

/**
 * Bucket structure: tick → unit name → { winners: number[], losers: number[] }
 *
 * We keep the raw value lists (not running sums) so the median is
 * computable without a second pass — the cohort is bounded in size
 * by the upstream tier resolution.
 */
function makeUnitBuckets() {
  /** @type {Map<number, Map<string, {winners:number[], losers:number[]}>>} */
  return new Map();
}

/**
 * @param {ReturnType<typeof makeUnitBuckets>} buckets
 * @param {number} t
 * @param {Record<string, unknown>|undefined} units
 * @param {boolean} isWin
 */
function accumulateUnits(buckets, t, units, isWin) {
  if (!units || typeof units !== "object") return;
  let tickMap = buckets.get(t);
  if (!tickMap) {
    tickMap = new Map();
    buckets.set(t, tickMap);
  }
  for (const [name, raw] of Object.entries(units)) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    let row = tickMap.get(name);
    if (!row) {
      row = { winners: [], losers: [] };
      tickMap.set(name, row);
    }
    (isWin ? row.winners : row.losers).push(v);
  }
}

/**
 * @param {ReturnType<typeof makeUnitBuckets>} buckets
 */
function foldUnitBuckets(buckets) {
  /** @type {Map<number, any>} */
  const out = new Map();
  for (const [t, tickMap] of buckets) {
    /** @type {Record<string, number>} */
    const winnerCentroid = {};
    /** @type {Record<string, number>} */
    const loserCentroid = {};
    /** @type {Record<string, number>} */
    const winnerMedian = {};
    let winnerSampleMax = 0;
    let loserSampleMax = 0;
    for (const [name, row] of tickMap) {
      if (row.winners.length > 0) {
        winnerCentroid[name] = mean(row.winners);
        winnerMedian[name] = median(row.winners);
        winnerSampleMax = Math.max(winnerSampleMax, row.winners.length);
      }
      if (row.losers.length > 0) {
        loserCentroid[name] = mean(row.losers);
        loserSampleMax = Math.max(loserSampleMax, row.losers.length);
      }
    }
    if (winnerSampleMax < MIN_TICK_SAMPLES && loserSampleMax < MIN_TICK_SAMPLES) {
      continue;
    }
    out.set(t, { winnerCentroid, loserCentroid, winnerMedian });
  }
  return out;
}

/**
 * Sorted (by |delta| desc) delta rows for one tick.
 *
 * @param {Record<string, number>} mine
 * @param {{winnerCentroid: Record<string, number>, winnerMedian: Record<string, number>}|undefined} centroid
 */
function deltaRows(mine, centroid) {
  if (!centroid) return [];
  const names = new Set([
    ...Object.keys(mine),
    ...Object.keys(centroid.winnerCentroid),
  ]);
  /** @type {Array<any>} */
  const rows = [];
  for (const unit of names) {
    const mineCount = Number(mine[unit] || 0);
    const median = Number(centroid.winnerMedian[unit] || 0);
    const mean = Number(centroid.winnerCentroid[unit] || 0);
    const delta = mineCount - median;
    rows.push({
      unit,
      mine: mineCount,
      cohortWinnerMedian: median,
      delta,
      percentile: pseudoPercentile(mineCount, mean),
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rows;
}

/**
 * Cosine similarity between two unit-count vectors over the union
 * of their keys. Returns 0 if either vector has zero L2 norm so a
 * blank tick doesn't divide by zero.
 *
 * @param {Record<string, number>|undefined} a
 * @param {Record<string, number>|undefined} b
 */
function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const av = Number(a[k] || 0);
    const bv = Number(b[k] || 0);
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cheap distribution-free percentile estimate: if my count >= the
 * cohort mean, I'm at least at the 50th percentile; the further
 * above/below I am, the more it shifts. Bounded to [0, 1]. This
 * is a UI hint, not a statistically rigorous figure — the cohort
 * percentile band view carries the real distribution.
 *
 * @param {number} mine
 * @param {number} mean
 */
function pseudoPercentile(mine, mean) {
  if (mean <= 0) return mine > 0 ? 1 : 0.5;
  const ratio = mine / mean;
  if (ratio >= 2) return 1;
  if (ratio <= 0) return 0;
  return Math.max(0, Math.min(1, 0.5 + (ratio - 1) * 0.5));
}

/** @param {number[]} arr */
function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** @param {number[]} arr */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Index a game's unit_timeline into (tick → side units). Used by
 * the route layer so it doesn't have to know the timeline shape.
 *
 * @param {Array<any>|undefined} timeline
 * @returns {{my: Map<number, Record<string, number>>, opp: Map<number, Record<string, number>>}}
 */
function indexUnitTimeline(timeline) {
  /** @type {Map<number, Record<string, number>>} */
  const my = new Map();
  /** @type {Map<number, Record<string, number>>} */
  const opp = new Map();
  if (!Array.isArray(timeline)) return { my, opp };
  for (const frame of timeline) {
    const t = roundToTick(frame?.time ?? frame?.t);
    if (t === null) continue;
    if (frame?.my && typeof frame.my === "object") my.set(t, frame.my);
    if (frame?.opp && typeof frame.opp === "object") opp.set(t, frame.opp);
  }
  return { my, opp };
}

module.exports = {
  SnapshotCentroidsService,
  cosineSimilarity,
  indexUnitTimeline,
  deltaRows,
};
