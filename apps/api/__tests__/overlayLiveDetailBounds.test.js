// @ts-nocheck
"use strict";

const {
  opponentPhaseProfile,
  last5GamesScouting,
} = require("../src/services/overlayLiveAggregations");

const USER_ID = "u_overlay_bounds";
const OPP = { pulseId: "p-overlay-bounds", displayName: "Bounded" };

function fakeGames(rows) {
  return {
    find(_filter, options) {
      fakeGames.projections.push(options.projection);
      return {
        sort() { return this; },
        limit(n) { this.n = n; return this; },
        toArray() { return Promise.resolve(rows.slice(0, this.n)); },
        catch() { return Promise.resolve(rows.slice(0, this.n)); },
      };
    },
    findOne: jest.fn(() => {
      throw new Error("detail-backed rows must not need inline hydration");
    }),
  };
}
fakeGames.projections = [];

function detailStore(blob) {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  return {
    calls,
    get maxActive() { return maxActive; },
    async findMany(_userId, ids, options) {
      calls.push({ ids: ids.slice(), options });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return new Map([[ids[0], blob]]);
    },
  };
}

describe("overlay replay-detail bounds", () => {
  beforeEach(() => { fakeGames.projections = []; });

  test("phase forecast reads 50 macro details serially and retains summaries", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      gameId: `phase-${i}`,
      result: i % 2 ? "Victory" : "Defeat",
      durationSec: 300,
      myRace: "Protoss",
    }));
    const giant = "x".repeat(256 * 1024);
    const details = detailStore({
      macroBreakdown: {
        bases: [],
        production_buildings: [],
        stats_events: [],
        unit_timeline: [],
        legacyUnknown: giant,
      },
      legacyUnknown: giant,
    });
    const games = fakeGames(rows);

    const out = await opponentPhaseProfile(
      games, details, USER_ID, OPP, "Protoss", "Zerg",
    );

    expect(out).not.toBeNull();
    expect(details.calls).toHaveLength(50);
    expect(details.maxActive).toBe(1);
    for (const call of details.calls) {
      expect(call.ids).toHaveLength(1);
      expect(call.options).toMatchObject({
        fields: ["macroBreakdown"],
        concurrency: 1,
      });
    }
    expect(fakeGames.projections[0]).not.toHaveProperty("macroBreakdown");
    expect(JSON.stringify(out)).not.toContain("legacyUnknown");
  });

  test("last-five scouting reads one projected detail at a time", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      gameId: `scout-${i}`,
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      result: "Victory",
      map: "Bounded LE",
      myRace: "Protoss",
      myBuild: "Gateway Expand",
      durationSec: 300,
      opponent: { displayName: "Bounded", race: "Zerg", strategy: "Macro" },
    }));
    const details = detailStore({
      buildLog: ["[0:20] Pylon"],
      oppBuildLog: ["[0:17] SpawningPool"],
      macroBreakdown: {
        bases: [],
        production_buildings: [],
        stats_events: [],
        unit_timeline: [],
      },
    });
    const games = fakeGames(rows);

    const out = await last5GamesScouting(
      games, details, USER_ID, OPP, "Protoss", "Zerg",
    );

    expect(out).toHaveLength(5);
    expect(details.calls).toHaveLength(5);
    expect(details.maxActive).toBe(1);
    for (const call of details.calls) {
      expect(call.ids).toHaveLength(1);
      expect(call.options).toMatchObject({
        fields: ["buildLog", "oppBuildLog", "macroBreakdown"],
        concurrency: 1,
      });
    }
    expect(fakeGames.projections[0]).not.toHaveProperty("opponent");
    expect(fakeGames.projections[0]).not.toHaveProperty("buildLog");
  });
});
