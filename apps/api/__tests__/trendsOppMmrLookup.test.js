// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { oppMmrBuckets } = require("../src/services/trendsOppMmr");

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
});
