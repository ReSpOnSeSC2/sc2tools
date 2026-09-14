// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { oppMmrBuckets, oppMmrBucketGames } = require("../src/services/trendsOppMmr");
const { bucketSwitch } = require("../src/services/aggregations");

describe("opponent MMR fallback lookup", () => {
  let mongo;
  let client;
  let db;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    db = client.db("opponent_lookup");
    await db.collection("opponents").createIndex({ userId: 1, pulseId: 1 });
  });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.collection("games").deleteMany({}), db.collection("opponents").deleteMany({})]);
  });

  test("only joins recent games that need a known account's fallback rating", async () => {
    const date = new Date();
    await db.collection("opponents").insertMany([
      { userId: "u1", pulseId: "p1", race: "Protoss", mmr: 4200 },
      { userId: "u1", pulseId: null, race: "Protoss", mmr: 9900 },
      { userId: "u2", pulseId: "p1", race: "Protoss", mmr: 6000 },
    ]);
    const game = (gameId, opponent, extra = {}) => ({ gameId, userId: "u1", date, opponent: { race: "Protoss", ...opponent }, ...extra });
    await db.collection("games").insertMany([
      game("old", { pulseId: "p1" }, { date: new Date("2020-01-01") }),
      game("snapshot", { pulseId: "p1", mmr: 3500 }),
      game("missing-id", {}),
      game("fallback", { pulseId: "p1" }),
      game("other-race", { pulseId: "p1", race: "Zerg" }),
    ]);
    let pipeline;
    await oppMmrBuckets({
      games: { aggregate: (stages) => { pipeline = stages; return { toArray: async () => [] }; } },
      gamesMatchStage: () => ({ userId: "u1" }), bucketSwitch: () => "win",
    }, "u1", {}, { bucketWidth: 500 });
    const lookup = pipeline.find((stage) => stage.$lookup);
    const rating = pipeline.find((stage) => stage.$addFields?._oppMmr);
    const rows = await db.collection("games").aggregate([
      lookup, rating, { $project: { _id: 0, gameId: 1, mmr: "$_oppMmr", joined: { $size: "$_opp" } } },
    ]).toArray();
    expect(rows).toEqual(expect.arrayContaining([
      { gameId: "old", mmr: null, joined: 0 },
      { gameId: "snapshot", mmr: 3500, joined: 0 },
      { gameId: "missing-id", mmr: null, joined: 0 },
      { gameId: "fallback", mmr: 4200, joined: 1 },
      { gameId: "other-race", mmr: null, joined: 1 },
    ]));
  });

  test("grouped histogram weights repeated ratings and matches the per-game drilldown", async () => {
    const date = new Date();
    await db.collection("opponents").insertMany([
      { userId: "u1", pulseId: "p1", race: "Protoss", mmr: 2700 },
      { userId: "u2", pulseId: "p1", race: "Protoss", mmr: 6000 },
    ]);
    const game = (gameId, result, opponent, extra = {}) => ({
      gameId, userId: "u1", date, result, opponent: { race: "Protoss", ...opponent }, ...extra,
    });
    await db.collection("games").insertMany([
      ...Array.from({ length: 4 }, (_, i) => game(`low-${i}`, i < 3 ? "Victory" : "Defeat", { mmr: 2501 })),
      ...Array.from({ length: 2 }, (_, i) => game(`high-${i}`, "Defeat", { mmr: 2799 })),
      ...Array.from({ length: 3 }, (_, i) => game(`fallback-${i}`, i < 2 ? "Victory" : "Defeat", { pulseId: "p1" })),
      game("off-race", "Victory", { pulseId: "p1", race: "Zerg" }),
      game("old", "Defeat", { pulseId: "p1", mmr: 8000 }, { date: new Date("2020-01-01") }),
      game("unidentified", "Victory", {}),
      game("tie", "Tie", { mmr: 1000 }),
      game("other-uploader", "Victory", { pulseId: "p1" }, { userId: "u2" }),
    ]);
    const deps = { games: db.collection("games"), gamesMatchStage: (userId) => ({ userId }), bucketSwitch };
    const histogram = await oppMmrBuckets(deps, "u1", {}, { bucketWidth: 500 });
    expect(histogram.buckets).toHaveLength(1);
    expect(histogram.buckets[0]).toMatchObject({ lo: 2500, hi: 3000, total: 9, wins: 5, losses: 4, avgMmr: 2634, minMmr: 2501, maxMmr: 2799 });
    expect(histogram.unknown).toEqual({ total: 3, wins: 2, losses: 1 });
    const drilldown = await oppMmrBucketGames(deps, "u1", {}, { lo: 2500, hi: 3000 });
    expect(drilldown.total).toBe(histogram.buckets[0].total);
    expect(drilldown.games).toHaveLength(9);
    expect(drilldown.games.every((row) => row.opp_mmr >= 2500 && row.opp_mmr < 3000)).toBe(true);
    expect((await oppMmrBuckets(deps, "u2", {}, { bucketWidth: 500 })).buckets[0]).toMatchObject({ lo: 6000, total: 1 });
    // Automatic width historically includes numeric ratings from undecided
    // results in its spread, while the histogram itself shows decided games.
    expect((await oppMmrBuckets(deps, "u1", {}, { bucketWidth: "auto" })).bucketWidth).toBe(100);
  });

  test("histogram joins distinct rating inputs instead of every replay", async () => {
    const date = new Date();
    await db.collection("opponents").insertOne({ userId: "u1", pulseId: "p1", race: "Protoss", mmr: 4200 });
    await db.collection("games").insertMany(Array.from({ length: 300 }, (_, i) => ({
      gameId: `game-${i}`, userId: "u1", result: "Victory",
      date: i < 100 ? new Date("2020-01-01") : date,
      opponent: { pulseId: "p1", race: "Protoss", ...(i >= 200 ? { mmr: 3500 } : {}) },
    })));
    let pipeline;
    const result = await oppMmrBuckets({
      games: { aggregate: (stages) => { pipeline = stages; return db.collection("games").aggregate(stages); } },
      gamesMatchStage: (userId) => ({ userId }), bucketSwitch,
    }, "u1", {}, { bucketWidth: 500 });
    const lookupIndex = pipeline.findIndex((stage) => stage.$lookup);
    const inputs = await db.collection("games").aggregate([...pipeline.slice(0, lookupIndex), { $count: "total" }]).toArray();
    expect(inputs).toEqual([{ total: 3 }]);
    expect(result.unknown.total).toBe(100);
    expect(result.buckets.reduce((total, bucket) => total + bucket.total, 0)).toBe(200);
  });
});
