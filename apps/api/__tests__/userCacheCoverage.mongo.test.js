// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { AggregationsService } = require("../src/services/aggregations");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache } = require("../src/middleware/userCache");
const { buildAggregationsRouter } = require("../src/routes/aggregations");

let mongo, db;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_coverage" }); });
afterAll(async () => { await db.close(); await mongo.stop(); });
beforeEach(async () => { jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({}); await db.users.insertOne({ userId: "a" }); });
const game = (gameId, overrides = {}) => ({ gameId, date: new Date("2026-01-01T12:00:00Z"), result: "Victory",
  myRace: "Protoss", myLadderRace: "P", myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay",
  playerCount: 2, isLadderGame: true, map: "Site Delta LE", durationSec: 600, macroScore: 70,
  myBuild: "Expand", opponent: { race: "Zerg", strategy: "Pool", displayName: "Opponent" }, ...overrides });
function fixture() {
  const revisions = new UserRevision(db.users, { enabled: true });
  const cache = new UserCache(revisions, { enabled: true }), aggregations = new AggregationsService(db);
  // Match the production composition: retirement also detaches inner chart joins.
  revisions.addInvalidator(owner => aggregations.trendsRequests.invalidateForUser(owner));
  const app = express();
  app.use(buildAggregationsRouter({ aggregations, userCache: cache, auth: (req, _res, next) => { req.auth = { userId: "a", source: "device" }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || error.message }));
  return { app, aggregations, games: new GamesService(db, { userRevision: revisions }), revisions, cache };
}
const routes = [["summary", "/summary"], ["macroSummary", "/macro/summary"], ["mmrProgression", "/timeseries/mmr"],
  ["myBuildMixOverTime", "/timeseries/my-builds"], ["oppStrategyMixOverTime", "/timeseries/opp-strategies"]];
test.each(routes)("%s serves real aggregates and retires ingest, reupload, quarantine and unknown commits", async (method, path) => {
  const f = fixture(); await f.games.upsert("a", game("one"));
  // A second owner's data must never enter a retained response.
  await f.games.upsert("b", game("other", { macroScore: 1, myMmr: 1000 }));
  const spy = jest.spyOn(f.aggregations, method);
  let previous;
  for (const mutate of [null,
    () => f.games.upsert("a", game("two", { date: new Date("2026-02-01T12:00:00Z"), macroScore: 90, myMmr: 4500, myBuild: "Air", opponent: { race: "Terran", strategy: "Bio" } })),
    () => f.games.upsert("a", game("two", { date: new Date("2026-03-01T12:00:00Z"), macroScore: 80, myMmr: 4300, myBuild: "Tech" })),
    () => f.games.quarantineResumedReplay("a", game("two")),
  ]) {
    if (mutate) await mutate();
    const calls = spy.mock.calls.length;
    const fresh = await request(f.app).get(path).set("If-None-Match", previous?.headers.etag || 'W/"old"');
    expect(fresh.status).toBe(200); expect(spy).toHaveBeenCalledTimes(calls + 1);
    if (previous) expect(fresh.body).not.toEqual(previous.body);
    const hit = await request(f.app).get(path); expect(hit.body).toEqual(fresh.body);
    const revalidated = await request(f.app).get(path).set("If-None-Match", fresh.headers.etag);
    expect(revalidated.status).toBe(304); expect(revalidated.text).toBe("");
    expect(spy).toHaveBeenCalledTimes(calls + 1); previous = fresh;
  }
  const original = db.games.updateOne.bind(db.games);
  jest.spyOn(db.games, "updateOne").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("lost acknowledgement"); });
  await expect(f.games.upsert("a", game("one", { macroScore: 85, myMmr: 4700, myBuild: "Changed", opponent: { race: "Terran", strategy: "Mech", displayName: "Changed" } }))).rejects.toThrow("lost acknowledgement");
  const afterUnknown = await request(f.app).get(path).set("If-None-Match", previous.headers.etag);
  expect(afterUnknown.status).toBe(200); expect(afterUnknown.body).not.toEqual(previous.body);
});
