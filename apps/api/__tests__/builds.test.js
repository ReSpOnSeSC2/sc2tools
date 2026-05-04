// @ts-nocheck
"use strict";

const { BuildsService } = require("../src/services/builds");

function buildGames(handlers) {
  let i = 0;
  return {
    aggregate(pipeline) {
      const handler = handlers[i++ % handlers.length];
      return {
        toArray: () => Promise.resolve(handler(pipeline)),
      };
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
    const games = buildGames([
      () => [
        {
          totals: [{ wins: 5, losses: 5, total: 10, lastPlayed: new Date() }],
          byMatchup: [{ name: "vs Z", wins: 3, losses: 2, total: 5 }],
          byMap: [{ name: "Goldenaura", wins: 2, losses: 1, total: 3 }],
          byStrategy: [{ name: "Cheese", wins: 1, losses: 2, total: 3 }],
          recent: [{ gameId: "g1", date: new Date(), map: "Goldenaura", opponent: "Foo", opp_race: "Z", opp_strategy: "Cheese", result: "Victory" }],
        },
      ],
    ]);
    const svc = new BuildsService({ games });
    const out = /** @type {any} */ (await svc.detail("u1", "P - Stargate", {}));
    expect(out.name).toBe("P - Stargate");
    expect(out.totals.winRate).toBe(0.5);
    expect(out.byMatchup[0].winRate).toBe(0.6);
    expect(out.recent).toHaveLength(1);
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
