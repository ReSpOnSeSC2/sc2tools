// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

const { ArcadeService } = require("../src/services/arcade");

function arcadeGames(rows) {
  return {
    find: (_query, options) => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => rows,
        }),
      }),
      options,
    }),
  };
}

describe("Arcade heavy-detail memory bounds", () => {
  test("the sequential fold preserves every heavy quest predicate", async () => {
    const rows = [
      { gameId: "fold-1", date: new Date(2026, 0, 1), result: "Defeat" },
      { gameId: "fold-2", date: new Date(2026, 0, 2), result: "Victory" },
    ];
    const blobs = new Map([
      ["fold-1", {
        buildLog: ["[0:10] Marine", "[0:20] Marine"],
        oppBuildLog: ["[0:12] Drone"],
      }],
      ["fold-2", {
        buildLog: [
          "[0:10] Marine",
          "[0:20] Marine",
          "[0:30] Mothership",
        ],
        oppBuildLog: ["[0:12] Zergling"],
      }],
    ]);
    const service = new ArcadeService(
      { games: arcadeGames(rows) },
      {
        games: null,
        gameDetails: {
          findMany: async (_userId, ids) => new Map([[ids[0], blobs.get(ids[0])]]),
        },
      },
    );

    const result = await service.resolveQuests("arcade-user", {
      startedAt: "2025-01-01T00:00:00.000Z",
      cells: [
        {
          id: "with-unit",
          predicate: "won_with_unit",
          params: { unit: "Mothership" },
        },
        {
          id: "n-units",
          predicate: "won_built_n_of_unit",
          params: { unit: "Marine", count: 2 },
        },
        {
          id: "opp-unit",
          predicate: "won_built_opp_unit_seen",
          params: { unit: "Zergling" },
        },
        {
          id: "week-units",
          predicate: "built_n_of_unit_week",
          params: { unit: "Marine", count: 3 },
        },
      ],
    });

    expect(result.resolved).toEqual([
      { id: "with-unit", ticked: true, gameId: "fold-2" },
      { id: "n-units", ticked: true, gameId: "fold-2" },
      { id: "opp-unit", ticked: true, gameId: "fold-2" },
      { id: "week-units", ticked: true, gameId: "fold-2" },
    ]);
  });

  test("quest resolution hydrates one projected detail at a time", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      gameId: `quest-${i}`,
      date: new Date(2026, 0, i + 1),
      result: "Victory",
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [];
    const gameDetails = {
      findMany: jest.fn(async (_userId, ids, options) => {
        calls.push({ ids, options });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return new Map([[ids[0], {
          buildLog: [`[0:10] Marine ${"x".repeat(1024 * 1024)}`],
          oppBuildLog: ["[0:12] Zergling"],
        }]]);
      }),
    };
    const service = new ArcadeService(
      { games: arcadeGames(rows) },
      { games: null, gameDetails },
    );

    const result = await service.resolveQuests("arcade-user", {
      startedAt: "2025-01-01T00:00:00.000Z",
      cells: [{
        id: "weekly-marines",
        predicate: "built_n_of_unit_week",
        params: { unit: "Marine", count: 99 },
      }],
    });

    expect(result.resolved).toEqual([{ id: "weekly-marines", ticked: false }]);
    expect(calls).toHaveLength(rows.length);
    expect(maxInFlight).toBe(1);
    for (const call of calls) {
      expect(call.ids).toHaveLength(1);
      expect(call.options).toEqual({
        fields: ["buildLog", "oppBuildLog"],
        concurrency: 1,
      });
    }
  });

  test("unit trivia folds one projected detail at a time", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      gameId: `unit-${i}`,
      date: new Date(2026, 0, i + 1),
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [];
    const gameDetails = {
      findMany: jest.fn(async (_userId, ids, options) => {
        calls.push({ ids, options });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return new Map([[ids[0], {
          buildLog: ["[0:10] Marine"],
          macroBreakdown: {
            player_stats: { me: { units_lost: 2 } },
          },
        }]]);
      }),
    };
    const service = new ArcadeService(
      { games: arcadeGames(rows) },
      { games: null, gameDetails },
    );

    const result = await service.unitStats("arcade-user");

    expect(result.builtByUnit.Marine).toBe(rows.length);
    expect(result.totalUnitsLost).toBe(rows.length * 2);
    expect(maxInFlight).toBe(1);
    expect(calls).toHaveLength(rows.length);
    for (const call of calls) {
      expect(call.ids).toHaveLength(1);
      expect(call.options).toEqual({
        fields: ["buildLog", "macroBreakdown.player_stats"],
        concurrency: 1,
        strict: true,
      });
    }
  });
});
