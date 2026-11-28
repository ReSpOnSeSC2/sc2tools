import { describe, expect, it } from "vitest";
import {
  activeMatchupCount,
  defaultRandomizerConfig,
  emptyMatchupConfig,
  matchupDraws,
  sanitizeRandomizerConfig,
  setBuildOpeningUnits,
  setBuildWeight,
  toggleBuild,
  withMatchup,
  withUnitSelected,
  withUnitWeight,
} from "@/lib/randomizer/config";
import { defaultGatewayUnits } from "@/lib/randomizer/gatewayUnits";
import {
  MATCHUPS,
  type MatchupConfig,
  type OpeningUnitsConfig,
  type RandomizerBuild,
} from "@/lib/randomizer/types";

function build(id: string, weight = 1): RandomizerBuild {
  return { id, name: id, race: "Protoss", source: "catalog", weight };
}

function switchesOf(raw: unknown, matchup: "PvZ" | "TvZ") {
  const { enabled, unitRandomizerEnabled } = sanitizeRandomizerConfig(raw).matchups[matchup];
  return { build: enabled, units: unitRandomizerEnabled };
}

describe("sanitizeRandomizerConfig", () => {
  it("returns the default config from garbage input, every draw off", () => {
    const cfg = sanitizeRandomizerConfig(null);
    expect(cfg.version).toBe(3);
    for (const m of MATCHUPS) {
      expect(cfg.matchups[m]).toEqual(emptyMatchupConfig());
    }
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
    const cfg = sanitizeRandomizerConfig({
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
    });
    const pvt = cfg.matchups.PvT;
    expect(pvt.enabled).toBe(true);
    expect(pvt.builds).toHaveLength(2);
    expect(pvt.builds[0].weight).toBe(3);
    // Bad weights coerce to a sensible default (1).
    expect(pvt.builds[1].weight).toBe(1);
  });
});

describe("the two switches keep a stored config's meaning", () => {
  it("reads an older config's unit switch as on only after a Protoss build draw", () => {
    expect(switchesOf({ version: 2, matchups: { PvZ: { enabled: false, unitRandomizerEnabled: true } } }, "PvZ"))
      .toEqual({ build: false, units: false });
    expect(switchesOf({ version: 2, matchups: { PvZ: { enabled: true } } }, "PvZ"))
      .toEqual({ build: true, units: true });
    expect(switchesOf({ version: 2, matchups: { PvZ: { enabled: true, unitRandomizerEnabled: false } } }, "PvZ"))
      .toEqual({ build: true, units: false });
    expect(switchesOf({ version: 2, matchups: { TvZ: { enabled: true, unitRandomizerEnabled: true } } }, "TvZ"))
      .toEqual({ build: true, units: false });
    expect(switchesOf({ matchups: { PvZ: { enabled: true } } }, "PvZ")).toEqual({ build: true, units: true });
  });

  it("reads version 3's switches independently, each off unless saved on", () => {
    const units = { gateCount: 1, units: [{ id: "marine", weight: 1 }] };
    expect(switchesOf({ version: 3, matchups: { TvZ: { enabled: false, unitRandomizerEnabled: true, units } } }, "TvZ"))
      .toEqual({ build: false, units: true });
    expect(switchesOf({ version: 3, matchups: { PvZ: { enabled: true } } }, "PvZ"))
      .toEqual({ build: true, units: false });
  });

  it("reads a version-3 unit switch with nothing it could draw as off", () => {
    // How an agent older than 0.26 adds a Protoss matchup to a newer config.
    expect(switchesOf({ version: 3, matchups: { PvZ: { enabled: false, unitRandomizerEnabled: true } } }, "PvZ"))
      .toEqual({ build: false, units: false });
    expect(switchesOf({ version: 3, matchups: { PvZ: { enabled: true, unitRandomizerEnabled: true } } }, "PvZ"))
      .toEqual({ build: true, units: true });
  });

  it("saves as version 3, so a saved draft reads back the same", () => {
    const draft = withMatchup(defaultRandomizerConfig(), "ZvT", {
      ...emptyMatchupConfig(), unitRandomizerEnabled: true,
      units: { gateCount: 1, useCustomWeights: false, units: [{ id: "queen", weight: 1 }] },
    });
    const saved = sanitizeRandomizerConfig(JSON.parse(JSON.stringify(draft)));
    expect(saved.version).toBe(3);
    expect(saved.matchups).toEqual(draft.matchups);
  });
});

describe("opening-unit settings", () => {
  it("migrates v1 Protoss builds to inferred opening-unit defaults", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 1,
      matchups: { PvT: { enabled: true, builds: [
        { id: "two-gate", name: "PvT - 2 Gate Blink", race: "Protoss", source: "catalog", weight: 1 },
      ] } },
    });
    expect(cfg.matchups.PvT.unitRandomizerEnabled).toBe(true);
    expect(cfg.matchups.PvT.builds[0].openingUnits).toEqual(defaultGatewayUnits(2));
  });

  it("sanitizes, de-dupes, and canonically orders a build's units", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 2,
      matchups: { PvP: { builds: [{
        id: "a", name: "PvP Macro", race: "Protoss", weight: 1,
        openingUnits: { gateCount: 9, useCustomWeights: true, units: [
          { id: "ADEPT", weight: 0 }, { id: "marine", weight: 99 },
          { id: "zealot", weight: "bad" }, { id: "adept", weight: 4 },
        ] },
      }] } },
    });
    expect(cfg.matchups.PvP.builds[0].openingUnits).toEqual({
      gateCount: 2,
      useCustomWeights: true,
      units: [{ id: "zealot", weight: 1 }, { id: "adept", weight: 4 }],
    });
  });

  it("keeps a Terran or Zerg build's own units, in its race's order and nobody else's", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 3,
      matchups: { ZvP: { builds: [
        { id: "own", name: "Ling Bane", race: "Zerg", openingUnits: {
          gateCount: 2, units: [{ id: "baneling", weight: 2 }, { id: "zealot" }, { id: "Zergling", weight: 1 }],
        } },
        { id: "older", name: "Roach", race: "Zerg" },
        { id: "wrong-race", name: "Gateway", race: "Protoss", openingUnits: defaultGatewayUnits(1) },
      ] } },
    });
    const [own, older, wrongRace] = cfg.matchups.ZvP.builds;
    expect(own.openingUnits).toEqual({
      gateCount: 2, useCustomWeights: false,
      units: [{ id: "zergling", weight: 1 }, { id: "baneling", weight: 2 }],
    });
    expect(older.openingUnits).toBeUndefined();
    expect(wrongRace.openingUnits).toBeUndefined();
  });

  it("keeps a matchup's own units absent until set up, and validates them per race", () => {
    const cfg = sanitizeRandomizerConfig({
      version: 3,
      matchups: {
        PvP: { units: { units: "everything" } },
        TvT: { units: { gateCount: 3, units: [{ id: "raven" }, { id: "roach" }, { id: "marine", weight: -1 }] } },
        ZvZ: { units: { units: "everything" } },
      },
    });
    expect(cfg.matchups.PvT.units).toBeUndefined();
    expect(cfg.matchups.PvP.units).toEqual(defaultGatewayUnits(2));
    expect(cfg.matchups.TvT.units).toEqual({
      gateCount: 1, useCustomWeights: false,
      units: [{ id: "marine", weight: 1 }, { id: "raven", weight: 1 }],
    });
    expect(cfg.matchups.ZvZ.units?.units).toEqual([]);
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

describe("opening-unit editors", () => {
  const terran: OpeningUnitsConfig = { gateCount: 1, useCustomWeights: true, units: [{ id: "banshee", weight: 1 }] };

  it("replaces one build's settings and leaves an unknown build alone", () => {
    const cfg: MatchupConfig = { ...emptyMatchupConfig(), builds: [{ ...build("a"), openingUnits: defaultGatewayUnits(1) }] };
    expect(setBuildOpeningUnits(cfg, "a", defaultGatewayUnits(2)).builds[0].openingUnits?.gateCount).toBe(2);
    expect(setBuildOpeningUnits(cfg, "missing", defaultGatewayUnits(2))).toBe(cfg);
  });

  it("selects units in the race's canonical order and clamps weights", () => {
    let opening = withUnitSelected(terran, "Terran", "marine", true);
    opening = withUnitSelected(opening, "Terran", "hellion", true);
    opening = withUnitWeight(opening, "hellion", 7.5);
    opening = withUnitWeight(opening, "marine", -4);
    expect(opening.units).toEqual([
      { id: "marine", weight: 0 }, { id: "hellion", weight: 7.5 }, { id: "banshee", weight: 1 },
    ]);
    expect(withUnitSelected(opening, "Terran", "hellion", false).units.map((unit) => unit.id))
      .toEqual(["marine", "banshee"]);
  });
});

describe("what a matchup draws", () => {
  const units: OpeningUnitsConfig = { gateCount: 1, useCustomWeights: false, units: [{ id: "roach", weight: 1 }] };

  it("draws units alone only with the build draw off and units set up", () => {
    expect(matchupDraws({ ...emptyMatchupConfig(), unitRandomizerEnabled: true, units })).toEqual({ build: false, units: true });
    expect(matchupDraws({ ...emptyMatchupConfig(), unitRandomizerEnabled: true })).toEqual({ build: false, units: false });
    expect(matchupDraws({ ...emptyMatchupConfig(), enabled: true, unitRandomizerEnabled: true, units }))
      .toEqual({ build: false, units: false });
  });

  it("counts a units-only matchup as active and an all-off one as not", () => {
    let cfg = withMatchup(defaultRandomizerConfig(), "ZvT", { ...emptyMatchupConfig(), unitRandomizerEnabled: true, units });
    expect(activeMatchupCount(cfg)).toBe(1);
    cfg = withMatchup(cfg, "PvZ", { ...emptyMatchupConfig(), enabled: true, builds: [build("a")] });
    expect(activeMatchupCount(cfg)).toBe(2);
  });
});
