import { describe, expect, it } from "vitest";
import {
  effectiveWeight,
  mulberry32,
  normalizeProbabilities,
  pickIndex,
  pickRevealStyle,
  spinResult,
} from "@/lib/randomizer/engine";
import {
  REVEAL_STYLES,
  type MatchupConfig,
  type RandomizerBuild,
} from "@/lib/randomizer/types";

function build(id: string, weight = 1): RandomizerBuild {
  return {
    id,
    name: `Build ${id}`,
    race: "Protoss",
    source: "catalog",
    weight,
  };
}

describe("normalizeProbabilities", () => {
  it("normalizes to sum 1", () => {
    const probs = normalizeProbabilities([1, 2, 1]);
    expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
    expect(probs[1]).toBeCloseTo(0.5);
  });

  it("falls back to uniform when total is zero", () => {
    const probs = normalizeProbabilities([0, 0, 0]);
    expect(probs).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

describe("effectiveWeight", () => {
  it("is 1 when custom weights are off", () => {
    expect(effectiveWeight(build("a", 7), false)).toBe(1);
  });
  it("honours weight when custom weights are on", () => {
    expect(effectiveWeight(build("a", 3), true)).toBe(3);
  });
  it("clamps non-positive weights to 0", () => {
    expect(effectiveWeight(build("a", -2), true)).toBe(0);
    expect(effectiveWeight(build("a", Number.NaN), true)).toBe(0);
  });
});

describe("pickIndex", () => {
  it("respects probability distribution", () => {
    // First half always lands index 0, second always index 1.
    expect(pickIndex([0.5, 0.5], () => 0.1)).toBe(0);
    expect(pickIndex([0.5, 0.5], () => 0.9)).toBe(1);
  });

  it("never returns out-of-bounds", () => {
    expect(pickIndex([0.3, 0.7], () => 0.999999)).toBe(1);
  });
});

describe("pickRevealStyle", () => {
  it("returns one of the known styles", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 20; i += 1) {
      const style = pickRevealStyle(rng);
      expect(REVEAL_STYLES).toContain(style);
    }
  });

  it("avoids the requested style when possible", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i += 1) {
      const style = pickRevealStyle(rng, "wheel");
      expect(style).not.toBe("wheel");
    }
  });
});

describe("spinResult", () => {
  const cfgEnabled = (
    builds: RandomizerBuild[],
    useCustomWeights = false,
  ): MatchupConfig => ({
    enabled: true,
    useCustomWeights,
    builds,
  });

  it("returns null when disabled or empty", () => {
    expect(spinResult("PvT", undefined)).toBeNull();
    expect(
      spinResult("PvT", { enabled: false, useCustomWeights: false, builds: [] }),
    ).toBeNull();
    expect(spinResult("PvT", cfgEnabled([]))).toBeNull();
  });

  it("uses equal probabilities by default", () => {
    const outcome = spinResult(
      "PvT",
      cfgEnabled([build("a"), build("b"), build("c", 99)]),
    );
    expect(outcome).not.toBeNull();
    for (const p of outcome!.probabilities) expect(p).toBeCloseTo(1 / 3);
  });

  it("respects custom weights when enabled", () => {
    const outcome = spinResult(
      "PvT",
      cfgEnabled([build("a", 1), build("b", 3)], true),
    );
    expect(outcome!.probabilities[0]).toBeCloseTo(0.25);
    expect(outcome!.probabilities[1]).toBeCloseTo(0.75);
  });

  it("lands on a build inside the pool", () => {
    const rng = mulberry32(7);
    const outcome = spinResult("PvP", cfgEnabled([build("a"), build("b")]), rng);
    expect(outcome).not.toBeNull();
    expect(["a", "b"]).toContain(outcome!.winner.id);
  });
});
