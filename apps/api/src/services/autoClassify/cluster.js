"use strict";

/**
 * autoClassify/cluster — Group unclassified games whose opening
 * signatures match closely into candidate buckets the auto-classifier
 * can promote into named custom builds.
 *
 * Deterministic, synchronous, no ML deps. Two-stage algorithm:
 *
 *   1. Coarse bucket by signatureKey (the first six canonical tokens).
 *      Two games with different bucket keys can never end up in the
 *      same cluster — this both narrows the O(n²) distance pass to a
 *      per-bucket O(b²), and matches the discovery-engine intent that
 *      a cluster represents a single tech path, not a tech family.
 *
 *   2. Within each bucket, build the pairwise distance matrix and
 *      merge by single-linkage on `signatureDistance ≤ maxDistance`
 *      (i.e. connected components of the threshold graph).
 *
 *   3. Drop sub-clusters below the `minGames` gate (5 by default —
 *      the minimum the discovery-engine spec considers statistically
 *      meaningful before promoting to a named build).
 *
 * Reuses extractSignature / signatureKey / signatureDistance from
 * ./signature, so the auto-classifier and the rule engine share one
 * canonical view of what counts as the "same opening".
 *
 * Pure: no I/O, no Mongo, deterministic in the input game order.
 */

const {
  extractSignature,
  signatureKey,
  signatureDistance,
} = require("./signature");

const DEFAULT_MIN_GAMES = 5;
const DEFAULT_MAX_DISTANCE = 0.2;
const DEFAULT_SAMPLE_SIZE = 5;

/**
 * @typedef {{
 *   gameId: string,
 *   events: ReadonlyArray<{time:number, name:string, [k:string]:any}>,
 *   result?: string,
 *   date?: any,
 *   map?: string,
 * }} ClusterInputGame
 *
 * @typedef {{token:string, t:number, count:number}} SignatureEntry
 *
 * @typedef {{
 *   gameIds: string[],
 *   size: number,
 *   cohesion: number,
 *   medoidGameId: string,
 *   representativeSignature: SignatureEntry[],
 *   winRate: number,
 *   sampleGameIds: string[],
 * }} CandidateCluster
 */

/**
 * Union-find connected components of an undirected graph. Component
 * ids are assigned in order of first-seen root during the final
 * sweep, which is deterministic in the input edges.
 *
 * @param {number} n
 * @param {ReadonlyArray<[number, number]>} edges
 * @returns {number[]}
 */
function connectedComponents(n, edges) {
  /** @type {number[]} */
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  /** @param {number} x @returns {number} */
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  /** @type {Map<number, number>} */
  const roots = new Map();
  const labels = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let id = roots.get(r);
    if (id === undefined) {
      id = roots.size;
      roots.set(r, id);
    }
    labels[i] = id;
  }
  return labels;
}

/**
 * Within one bucket, build the full pairwise distance matrix and
 * single-linkage merge by `maxDistance`.
 *
 * @param {SignatureEntry[][]} sigs
 * @param {number} maxDistance
 * @param {{horizonSec?: number}} sigOpts
 * @returns {{ labels: number[], distances: number[][] }}
 */
function agglomerate(sigs, maxDistance, sigOpts) {
  const n = sigs.length;
  const distances = new Array(n);
  for (let i = 0; i < n; i++) distances[i] = new Array(n).fill(0);
  /** @type {Array<[number, number]>} */
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = signatureDistance(sigs[i], sigs[j], sigOpts);
      distances[i][j] = d;
      distances[j][i] = d;
      if (d <= maxDistance) edges.push([i, j]);
    }
  }
  return { labels: connectedComponents(n, edges), distances };
}

/**
 * Member with minimum total distance to the rest of its cluster.
 * Ties broken by lower index (first-seen wins) so the medoid is
 * deterministic in input order.
 *
 * @param {number[]} memberIdx
 * @param {number[][]} distances
 * @returns {number}
 */
function findMedoidIndex(memberIdx, distances) {
  let best = memberIdx[0];
  let bestSum = Infinity;
  for (const i of memberIdx) {
    let sum = 0;
    for (const j of memberIdx) {
      if (i !== j) sum += distances[i][j];
    }
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return best;
}

/**
 * Mean of the (n choose 2) intra-cluster pairwise distances. Returns
 * 0 for singletons.
 *
 * @param {number[]} memberIdx
 * @param {number[][]} distances
 * @returns {number}
 */
function meanIntraDistance(memberIdx, distances) {
  if (memberIdx.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < memberIdx.length; i++) {
    for (let j = i + 1; j < memberIdx.length; j++) {
      sum += distances[memberIdx[i]][memberIdx[j]];
      pairs++;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}

/**
 * Cluster a pre-filtered set of games (one matchup + perspective)
 * by opening signature. See the module docstring for the algorithm.
 *
 * Inputs are not validated beyond shape — the caller is expected to
 * pass games already filtered to one matchup + perspective and to
 * exclude games that already match an existing named or custom build.
 *
 * @param {ReadonlyArray<ClusterInputGame>} games
 * @param {{ minGames?: number, maxDistance?: number, horizonSec?: number }} [opts]
 * @returns {CandidateCluster[]}
 */
function clusterGames(games, opts = {}) {
  if (!Array.isArray(games) || games.length === 0) return [];

  const rawMin = opts.minGames;
  const minGames =
    typeof rawMin === "number" && Number.isFinite(rawMin) && rawMin >= 2
      ? Math.floor(rawMin)
      : DEFAULT_MIN_GAMES;
  const rawMaxDist = opts.maxDistance;
  const maxDistance =
    typeof rawMaxDist === "number" &&
    Number.isFinite(rawMaxDist) &&
    rawMaxDist >= 0
      ? rawMaxDist
      : DEFAULT_MAX_DISTANCE;
  const rawHorizon = opts.horizonSec;
  const sigOpts =
    typeof rawHorizon === "number" &&
    Number.isFinite(rawHorizon) &&
    rawHorizon > 0
      ? { horizonSec: rawHorizon }
      : {};

  /** @type {SignatureEntry[][]} */
  const sigs = new Array(games.length).fill(null).map(() => []);
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    sigs[i] =
      g && Array.isArray(g.events) ? extractSignature(g.events, sigOpts) : [];
    const key = signatureKey(sigs[i]);
    let arr = buckets.get(key);
    if (arr === undefined) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(i);
  }

  /** @type {CandidateCluster[]} */
  const out = [];
  for (const [key, indices] of buckets) {
    // Empty-signature games (no tech events / nonsense replays) can't
    // be named as a build — skip the empty bucket entirely.
    if (!key) continue;
    if (indices.length < minGames) continue;
    const localSigs = indices.map((idx) => sigs[idx]);
    const { labels, distances } = agglomerate(localSigs, maxDistance, sigOpts);

    /** @type {Map<number, number[]>} */
    const groups = new Map();
    for (let li = 0; li < labels.length; li++) {
      const lab = labels[li];
      let arr = groups.get(lab);
      if (arr === undefined) {
        arr = [];
        groups.set(lab, arr);
      }
      arr.push(li);
    }

    for (const memberLocalIdx of groups.values()) {
      if (memberLocalIdx.length < minGames) continue;
      const medoidLocal = findMedoidIndex(memberLocalIdx, distances);
      const meanDist = meanIntraDistance(memberLocalIdx, distances);
      const memberGames = memberLocalIdx.map((li) => games[indices[li]]);
      const gameIds = memberGames.map((g) => g.gameId);
      let wins = 0;
      let losses = 0;
      for (const g of memberGames) {
        if (g.result === "Win") wins++;
        else if (g.result === "Loss") losses++;
      }
      const wlTotal = wins + losses;
      const winRate = wlTotal > 0 ? wins / wlTotal : 0;
      const medoidGameId = games[indices[medoidLocal]].gameId;
      // Sample: medoid first, then the next-closest members to the
      // medoid in distance order (capped at DEFAULT_SAMPLE_SIZE).
      const others = memberLocalIdx
        .filter((li) => li !== medoidLocal)
        .sort((a, b) => distances[medoidLocal][a] - distances[medoidLocal][b]);
      const sampleGameIds = [medoidGameId];
      for (const li of others) {
        if (sampleGameIds.length >= DEFAULT_SAMPLE_SIZE) break;
        sampleGameIds.push(games[indices[li]].gameId);
      }
      out.push({
        gameIds,
        size: memberGames.length,
        cohesion: 1 - meanDist,
        medoidGameId,
        representativeSignature: localSigs[medoidLocal],
        winRate,
        sampleGameIds,
      });
    }
  }

  out.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.cohesion - a.cohesion;
  });
  return out;
}

module.exports = {
  clusterGames,
  DEFAULT_MIN_GAMES,
  DEFAULT_MAX_DISTANCE,
};
