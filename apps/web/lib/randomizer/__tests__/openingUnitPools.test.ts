import { describe, expect, it } from "vitest";
import catalog from "../../build-definitions.generated.json";
import preset from "../../../../api/src/config/presetCatalog.json";
import {
  MATCHUP_UNIT_POOLS,
  defaultBuildOpeningUnits,
  defaultMatchupUnits,
  unitIconId,
  unitIconIdsIn,
} from "../openingUnitPools";
import { OPENING_UNITS, openingUnitMeta } from "../openingUnits";
import {
  GATEWAY_UNIT_IDS,
  MATCHUPS,
  OPENING_UNIT_IDS,
  playedRace,
  type MatchupKey,
} from "../types";

type Prerequisites = string[][];
const PREREQUISITES = preset.unitTechPrerequisites as Record<string, Prerequisites>;

/** The preset catalog's prerequisites by icon id; sc2reader keeps a mode
 * or multiplayer suffix on two names ("VikingFighter", "SwarmHostMP"). */
function prerequisitesByIconId(): Map<string, Prerequisites> {
  const byId = new Map<string, Prerequisites>();
  for (const [unit, alternatives] of Object.entries(PREREQUISITES)) {
    const id = unitIconId(unit) ?? unitIconId(unit.replace(/(Fighter|MP)$/, ""));
    if (id) byId.set(id, alternatives);
  }
  return byId;
}

/** The derivation the pools document: units named by the matchup's own
 * pre-made builds that a single production structure makes. */
function derivedPool(matchup: MatchupKey): Set<string> {
  const prerequisites = prerequisitesByIconId();
  const named = catalog.definitions
    .filter((definition) => definition.matchup === matchup)
    .flatMap((definition) => unitIconIdsIn(definition.name));
  return new Set(named.filter((id) => {
    const needs = prerequisites.get(id);
    return needs !== undefined && needs.length === 1 && needs[0].length === 1;
  }));
}

const plain = (value: string) => value.replace(/\s+/g, "").toLowerCase();
const CATALOG_MATCHUPS = MATCHUPS.filter((matchup) => playedRace(matchup) !== "Protoss");

describe("each matchup's opening units", () => {
  it.each(CATALOG_MATCHUPS)("%s draws what its own pre-made builds are named for", (matchup) => {
    expect(new Set(MATCHUP_UNIT_POOLS[matchup])).toEqual(derivedPool(matchup));
    const order = OPENING_UNIT_IDS[playedRace(matchup)];
    expect([...MATCHUP_UNIT_POOLS[matchup]]).toEqual(order.filter((id) => MATCHUP_UNIT_POOLS[matchup].includes(id)));
  });

  it("keeps Protoss on its four Gateway units in every matchup", () => {
    for (const matchup of ["PvP", "PvT", "PvZ"] as const) expect(MATCHUP_UNIT_POOLS[matchup]).toBe(GATEWAY_UNIT_IDS);
  });

  it("differs by matchup, never one list per race", () => {
    expect(MATCHUP_UNIT_POOLS.TvZ).toContain("hellion");
    expect(MATCHUP_UNIT_POOLS.TvP).not.toContain("hellion");
    expect(MATCHUP_UNIT_POOLS.ZvT).toContain("queen");
    expect(MATCHUP_UNIT_POOLS.ZvZ).not.toContain("queen");
  });

  it("knows exactly the Terran and Zerg units some matchup draws, nothing invented", () => {
    for (const race of ["Terran", "Zerg"] as const) {
      const drawn = new Set(CATALOG_MATCHUPS.filter((m) => playedRace(m) === race).flatMap((m) => [...derivedPool(m)]));
      expect(new Set(OPENING_UNIT_IDS[race])).toEqual(drawn);
    }
  });

  it("names each unit's structure as the preset catalog does", () => {
    const prerequisites = prerequisitesByIconId();
    for (const unit of OPENING_UNITS.filter((entry) => entry.race !== "Protoss")) {
      expect(plain(unit.building)).toBe(plain(prerequisites.get(unit.id)?.[0]?.[0] ?? ""));
    }
    expect(openingUnitMeta("stalker").building).toBe("Gateway");
  });
});

describe("reading units from a build name", () => {
  it("reads full names, two-word names, short names and plurals", () => {
    expect(unitIconIdsIn("TvZ - Widow Mine Marine")).toEqual(["widowmine", "marine"]);
    expect(unitIconIdsIn("TvP - Tank/Thor Mech")).toEqual(["siegetank", "thor"]);
    expect(unitIconIdsIn("ZvT - 3 Hatch Ling Bane Muta")).toEqual(["zergling", "baneling", "mutalisk"]);
    expect(unitIconIdsIn("Mass Marines into Roaches")).toEqual(["marine", "roach"]);
  });

  it("skips structures, upgrades and plain words", () => {
    expect(unitIconIdsIn("ZvZ - 12 Pool into Baneling")).toEqual(["baneling"]);
    expect(unitIconIdsIn("TvP - 1-1-1 Cloak Banshee")).toEqual(["banshee"]);
    expect(unitIconIdsIn("Proxy Rax Bust")).toEqual([]);
  });
});

describe("a new build's unit draw", () => {
  it("draws the units its name names, two for a two-building opener", () => {
    expect(defaultBuildOpeningUnits("TvZ", "TvZ - Reaper Hellion Expand")).toEqual({
      gateCount: 2, useCustomWeights: false,
      units: [{ id: "reaper", weight: 1 }, { id: "hellion", weight: 1 }],
    });
    expect(defaultBuildOpeningUnits("ZvP", "ZvP - Ling Bane Bust").gateCount).toBe(2);
    expect(defaultBuildOpeningUnits("ZvP", "ZvP - 2 Base Roach Ravager All-in")).toMatchObject({
      gateCount: 1, units: [{ id: "roach" }, { id: "ravager" }],
    });
  });

  it("draws from the whole matchup list when its name names none of it", () => {
    for (const name of ["TvZ - 3 CC Bio", "TvZ - 2 Base Hellbat Thor"]) {
      const opening = defaultBuildOpeningUnits("TvZ", name);
      expect(opening.units.map((unit) => unit.id)).toEqual(MATCHUP_UNIT_POOLS.TvZ);
      expect(opening.gateCount).toBe(1);
    }
  });

  it("keeps the Protoss Gateway rules", () => {
    expect(defaultBuildOpeningUnits("PvP", "PvP - 1 Gate Expand").gateCount).toBe(1);
    expect(defaultBuildOpeningUnits("PvT", "PvT - Robo").units.map((unit) => unit.id)).toEqual([...GATEWAY_UNIT_IDS]);
  });

  it("sets each matchup's own default: two for PvP, one elsewhere", () => {
    expect(defaultMatchupUnits("PvP").gateCount).toBe(2);
    expect(defaultMatchupUnits("PvZ").gateCount).toBe(1);
    expect(defaultMatchupUnits("ZvT").units.map((unit) => unit.id)).toEqual(MATCHUP_UNIT_POOLS.ZvT);
    expect(defaultMatchupUnits("ZvT").gateCount).toBe(1);
  });
});
