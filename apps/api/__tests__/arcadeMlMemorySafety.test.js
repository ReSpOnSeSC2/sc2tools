// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

const fs = require("fs");
const { ArcadeService } = require("../src/services/arcade");
const {
  MLService,
  ML_TRAINING_NDJSON_BYTE_CAP,
} = require("../src/services/ml");

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

function asyncGameCursor(factory) {
  let limit = Number.POSITIVE_INFINITY;
  const cursor = {
    batchSizeValue: null,
    sort() {
      return this;
    },
    limit(value) {
      limit = value;
      return this;
    },
    batchSize(value) {
      this.batchSizeValue = value;
      return this;
    },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < limit; i += 1) {
        const row = factory(i);
        if (row === null) break;
        yield row;
      }
    },
  };
  return cursor;
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
        fields: ["buildLog", "macroBreakdown"],
        concurrency: 1,
      });
    }
  });
});

describe("ML training snapshot memory bounds", () => {
  test("admits only one in-process training job at a time", async () => {
    const oldProjectDir = process.env.SC2_PY_ANALYZER_DIR;
    const oldPython = process.env.SC2_PY_PYTHON;
    process.env.SC2_PY_ANALYZER_DIR = process.cwd();
    process.env.SC2_PY_PYTHON = process.execPath;
    let nextId = 0;
    const service = new MLService({
      mlJobs: {
        insertOne: async () => ({ insertedId: String(++nextId) }),
      },
    });
    service._runTraining = jest.fn(() => new Promise(() => {}));
    try {
      await expect(service.train("trainer-a")).resolves.toEqual({
        jobId: "1",
        status: "running",
      });
      await expect(service.train("trainer-b")).rejects.toMatchObject({
        code: "training_capacity_busy",
        status: 503,
        retryAfterSec: 30,
      });
    } finally {
      service._activeJobs.clear();
      if (oldProjectDir === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = oldProjectDir;
      if (oldPython === undefined) delete process.env.SC2_PY_PYTHON;
      else process.env.SC2_PY_PYTHON = oldPython;
    }
  });

  test("hydrates at most one build log and strips giant late-game data", async () => {
    const count = 24;
    let capturedProjection = null;
    const cursor = asyncGameCursor((i) => i < count ? {
      gameId: `hydrated-${i}`,
      date: new Date(2026, 0, i + 1),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "Stargate",
      map: "Abyss",
      opponent: { race: "Zerg" },
      macroScore: 80,
    } : null);
    const db = {
      games: {
        find: (_query, options) => {
          capturedProjection = options.projection;
          return cursor;
        },
      },
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [];
    const giantLateLine = `[9:00] ${"late".repeat(512 * 1024)}`;
    const service = new MLService(db, {
      gameDetails: {
        findMany: jest.fn(async (_userId, ids, options) => {
          calls.push({ ids, options });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return new Map([[ids[0], {
            buildLog: ["[0:10] Pylon", giantLateLine],
          }]]);
        }),
      },
    });

    const prepared = await service._writeTrainingNdjson("ml-user");
    try {
      const contents = fs.readFileSync(prepared.path, "utf8");
      const lines = contents.trim().split("\n");
      expect(lines).toHaveLength(count);
      expect(maxInFlight).toBe(1);
      expect(calls).toHaveLength(count);
      expect(cursor.batchSizeValue).toBe(1);
      expect(capturedProjection.opponent).toBeUndefined();
      expect(capturedProjection["opponent.race"]).toBe(1);
      for (const call of calls) {
        expect(call.ids).toHaveLength(1);
        expect(call.options).toEqual({ fields: ["buildLog"], concurrency: 1 });
      }
      const first = JSON.parse(lines[0]);
      expect(first.buildLog).toEqual(["[0:10] Pylon"]);
      expect(first.earlyBuildLog).toEqual(["[0:10] Pylon"]);
      expect(contents).not.toContain("latelatelate");
      expect(fs.statSync(prepared.path).size).toBeLessThanOrEqual(
        ML_TRAINING_NDJSON_BYTE_CAP,
      );
    } finally {
      fs.unlinkSync(prepared.path);
    }
  });

  test("stops before the NDJSON byte cap instead of accumulating lines", async () => {
    const sourceRows = 700;
    const denseLog = Array.from({ length: 64 }, (_, i) => {
      const second = String((i % 59) + 1).padStart(2, "0");
      return `[0:${second}] ${"x".repeat(116)}`;
    });
    const cursor = asyncGameCursor((i) => i < sourceRows ? {
      gameId: `dense-${i}`,
      date: "2026-01-01T00:00:00.000Z",
      result: "Victory",
      myRace: "Terran",
      myBuild: "Bio",
      map: "Abyss",
      opponent: { race: "Zerg" },
      buildLog: denseLog,
    } : null);
    const service = new MLService({
      games: { find: () => cursor },
    });

    const prepared = await service._writeTrainingNdjson("ml-user");
    try {
      const stat = fs.statSync(prepared.path);
      expect(prepared.truncated).toBe(true);
      expect(prepared.limitReason).toBe("byte_cap");
      expect(prepared.gamesWritten).toBeLessThan(sourceRows);
      expect(prepared.bytesWritten).toBe(stat.size);
      expect(stat.size).toBeLessThanOrEqual(ML_TRAINING_NDJSON_BYTE_CAP);
    } finally {
      fs.unlinkSync(prepared.path);
    }
  });
});
