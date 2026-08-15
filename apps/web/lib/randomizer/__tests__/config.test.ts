import { describe, expect, it } from "vitest";
import {
  defaultRandomizerConfig,
  sanitizeRandomizerConfig,
  setBuildOpeningUnits,
  setBuildWeight,
  setOpeningUnitCustomWeights,
  setOpeningUnitGateCount,
  setOpeningUnitWeight,
  setUnitRandomizerEnabled,
  toggleOpeningUnit,
  toggleBuild,
} from "@/lib/randomizer/config";
import { defaultOpeningUnits } from "@/lib/randomizer/gatewayUnits";
import {
  MATCHUPS,
  type MatchupConfig,
  type RandomizerBuild,
} from "@/lib/randomizer/types";

function build(id: string, weight = 1): RandomizerBuild {
  return { id, name: id, race: "Protoss", source: "catalog", weight };
}

describe("sanitizeRandomizerConfig", () => {
  it("returns the default config from garbage input", () => {
    const cfg = sanitizeRandomizerConfig(null);
    expect(cfg.version).toBe(2);
    for (const m of MATCHUPS) {
      expect(cfg.matchups[m].enabled).toBe(false);
      expect(cfg.matchups[m].builds).toEqual([]);
      expect(cfg.matchups[m].unitRandomizerEnabled).toBe(m.startsWith("P"));
    }
    // Sound defaults: on, 60%.
    expect(cfg.matchups).toBeDefined();
    expect(cfg.sound.enabled).toBe(true);
    expect(cfg.sound.volume).toBeCloseTo(0.6);
  });

  it("sanitizes the sound block (clamps volume, defaults enabled)", () => {
    const cfg = sanitizeRandomizerConfig({
      sound: { enabled: false, volume: 5 },
    });
    expect(cfg.sound.enabled).toBe(false);
    expect(cfg.sound.volume).toBe(1); // clamped to 0..1
    const cfg2 = sanitizeRandomizerConfig({ sound: { volume: -3 } });
    expect(cfg2.sound.enabled).toBe(true); // only `false` disables
    expect(cfg2.sound.volume).toBe(0);
  });

  it("drops invalid builds and clamps weights", () => {
    const raw = {
      matchups: {
        PvT: {
          enabled: true,
          useCustomWeights: true,
          builds: [
            { id: "a", name: "Build A", race: "Protoss", weight: 3 },
            { id: "", name: "no-id" },
            { name: "no-id" },
            { id: "b", name: "Build B", race: "Protoss", weight: -2 },
          ],
        },
      },
    };
    const cfg = sanitizeRandomizerConfig(raw);
    const pvt = cfg.matchups.PvT;
    expect(pvt.enabled).toBe(true);
    expect(pvt.builds).toHaveLength(2);
    expect(pvt.builds[0].weight).toBe(3);
    // Bad weights coerce to a sensible default (1).
    expect(pvt.builds[1].weight).toBe(1);
  });

  it("migrates v1 Protoss builds to inferred opening-unit defaults", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 1,
      matchups: {
        PvT: {
          enabled: true,
          builds: [
            {
              id: "two-gate",
              name: "PvT - 2 Gate Blink",
              race: "Protoss",
              source: "catalog",
              weight: 1,
            },
          ],
        },
      },
    });
    expect(cfg.version).toBe(2);
    expect(cfg.matchups.PvT.unitRandomizerEnabled).toBe(true);
    expect(cfg.matchups.PvT.builds[0].openingUnits).toEqual(
      defaultOpeningUnits(2),
    );
  });

  it("sanitizes, de-dupes, and canonically orders fixed unit entries", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 2,
      matchups: {
        PvP: {
          unitRandomizerEnabled: false,
          builds: [
            {
              id: "a",
              name: "PvP Macro",
              race: "Protoss",
              weight: 1,
              openingUnits: {
                gateCount: 9,
                useCustomWeights: true,
                units: [
                  { id: "ADEPT", weight: 0 },
                  { id: "marine", weight: 99 },
                  { id: "zealot", weight: "bad" },
                  { id: "adept", weight: 4 },
                ],
              },
            },
          ],
        },
      },
    });
    const opening = cfg.matchups.PvP.builds[0].openingUnits;
    expect(cfg.matchups.PvP.unitRandomizerEnabled).toBe(false);
    expect(opening).toEqual({
      gateCount: 2,
      useCustomWeights: true,
      units: [
        { id: "zealot", weight: 1 },
        { id: "adept", weight: 4 },
      ],
    });
  });

  it("never carries Gateway-unit settings on a non-Protoss build", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 2,
      matchups: {
        TvZ: {
          unitRandomizerEnabled: true,
          builds: [
            {
              id: "bio",
              name: "2 Gate somehow",
              race: "Terran",
              weight: 1,
              openingUnits: defaultOpeningUnits(2),
            },
          ],
        },
      },
    });
    expect(cfg.matchups.TvZ.unitRandomizerEnabled).toBe(true);
    expect(cfg.matchups.TvZ.builds[0].openingUnits).toBeUndefined();
  });
});

describe("toggleBuild", () => {
  const base = defaultRandomizerConfig().matchups.PvP;

  it("adds and removes builds", () => {
    const a = build("a");
    const added = toggleBuild(base, a, true);
    expect(added.builds.map((b) => b.id)).toEqual(["a"]);
    const removed = toggleBuild(added, a, false);
    expect(removed.builds).toEqual([]);
  });

  it("is idempotent on duplicate add", () => {
    const a = build("a");
    const once = toggleBuild(base, a, true);
    const twice = toggleBuild(once, a, true);
    expect(twice.builds).toHaveLength(1);
  });
});

describe("setBuildWeight", () => {
  it("updates the matching id only", () => {
    const cfg = {
      ...defaultRandomizerConfig().matchups.PvP,
      builds: [build("a", 1), build("b", 2)],
    };
    const next = setBuildWeight(cfg, "a", 5);
    expect(next.builds.find((b) => b.id === "a")?.weight).toBe(5);
    expect(next.builds.find((b) => b.id === "b")?.weight).toBe(2);
  });
});

describe("opening-unit config mutators", () => {
  function matchupWithOpening(): MatchupConfig {
    return {
      ...defaultRandomizerConfig().matchups.PvT,
      builds: [{ ...build("a"), openingUnits: defaultOpeningUnits(1) }],
    };
  }

  it("toggles the matchup-level second stage", () => {
    expect(setUnitRandomizerEnabled(matchupWithOpening(), false).unitRandomizerEnabled)
      .toBe(false);
  });

  it("replaces and updates gate-count/custom-weight settings", () => {
    const replaced = setBuildOpeningUnits(
      matchupWithOpening(),
      "a",
      { gateCount: 2, useCustomWeights: false, units: [{ id: "stalker", weight: 1 }] },
    );
    const gated = setOpeningUnitGateCount(replaced, "a", 1);
    const weighted = setOpeningUnitCustomWeights(gated, "a", true);
    expect(weighted.builds[0].openingUnits).toEqual({
      gateCount: 1,
      useCustomWeights: true,
      units: [{ id: "stalker", weight: 1 }],
    });
  });

  it("selects units in canonical order and updates non-negative weights", () => {
    let cfg = matchupWithOpening();
    cfg = toggleOpeningUnit(cfg, "a", "stalker", false);
    cfg = toggleOpeningUnit(cfg, "a", "stalker", true);
    cfg = setOpeningUnitWeight(cfg, "a", "stalker", 7.5);
    cfg = setOpeningUnitWeight(cfg, "a", "adept", -4);
    expect(cfg.builds[0].openingUnits?.units.map((unit) => unit.id)).toEqual([
      "zealot",
      "stalker",
      "sentry",
      "adept",
    ]);
    expect(cfg.builds[0].openingUnits?.units.find((u) => u.id === "stalker")?.weight)
      .toBe(7.5);
    expect(cfg.builds[0].openingUnits?.units.find((u) => u.id === "adept")?.weight)
      .toBe(0);
  });

  it("is a no-op for an unknown build", () => {
    const cfg = matchupWithOpening();
    expect(setOpeningUnitGateCount(cfg, "missing", 2)).toBe(cfg);
  });
});
