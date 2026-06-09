// @ts-nocheck
"use strict";

/**
 * Macro tab data plumbing, end-to-end against real Mongo:
 *
 *   1. GamesService.upsert stamps a sanitized ``top3Leaks`` on the slim
 *      games row when the incoming payload carries a macroBreakdown —
 *      the breakdown blob itself is heavy and may live in R2, so the
 *      aggregate leak summary can only ever read the slim row.
 *   2. AggregationsService.macroSummary groups those leaks and reports
 *      coverage with a live aggregation (validates the $facet /
 *      $isNumber / $round pipeline against a real server, not a mock).
 *   3. /v1/timeseries carries avgMacroScore per bucket.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { AggregationsService } = require("../src/services/aggregations");

describe("macro summary plumbing", () => {
  let mongo;
  let db;
  let games;
  let aggregations;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_macro_summary",
    });
    games = new GamesService(db);
    aggregations = new AggregationsService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function gameWithMacro(gameId, { score, leaks, date } = {}) {
    return {
      gameId,
      date: date || new Date("2026-05-01T12:00:00Z"),
      result: "Victory",
      myRace: "Protoss",
      map: "Site Delta",
      ...(typeof score === "number" ? { macroScore: score } : {}),
      ...(leaks
        ? {
            macroBreakdown: {
              raw: { sq: 80 },
              top_3_leaks: leaks,
              stats_events: [{ t: 0 }],
            },
          }
        : {}),
    };
  }

  test("upsert stamps sanitized top3Leaks on the slim row", async () => {
    await games.upsert("u1", gameWithMacro("g1", {
      score: 72,
      leaks: [
        {
          name: "Supply blocked",
          detail: "47s blocked across 3 windows",
          quantity: 47,
          mineral_cost: 460,
          penalty: 9,
          // Fields outside the leak contract must not leak onto the
          // slim row (bounded doc size is the whole point).
          stats_events: [{ huge: "blob" }],
        },
        { name: "Idle production", mineral_cost: 310 },
      ],
    }));
    const row = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(row.macroBreakdown).toBeUndefined();
    expect(row.top3Leaks).toHaveLength(2);
    expect(row.top3Leaks[0]).toEqual({
      name: "Supply blocked",
      detail: "47s blocked across 3 windows",
      quantity: 47,
      mineral_cost: 460,
      penalty: 9,
    });
    expect(row.top3Leaks[1]).toEqual({
      name: "Idle production",
      mineral_cost: 310,
    });
  });

  test("upsert skips top3Leaks when the breakdown has none", async () => {
    await games.upsert("u1", gameWithMacro("g2", { score: 90, leaks: [] }));
    const row = await db.games.findOne({ userId: "u1", gameId: "g2" });
    expect(row.top3Leaks).toBeUndefined();
  });

  test("macroSummary aggregates coverage + recurring leaks (live pipeline)", async () => {
    await games.upsert("u1", gameWithMacro("g1", {
      score: 80,
      leaks: [
        { name: "Supply blocked", mineral_cost: 400 },
        { name: "Missed injects", mineral_cost: 250 },
      ],
    }));
    await games.upsert("u1", gameWithMacro("g2", {
      score: 60,
      leaks: [{ name: "Supply blocked", mineral_cost: 600 }],
    }));
    // Pre-macro game: no score, no leaks — counts toward missing.
    await games.upsert("u1", gameWithMacro("g3", {}));
    // Other user's game must not bleed in.
    await games.upsert("u2", gameWithMacro("gx", {
      score: 10,
      leaks: [{ name: "Supply blocked", mineral_cost: 9999 }],
    }));

    const out = await aggregations.macroSummary("u1", {});
    expect(out.gamesTotal).toBe(3);
    expect(out.gamesWithMacro).toBe(2);
    expect(out.gamesMissingMacro).toBe(1);
    expect(out.avgScore).toBeCloseTo(70);
    expect(out.leaks[0]).toEqual({
      name: "Supply blocked",
      count: 2,
      totalMinerals: 1000,
    });
    expect(out.leaks[1]).toEqual({
      name: "Missed injects",
      count: 1,
      totalMinerals: 250,
    });
  });

  test("timeseries carries avgMacroScore per bucket (live pipeline)", async () => {
    const day1 = new Date("2026-05-01T10:00:00Z");
    await games.upsert("u1", gameWithMacro("g1", { score: 70, date: day1 }));
    await games.upsert("u1", gameWithMacro("g2", { score: 80, date: day1 }));
    // Same bucket, no score — must not drag the average down.
    await games.upsert("u1", gameWithMacro("g3", { date: day1 }));

    const out = await aggregations.timeseries(
      "u1",
      { interval: "day", tz: "UTC" },
      {},
    );
    expect(out.points).toHaveLength(1);
    expect(out.points[0].avgMacroScore).toBeCloseTo(75);
  });
});
