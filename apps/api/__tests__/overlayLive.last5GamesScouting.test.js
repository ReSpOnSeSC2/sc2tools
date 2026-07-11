// @ts-nocheck
"use strict";

/**
 * Integration test for overlayLiveAggregations.last5GamesScouting:
 * walks a fake games collection through the same path the live
 * overlay uses, confirms hydration covers both build logs +
 * macroBreakdown from a stubbed detail store, and pins that the
 * resulting per-game envelopes carry peak-alive composition counts
 * (the same fix the opponent profile widget got).
 *
 * Mirrors the in-memory-stub shape ``overlayLive.opponentPhases``
 * tests use — no MongoDB process required.
 */

const {
  last5GamesScouting,
} = require("../src/services/overlayLiveAggregations");

const USER_ID = "u_test";
const OPP = {
  pulseId: "9999",
  pulseCharacterId: "C9999",
  displayName: "WallOfHydra",
};

/** Stats curve that pushes the classifier into late phase. */
function statsCurve(duration) {
  const out = [];
  for (let t = 0; t <= duration; t += 10) {
    out.push({
      time: t,
      food_workers: Math.min(20 + t / 8, 70),
      food_used: Math.min(12 + t / 4, 180),
      army_value: Math.min(t * 12, 5000),
    });
  }
  return out;
}

/**
 * Build a unit_timeline where the opponent's Carrier count grows
 * 4 → 6 → 10 across mid-late ticks, then DIPS to 1 at the late
 * phase boundary (post-engagement low). Peak-alive sampling MUST
 * surface the 10, not the trailing 1.
 */
function carrierTimeline(duration) {
  return [
    { time: 0, my: {}, opp: { Drone: 12 } },
    { time: 300, my: {}, opp: { Drone: 50, BroodLord: 4 } },
    { time: 360, my: {}, opp: { Drone: 50, BroodLord: 6, Corruptor: 4 } },
    { time: 420, my: {}, opp: { Drone: 50, BroodLord: 10, Corruptor: 6 } },
    // Post-engagement low at the late phase boundary.
    { time: duration, my: {}, opp: { Drone: 50, BroodLord: 1 } },
  ];
}

function makeMacroBreakdown(duration = 600) {
  return {
    opp_bases: [
      { name: "Hatchery", born_time: 0, died_time: duration },
      { name: "Hatchery", born_time: 100, died_time: duration },
      { name: "Hatchery", born_time: 200, died_time: duration },
    ],
    opp_production_buildings: [
      { name: "SpawningPool", born_time: 30, died_time: duration },
      { name: "RoachWarren", born_time: 90, died_time: duration },
      { name: "HydraliskDen", born_time: 160, died_time: duration },
      { name: "Spire", born_time: 220, died_time: duration },
      { name: "Hive", born_time: 280, died_time: duration },
      { name: "GreaterSpire", born_time: 320, died_time: duration },
    ],
    opp_stats_events: statsCurve(duration),
    unit_timeline: carrierTimeline(duration),
  };
}

/**
 * In-memory games collection that just answers ``.find().sort()...``
 * with a static list. Matches the mongo cursor shape
 * ``last5GamesScouting`` uses.
 */
function makeGames(rows) {
  return {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        toArray: () => Promise.resolve(rows),
        catch() { return Promise.resolve(rows); },
      };
    },
  };
}

/** Simple gameDetails stub: returns the supplied blob map keyed by gameId. */
function makeGameDetails(blobsByGameId) {
  return {
    async findMany(_userId, ids) {
      const out = new Map();
      for (const id of ids) {
        if (blobsByGameId[id]) out.set(String(id), blobsByGameId[id]);
      }
      return out;
    },
  };
}

describe("overlayLiveAggregations.last5GamesScouting — peak-alive surface", () => {
  test("composition cards surface PEAK alive (not midpoint dip) for the opp side", async () => {
    const games = makeGames([{
      gameId: "g_peak",
      date: new Date("2026-05-15T17:26:39Z"),
      result: "Defeat",
      map: "Ruby Rock LE",
      myRace: "Protoss",
      myBuild: "PvZ - Sky Toss",
      durationSec: 600,
      opponent: {
        displayName: "WallOfHydra",
        race: "Zerg",
        strategy: "Zerg - Brood Lord Macro",
        pulseId: OPP.pulseId,
      },
      buildLog: ["[0:00] Nexus", "[3:56] Stargate"],
      oppBuildLog: [
        "[0:12] SpawningPool", "[1:30] Hatchery", "[2:30] RoachWarren",
        "[4:00] Hive", "[5:30] BroodLord",
      ],
      macroBreakdown: makeMacroBreakdown(600),
    }]);
    const envelopes = await last5GamesScouting(
      games, null, USER_ID, OPP, "Protoss", "Zerg",
    );
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    // Late phase should reflect the BroodLord PEAK count (10), not
    // the trailing 1 at the phase boundary that a midpoint sampler
    // would land on.
    const lateUnits = env.oppCompositionByPhase.late.units;
    const broodLord = lateUnits.find((u) => u.token === "BroodLord");
    expect(broodLord).toBeDefined();
    expect(broodLord.count).toBe(10);
  });

  test("hydrates buildLog + oppBuildLog + macroBreakdown from gameDetails for post-v0.4.3 rows", async () => {
    // Game row missing all three heavy fields — they're in the
    // detail store, the overlay must hydrate before computing the
    // envelope.
    const games = makeGames([{
      gameId: "g_hydrated",
      date: new Date("2026-05-15T17:26:39Z"),
      result: "Defeat",
      map: "Ruby Rock LE",
      myRace: "Protoss",
      myBuild: "PvZ - Sky Toss",
      durationSec: 600,
      opponent: {
        displayName: "WallOfHydra", race: "Zerg",
        strategy: "Zerg - Brood Lord Macro", pulseId: OPP.pulseId,
      },
      // buildLog, oppBuildLog, macroBreakdown intentionally absent.
    }]);
    const gameDetails = makeGameDetails({
      g_hydrated: {
        buildLog: ["[0:00] Nexus", "[3:56] Stargate"],
        oppBuildLog: [
          "[0:12] SpawningPool", "[2:30] RoachWarren",
          "[5:30] BroodLord",
        ],
        macroBreakdown: makeMacroBreakdown(600),
      },
    });
    const envelopes = await last5GamesScouting(
      games, gameDetails, USER_ID, OPP, "Protoss", "Zerg",
    );
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    // Hydration succeeded for all three: build orders populated,
    // composition surfaces real units (proves macroBreakdown was
    // hydrated and the timeline path took).
    expect(env.oppBuildOrder.length).toBeGreaterThan(0);
    expect(env.myBuildOrder.length).toBeGreaterThan(0);
    expect(env.oppCompositionByPhase.late.units.length).toBeGreaterThan(0);
    // Flags should NOT carry the buildlog-missing markers — the
    // hydration step filled them in before perGameScouting ran.
    expect(env.flags).not.toContain("opp_buildlog_missing");
    expect(env.flags).not.toContain("my_buildlog_missing");
    expect(env.flags).not.toContain("unit_timeline_missing");
  });

  test("Roach + RoachBurrowed variant tokens sum under one canonical token", async () => {
    // Variant rollup must apply on the overlay path too — a
    // burrowed-roach army at peak shouldn't split into two strip
    // entries.
    const macro = makeMacroBreakdown(600);
    macro.unit_timeline = [
      { time: 0, my: {}, opp: { Drone: 12 } },
      { time: 400, my: {}, opp: { Drone: 50, Roach: 14, RoachBurrowed: 6 } },
    ];
    const games = makeGames([{
      gameId: "g_burrow",
      date: new Date("2026-05-15T17:26:39Z"),
      result: "Defeat",
      map: "Ruby Rock LE",
      myRace: "Protoss",
      myBuild: "PvZ - Sky Toss",
      durationSec: 600,
      opponent: {
        displayName: "WallOfHydra", race: "Zerg",
        strategy: "Zerg - Roach Comp", pulseId: OPP.pulseId,
      },
      buildLog: ["[0:00] Nexus"],
      oppBuildLog: ["[0:12] SpawningPool", "[2:30] RoachWarren"],
      macroBreakdown: macro,
    }]);
    const envelopes = await last5GamesScouting(
      games, null, USER_ID, OPP, "Protoss", "Zerg",
    );
    const lateUnits = envelopes[0].oppCompositionByPhase.late.units;
    const roach = lateUnits.find((u) => u.token === "Roach");
    const rawBurrowed = lateUnits.find((u) => u.token === "RoachBurrowed");
    expect(roach).toBeDefined();
    expect(roach.count).toBe(20);
    expect(rawBurrowed).toBeUndefined();
  });

  test("returns an empty array when the opponent identity is missing", async () => {
    const games = makeGames([]);
    const out = await last5GamesScouting(games, null, USER_ID, null);
    expect(out).toEqual([]);
  });
});
