// @ts-nocheck
"use strict";

const {
  opponentPhaseProfile,
  opponentTendencies,
  TENDENCY_SCAN_CAP,
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

  test("opponent tendencies read one bounded metadata page and no replay detail", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, 80 - i)),
      durationSec: 300,
      myRace: "Protoss",
      opponent: { race: "Zerg", strategy: i % 2 ? "Zerg - 12 Pool" : "Zerg - Hatch First" },
    }));
    const games = fakeGames(rows);

    const matchup = { myRace: "Protoss", oppRace: "Zerg" };
    const out = await opponentTendencies(games, USER_ID, OPP, matchup);

    expect(out.window).toBe(TENDENCY_SCAN_CAP);
    expect(fakeGames.projections).toHaveLength(1);
    const projection = fakeGames.projections[0];
    for (const heavy of ["buildLog", "oppBuildLog", "macroBreakdown", "opponent"]) {
      expect(projection).not.toHaveProperty(heavy);
    }
    expect(projection).toMatchObject({ "opponent.strategy": 1, "buildIntent.opponent.build": 1 });
    expect(games.findOne).not.toHaveBeenCalled();
  });

  test("recent scouting reads five replay details serially and keeps real milestone summaries", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      gameId: `tech-${index}`,
      result: "Victory",
      durationSec: 600,
      myRace: "Protoss",
      opponent: { race: "Zerg", strategy: "Detected opening" },
      buildIntent: { opponent: {
        status: "confirmed", applied: true, build: { name: "Corrected opening" },
      } },
    }));
    const details = detailStore({
      buildLog: ["[0:00] Nexus", "[0:50] Gateway"],
      oppBuildLog: ["[0:00] Hatchery", "[0:47] SpawningPool", "[3:58] Lair"],
      macroBreakdown: { unit_timeline: [], legacyUnknown: "x".repeat(256 * 1024) },
    });
    const games = fakeGames(rows);
    const out = await last5GamesScouting(games, details, USER_ID, OPP, "Protoss", "Zerg");
    expect(out).toHaveLength(5);
    expect(details.calls).toHaveLength(5);
    expect(details.maxActive).toBe(1);
    for (const call of details.calls) {
      expect(call.ids).toHaveLength(1);
      expect(call.options).toMatchObject({ fields: ["buildLog", "oppBuildLog", "macroBreakdown"], concurrency: 1 });
    }
    expect(out[0].myTechMilestones).toEqual([
      { name: "Gateway", timeSec: 50, kind: "building", timing: "started" },
    ]);
    expect(out[0].oppTechMilestones).toContainEqual({ name: "Lair", timeSec: 238, kind: "building", timing: "completed" });
    expect(out[0].oppStrategy).toBe("Corrected opening");
    expect(fakeGames.projections[0]).not.toHaveProperty("buildLog");
    expect(fakeGames.projections[0]).not.toHaveProperty("oppBuildLog");
    expect(fakeGames.projections[0]).not.toHaveProperty("macroBreakdown");
    expect(JSON.stringify(out)).not.toContain("legacyUnknown");
    expect(games.findOne).not.toHaveBeenCalled();
  });

  test("recent scouting never reads another barcode account from a display name", async () => {
    const games = fakeGames([{ gameId: "another-player" }]);
    const out = await last5GamesScouting(games, null, USER_ID, { displayName: "Shared" }, "Protoss", "Zerg");
    expect(out).toEqual([]);
    expect(fakeGames.projections).toHaveLength(0);
  });

  test("recent scouting omits metadata-only games without replay evidence", async () => {
    const games = fakeGames([{ gameId: "metadata-only", durationSec: 600 }]);
    expect(await last5GamesScouting(games, null, USER_ID, OPP, "Protoss", "Zerg")).toEqual([]);
  });
});
