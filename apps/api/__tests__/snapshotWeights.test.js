// @ts-nocheck
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  loadWeights,
  assertValid,
  assertWeightsSum,
  phaseForTick,
  weightsFor,
  writeWeights,
  applyPresetDelta,
  PHASE_NAMES,
  METRIC_KEYS,
  SUM_TOLERANCE,
  DEFAULT_PATH,
} = require("../src/services/snapshotWeights");

describe("snapshotWeights", () => {
  test("loadWeights returns a validated config", () => {
    const cfg = loadWeights();
    expect(cfg).toBeTruthy();
    expect(cfg.phases.early).toBeDefined();
    expect(cfg.phases.mid).toBeDefined();
    expect(cfg.phases.late).toBeDefined();
  });

  test("every phase sums to 1.000 ± SUM_TOLERANCE", () => {
    const cfg = loadWeights();
    for (const phase of PHASE_NAMES) {
      let total = 0;
      for (const k of METRIC_KEYS) total += cfg.phases[phase].weights[k];
      expect(Math.abs(total - 1)).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  test("phaseForTick picks the right phase", () => {
    const cfg = loadWeights();
    expect(phaseForTick(cfg, 0)).toBe("early");
    expect(phaseForTick(cfg, 240)).toBe("early");
    expect(phaseForTick(cfg, 480)).toBe("mid");
    expect(phaseForTick(cfg, 1199)).toBe("mid");
    expect(phaseForTick(cfg, 1200)).toBe("late");
    expect(phaseForTick(cfg, 5000)).toBe("late");
  });

  test("weightsFor respects override when provided", () => {
    const cfg = loadWeights();
    const override = {
      phases: {
        mid: {
          tickRange: [480, 1200],
          weights: METRIC_KEYS.reduce(
            (acc, k) => ({ ...acc, [k]: k === "workers" ? 1 : 0 }),
            {},
          ),
        },
      },
    };
    const { weights } = weightsFor(cfg, 600, override);
    expect(weights.workers).toBe(1);
    expect(weights.army_value).toBe(0);
  });

  test("assertValid rejects a phase whose weights don't sum to 1", () => {
    expect(() =>
      assertValid({
        phases: {
          early: { tickRange: [0, 480], weights: bogusWeights() },
          mid: { tickRange: [480, 1200], weights: defaultWeights() },
          late: { tickRange: [1200, 2400], weights: defaultWeights() },
        },
      }),
    ).toThrow(/weights sum/);
  });

  test("assertWeightsSum rejects out-of-range metric values", () => {
    const bad = { ...defaultWeights(), workers: 2 };
    expect(() => assertWeightsSum(bad, "test")).toThrow(/out of \[0,1\]/);
  });

  test("assertValid rejects a phase missing a required metric", () => {
    const missing = defaultWeights();
    delete missing.workers;
    expect(() =>
      assertValid({
        phases: {
          early: { tickRange: [0, 480], weights: missing },
          mid: { tickRange: [480, 1200], weights: defaultWeights() },
          late: { tickRange: [1200, 2400], weights: defaultWeights() },
        },
      }),
    ).toThrow(/missing metric/);
  });

  test("applyPresetDelta clamps negatives to zero and re-normalizes", () => {
    const base = defaultWeights();
    const result = applyPresetDelta(base, { workers: 0.05, army_value: -0.95 });
    let total = 0;
    for (const k of METRIC_KEYS) total += result[k];
    expect(Math.abs(total - 1)).toBeLessThanOrEqual(1e-6);
    expect(result.army_value).toBeGreaterThanOrEqual(0);
  });

  test("writeWeights atomically updates + bumps version", () => {
    const cfg = loadWeights();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshotWeights-"));
    const filePath = path.join(tmpDir, "snapshotWeights.json");
    fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
    const next = writeWeights(filePath, cfg);
    expect(next.version).toBe(cfg.version + 1);
    const reloaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(reloaded.version).toBe(next.version);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

function defaultWeights() {
  const cfg = loadWeights();
  return { ...cfg.phases.mid.weights };
}

function bogusWeights() {
  const w = defaultWeights();
  w.workers = w.workers + 0.5;
  return w;
}
