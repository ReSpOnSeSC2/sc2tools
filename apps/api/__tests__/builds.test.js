// @ts-nocheck
"use strict";

const { BuildsService } = require("../src/services/builds");

function buildGames(handlers, opts = {}) {
  let i = 0;
  const findRows = opts.find || [];
  return {
    aggregate(pipeline) {
      const handler = handlers[i++ % handlers.length];
      return {
        toArray: () => Promise.resolve(handler(pipeline)),
      };
    },
    find() {
      // Support the dossier-extras follow-up query: find(...).sort(...).toArray().
      const cursor = {
        sort: () => cursor,
        toArray: () => Promise.resolve(findRows),
      };
      return cursor;
    },
  };
}

describe("services/builds", () => {
  test("list returns all builds with computed winRate", async () => {
    const games = buildGames([
      () => [
        { name: "P - Stargate", wins: 4, losses: 2, total: 6, lastPlayed: new Date(), winRate: 4 / 6 },
        { name: "P - Glaives", wins: 1, losses: 3, total: 4, lastPlayed: new Date(), winRate: 0.25 },
      ],
    ]);
    const svc = new BuildsService({ games });
    const out = await svc.list("u1", {});
    expect(out).toHaveLength(2);
    expect(out[0].winRate).toBeCloseTo(4 / 6);
  });

  test("detail returns null when no games match the build", async () => {
    const games = buildGames([
      () => [{ totals: [], byMatchup: [], byMap: [], byStrategy: [], recent: [] }],
    ]);
    const svc = new BuildsService({ games });
    const out = await svc.detail("u1", "P - Stargate", {});
    expect(out).toBeNull();
  });

  test("detail collapses every facet into the legacy shape", async () => {
    const games = buildGames(
      [
        () => [
          {
            totals: [{ wins: 5, losses: 5, total: 10, lastPlayed: new Date() }],
            byMatchup: [{ name: "vs Z", wins: 3, losses: 2, total: 5 }],
            byMap: [{ name: "Goldenaura", wins: 2, losses: 1, total: 3 }],
            byStrategy: [{ name: "Cheese", wins: 1, losses: 2, total: 3 }],
            recent: [{ gameId: "g1", date: new Date(), map: "Goldenaura", opponent: "Foo", opp_race: "Z", opp_strategy: "Cheese", result: "Victory" }],
          },
        ],
      ],
      { find: [] },
    );
    const svc = new BuildsService({ games });
    const out = /** @type {any} */ (await svc.detail("u1", "P - Stargate", {}));
    expect(out.name).toBe("P - Stargate");
    expect(out.totals.winRate).toBe(0.5);
    expect(out.byMatchup[0].winRate).toBe(0.6);
    expect(out.recent).toHaveLength(1);
    expect(out).toHaveProperty("topStrategies");
    expect(out).toHaveProperty("predictedStrategies");
    expect(out).toHaveProperty("medianTimings");
    expect(out).toHaveProperty("macro");
    expect(out.macro.gamesWithScore).toBe(0);
  });

  test("detail derives DNA + macro extras from enriched game docs", async () => {
    const baseDate = new Date("2026-04-01T00:00:00Z");
    const enriched = [
      {
        gameId: "g1",
        date: baseDate,
        result: "Victory",
        map: "Goldenaura",
        myRace: "P",
        myBuild: "P - Stargate",
        durationSec: 720,
        macroScore: 78,
        apm: 220,
        spq: 88,
        buildLog: ["[1:30] Gateway", "[2:00] CyberneticsCore"],
        oppBuildLog: ["[2:30] SpawningPool"],
        opponent: { displayName: "Foo", race: "Z", strategy: "Pool first" },
      },
      {
        gameId: "g2",
        date: new Date("2026-03-30T00:00:00Z"),
        result: "Defeat",
        map: "Site Delta",
        myRace: "P",
        myBuild: "P - Stargate",
        durationSec: 540,
        macroScore: 55,
        apm: 180,
        spq: 70,
        buildLog: ["[1:45] Gateway"],
        oppBuildLog: ["[2:50] SpawningPool"],
        opponent: { displayName: "Bar", race: "Z", strategy: "Roach allin" },
      },
    ];
    const games = buildGames(
      [
        () => [
          {
            totals: [{ wins: 1, losses: 1, total: 2, lastPlayed: baseDate }],
            byMatchup: [{ name: "vs Z", wins: 1, losses: 1, total: 2 }],
            byMap: [],
            byStrategy: [
              { name: "Pool first", wins: 1, losses: 0, total: 1 },
              { name: "Roach allin", wins: 0, losses: 1, total: 1 },
            ],
            recent: [],
          },
        ],
      ],
      { find: enriched },
    );
    const svc = new BuildsService({ games });
    const out = /** @type {any} */ (await svc.detail("u1", "P - Stargate", {}));
    expect(out.macro.gamesWithScore).toBe(2);
    expect(out.macro.avgMacroScore).toBeCloseTo((78 + 55) / 2);
    expect(out.macro.scoreDistribution.excellent).toBe(1);
    expect(out.macro.scoreDistribution.good).toBe(1);
    expect(out.last5Games).toHaveLength(2);
    expect(out.predictedStrategies.length).toBeGreaterThan(0);
    expect(out.topStrategies.length).toBe(2);
  });

  test("oppStrategies returns sorted rows with winRate", async () => {
    const games = buildGames([
      () => [
        { name: "Cheese", wins: 1, losses: 2, total: 3, winRate: 1 / 3 },
        { name: "Macro", wins: 5, losses: 5, total: 10, winRate: 0.5 },
      ],
    ]);
    const svc = new BuildsService({ games });
    const out = await svc.oppStrategies("u1", {});
    expect(out).toHaveLength(2);
    expect(out[1].winRate).toBe(0.5);
  });
});
