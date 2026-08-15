import { describe, expect, it } from "vitest";
import {
  effectiveWeight,
  effectiveOpeningUnitWeight,
  mulberry32,
  normalizeProbabilities,
  pickIndex,
  pickRevealStyle,
  pickUnitRevealStyle,
  seedFromString,
  spinOpeningUnits,
  spinResult,
} from "@/lib/randomizer/engine";
import { defaultOpeningUnits } from "@/lib/randomizer/gatewayUnits";
import {
  REVEAL_STYLES,
  UNIT_REVEAL_STYLES,
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
    unitRandomizerEnabled: false,
    builds,
  });

  it("returns null when disabled or empty", () => {
    expect(spinResult("PvT", undefined)).toBeNull();
    expect(
      spinResult("PvT", {
        enabled: false,
        useCustomWeights: false,
        unitRandomizerEnabled: false,
        builds: [],
      }),
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

describe("seedFromString", () => {
  it("returns stable unsigned FNV-1a seeds", () => {
    expect(seedFromString("")).toBe(2166136261);
    expect(seedFromString("PvT:game-123")).toBe(3952564394);
    expect(seedFromString("PvP:test:PvP")).toBe(3730190309);
  });

  it("feeds reproducible mulberry32 sequences", () => {
    const a = mulberry32(seedFromString("same-game"));
    const b = mulberry32(seedFromString("same-game"));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("opening-unit randomizer", () => {
  function protossBuild(gateCount: 1 | 2 = 1): RandomizerBuild {
    return { ...build("gateway"), openingUnits: defaultOpeningUnits(gateCount) };
  }

  it("uses equal odds when custom weights are off", () => {
    expect(effectiveOpeningUnitWeight({ id: "zealot", weight: 99 }, false)).toBe(1);
  });

  it("uses positive custom weights and treats invalid values as zero", () => {
    expect(effectiveOpeningUnitWeight({ id: "stalker", weight: 3 }, true)).toBe(3);
    expect(effectiveOpeningUnitWeight({ id: "sentry", weight: -1 }, true)).toBe(0);
  });

  it("chooses only one of the three unit reveal styles", () => {
    for (const n of [0, 0.34, 0.99]) {
      expect(UNIT_REVEAL_STYLES).toContain(pickUnitRevealStyle(() => n));
    }
  });

  it("rolls two independent picks with replacement", () => {
    const values = [0.8, 0.8, 0];
    const outcome = spinOpeningUnits(protossBuild(2), true, () => values.shift() ?? 0);
    expect(outcome?.gateCount).toBe(2);
    expect(outcome?.picks).toEqual(["adept", "adept"]);
    expect(outcome?.style).toBe("warp-gate");
    expect(outcome?.probabilities).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("honours custom unit weights", () => {
    const candidate = protossBuild();
    candidate.openingUnits = {
      gateCount: 1,
      useCustomWeights: true,
      units: [
        { id: "zealot", weight: 1 },
        { id: "stalker", weight: 3 },
      ],
    };
    const values = [0.3, 0.99];
    const outcome = spinOpeningUnits(candidate, true, () => values.shift() ?? 0);
    expect(outcome?.picks).toEqual(["stalker"]);
    expect(outcome?.probabilities).toEqual([0.25, 0.75]);
    expect(outcome?.style).toBe("power-surge");
  });

  it("falls back to uniform odds when every custom weight is zero", () => {
    const candidate = protossBuild();
    candidate.openingUnits = {
      gateCount: 1,
      useCustomWeights: true,
      units: [
        { id: "zealot", weight: 0 },
        { id: "stalker", weight: 0 },
      ],
    };
    const outcome = spinOpeningUnits(candidate, true, () => 0.75);
    expect(outcome?.picks).toEqual(["stalker"]);
    expect(outcome?.probabilities).toEqual([0.5, 0.5]);
  });

  it("skips disabled, non-Protoss, missing, and empty configurations", () => {
    expect(spinOpeningUnits(protossBuild(), false)).toBeNull();
    expect(spinOpeningUnits({ ...protossBuild(), race: "Terran" }, true)).toBeNull();
    expect(spinOpeningUnits(build("plain"), true)).toBeNull();
    const empty = protossBuild();
    empty.openingUnits = { gateCount: 1, useCustomWeights: false, units: [] };
    expect(spinOpeningUnits(empty, true)).toBeNull();
  });

  it("preserves build-winner then build-style RNG ordering before unit draws", () => {
    const a = protossBuild(2);
    a.id = "a";
    const b = protossBuild(2);
    b.id = "b";
    const cfg: MatchupConfig = {
      enabled: true,
      useCustomWeights: false,
      unitRandomizerEnabled: true,
      builds: [a, b],
    };
    const values = [0.75, 0, 0.9, 0.1, 0.5];
    const outcome = spinResult("PvP", cfg, () => values.shift() ?? 0);
    expect(outcome?.winner.id).toBe("b");
    expect(outcome?.style).toBe(REVEAL_STYLES[0]);
    expect(outcome?.openingUnits?.picks).toEqual(["adept", "zealot"]);
    expect(outcome?.openingUnits?.style).toBe("psi-draft");
  });
});
