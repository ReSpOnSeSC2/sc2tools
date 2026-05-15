// @ts-nocheck
"use strict";

const {
  kmeans,
  bestKByCohesion,
  silhouette,
  cosineDistance,
  l2Normalize,
  vectorize,
  labelCentroid,
  mulberry32,
  RNG_SEED,
} = require("../src/services/snapshotClustering");

describe("l2Normalize", () => {
  test("normalizes a non-zero vector to unit length", () => {
    const v = l2Normalize([3, 4]);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 5);
  });
  test("zero vector → zero vector (no NaN)", () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });
});

describe("cosineDistance", () => {
  test("identical unit vectors → 0", () => {
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0, 5);
  });
  test("orthogonal unit vectors → 1", () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 5);
  });
});

describe("vectorize", () => {
  test("aligns to provided unit-name order with zeros for missing", () => {
    expect(vectorize({ Probe: 10, Stalker: 3 }, ["Stalker", "Probe", "Zealot"]))
      .toEqual([3, 10, 0]);
  });
});

describe("kmeans (deterministic)", () => {
  test("clusters well-separated points consistently across runs", () => {
    const vectors = [
      [1, 0, 0],
      [0.95, 0.05, 0],
      [0, 1, 0],
      [0, 0.95, 0.05],
      [0, 0, 1],
      [0.05, 0, 0.95],
    ].map((v) => l2Normalize(v));
    const a = kmeans(vectors, ["x", "y", "z"], 3);
    const b = kmeans(vectors, ["x", "y", "z"], 3);
    expect(a.assignments).toEqual(b.assignments);
  });

  test("inertia decreases with more clusters", () => {
    const vectors = [];
    for (let i = 0; i < 20; i += 1) {
      vectors.push(l2Normalize([Math.sin(i), Math.cos(i), (i % 3) - 1]));
    }
    const k2 = kmeans(vectors, ["x", "y", "z"], 2);
    const k4 = kmeans(vectors, ["x", "y", "z"], 4);
    expect(k4.inertia).toBeLessThanOrEqual(k2.inertia + 1e-6);
  });
});

describe("bestKByCohesion", () => {
  test("returns a fit + silhouette + k", () => {
    const vectors = [];
    for (let i = 0; i < 12; i += 1) {
      vectors.push(l2Normalize([Math.cos(i / 2), Math.sin(i / 2), 0]));
    }
    const fit = bestKByCohesion(vectors, ["x", "y", "z"], [3, 4, 5], 4);
    expect(fit.centroids.length).toBe(fit.k);
    expect(fit.assignments.length).toBe(vectors.length);
    expect(typeof fit.silhouette).toBe("number");
  });

  test("handles tiny input gracefully", () => {
    const fit = bestKByCohesion([[1, 0, 0]], ["x", "y", "z"], [2, 3], 2);
    expect(fit.k).toBe(1);
  });
});

describe("silhouette", () => {
  test("close clusters score ≤ far-cluster baseline", () => {
    const close = [l2Normalize([1, 0]), l2Normalize([0.99, 0.01]), l2Normalize([0.98, 0.02])];
    const far = [l2Normalize([1, 0]), l2Normalize([0, 1])];
    expect(silhouette(close, [0, 0, 1], 2)).toBeLessThan(silhouette(far, [0, 1], 2));
  });
});

describe("labelCentroid", () => {
  test("label = top-unit-heavy when one unit dominates", () => {
    expect(labelCentroid([8, 0.5, 0.5], ["Stalker", "Sentry", "Phoenix"])).toBe("Stalker-heavy");
  });
  test("label = top1 / top2 when two units are roughly even", () => {
    expect(labelCentroid([5, 4, 1], ["Stalker", "Sentry", "Phoenix"])).toBe("Stalker / Sentry");
  });
  test("empty centroid → 'Empty'", () => {
    expect(labelCentroid([0, 0, 0], ["a", "b", "c"])).toBe("Empty");
  });
});

describe("mulberry32 PRNG", () => {
  test("is deterministic given the seed", () => {
    const a = mulberry32(RNG_SEED);
    const b = mulberry32(RNG_SEED);
    for (let i = 0; i < 5; i += 1) expect(a()).toBe(b());
  });
});
