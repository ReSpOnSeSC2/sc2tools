"use strict";

const {
  bestKByCohesion,
  cosineDistance,
  l2Normalize,
  labelCentroid,
  vectorize,
} = require("./snapshotClustering");
const { wilsonCI } = require("./snapshotTechPath");
const { roundToTick, raceLetter, resultOf } = require("./snapshotCohort");

/**
 * SnapshotMatchupMatrixService — k-means composition archetypes
 * + K×K win-rate matrix per tick.
 *
 * For a (matchup, mmrBucket, tickSec) tuple:
 *   1. Pull unit_timeline frames for every cohort game at tickSec.
 *   2. L2-normalize each side's unit vector (shape, not magnitude).
 *   3. Cluster each side independently via k-means; pick k ∈ {3..6}
 *      by silhouette, default to 5.
 *   4. Auto-label each cluster from its centroid's dominant units.
 *   5. Build the K×K matrix: for every (myCluster, oppCluster)
 *      pair, count wins/losses + Wilson CI.
 *
 * Counter suggestions: at the focal tick, look across the user's
 * row and pick the cell with the highest win rate above the user's
 * current cluster's win rate. Compute the unit-delta needed to
 * approach the better cluster's centroid. Race-validate so we
 * never suggest a Hatchery for a Protoss.
 *
 * Determinism: PRNG seeded; assignments + labels reproducible
 * across runs given the same input.
 */

const DEFAULT_K_CANDIDATES = [3, 4, 5, 6];
const DEFAULT_K = 5;
const NEUTRAL_BAND = Object.freeze([0.4, 0.6]);
const MIN_CELL_GAMES = 10;
const RACE_UNITS = Object.freeze({
  P: new Set([
    "Probe", "Zealot", "Stalker", "Sentry", "Adept", "HighTemplar", "DarkTemplar",
    "Archon", "Immortal", "Colossus", "Disruptor", "Observer", "WarpPrism",
    "Phoenix", "VoidRay", "Oracle", "Tempest", "Carrier", "Mothership",
  ]),
  T: new Set([
    "SCV", "Marine", "Marauder", "Reaper", "Ghost", "Hellion", "Hellbat",
    "WidowMine", "Cyclone", "SiegeTank", "Thor", "Viking", "Medivac", "Liberator",
    "Raven", "Banshee", "Battlecruiser",
  ]),
  Z: new Set([
    "Drone", "Larva", "Queen", "Zergling", "Baneling", "Roach", "Ravager",
    "Hydralisk", "Lurker", "Infestor", "SwarmHost", "Ultralisk", "Mutalisk",
    "Corruptor", "BroodLord", "Viper", "Overlord", "Overseer",
  ]),
});

class SnapshotMatchupMatrixService {
  /**
   * Build the K×K matrix at a single tick for the given cohort.
   *
   * @param {Array<object>} cohortGames slim rows (need myRace, opponent.race, result, gameId, userId)
   * @param {Map<string, object>} detailsByGameId
   * @param {number} tickSec
   * @returns {{
   *   tick: number,
   *   myClusters: Array<{ id: string, label: string, centroid: Record<string, number>, size: number }>,
   *   oppClusters: Array<{ id: string, label: string, centroid: Record<string, number>, size: number }>,
   *   silhouettes: { my: number, opp: number },
   *   rows: Array<Array<{ winRate: number, sampleSize: number, ci: [number, number] }>>,
   * }}
   */
  buildMatrix(cohortGames, detailsByGameId, tickSec) {
    const myFrames = extractFrames(cohortGames, detailsByGameId, tickSec, "my");
    const oppFrames = extractFrames(cohortGames, detailsByGameId, tickSec, "opp");
    if (myFrames.length === 0) {
      return emptyMatrix(tickSec);
    }
    const myFit = clusterFrames(myFrames);
    const oppFit = clusterFrames(oppFrames);
    const matrix = buildWinMatrix(myFrames, oppFrames, myFit.assignments, oppFit.assignments, myFit.centroidsByCluster, oppFit.centroidsByCluster);
    return {
      tick: tickSec,
      myClusters: myFit.descriptors,
      oppClusters: oppFit.descriptors,
      silhouettes: { my: myFit.silhouette, opp: oppFit.silhouette },
      rows: matrix.rows,
    };
  }

  /**
   * For a focal game's vector at the tick, find its cluster
   * assignment + the matchup matrix row + counter-suggestions.
   *
   * @param {{ units: Record<string, number>, race: string|null }} focal
   * @param {{ units: Record<string, number>, race: string|null }} focalOpp
   * @param {ReturnType<SnapshotMatchupMatrixService['buildMatrix']>} matrix
   */
  resolveFocal(focal, focalOpp, matrix) {
    if (matrix.myClusters.length === 0) return null;
    const myIdx = assignToCluster(focal.units, matrix.myClusters);
    const oppIdx = assignToCluster(focalOpp.units, matrix.oppClusters);
    const cell = matrix.rows[myIdx.idx]?.[oppIdx.idx];
    const myCluster = matrix.myClusters[myIdx.idx];
    const oppCluster = matrix.oppClusters[oppIdx.idx];
    const winRate = cell?.winRate ?? 0.5;
    const verdict = verdictFromRate(winRate);
    const fullRow = matrix.rows[myIdx.idx].map((c, i) => ({
      oppClusterId: matrix.oppClusters[i].id,
      oppLabel: matrix.oppClusters[i].label,
      winRate: c.winRate,
      sampleSize: c.sampleSize,
    }));
    const counters = suggestCounters({
      myIdx: myIdx.idx,
      oppIdx: oppIdx.idx,
      matrix,
      focalUnits: focal.units,
      race: focal.race,
    });
    return {
      myCluster: {
        id: myCluster.id,
        label: myCluster.label,
        centroid: myCluster.centroid,
        distanceFromCentroid: myIdx.distance,
        secondClosest: myIdx.second
          ? { id: matrix.myClusters[myIdx.second.idx].id, distance: myIdx.second.distance }
          : null,
      },
      oppCluster: {
        id: oppCluster.id,
        label: oppCluster.label,
        centroid: oppCluster.centroid,
        distanceFromCentroid: oppIdx.distance,
      },
      winRate,
      winRateCI: cell?.ci ?? [0, 1],
      neutralBand: NEUTRAL_BAND,
      verdict,
      sampleSize: cell?.sampleSize ?? 0,
      fullRow,
      fullMatrix: {
        myClusters: matrix.myClusters.map((c) => c.id),
        oppClusters: matrix.oppClusters.map((c) => c.id),
        rows: matrix.rows,
      },
      counterSuggestions: counters,
    };
  }
}

function extractFrames(cohortGames, detailsByGameId, tickSec, side) {
  /** @type {Array<{ gameId: string, userId: string, race: string|null, units: Record<string, number>, result: 'win'|'loss'|null }>} */
  const out = [];
  for (const game of cohortGames) {
    const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
    if (!detail) continue;
    const timeline = detail.macroBreakdown?.unit_timeline;
    if (!Array.isArray(timeline)) continue;
    for (const frame of timeline) {
      const t = roundToTick(frame?.time ?? frame?.t);
      if (t !== tickSec) continue;
      const units = frame?.[side];
      if (!units || typeof units !== "object") break;
      const race = raceLetter(side === "my" ? game.myRace : game.opponent?.race);
      out.push({
        gameId: game.gameId,
        userId: game.userId,
        race,
        units,
        result: resultOf(game),
      });
      break;
    }
  }
  return out;
}

function clusterFrames(frames) {
  if (frames.length === 0) {
    return { descriptors: [], assignments: [], silhouette: 0, centroidsByCluster: [] };
  }
  const unitNames = collectUnitNames(frames);
  const vectors = frames.map((f) =>
    l2Normalize(vectorize(filterUnitsToRace(f.units, f.race), unitNames)),
  );
  const fit = bestKByCohesion(vectors, unitNames, DEFAULT_K_CANDIDATES, DEFAULT_K);
  const sizes = new Array(fit.k).fill(0);
  for (const a of fit.assignments) sizes[a] += 1;
  const centroidsAsMap = fit.centroids.map((c) => centroidToMap(c, unitNames));
  const descriptors = fit.centroids.map((c, i) => ({
    id: clusterId(i, labelCentroid(c, unitNames)),
    label: labelCentroid(c, unitNames),
    centroid: centroidsAsMap[i],
    size: sizes[i],
  }));
  return {
    descriptors,
    assignments: fit.assignments,
    silhouette: fit.silhouette || 0,
    centroidsByCluster: centroidsAsMap,
    unitNames,
  };
}

function buildWinMatrix(myFrames, oppFrames, myAssign, oppAssign, myCentroidsMap, oppCentroidsMap) {
  const kMy = myCentroidsMap.length;
  const kOpp = oppCentroidsMap.length;
  /** @type {Array<Array<{ wins: number, losses: number }>>} */
  const grid = Array.from({ length: kMy }, () =>
    Array.from({ length: kOpp }, () => ({ wins: 0, losses: 0 })),
  );
  const oppByGameKey = new Map();
  for (let i = 0; i < oppFrames.length; i += 1) {
    oppByGameKey.set(`${oppFrames[i].userId}:${oppFrames[i].gameId}`, oppAssign[i]);
  }
  for (let i = 0; i < myFrames.length; i += 1) {
    const f = myFrames[i];
    const oppIdx = oppByGameKey.get(`${f.userId}:${f.gameId}`);
    if (oppIdx === undefined) continue;
    if (f.result === "win") grid[myAssign[i]][oppIdx].wins += 1;
    else if (f.result === "loss") grid[myAssign[i]][oppIdx].losses += 1;
  }
  const rows = grid.map((row) =>
    row.map((cell) => {
      const total = cell.wins + cell.losses;
      const winRate = total > 0 ? cell.wins / total : 0;
      return {
        winRate,
        sampleSize: total,
        ci: wilsonCI(cell.wins, total),
      };
    }),
  );
  return { rows };
}

function assignToCluster(units, clusters) {
  if (clusters.length === 0) return { idx: 0, distance: 0, second: null };
  const unitNames = unique(clusters.flatMap((c) => Object.keys(c.centroid)));
  const vec = l2Normalize(vectorize(units, unitNames));
  let bestIdx = 0;
  let bestDist = Infinity;
  let secondIdx = -1;
  let secondDist = Infinity;
  for (let i = 0; i < clusters.length; i += 1) {
    const cv = l2Normalize(vectorize(clusters[i].centroid, unitNames));
    const d = cosineDistance(vec, cv);
    if (d < bestDist) {
      secondIdx = bestIdx;
      secondDist = bestDist;
      bestIdx = i;
      bestDist = d;
    } else if (d < secondDist) {
      secondIdx = i;
      secondDist = d;
    }
  }
  return {
    idx: bestIdx,
    distance: bestDist,
    second: secondIdx >= 0 ? { idx: secondIdx, distance: secondDist } : null,
  };
}

function suggestCounters({ myIdx, oppIdx, matrix, focalUnits, race }) {
  const row = matrix.rows[myIdx] || [];
  /** @type {Array<{ strategy: string, targetClusterId: string, targetClusterLabel: string, projectedWinRate: number, projectedWinRateCI: [number, number], sampleSize: number, unitsToAdd: Record<string, number>, unitsToRemove: Record<string, number>, feasibility: string }>} */
  const out = [];
  const currentRate = row[oppIdx]?.winRate ?? 0;
  const candidates = matrix.myClusters
    .map((c, i) => ({
      idx: i,
      cluster: c,
      cell: row[oppIdx] && i === oppIdx ? null : matrix.rows[i]?.[oppIdx],
    }))
    .filter((x) => x.idx !== myIdx && x.cell && x.cell.sampleSize >= MIN_CELL_GAMES);
  candidates.sort((a, b) => (b.cell?.winRate || 0) - (a.cell?.winRate || 0));
  for (const cand of candidates.slice(0, 2)) {
    if (!cand.cell || cand.cell.winRate <= currentRate + 0.05) continue;
    const diff = unitDelta(focalUnits, cand.cluster.centroid, race);
    if (Object.keys(diff.toAdd).length === 0 && Object.keys(diff.toRemove).length === 0) continue;
    out.push({
      strategy: "switch_composition",
      targetClusterId: cand.cluster.id,
      targetClusterLabel: cand.cluster.label,
      projectedWinRate: cand.cell.winRate,
      projectedWinRateCI: cand.cell.ci,
      sampleSize: cand.cell.sampleSize,
      unitsToAdd: diff.toAdd,
      unitsToRemove: diff.toRemove,
      feasibility: feasibilityNote(diff.toAdd, race),
    });
  }
  return out;
}

function unitDelta(focal, target, race) {
  const allowed = race ? RACE_UNITS[/** @type {'P'|'T'|'Z'} */ (race)] : null;
  const keys = new Set([...Object.keys(focal || {}), ...Object.keys(target || {})]);
  /** @type {Record<string, number>} */
  const toAdd = {};
  /** @type {Record<string, number>} */
  const toRemove = {};
  for (const k of keys) {
    if (allowed && !allowed.has(k)) continue;
    const f = Math.round(Number(focal[k]) || 0);
    const t = Math.round(Number(target[k]) || 0);
    const diff = t - f;
    if (diff >= 1) toAdd[k] = diff;
    else if (diff <= -1) toRemove[k] = -diff;
  }
  return { toAdd, toRemove };
}

function feasibilityNote(toAdd, race) {
  const count = Object.values(toAdd).reduce((s, n) => s + Number(n), 0);
  if (count === 0) return "no change required";
  if (count <= 3) return "achievable_within_60s";
  if (count <= 6) return "achievable_within_120s";
  return "requires_economic_pivot";
}

function verdictFromRate(rate) {
  if (rate >= NEUTRAL_BAND[1]) return "favorable";
  if (rate <= NEUTRAL_BAND[0]) return "unfavorable";
  return "neutral";
}

function centroidToMap(centroid, unitNames) {
  /** @type {Record<string, number>} */
  const out = {};
  for (let i = 0; i < unitNames.length; i += 1) {
    if (centroid[i] > 0) out[unitNames[i]] = Math.round(centroid[i] * 1000) / 1000;
  }
  return out;
}

function collectUnitNames(frames) {
  const set = new Set();
  for (const f of frames) {
    for (const k of Object.keys(filterUnitsToRace(f.units, f.race))) set.add(k);
  }
  return Array.from(set).sort();
}

function filterUnitsToRace(units, race) {
  const allowed = race ? RACE_UNITS[/** @type {'P'|'T'|'Z'} */ (race)] : null;
  if (!allowed) return units;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(units)) {
    if (allowed.has(k)) out[k] = Number(v);
  }
  return out;
}

function clusterId(idx, label) {
  return `c${idx}_${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function emptyMatrix(tickSec) {
  return {
    tick: tickSec,
    myClusters: [],
    oppClusters: [],
    silhouettes: { my: 0, opp: 0 },
    rows: [],
  };
}

module.exports = {
  SnapshotMatchupMatrixService,
  buildWinMatrix,
  suggestCounters,
  unitDelta,
  assignToCluster,
  clusterId,
  verdictFromRate,
  NEUTRAL_BAND,
  MIN_CELL_GAMES,
  RACE_UNITS,
};
