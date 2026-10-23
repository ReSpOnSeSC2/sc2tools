// @ts-nocheck
"use strict";

const {
  opponentPhaseProfile,
  opponentTendencies,
  TENDENCY_SCAN_CAP,
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
});
