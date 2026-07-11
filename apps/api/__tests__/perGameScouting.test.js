// @ts-nocheck
"use strict";

/**
 * computePerGameScouting — pure compute that produces the per-game
 * scouting envelope the overlay's "Last 5 games" widget renders.
 *
 * The fixtures here are hand-crafted so the classifier lands on a
 * known finalPhase + endReason and so the per-phase composition
 * snapshot picks the unit-token we expect. Same calibration anchors
 * the Workstream-A phaseClassifier tests use: T3 tech raises the
 * floor to midLate, T3 unit raises the floor to late.
 */

const {
  computePerGameScouting,
  deriveEndReason,
  buildOpponentBuildOrder,
  canonicalUnitToken,
} = require("../src/services/scouting/perGameScouting");

/**
 * Build a macroBreakdown that classifies into "late" with the
 * supplied units in the late-phase window. Mirrors the late-shape
 * helpers used in opponentsPhases.test.js, with units gated past
 * t=420 so the T3-unit floor only fires inside the late phase.
 *
 * @param {{ units?: Record<string, number>, duration?: number, t3TechBornAt?: number, t3UnitBornAt?: number }} opts
 */
function makeMacroLate(opts = {}) {
  const duration = opts.duration || 600;
  const techBorn = opts.t3TechBornAt ?? 280;
  const unitBorn = opts.t3UnitBornAt ?? 420;
  const opp_bases = [
    { name: "Hatchery", born_time: 0, died_time: duration },
    { name: "Hatchery", born_time: 100, died_time: duration },
    { name: "Hatchery", born_time: 200, died_time: duration },
  ];
  const opp_production_buildings = [
    { name: "SpawningPool", born_time: 30, died_time: duration },
    { name: "RoachWarren", born_time: 90, died_time: duration },
    { name: "HydraliskDen", born_time: 160, died_time: duration },
    { name: "Spire", born_time: 220, died_time: duration },
    { name: "Hive", born_time: techBorn, died_time: duration },
  ];
  const opp_stats_events = [];
  for (let t = 0; t <= duration; t += 10) {
    opp_stats_events.push({
      time: t,
      food_workers: Math.min(20 + t / 8, 70),
      food_used: Math.min(12 + t / 4, 180),
      army_value: Math.min(t * 12, 5000),
    });
  }
  const lateUnits = opts.units || { BroodLord: 4, Corruptor: 6 };
  const unit_timeline = [];
  for (let t = 0; t <= duration; t += 30) {
    const opp = t >= unitBorn
      ? { ...lateUnits }
      : { Zergling: 8, Roach: 4 };
    unit_timeline.push({ time: t, my: {}, opp });
  }
  return {
    opp_bases,
    opp_production_buildings,
    opp_stats_events,
    unit_timeline,
  };
}

function buildLateGame(overrides = {}) {
  const macroBreakdown = overrides.macroBreakdown || makeMacroLate();
  return {
    gameId: "g_late",
    date: new Date("2026-04-10T00:00:00Z"),
    result: "Victory",
    map: "Goldenaura LE",
    myRace: "Protoss",
    myBuild: "PvZ - 3 Stargate Phoenix",
    durationSec: 600,
    opponent: {
      displayName: "WallOfHydra",
      race: "Zerg",
      strategy: "Zerg - Brood Lord Macro",
    },
    oppBuildLog: [
      "[0:12] SpawningPool",
      "[1:30] RoachWarren",
      "[2:40] HydraliskDen",
      "[3:40] Spire",
      "[4:40] Hive",
      "[5:00] GreaterSpire",
      "[5:20] BroodLord",
      "[5:50] BroodLord",
    ],
    macroBreakdown,
    ...overrides,
  };
}

describe("computePerGameScouting — canonical shape", () => {
  test("returns the canonical envelope shape", () => {
    const env = computePerGameScouting(buildLateGame());
    expect(env).toEqual(expect.objectContaining({
      gameId: "g_late",
      date: expect.any(String),
      map: "Goldenaura LE",
      result: "win",
      durationSec: 600,
      myRace: "Protoss",
      myBuild: "PvZ - 3 Stargate Phoenix",
      oppRace: "Zerg",
      oppName: "WallOfHydra",
      oppStrategy: "Zerg - Brood Lord Macro",
    }));
    // The five phase buckets all exist on the snapshot map.
    expect(Object.keys(env.oppCompositionByPhase).sort()).toEqual(
      ["early", "earlyMid", "late", "mid", "midLate"],
    );
    // Build order events carry name + time + category + tier.
    expect(env.oppBuildOrder.length).toBeGreaterThan(0);
    const first = env.oppBuildOrder[0];
    expect(first).toEqual(expect.objectContaining({
      name: expect.any(String),
      time: expect.any(Number),
      category: expect.stringMatching(/^(building|unit|upgrade)$/),
      tier: expect.any(Number),
    }));
  });

  test("applies the workstream-A T3 floor through to endPhase", () => {
    // The macro carries Brood Lord (T3 unit) in the unit_timeline
    // from t=420; the classifier's T3 floor pushes finalPhase to "late".
    const env = computePerGameScouting(buildLateGame());
    expect(env.endPhase).toBe("late");
    // The classifier also reports the corresponding crossing.
    expect(env.oppTransitions.lateAt).not.toBeNull();
    expect(env.oppTransitions.lateAt).toBeLessThanOrEqual(420);
  });

  test("composition snapshot at late phase includes the T3 unit", () => {
    const env = computePerGameScouting(buildLateGame());
    const lateUnits = env.oppCompositionByPhase.late.units.map((u) => u.token);
    expect(lateUnits).toContain("BroodLord");
  });

  test("phases the game didn't reach render reached=false", () => {
    // Short early-game fixture — score should never cross midLate.
    const env = computePerGameScouting({
      gameId: "g_short",
      date: new Date("2026-04-10T00:00:00Z"),
      result: "Defeat",
      map: "Goldenaura LE",
      myRace: "Protoss",
      myBuild: "PvZ - Cannon Rush",
      durationSec: 180,
      opponent: {
        displayName: "OppX", race: "Zerg", strategy: "Zerg - Pool First",
      },
      oppBuildLog: ["[0:12] SpawningPool"],
      macroBreakdown: {
        opp_bases: [{ name: "Hatchery", born_time: 0, died_time: 180 }],
        opp_production_buildings: [
          { name: "SpawningPool", born_time: 30, died_time: 180 },
        ],
        opp_stats_events: [
          { time: 0, food_workers: 12, food_used: 12, army_value: 0 },
          { time: 90, food_workers: 14, food_used: 16, army_value: 100 },
          { time: 180, food_workers: 16, food_used: 18, army_value: 200 },
        ],
        unit_timeline: [
          { time: 0, my: {}, opp: { Zergling: 4 } },
          { time: 60, my: {}, opp: { Zergling: 8 } },
        ],
      },
    });
    expect(env.endPhase).toBe("early");
    expect(env.oppCompositionByPhase.early.reached).toBe(true);
    expect(env.oppCompositionByPhase.midLate.reached).toBe(false);
    expect(env.oppCompositionByPhase.late.reached).toBe(false);
  });
});

describe("computePerGameScouting — degraded inputs", () => {
  test("missing unit_timeline sets the flag AND renders empty composition", () => {
    // Composition is now PEAK-alive across unit_timeline samples in
    // the phase window — there is no cumulative-build-order fallback.
    // Build-order cumulative produced nonsense like "65 Zealots
    // alive" (way over food cap) because it never subtracted deaths.
    // Without timeline data the right answer is "we don't know" —
    // surface the unit_timeline_missing flag and leave units empty
    // so the UI hints rather than misinforms.
    const macro = makeMacroLate();
    delete macro.unit_timeline;
    const env = computePerGameScouting(buildLateGame({ macroBreakdown: macro }));
    expect(env.flags).toContain("unit_timeline_missing");
    expect(env.oppCompositionByPhase.late.units).toEqual([]);
    expect(env.oppCompositionByPhase.late.source).toBe("empty");
  });

  test("missing oppBuildLog produces empty build order + flag", () => {
    const env = computePerGameScouting(buildLateGame({ oppBuildLog: [] }));
    expect(env.flags).toContain("opp_buildlog_missing");
    expect(env.oppBuildOrder).toEqual([]);
  });

  test("composition uses PEAK alive across the phase window, not point-sample", () => {
    // unit_timeline shows Carrier count growing to 8 mid-window then
    // shrinking back to 1 by the phase boundary. The peak-alive
    // sampler returns 8 (the high-water mark) rather than the 1
    // alive at the phase end — that's the streamer-meaningful
    // "how many carriers did you field during this phase".
    const macro = makeMacroLate();
    macro.unit_timeline = [
      { time: 0, my: {}, opp: { Drone: 12 } },
      { time: 420, my: {}, opp: { Drone: 70, Zergling: 8 } },
      { time: 450, my: {}, opp: { Drone: 70, Zergling: 8, Carrier: 4 } },
      { time: 480, my: {}, opp: { Drone: 70, Zergling: 16, Carrier: 8, BroodLord: 2 } },
      { time: 540, my: {}, opp: { Drone: 70, Zergling: 12, Carrier: 5, BroodLord: 4 } },
      { time: 600, my: {}, opp: { Drone: 70, Carrier: 1 } },
    ];
    const env = computePerGameScouting(buildLateGame({ macroBreakdown: macro }));
    const lateUnits = env.oppCompositionByPhase.late.units;
    const carrier = lateUnits.find((u) => u.token === "Carrier");
    const zergling = lateUnits.find((u) => u.token === "Zergling");
    const broodLord = lateUnits.find((u) => u.token === "BroodLord");
    expect(carrier).toBeDefined();
    expect(carrier.count).toBe(8); // peak, not the trailing 1
    expect(zergling.count).toBe(16); // peak, not the trailing 0
    expect(broodLord.count).toBe(4); // peak, not the trailing 0
  });

  test("composition never falls back to cumulative-built when timeline absent", () => {
    // A heavy-production replay with no unit_timeline must not report
    // a build-order cumulative count — that would surface a
    // food-cap-violating "65 Zealots alive" style number. The right
    // failure mode is "empty + flag" so the UI can hint rather than
    // misinform.
    const macro = makeMacroLate();
    delete macro.unit_timeline;
    const env = computePerGameScouting(buildLateGame({
      macroBreakdown: macro,
      oppBuildLog: Array.from({ length: 65 }, (_, i) =>
        `[${Math.floor((300 + i * 5) / 60)}:${String((300 + i * 5) % 60).padStart(2, "0")}] Zergling`,
      ).concat(["[10:00] BroodLord"]),
    }));
    expect(env.flags).toContain("unit_timeline_missing");
    // Build order parsing succeeded so oppBuildOrder is populated…
    expect(env.oppBuildOrder.length).toBeGreaterThan(0);
    // …but compositionByPhase stays empty rather than emitting a
    // cumulative count that would mislead the streamer.
    for (const phase of ["early", "earlyMid", "mid", "midLate", "late"]) {
      expect(env.oppCompositionByPhase[phase].units).toEqual([]);
    }
  });

  test("opp_bases empty + opp_production_buildings present sets the synthesized flag", () => {
    const macro = makeMacroLate();
    macro.opp_bases = [];
    const env = computePerGameScouting(buildLateGame({ macroBreakdown: macro }));
    expect(env.flags).toContain("opp_bases_synthesized");
  });

  test("oppBuildOrder filters out worker / overlord / supply / cocoon noise", () => {
    const env = computePerGameScouting(buildLateGame({
      oppBuildLog: [
        "[0:12] SpawningPool",
        "[0:15] Overlord",          // dropped — supply
        "[0:20] Drone",             // dropped — worker
        "[1:00] RoachWarren",
        "[2:00] OverlordCocoon",    // dropped — supply morph
        "[3:00] BroodLordCocoon",   // dropped — cocoon
        "[4:00] BroodLord",
      ],
    }));
    const names = env.oppBuildOrder.map((e) => e.name);
    expect(names).not.toContain("Overlord");
    expect(names).not.toContain("Drone");
    expect(names).not.toContain("OverlordCocoon");
    expect(names).not.toContain("BroodLordCocoon");
    expect(names).toContain("SpawningPool");
    expect(names).toContain("BroodLord");
  });
});

describe("computePerGameScouting — endReason branches", () => {
  test("early_allin: finalPhase=early + duration < 240", () => {
    const env = computePerGameScouting({
      gameId: "g_allin",
      date: new Date("2026-04-10T00:00:00Z"),
      result: "Defeat",
      map: "Pylon Wars",
      myRace: "Protoss", myBuild: "PvZ - Cheese",
      durationSec: 180,
      opponent: { displayName: "OppX", race: "Zerg", strategy: "6 Pool" },
      oppBuildLog: ["[0:10] SpawningPool"],
      macroBreakdown: {
        opp_bases: [{ name: "Hatchery", born_time: 0, died_time: 180 }],
        opp_production_buildings: [],
        opp_stats_events: [],
        unit_timeline: [],
      },
    });
    expect(env.endPhase).toBe("early");
    expect(env.endReason).toBe("early_allin");
  });

  test("early_loss: finalPhase=early + duration >= 240 + result=loss", () => {
    expect(deriveEndReason("early", 300, "loss")).toBe("early_loss");
  });

  test("early_win: finalPhase=early + duration >= 240 + result=win", () => {
    expect(deriveEndReason("early", 300, "win")).toBe("early_win");
  });

  test("midgame_engagement: finalPhase=earlyMid|mid + duration < 540", () => {
    expect(deriveEndReason("earlyMid", 400, "win")).toBe("midgame_engagement");
    expect(deriveEndReason("mid", 500, "loss")).toBe("midgame_engagement");
  });

  test("macro_game: finalPhase=midLate|late", () => {
    expect(deriveEndReason("midLate", 800, "win")).toBe("macro_game");
    expect(deriveEndReason("late", 1200, "loss")).toBe("macro_game");
  });

  test("unknown: mid game past 540s with no other rule matching", () => {
    expect(deriveEndReason("mid", 600, "win")).toBe("unknown");
    expect(deriveEndReason("earlyMid", 700, "loss")).toBe("unknown");
  });

  test("real late game uses macro_game endReason", () => {
    const env = computePerGameScouting(buildLateGame());
    expect(env.endReason).toBe("macro_game");
  });
});

describe("computePerGameScouting — buildings + upgrades parity with macro panel", () => {
  test("oppBuildingsByPhase counts cumulative buildings up to the phase end", () => {
    const env = computePerGameScouting(buildLateGame());
    // The fixture's oppBuildLog drops SpawningPool / RoachWarren /
    // HydraliskDen / Spire / Hive / GreaterSpire. By the late phase
    // end (game end = 600s), all of those buildings are present, but
    // the Hatchery → Lair → Hive chain collapses to one Hive and
    // Spire → GreaterSpire collapses to one GreaterSpire.
    const late = env.oppBuildingsByPhase.late;
    expect(late.reached).toBe(true);
    const buildingTokens = late.buildings.map((b) => b.token);
    expect(buildingTokens).toContain("SpawningPool");
    expect(buildingTokens).toContain("RoachWarren");
    expect(buildingTokens).toContain("HydraliskDen");
    expect(buildingTokens).toContain("Hive");
    expect(buildingTokens).toContain("GreaterSpire");
    // Lair was consumed by Hive — no separate Lair row.
    expect(buildingTokens).not.toContain("Lair");
    // Spire was consumed by GreaterSpire — no separate Spire row.
    expect(buildingTokens).not.toContain("Spire");
  });

  test("buildings reached=false when the phase wasn't reached", () => {
    // Short fixture that never reaches mid/midLate/late. The
    // buildings map mirrors the composition map's reached flag.
    const env = computePerGameScouting({
      gameId: "g_early",
      date: new Date("2026-04-10T00:00:00Z"),
      result: "Defeat",
      map: "Pylon Wars",
      myRace: "Protoss", myBuild: "PvZ - Cheese",
      durationSec: 180,
      opponent: { displayName: "OppX", race: "Zerg", strategy: "6 Pool" },
      oppBuildLog: ["[0:10] SpawningPool"],
      buildLog: ["[0:00] Nexus", "[0:12] Pylon"],
      macroBreakdown: {
        opp_bases: [{ name: "Hatchery", born_time: 0, died_time: 180 }],
        opp_production_buildings: [],
        opp_stats_events: [],
        unit_timeline: [],
      },
    });
    expect(env.oppBuildingsByPhase.midLate.reached).toBe(false);
    expect(env.oppBuildingsByPhase.late.reached).toBe(false);
    expect(env.oppBuildingsByPhase.late.buildings).toEqual([]);
  });

  test("upgrades surface in the upgradesByPhase map using completion time", () => {
    // Add a research event to the user's buildLog and confirm it
    // shows up in myUpgradesByPhase at the phase containing its
    // completion time. The base fixture sets durationSec=600 so the
    // 5:00 research completes within the game.
    const env = computePerGameScouting(buildLateGame({
      buildLog: [
        "[0:00] Nexus",
        "[0:54] Pylon",
        "[1:06] Assimilator",
        "[1:58] Gateway",
        "[5:00] WarpGateResearch",
      ],
    }));
    // Upgrade lands in whatever phase contains its completion time.
    // We just confirm SOMEWHERE on the phase ladder the upgrade was
    // recorded — the exact phase depends on classifier timing.
    const allUpgrades = [
      ...env.myUpgradesByPhase.early.upgrades,
      ...env.myUpgradesByPhase.earlyMid.upgrades,
      ...env.myUpgradesByPhase.mid.upgrades,
      ...env.myUpgradesByPhase.midLate.upgrades,
      ...env.myUpgradesByPhase.late.upgrades,
    ].map((u) => u.token);
    expect(allUpgrades).toContain("WarpGateResearch");
  });
});

describe("composition snapshot — canonical unit token rollup", () => {
  test("Lurker + LurkerMP + LurkerMPBurrowed sum into a single Lurker row", () => {
    // Late-phase fixture where the timeline carries the unit under
    // three sc2reader variant tokens at the same tick. Without
    // rollup, the composition strip would surface three separate
    // rows splitting the count.
    const env = computePerGameScouting(buildLateGame({
      macroBreakdown: {
        ...makeMacroLate(),
        unit_timeline: [
          { time: 0, my: {}, opp: { Drone: 12 } },
          { time: 600, my: {}, opp: {
            Lurker: 4,
            LurkerMP: 3,
            LurkerMPBurrowed: 2,
            Zergling: 8,
          } },
        ],
      },
    }));
    const lateUnits = env.oppCompositionByPhase.late.units;
    const lurker = lateUnits.find((u) => u.token === "Lurker");
    expect(lurker).toBeDefined();
    expect(lurker.count).toBe(9);
    // No raw variant tokens leaked into the response.
    expect(lateUnits.some((u) => u.token === "LurkerMP")).toBe(false);
    expect(lateUnits.some((u) => u.token === "LurkerMPBurrowed")).toBe(false);
  });

  test("SiegeTank + SiegeTankSieged sum under the canonical SiegeTank token", () => {
    expect(canonicalUnitToken("SiegeTankSieged")).toBe("SiegeTank");
    expect(canonicalUnitToken("WidowMineBurrowed")).toBe("WidowMine");
    expect(canonicalUnitToken("VikingFighter")).toBe("Viking");
    expect(canonicalUnitToken("VikingAssault")).toBe("Viking");
  });

  test("Protoss morph variants fold to their base name", () => {
    expect(canonicalUnitToken("WarpPrismPhasing")).toBe("WarpPrism");
    expect(canonicalUnitToken("ObserverSiegeMode")).toBe("Observer");
    expect(canonicalUnitToken("AdeptPhaseShift")).toBe("Adept");
  });

  test("unrecognised tokens pass through unchanged", () => {
    expect(canonicalUnitToken("Carrier")).toBe("Carrier");
    expect(canonicalUnitToken("Marine")).toBe("Marine");
    expect(canonicalUnitToken("Stalker")).toBe("Stalker");
  });

  test("regex stance suffix fallback catches unenumerated variants", () => {
    // No explicit alias for these — the suffix regex strips the
    // posture and resolves to the base name. Matches the
    // macro-breakdown canonicaliser's behaviour.
    expect(canonicalUnitToken("CarrierFlying")).toBe("Carrier");
    expect(canonicalUnitToken("BarracksFlying")).toBe("Barracks");
    expect(canonicalUnitToken("SupplyDepotLowered")).toBe("SupplyDepot");
    expect(canonicalUnitToken("SpineCrawlerUprooted")).toBe("SpineCrawler");
  });

  test("warp-in cocoon variants fold to their unit name", () => {
    expect(canonicalUnitToken("ZealotWarp")).toBe("Zealot");
    expect(canonicalUnitToken("StalkerWarp")).toBe("Stalker");
    expect(canonicalUnitToken("DarkTemplarWarp")).toBe("DarkTemplar");
    expect(canonicalUnitToken("ImmortalWarp")).toBe("Immortal");
  });

  test("Overlord variants fold (Transport / Cocoon / TransportOverlordCocoon)", () => {
    expect(canonicalUnitToken("OverlordTransport")).toBe("Overlord");
    expect(canonicalUnitToken("OverlordTransportCocoon")).toBe("Overlord");
    expect(canonicalUnitToken("TransportOverlordCocoon")).toBe("Overlord");
  });

  test("real Roach + RoachBurrowed sum in a unit_timeline snapshot", () => {
    // sc2reader frequently splits a roach army into the alive +
    // burrowed forms in the same tick (player burrowed some roaches
    // ahead of an engagement). The composition strip must sum them
    // so the streamer sees the real on-field count, not half of it.
    const env = computePerGameScouting(buildLateGame({
      macroBreakdown: {
        ...makeMacroLate(),
        unit_timeline: [
          { time: 0, my: {}, opp: { Drone: 12 } },
          { time: 600, my: {}, opp: {
            Roach: 14,
            RoachBurrowed: 6,
            ZerglingBurrowed: 12,
            Zergling: 8,
          } },
        ],
      },
    }));
    const lateUnits = env.oppCompositionByPhase.late.units;
    const roach = lateUnits.find((u) => u.token === "Roach");
    const zergling = lateUnits.find((u) => u.token === "Zergling");
    expect(roach.count).toBe(20);
    expect(zergling.count).toBe(20);
    expect(lateUnits.some((u) => u.token === "RoachBurrowed")).toBe(false);
    expect(lateUnits.some((u) => u.token === "ZerglingBurrowed")).toBe(false);
  });
});

describe("buildOpponentBuildOrder — direct", () => {
  test("orders by time ascending", () => {
    const out = buildOpponentBuildOrder([
      "[2:00] HydraliskDen",
      "[0:12] SpawningPool",
      "[1:00] RoachWarren",
    ]);
    expect(out.map((e) => e.name)).toEqual([
      "SpawningPool", "RoachWarren", "HydraliskDen",
    ]);
  });

  test("tags tier 3 units as tier:3", () => {
    const out = buildOpponentBuildOrder(["[6:00] BroodLord"]);
    expect(out[0]).toEqual({
      name: "BroodLord", time: 360, category: "unit", tier: 3,
    });
  });

  test("keeps only the first occurrence of each non-building unit", () => {
    const out = buildOpponentBuildOrder([
      "[6:00] BroodLord",
      "[6:30] BroodLord",
      "[7:00] BroodLord",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].time).toBe(360);
  });
});
