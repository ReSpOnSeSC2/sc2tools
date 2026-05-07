"use strict";

const { validateGameRecord } = require("../src/validation/gameRecord");

describe("validateGameRecord", () => {
  test("accepts a minimal real-shaped record", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(true);
  });

  test("rejects bad result enum", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Win",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects missing gameId", () => {
    const r = validateGameRecord({
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects non-ISO date", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "May 4 2026",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("accepts opponent block when present", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Defeat",
      myRace: "Zerg",
      map: "Site Delta",
      opponent: {
        pulseId: "1234",
        displayName: "Foo#1",
        race: "Protoss",
        mmr: 4500,
        opening: "Pool first",
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(/** @type {any} */ (r.value).opponent.mmr).toBe(4500);
    }
  });

  test("accepts toonHandle and pulseCharacterId on opponent", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      opponent: {
        pulseId: "1-S2-1-716965",
        toonHandle: "1-S2-1-716965",
        pulseCharacterId: "994428",
        displayName: "BrenMcBash",
        race: "Terran",
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      const opp = /** @type {any} */ (r.value).opponent;
      expect(opp.toonHandle).toBe("1-S2-1-716965");
      expect(opp.pulseCharacterId).toBe("994428");
    }
  });

  test("rejects non-numeric pulseCharacterId", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      opponent: {
        pulseId: "1-S2-1-716965",
        pulseCharacterId: "not-a-number",
        displayName: "x",
        race: "Terran",
      },
    });
    expect(r.valid).toBe(false);
  });

  // Locks down the shape the agent v0.4.0+ ships on every replay
  // upload. Without these passing through, the SPA's MacroBreakdown
  // drilldown and dual-build timeline render their empty states
  // ("Macro breakdown not available" / "No opponent build extracted
  // yet") even on freshly uploaded games, because the cloud doesn't
  // store the .SC2Replay binary and can't recompute later.
  test("preserves macroBreakdown + oppBuildLog from a v0.4 agent payload", () => {
    const r = validateGameRecord({
      gameId: "2026-05-06T17:48:32|Hunter|White Rabbit LE|522",
      date: "2026-05-06T17:48:32Z",
      result: "Victory",
      myRace: "Protoss",
      map: "White Rabbit LE",
      durationSec: 522,
      myBuild: "PvP - AlphaStar (4 Adept/Oracle)",
      macroScore: 78,
      apm: 200,
      spq: 80,
      opponent: {
        displayName: "Hunter",
        race: "P",
        toonHandle: "1-S2-2-690921",
        pulseId: "1-S2-2-690921",
        strategy: "Protoss - Standard Expand",
      },
      buildLog: ["[0:00] Nexus", "[0:26] Pylon", "[0:53] Gateway"],
      earlyBuildLog: ["[0:00] Nexus", "[0:26] Pylon"],
      oppBuildLog: [
        "[0:00] Nexus",
        "[0:30] Pylon",
        "[2:00] Gateway",
        "[3:30] RoboticsFacility",
      ],
      oppEarlyBuildLog: ["[0:00] Nexus", "[0:30] Pylon"],
      macroBreakdown: {
        raw: { sq: 80, base_score: 75 },
        all_leaks: [
          { name: "Chrono", detail: "5/8", penalty: 2, mineral_cost: 200 },
        ],
        top_3_leaks: [
          { name: "Chrono", detail: "5/8", penalty: 2, mineral_cost: 200 },
        ],
        stats_events: [
          { time: 0, food_used: 12, minerals_current: 50 },
          { time: 60, food_used: 22, minerals_current: 250 },
        ],
        opp_stats_events: [{ time: 0, food_used: 12 }],
      },
      apmCurve: {
        window_sec: 30,
        has_data: true,
        players: [
          { pid: 1, name: "Me", race: "Protoss", samples: [] },
          { pid: 2, name: "Opp", race: "Zerg", samples: [] },
        ],
      },
      // Exercises the additionalProperties: true escape hatch — newer
      // agents may add fields (e.g. spatial extracts for Map Intel)
      // that weren't in the schema when an older API was deployed.
      // These must pass through unchanged.
      spatial: {
        map_bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
        buildings: [{ x: 100, y: 100 }],
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      const v = /** @type {any} */ (r.value);
      expect(Array.isArray(v.oppBuildLog)).toBe(true);
      expect(v.oppBuildLog.length).toBe(4);
      expect(v.macroBreakdown).toBeDefined();
      expect(v.macroBreakdown.top_3_leaks.length).toBe(1);
      expect(v.macroBreakdown.stats_events.length).toBe(2);
      expect(v.apmCurve.has_data).toBe(true);
      // Forward-compat: spatial isn't in the schema yet but must
      // round-trip via additionalProperties: true.
      expect(v.spatial.map_bounds.maxX).toBe(200);
    }
  });
});
