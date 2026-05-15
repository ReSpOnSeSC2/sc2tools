// @ts-nocheck
"use strict";

const {
  SnapshotCalibrateService,
  buildMatrix,
  ridgeRegression,
  partialCorrelations,
  normalizeWeights,
  withinDelta,
  resultToBinary,
  pearson,
} = require("../src/services/snapshotCalibrate");
const { METRIC_KEYS, loadWeights } = require("../src/services/snapshotWeights");

describe("buildMatrix", () => {
  test("stacks per-(game, tick) rows inside the phase range", () => {
    const games = [
      {
        result: "Victory",
        tickScores: [
          { t: 100, my: { scores: { workers: 1 } } },
          { t: 500, my: { scores: { workers: 2 } } },
        ],
      },
      {
        result: "Defeat",
        tickScores: [
          { t: 100, my: { scores: { workers: -1 } } },
          { t: 600, my: { scores: { workers: -2 } } },
        ],
      },
    ];
    const { X, y, included } = buildMatrix(games, [0, 480]);
    expect(included).toBe(2);
    expect(X.length).toBe(2);
    expect(y).toEqual([1, 0]);
  });

  test("skips ties", () => {
    const games = [{ result: "Tie", tickScores: [{ t: 100, my: { scores: { workers: 1 } } }] }];
    const { X, y } = buildMatrix(games, [0, 480]);
    expect(X.length).toBe(0);
    expect(y.length).toBe(0);
  });
});

describe("ridgeRegression", () => {
  test("recovers a near-correct coefficient on linear data", () => {
    // y ≈ 0.7 * x_workers
    const X = [];
    const y = [];
    for (let i = -5; i <= 5; i += 1) {
      const row = new Array(METRIC_KEYS.length).fill(0);
      row[METRIC_KEYS.indexOf("workers")] = i;
      X.push(row);
      y.push(0.7 * i);
    }
    const coef = ridgeRegression(X, y, 0.1);
    expect(coef.workers).toBeGreaterThan(0.5);
    expect(coef.workers).toBeLessThan(1.0);
  });
});

describe("partialCorrelations", () => {
  test("attenuates a redundant feature", () => {
    const X = [];
    const y = [];
    for (let i = -10; i <= 10; i += 1) {
      const row = new Array(METRIC_KEYS.length).fill(0);
      // Two features perfectly correlated; only one carries unique signal.
      row[METRIC_KEYS.indexOf("workers")] = i;
      row[METRIC_KEYS.indexOf("bases")] = i;
      X.push(row);
      y.push(i > 0 ? 1 : 0);
    }
    const partials = partialCorrelations(X, y);
    // With workers and bases perfectly collinear, the partial of each
    // controlling for the other should be near zero (they share the signal).
    expect(Math.abs(partials.workers)).toBeLessThan(0.4);
  });
});

describe("normalizeWeights", () => {
  test("sums to 1 and clips negatives to 0", () => {
    const coef = METRIC_KEYS.reduce(
      (acc, k) => ({ ...acc, [k]: k === "workers" ? -0.5 : 0.2 }),
      {},
    );
    const norm = normalizeWeights(coef);
    let total = 0;
    for (const k of METRIC_KEYS) total += norm[k];
    expect(Math.abs(total - 1)).toBeLessThan(1e-6);
    expect(norm.workers).toBe(0);
  });

  test("falls back to uniform on all-zero coefficients", () => {
    const coef = METRIC_KEYS.reduce((acc, k) => ({ ...acc, [k]: 0 }), {});
    const norm = normalizeWeights(coef);
    const expected = 1 / METRIC_KEYS.length;
    for (const k of METRIC_KEYS) expect(norm[k]).toBeCloseTo(expected, 6);
  });
});

describe("withinDelta sanity gate", () => {
  const cfg = loadWeights();
  test("passes when all deltas under threshold", () => {
    const current = cfg.phases.mid.weights;
    const next = { ...current };
    expect(withinDelta(current, next, 0.1).passed).toBe(true);
  });

  test("trips when one delta exceeds threshold", () => {
    const current = cfg.phases.mid.weights;
    const next = { ...current, workers: current.workers + 0.5 };
    const result = withinDelta(current, next, 0.1);
    expect(result.passed).toBe(false);
    expect(result.violations[0].metric).toBe("workers");
  });
});

describe("SnapshotCalibrateService.calibrate", () => {
  test("returns one report per phase + recommended weights", () => {
    const games = [];
    for (let g = 0; g < 60; g += 1) {
      const isWin = g % 2 === 0;
      const tickScores = [];
      for (let t = 0; t <= 1200; t += 30) {
        const row = { t, my: { scores: {} } };
        for (const k of METRIC_KEYS) {
          row.my.scores[k] = isWin ? 1 + (g % 3) : -1 - (g % 3);
        }
        tickScores.push(row);
      }
      games.push({ result: isWin ? "Victory" : "Defeat", tickScores });
    }
    const svc = new SnapshotCalibrateService();
    const report = svc.calibrate(games);
    expect(report.perPhase.early).toBeDefined();
    expect(report.perPhase.mid).toBeDefined();
    expect(report.perPhase.late).toBeDefined();
    for (const phase of ["early", "mid", "late"]) {
      const p = report.perPhase[phase];
      if (p.skipped) continue;
      let total = 0;
      for (const k of METRIC_KEYS) total += p.recommendedWeights[k];
      expect(Math.abs(total - 1)).toBeLessThan(1e-6);
    }
  });
});

describe("resultToBinary", () => {
  test("Victory → 1", () => expect(resultToBinary("Victory")).toBe(1));
  test("Defeat → 0", () => expect(resultToBinary("Defeat")).toBe(0));
  test("Tie → null", () => expect(resultToBinary("Tie")).toBeNull());
});

describe("pearson", () => {
  test("perfect positive correlation → ~1", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 5);
  });
  test("perfect negative correlation → ~-1", () => {
    expect(pearson([1, 2, 3], [-2, -4, -6])).toBeCloseTo(-1, 5);
  });
});
