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
  drawGame,
  drawOpeningUnits,
  spinResult,
} from "@/lib/randomizer/engine";
import { emptyMatchupConfig } from "@/lib/randomizer/config";
import { defaultGatewayUnits } from "@/lib/randomizer/gatewayUnits";
import {
  REVEAL_STYLES,
  UNIT_REVEAL_STYLES,
  type MatchupConfig,
  type OpeningUnitsConfig,
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
    return { ...build("gateway"), openingUnits: defaultGatewayUnits(gateCount) };
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
    const outcome = drawOpeningUnits("Protoss", defaultGatewayUnits(2), () => values.shift() ?? 0);
    expect(outcome?.gateCount).toBe(2);
    expect(outcome?.picks).toEqual(["adept", "adept"]);
    expect(outcome?.style).toBe("warp-gate");
    expect(outcome?.race).toBe("Protoss");
    expect(outcome?.probabilities).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("honours custom unit weights", () => {
    const values = [0.3, 0.99];
    const outcome = drawOpeningUnits("Protoss", {
      gateCount: 1,
      useCustomWeights: true,
      units: [{ id: "zealot", weight: 1 }, { id: "stalker", weight: 3 }],
    }, () => values.shift() ?? 0);
    expect(outcome?.picks).toEqual(["stalker"]);
    expect(outcome?.probabilities).toEqual([0.25, 0.75]);
    expect(outcome?.style).toBe("power-surge");
  });

  it("falls back to uniform odds when every custom weight is zero", () => {
    const outcome = drawOpeningUnits("Protoss", {
      gateCount: 1,
      useCustomWeights: true,
      units: [{ id: "zealot", weight: 0 }, { id: "stalker", weight: 0 }],
    }, () => 0.75);
    expect(outcome?.picks).toEqual(["stalker"]);
    expect(outcome?.probabilities).toEqual([0.5, 0.5]);
  });

  it("draws only the race's own units and skips an empty selection", () => {
    const mixed = { gateCount: 1 as const, useCustomWeights: false, units: [{ id: "zealot" as const, weight: 1 }, { id: "marine" as const, weight: 1 }] };
    expect(drawOpeningUnits("Terran", mixed, () => 0)?.pool).toEqual([{ id: "marine", weight: 1 }]);
    expect(drawOpeningUnits("Zerg", mixed, () => 0)).toBeNull();
    expect(drawOpeningUnits("Protoss", { ...mixed, units: [] })).toBeNull();
  });
});

describe("drawGame: the build and unit draws are independent switches", () => {
  function pool(race: "Protoss" | "Terran", ids: string[], units?: OpeningUnitsConfig): RandomizerBuild[] {
    return ids.map((id) => ({ ...build(id), race, ...(units ? { openingUnits: units } : {}) }));
  }
  const marineOrReaper: OpeningUnitsConfig = {
    gateCount: 2, useCustomWeights: false,
    units: [{ id: "marine", weight: 1 }, { id: "reaper", weight: 1 }],
  };

  it("draws nothing with both switches off", () => {
    expect(drawGame("TvZ", { ...emptyMatchupConfig(), builds: pool("Terran", ["a"]), units: marineOrReaper })).toBeNull();
  });

  it("draws a build alone with the unit draw off", () => {
    const cfg = { ...emptyMatchupConfig(), enabled: true, builds: pool("Terran", ["a"], marineOrReaper) };
    const drawn = drawGame("TvZ", cfg, () => 0);
    expect(drawn?.build?.winner.id).toBe("a");
    expect(drawn?.units).toBeNull();
  });

  it("draws the matchup's own units alone, from the generator's first values", () => {
    const cfg: MatchupConfig = { ...emptyMatchupConfig(), unitRandomizerEnabled: true, builds: pool("Terran", ["a"]), units: marineOrReaper };
    const values = [0.75, 0.1, 0];
    const drawn = drawGame("TvZ", cfg, () => values.shift() ?? 0);
    expect(drawn?.build).toBeNull();
    expect(drawn?.units).toMatchObject({ race: "Terran", gateCount: 2, picks: ["reaper", "marine"], style: "warp-gate" });
  });

  it("follows a drawn build with its own units after the build's two values", () => {
    const own: OpeningUnitsConfig = { ...marineOrReaper, gateCount: 1, units: [{ id: "hellion", weight: 1 }] };
    const builds = [...pool("Terran", ["a"], own), ...pool("Terran", ["b"])];
    const cfg: MatchupConfig = { ...emptyMatchupConfig(), enabled: true, unitRandomizerEnabled: true, builds, units: marineOrReaper };
    const values = [0.75, 0, 0.9, 0.1];
    const drawn = drawGame("TvZ", cfg, () => values.shift() ?? 0);
    expect(drawn?.build?.winner.id).toBe("b");
    expect(drawn?.units?.picks).toEqual(["reaper", "marine"]);
    expect(drawGame("TvZ", cfg, () => 0)?.units?.picks).toEqual(["hellion"]);
  });

  it("keeps the build-winner then build-style RNG ordering before Protoss units", () => {
    const a = { ...protossPool()[0], id: "a" };
    const b = { ...protossPool()[0], id: "b" };
    const cfg: MatchupConfig = { enabled: true, useCustomWeights: false, unitRandomizerEnabled: true, builds: [a, b] };
    const values = [0.75, 0, 0.9, 0.1, 0.5];
    const drawn = drawGame("PvP", cfg, () => values.shift() ?? 0);
    expect(drawn?.build?.winner.id).toBe("b");
    expect(drawn?.build?.style).toBe(REVEAL_STYLES[0]);
    expect(drawn?.units?.picks).toEqual(["adept", "zealot"]);
    expect(drawn?.units?.style).toBe("psi-draft");
  });

  it("draws no units for a build draw with an empty pool, or a saved pick outside the pool", () => {
    const empty: MatchupConfig = { ...emptyMatchupConfig(), enabled: true, unitRandomizerEnabled: true, units: marineOrReaper };
    expect(drawGame("TvZ", empty, () => 0)).toBeNull();
    const cfg: MatchupConfig = { ...empty, builds: pool("Terran", ["a"], marineOrReaper) };
    const stranger = { ...build("gone"), race: "Terran" as const };
    const drawn = drawGame("TvZ", cfg, () => 0, undefined, stranger);
    expect(drawn?.build?.winner.id).toBe("gone");
    expect(drawn?.units).toBeNull();
  });

  function protossPool(): RandomizerBuild[] {
    return pool("Protoss", ["p"], defaultGatewayUnits(2));
  }
});
