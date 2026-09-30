import { describe, expect, it } from "vitest";
import { resolveProfile } from "../sc2-patch/profiles";
import {
  computeArmyValue,
  getUnitCost,
  isBuildingUnit,
  isWorkerUnit,
  sortedArmyComposition,
  unitMineralGasCost,
} from "../sc2-units";

describe("unit-cost catalog by patch era", () => {
  it("prices the 12-worker game (before 5.0.16, and 5.0.17 on) at the LotV base balance", () => {
    expect(getUnitCost("Queen", "after")).toMatchObject({ m: 175, g: 0, s: 2 });
    expect(getUnitCost("CommandCenter", "after")).toMatchObject({ m: 400, g: 0 });
    expect(getUnitCost("PlanetaryFortress", "after")).toMatchObject({
      m: 150,
      g: 150,
    });
    expect(getUnitCost("Ghost", "after")).toMatchObject({ m: 150, g: 125, s: 2 });
  });

  it("prices the 8-worker 5.0.16 window at 5.0.16b", () => {
    expect(getUnitCost("Queen", "before")).toMatchObject({ m: 150, g: 0, s: 2 });
    expect(getUnitCost("CommandCenter", "before")).toMatchObject({ m: 300, g: 0 });
    expect(getUnitCost("PlanetaryFortress", "before")).toMatchObject({
      m: 250,
      g: 150,
    });
    expect(getUnitCost("Ghost", "before")).toMatchObject({ m: 150, g: 125, s: 2 });
  });

  it("defaults to the live 12-worker game when the era is unknown", () => {
    expect(getUnitCost("Queen")?.m).toBe(175);
    expect(getUnitCost("Queen", null)?.m).toBe(175);
    expect(unitMineralGasCost("CommandCenter")).toBe(400);
  });

  it("derives every dataset unit from its era's resolved profile", () => {
    for (const [era, profileId] of [
      ["after", "lotv-base"],
      ["before", "5.0.16b"],
    ] as const) {
      for (const [name, def] of Object.entries(resolveProfile(profileId).units)) {
        expect(getUnitCost(name, era), `${era} ${name}`).toEqual(
          expect.objectContaining({
            m: def.minerals,
            g: def.gas,
            s: def.supply,
            race: def.race,
          }),
        );
        expect(isBuildingUnit(name), name).toBe(Boolean(def.isStructure));
      }
    }
  });

  it("prices alternate names as the unit they stand for, in either era", () => {
    for (const era of ["after", "before"] as const) {
      expect(getUnitCost("SiegeTankSieged", era)).toBe(getUnitCost("SiegeTank", era));
      expect(getUnitCost("Broodlord", era)).toBe(getUnitCost("BroodLord", era));
      expect(getUnitCost("WarpGate", era)).toBe(getUnitCost("Gateway", era));
    }
    // Suffix fallback for states the table doesn't list.
    expect(getUnitCost("QueenBurrowed", "before")?.m).toBe(150);
  });

  it("keeps the hand-priced names the dataset doesn't carry", () => {
    expect(getUnitCost("Archon", "before")).toMatchObject({ m: 100, g: 300, s: 4 });
    expect(getUnitCost("Mothership", "after")).toMatchObject({ m: 400, g: 400 });
    expect(isWorkerUnit("MULE")).toBe(true);
    // A lifted Command Center was already counted when it was built.
    expect(getUnitCost("CommandCenterFlying", "after")).toMatchObject({ m: 0, g: 0 });
    expect(getUnitCost("NotARealUnit", "after")).toBeNull();
  });
});

describe("army value by patch era", () => {
  const army = { Queen: 2, Zergling: 10, Drone: 30, Hatchery: 2 };

  it("prices the same army at each era's costs", () => {
    // 2 Queens + 10 Zerglings; workers and buildings excluded.
    expect(computeArmyValue(army, "after")).toBe(2 * 175 + 10 * 25);
    expect(computeArmyValue(army, "before")).toBe(2 * 150 + 10 * 25);
    expect(computeArmyValue(army)).toBe(computeArmyValue(army, "after"));
  });

  it("sorts and reports the roster at each era's costs", () => {
    expect(sortedArmyComposition(army, "after")).toEqual([
      { name: "Queen", count: 2, cost: 175 },
      { name: "Zergling", count: 10, cost: 25 },
    ]);
    expect(sortedArmyComposition(army, "before")[0]).toEqual({
      name: "Queen",
      count: 2,
      cost: 150,
    });
  });
});
