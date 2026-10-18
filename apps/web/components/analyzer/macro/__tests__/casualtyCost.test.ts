import { describe, expect, it } from "vitest";
import { casualtyCost } from "../casualtyCost";
import { profileIdForEra, resolveProfile } from "@/lib/sc2-patch/profiles";

describe("casualtyCost", () => {
  it.each([
    ["Probe", 50, 0], ["SCV", 50, 0], ["DroneBurrowed", 50, 0],
    ["Marine", 50, 0], ["SiegeTankSieged", 150, 125], ["StalkerWarp", 125, 50],
    ["HellionTank", 100, 0], ["GhostAlternate", 150, 125],
  ])("prices one %s without charging for its producer", (name, minerals, gas) => {
    expect(casualtyCost(name as string)).toEqual({ minerals, gas });
  });

  it.each([
    ["BanelingBurrowed", 50, 25], ["Ravager", 100, 100],
    ["LurkerMPBurrowed", 150, 150], ["Broodlord", 300, 250],
    ["OverseerSiegeMode", 150, 50], ["Archon", 100, 300],
  ])("includes consumed units in the full investment of %s", (name, minerals, gas) => {
    expect(casualtyCost(name as string)).toEqual({ minerals, gas });
  });

  it.each([
    ["Hatchery", 350, 0], ["Lair", 500, 100], ["Hive", 700, 250],
    ["Spire", 250, 200], ["GreaterSpire", 350, 350],
    ["SpineCrawlerUprooted", 150, 0], ["SporeCrawlerUprooted", 125, 0],
    ["LurkerDenMP", 150, 150], ["ExtractorRich", 75, 0],
    ["NydusNetwork", 200, 200],
  ])("includes exactly one consumed Drone in %s", (name, minerals, gas) => {
    expect(casualtyCost(name as string)).toEqual({ minerals, gas });
  });

  it.each([
    ["CommandCenterFlying", 400, 0], ["OrbitalCommandFlying", 550, 0],
    ["PlanetaryFortress", 550, 150], ["FactoryFlying", 150, 100],
    ["BarracksFlying", 150, 0], ["StarportFlying", 150, 100],
    ["SupplyDepotLowered", 100, 0], ["WarpGate", 150, 0],
    ["TemplarArchive", 150, 200], ["TechLab", 50, 25],
    ["Reactor", 50, 50], ["SensorTower", 125, 100], ["NydusCanal", 50, 50],
  ])("prices %s as its full structure investment", (name, minerals, gas) => {
    expect(casualtyCost(name as string)).toEqual({ minerals, gas });
  });

  it("uses the replay's patch costs, including the WarpGate transformation", () => {
    expect(casualtyCost("Queen", "before")).toEqual({ minerals: 150, gas: 0 });
    expect(casualtyCost("Queen", "after")).toEqual({ minerals: 175, gas: 0 });
    expect(casualtyCost("Queen", null)).toEqual({ minerals: 175, gas: 0 });
    expect(casualtyCost("WarpGate", "before")).toEqual({ minerals: 175, gas: 25 });
    expect(casualtyCost("WarpGate", "after")).toEqual({ minerals: 150, gas: 0 });
  });

  it("covers the complete profile catalog without conflating missing prices and zero", () => {
    for (const era of ["before", "after"] as const) {
      const profile = resolveProfile(profileIdForEra(era));
      for (const name of Object.keys(profile.units)) {
        const cost = casualtyCost(name, era);
        expect(cost, `${era}: ${name}`).not.toBeNull();
        expect(cost!.minerals).toBeGreaterThanOrEqual(0);
        expect(cost!.gas).toBeGreaterThanOrEqual(0);
      }
    }
    expect(casualtyCost("CreepTumor")).toEqual({ minerals: 0, gas: 0 });
    expect(casualtyCost("NotARealUnit")).toBeNull();
    expect(casualtyCost("toString")).toBeNull();
    expect(casualtyCost("")).toBeNull();
  });
});
