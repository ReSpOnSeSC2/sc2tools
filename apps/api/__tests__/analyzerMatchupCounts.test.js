// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { BuildsService } = require("../src/services/builds");
const { AggregationsService } = require("../src/services/aggregations");
let mongo, db;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "analyzer_matchup_metadata" }); });
afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
beforeEach(async () => {
  await db.games.deleteMany({});
  await db.games.insertMany(["Protoss", "p", "Terran", "Zerg", "Random", true].map((race, i) => ({
    userId: "owner", gameId: `one-${i}`, date: new Date("2026-10-25T12:00:00Z"), durationSec: 600,
    myBuild: "Any matchup build", myRace: "Protoss", result: i % 2 ? "Defeat" : "Victory",
    opponent: { race, strategy: "Recorded opener", pulseId: "1-S2-1-42" },
  })));
  await db.games.insertOne({ userId: "other", gameId: "foreign", date: new Date(), durationSec: 600, myBuild: "Any matchup build", myRace: "Protoss", result: "Victory", opponent: { race: "Zerg", strategy: "Recorded opener" } });
});
test("build rows carry actual opponent-race counts from their existing filtered cohort", async () => {
  const service = new BuildsService(db), rows = await service.list("owner", {});
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ total: 6, myMatchups: { P: 2, T: 1, Z: 1 } });
  const narrowed = await service.list("owner", { oppRace: "P" });
  expect(narrowed[0]).toMatchObject({ total: 2, myMatchups: { P: 2, T: 0, Z: 0 } });
});
test("the matrix keeps unique build/strategy cells and the same race-filter semantics", async () => {
  const service = new AggregationsService(db), rows = await service.buildVsStrategy("owner", {});
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ my_build: "Any matchup build", opp_strat: "Recorded opener", total: 6, myMatchups: { P: 2, T: 1, Z: 1 } });
  const narrowed = await service.buildVsStrategy("owner", { oppRace: "Z" });
  expect(narrowed[0]).toMatchObject({ total: 1, myMatchups: { P: 0, T: 0, Z: 1 } });
});
