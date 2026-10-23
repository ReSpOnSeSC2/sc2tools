"use strict";

const { computePerGameScouting, buildTechMilestones } = require("../src/services/scouting/perGameScouting");

describe("per-game scouting tech milestones", () => {
  test("keeps recorded starts and completions for both players without invented offsets", () => {
    const envelope = computePerGameScouting({
      durationSec: 600,
      buildLog: ["[0:00] Nexus", "[0:50] Gateway", "[2:10] Stalker", "[3:40] WarpGateResearch", "[3:47] WarpGate"],
      oppBuildLog: ["[0:00] Hatchery", "[0:47] SpawningPool", "[1:45] Hatchery", "[3:58] Lair", "[4:30] HydraliskDen", "[5:20] Hydralisk", "[5:40] zerglingmovementspeed", "[8:00] Hive", "[9:00] GreaterSpire"],
    });
    expect(envelope.myTechMilestones).toEqual([
      { name: "Gateway", timeSec: 50, kind: "building", timing: "started" },
      { name: "Stalker", timeSec: 130, kind: "unit", timing: "completed" },
      { name: "WarpGateResearch", timeSec: 220, kind: "upgrade", timing: "completed" },
      { name: "WarpGate", timeSec: 227, kind: "building", timing: "completed" },
    ]);
    expect(envelope.oppTechMilestones).toEqual([
      { name: "SpawningPool", timeSec: 47, kind: "building", timing: "started" },
      { name: "Hatchery", timeSec: 105, kind: "building", timing: "started" },
      { name: "Lair", timeSec: 238, kind: "building", timing: "completed" },
      { name: "HydraliskDen", timeSec: 270, kind: "building", timing: "started" },
      { name: "Hydralisk", timeSec: 320, kind: "unit", timing: "completed" },
      { name: "zerglingmovementspeed", timeSec: 340, kind: "upgrade", timing: "completed" },
      { name: "Hive", timeSec: 480, kind: "building", timing: "completed" },
      { name: "GreaterSpire", timeSec: 540, kind: "building", timing: "completed" },
    ]);
  });

  test("keeps first gas timings and removes worker, supply, shell, effect and repeat unit noise", () => {
    const envelope = computePerGameScouting({
      durationSec: 600,
      buildLog: [
        "[0:12] Probe", "[0:17] Pylon", "[0:35] Assimilator", "[0:40] SCV", "[0:41] Drone",
        "[0:42] Overlord", "[0:43] Refinery", "[0:44] Extractor", "[0:45] SupplyDepot",
        "[1:00] Gateway", "[1:10] Gateway", "[1:12] RavagerCocoon", "[1:14] LurkerMPEgg",
        "[1:16] CreepTumor", "[1:18] AdeptPhaseShift", "[1:20] NotARealTechStep",
        "[2:10] Stalker", "[2:25] Stalker", "[2:40] BarracksFlying", "[3:00] OrbitalCommand", "[3:30] AssimilatorRich", "[3:40] Refinery", "[3:50] Extractor",
      ],
    });
    expect(envelope.myTechMilestones).toEqual([
      { name: "Assimilator", timeSec: 35, kind: "building", timing: "started" },
      { name: "Refinery", timeSec: 43, kind: "building", timing: "started" },
      { name: "Extractor", timeSec: 44, kind: "building", timing: "started" },
      { name: "Gateway", timeSec: 60, kind: "building", timing: "started" },
      { name: "Stalker", timeSec: 130, kind: "unit", timing: "completed" },
      { name: "OrbitalCommand", timeSec: 180, kind: "building", timing: "completed" },
    ]);
  });

  test("preserves subsequent real expansions and canonicalizes first unit types", () => {
    const envelope = computePerGameScouting({
      durationSec: 600,
      buildLog: ["[5:00] LurkerMP", "[0:00] CommandCenter", "[1:35] CommandCenter", "[2:00] VikingFighter", "[2:05] VikingAssault", "[3:30] CommandCenter", "[5:40] LurkerMP"],
    });
    expect(envelope.myTechMilestones).toMatchObject([
      { name: "CommandCenter", timeSec: 95 },
      { name: "Viking", timeSec: 120 },
      { name: "CommandCenter", timeSec: 210 },
      { name: "Lurker", timeSec: 300 },
    ]);
  });

  test("returns empty arrays on legacy records without build logs", () => {
    const envelope = computePerGameScouting({ durationSec: 600, macroBreakdown: {
      unit_timeline: [{ time: 300, my: { Carrier: 1 }, opp: { BroodLord: 1 } }],
    } });
    expect(envelope.myTechMilestones).toEqual([]);
    expect(envelope.oppTechMilestones).toEqual([]);
  });

  test("does not promote snapshots, invalid timestamps or events beyond the game", () => {
    expect(buildTechMilestones([
      { name: "Gateway", time: NaN, is_building: true },
      { name: "Gateway", time: -5, is_building: true },
      { name: "Stalker", time: Infinity },
      { name: "Carrier", time: 620 },
      { name: "Gateway", time: 55, is_building: true },
    ], 600)).toEqual([{ name: "Gateway", timeSec: 55, kind: "building", timing: "started" }]);
  });
});
