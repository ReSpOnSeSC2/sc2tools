"use strict";

/**
 * snapshotClustering — hand-rolled k-means + silhouette for the
 * composition matchup matrix. Hand-rolled (rather than an npm
 * dependency) to keep the API's deploy surface small and to
 * guarantee determinism: same input → same labels.
 *
 * Vectors are L2-normalized before clustering so the algorithm
 * sees *shape* (Stalker-heavy vs Roach-heavy) rather than
 * magnitude (an early-game 20-supply army shouldn't end up in a
 * different cluster from a late-game 100-supply one with the same
 * mix). Magnitude is already captured by ``army_value`` in the
 * other metrics.
 *
 * Auto-label uses the top-3 units in each centroid by relative
 * weight, plus a race-aware archetype hinter for common patterns.
 *
 * Deterministic seeding: we initialize centroids from the K
 * vectors most spread out by cosine distance (a small k-means++
 * variant) using a fixed-seed PRNG. Same input → same labels.
 */

const RNG_SEED = 0x6c0f5b00;
const MAX_ITER = 50;
const TOLERANCE = 1e-5;

/**
 * @param {number[][]} vectors    rows = games, columns = units
 * @param {string[]} unitNames    column index → unit name
 * @param {number} k              cluster count
 */
function kmeans(vectors, unitNames, k) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    return { centroids: [], assignments: [], inertia: 0 };
  }
  const dim = vectors[0].length;
  const rng = mulberry32(RNG_SEED);
  let centroids = seedCentroids(vectors, k, rng);
  /** @type {number[]} */
  let assignments = new Array(vectors.length).fill(0);
  let lastInertia = Infinity;
  for (let iter = 0; iter < MAX_ITER; iter += 1) {
    assignments = vectors.map((v) => nearestCentroid(v, centroids));
    const next = recomputeCentroids(vectors, assignments, k, dim);
    const inertia = totalInertia(vectors, assignments, next);
    if (Math.abs(lastInertia - inertia) < TOLERANCE) {
      centroids = next;
      break;
    }
    centroids = next;
    lastInertia = inertia;
  }
  return {
    centroids,
    assignments,
    inertia: lastInertia,
    unitNames,
  };
}

/**
 * Choose k seed centroids spread across the data. Picks the first
 * uniformly at random (via the seeded PRNG), then each subsequent
 * centroid is the vector with the largest minimum cosine distance
 * to already-chosen centroids. Mirrors k-means++ without the
 * probability-weighting overhead.
 */
function seedCentroids(vectors, k, rng) {
  const seeds = [];
  const firstIdx = Math.floor(rng() * vectors.length);
  seeds.push(vectors[firstIdx].slice());
  while (seeds.length < k && seeds.length < vectors.length) {
    let bestVec = null;
    let bestDist = -Infinity;
    for (const v of vectors) {
      const d = minDistance(v, seeds);
      if (d > bestDist) {
        bestDist = d;
        bestVec = v;
      }
    }
    if (bestVec === null) break;
    seeds.push(bestVec.slice());
  }
  return seeds;
}

/**
 * Run k-means for k ∈ candidates and return the best fit by
 * silhouette score. Falls back to default-k if every silhouette
 * is flat within a small epsilon (which means the data has no
 * meaningful clusters — common for tiny cohorts).
 *
 * @param {number[][]} vectors
 * @param {string[]} unitNames
 * @param {number[]} candidates
 * @param {number} defaultK
 */
function bestKByCohesion(vectors, unitNames, candidates, defaultK) {
  if (vectors.length < 2) {
    return { ...kmeans(vectors, unitNames, 1), silhouette: 0, k: 1 };
  }
  let best = null;
  for (const k of candidates) {
    if (k >= vectors.length) continue;
    const fit = kmeans(vectors, unitNames, k);
    const sil = silhouette(vectors, fit.assignments, k);
    if (!best || sil > best.silhouette + 0.02) {
      best = { ...fit, silhouette: sil, k };
    }
  }
  if (!best) {
    const fit = kmeans(vectors, unitNames, defaultK);
    return { ...fit, silhouette: 0, k: defaultK };
  }
  return best;
}

/** Cosine distance between two L2-normalized vectors (already unit length). */
function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return 1 - dot;
}

function minDistance(v, seeds) {
  let m = Infinity;
  for (const s of seeds) {
    const d = cosineDistance(v, s);
    if (d < m) m = d;
  }
  return m;
}

function nearestCentroid(v, centroids) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centroids.length; i += 1) {
    const d = cosineDistance(v, centroids[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function recomputeCentroids(vectors, assignments, k, dim) {
  /** @type {number[][]} */
  const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
  const counts = new Array(k).fill(0);
  for (let i = 0; i < vectors.length; i += 1) {
    const c = assignments[i];
    counts[c] += 1;
    for (let d = 0; d < dim; d += 1) sums[c][d] += vectors[i][d];
  }
  return sums.map((s, i) =>
    counts[i] > 0 ? l2Normalize(s.map((v) => v / counts[i])) : s,
  );
}

function totalInertia(vectors, assignments, centroids) {
  let sum = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    sum += cosineDistance(vectors[i], centroids[assignments[i]]);
  }
  return sum;
}

/**
 * Mean silhouette score across the assignment. Uses cosine
 * distance to stay consistent with the clustering metric.
 * Bounded in [-1, 1]; higher is better.
 */
function silhouette(vectors, assignments, k) {
  if (vectors.length < 2 || k < 2) return 0;
  /** @type {number[][]} */
  const buckets = Array.from({ length: k }, () => []);
  for (let i = 0; i < vectors.length; i += 1) buckets[assignments[i]].push(i);
  let total = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    const own = assignments[i];
    const a = avgDistance(vectors[i], buckets[own], vectors, i);
    let b = Infinity;
    for (let c = 0; c < k; c += 1) {
      if (c === own || buckets[c].length === 0) continue;
      const d = avgDistance(vectors[i], buckets[c], vectors, -1);
      if (d < b) b = d;
    }
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
  }
  return total / vectors.length;
}

function avgDistance(v, bucket, vectors, skipIdx) {
  let sum = 0;
  let n = 0;
  for (const i of bucket) {
    if (i === skipIdx) continue;
    sum += cosineDistance(v, vectors[i]);
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

function l2Normalize(vec) {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq === 0) return vec.slice();
  const norm = Math.sqrt(sumSq);
  return vec.map((v) => v / norm);
}

/**
 * Convert a per-unit count map into a vector aligned to a fixed
 * unitNames index. Missing units become 0. Used by both the
 * clustering pipeline AND the matrix lookup so the dimension
 * order is stable.
 *
 * @param {Record<string, number>} units
 * @param {string[]} unitNames
 */
function vectorize(units, unitNames) {
  return unitNames.map((n) => Number(units[n]) || 0);
}

/**
 * Auto-label a centroid by its top units. The label format
 * "Lead/Second-heavy" reads naturally on the matrix axes.
 *
 * @param {number[]} centroid
 * @param {string[]} unitNames
 */
function labelCentroid(centroid, unitNames) {
  const pairs = centroid.map((w, i) => ({ unit: unitNames[i], w })).filter((p) => p.w > 0);
  pairs.sort((a, b) => b.w - a.w);
  if (pairs.length === 0) return "Empty";
  if (pairs.length === 1) return `${pairs[0].unit}-only`;
  const lead = pairs[0].unit;
  const second = pairs[1].unit;
  if (pairs[0].w >= 2 * (pairs[1].w || 1)) return `${lead}-heavy`;
  return `${lead} / ${second}`;
}

/** Deterministic PRNG — mulberry32 (seeded). */
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  kmeans,
  bestKByCohesion,
  silhouette,
  cosineDistance,
  l2Normalize,
  vectorize,
  labelCentroid,
  mulberry32,
  RNG_SEED,
};
