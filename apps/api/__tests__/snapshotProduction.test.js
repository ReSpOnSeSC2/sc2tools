// @ts-nocheck
"use strict";

const {
  countProduction,
  projectProductionByTick,
  PRODUCTION_METRIC,
  PRODUCTION_UNITS,
} = require("../src/services/snapshotProduction");

describe("countProduction", () => {
  test("counts Protoss gateways + warpgates + robo + stargate", () => {
    const units = { Gateway: 2, WarpGate: 1, RoboticsFacility: 1, Stargate: 1, Pylon: 5 };
    expect(countProduction(units, "P")).toBe(5);
  });

  test("counts Terran rax + factory + starport + reactor bonus", () => {
    const units = { Barracks: 3, Factory: 1, Starport: 1, BarracksReactor: 2 };
    expect(countProduction(units, "T")).toBe(3 + 1 + 1 + 2 * 0.5);
  });

  test("counts Zerg hatchery + lair + hive", () => {
    const units = { Hatchery: 2, Lair: 1, Hive: 1, Drone: 30 };
    expect(countProduction(units, "Z")).toBe(4);
  });

  test("ignores non-production units", () => {
    expect(countProduction({ Probe: 60, Pylon: 5 }, "P")).toBe(0);
  });

  test("returns null for unknown race", () => {
    expect(countProduction({ Gateway: 2 }, null)).toBeNull();
  });

  test("returns null for missing units map", () => {
    expect(countProduction(undefined, "P")).toBeNull();
  });

  test("Reactor (no prefix) also contributes to Terran bonus", () => {
    expect(countProduction({ Barracks: 1, Reactor: 2 }, "T")).toBe(1 + 2 * 0.5);
  });
});

describe("projectProductionByTick", () => {
  test("buckets timeline frames to 30 s ticks", () => {
    const timeline = [
      { time: 0, my: { Gateway: 1 }, opp: {} },
      { time: 60, my: { Gateway: 2 }, opp: {} },
      { time: 90, my: { Gateway: 3, RoboticsFacility: 1 }, opp: {} },
    ];
    const map = projectProductionByTick(timeline, "P");
    expect(map.get(0)).toBe(1);
    expect(map.get(60)).toBe(2);
    expect(map.get(90)).toBe(4);
  });

  test("empty timeline returns empty map", () => {
    expect(projectProductionByTick(undefined, "P").size).toBe(0);
    expect(projectProductionByTick([], "P").size).toBe(0);
  });
});

describe("constants", () => {
  test("PRODUCTION_METRIC matches the snapshotCohort key", () => {
    expect(PRODUCTION_METRIC).toBe("production_capacity");
  });

  test("PRODUCTION_UNITS covers PTZ", () => {
    expect(PRODUCTION_UNITS.P).toBeDefined();
    expect(PRODUCTION_UNITS.T).toBeDefined();
    expect(PRODUCTION_UNITS.Z).toBeDefined();
  });
});
