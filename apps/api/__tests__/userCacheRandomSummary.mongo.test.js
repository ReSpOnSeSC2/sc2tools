// @ts-nocheck
"use strict";
// Random summary under the default-off cache: its one-minute completed memo is used only while the cache
// is off, so a request that skips the guard cannot leave a body that a later guarded GET retains.
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
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_random_summary" }); });
afterAll(async () => { await db.close(); await mongo.stop(); });
beforeEach(async () => { jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({}); await db.users.insertOne({ userId: "a", dataRev: 0 }); });
const game = (gameId, overrides = {}) => ({ gameId, date: new Date("2026-01-01T12:00:00Z"), result: "Victory",
  myRace: "Protoss", myLadderRace: "P", myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay",
  playerCount: 2, isLadderGame: true, map: "Site Delta LE", durationSec: 600,
  opponent: { race: "Zerg", strategy: "Pool", displayName: "Opponent" }, ...overrides });
// Another API process: its write reaches none of this process's invalidators; only the stored dataRev moves.
async function peerWrite(row) {
  await new GamesService(db).upsert("a", row);
  await db.users.updateOne({ userId: "a" }, { $inc: { dataRev: 1 } });
}
function fixture({ enabled = true, legacy = false } = {}) {
  const revisions = new UserRevision(db.users, { enabled });
  const cache = new UserCache(revisions, { enabled }), aggregations = new AggregationsService(db);
  // Production composition: an enabled retirement also drops the owner's inner joins and memo.
  if (revisions.enabled) revisions.addInvalidator(owner => aggregations.trendsRequests.invalidateForUser(owner));
  const app = express();
  app.use(buildAggregationsRouter({ aggregations, streak: {}, macroReport: {}, userCache: legacy ? undefined : cache,
    auth: (req, _res, next) => { req.auth = { userId: "a", source: "device" }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || error.message }));
  return { app, aggregations, cache, games: new GamesService(db, { userRevision: revisions }),
    computed: jest.spyOn(aggregations, "_randomSummaryOnce") };
}
const protoss = (res) => [res.body.total, res.body.perRace.Protoss.wins, res.body.perRace.Protoss.losses];
const two = () => game("two", { date: new Date("2026-03-01T12:00:00Z"), result: "Defeat" });

test("a HEAD before another process's write leaves nothing the first guarded GET can retain", async () => {
  const f = fixture(); await peerWrite(game("one"));
  // HEAD skips the guard but runs the route's work; a memo would keep this one-game answer for a minute.
  expect((await request(f.app).head("/random-summary")).status).toBe(200);
  await peerWrite(two());
  // This process has never observed the owner, so the GET adopts dataRev 2 without retiring anything.
  const fresh = await request(f.app).get("/random-summary");
  expect(fresh.status).toBe(200); expect(protoss(fresh)).toEqual([2, 1, 1]);
  const hit = await request(f.app).get("/random-summary");
  expect(hit.body).toEqual(fresh.body); expect(hit.headers.etag).toBe(fresh.headers.etag);
  expect((await request(f.app).get("/random-summary").set("If-None-Match", fresh.headers.etag)).status).toBe(304);
  expect(f.computed).toHaveBeenCalledTimes(2); expect(f.aggregations.trendsRequests.completed.size).toBe(0);
});

test("after another process's write, an observed owner's GET is retired and then reads fresh, never the old body", async () => {
  const f = fixture(); await peerWrite(game("one"));
  const first = await request(f.app).get("/random-summary"); expect(protoss(first)).toEqual([1, 1, 0]);
  expect((await request(f.app).head("/random-summary")).status).toBe(200);
  await peerWrite(two());
  const retired = await request(f.app).get("/random-summary").set("If-None-Match", first.headers.etag);
  expect(retired.status).toBe(503); expect(retired.headers["retry-after"]).toBe("1");
  const fresh = await request(f.app).get("/random-summary").set("If-None-Match", first.headers.etag);
  expect(fresh.status).toBe(200); expect(protoss(fresh)).toEqual([2, 1, 1]);
  expect(fresh.headers.etag).not.toBe(first.headers.etag);
});

test("filtered and unfiltered variants keep separate bodies, validators and retirement", async () => {
  const f = fixture(); await peerWrite(game("one")); await peerWrite(two());
  const all = await request(f.app).get("/random-summary"), since = await request(f.app).get("/random-summary?since=2026-02-01");
  expect(protoss(all)).toEqual([2, 1, 1]); expect(protoss(since)).toEqual([1, 0, 1]);
  expect(f.cache.completed.size).toBe(2); expect(since.headers.etag).not.toBe(all.headers.etag);
  expect((await request(f.app).get("/random-summary?since=2026-02-01").set("If-None-Match", all.headers.etag)).status).toBe(200);
  expect((await request(f.app).get("/random-summary").set("If-None-Match", all.headers.etag)).status).toBe(304);
  // The service ignores the race filter, but the key keeps it, so this request never shares the unfiltered entry.
  const race = await request(f.app).get("/random-summary?race=Z");
  expect(race.body).toEqual(all.body); expect(race.headers.etag).not.toBe(all.headers.etag);
  await f.games.upsert("a", game("three", { date: new Date("2026-04-01T12:00:00Z") }));
  for (const [path, tag, expected] of [["/random-summary", all.headers.etag, [3, 2, 1]],
    ["/random-summary?since=2026-02-01", since.headers.etag, [2, 1, 1]]]) {
    const changed = await request(f.app).get(path).set("If-None-Match", tag);
    expect(changed.status).toBe(200); expect(protoss(changed)).toEqual(expected);
  }
  expect(f.aggregations.trendsRequests.completed.size).toBe(0);
});

test.each([["off", { enabled: false }], ["absent", { enabled: false, legacy: true }]])(
  "with the cache %s, the unfiltered memo still shares one answer for its minute", async (_mode, opts) => {
    const f = fixture(opts); await peerWrite(game("one"));
    const first = await request(f.app).get("/random-summary"); expect(protoss(first)).toEqual([1, 1, 0]);
    expect((await request(f.app).head("/random-summary")).status).toBe(200);
    await peerWrite(two());
    // Unchanged flag-off behaviour: another process's write stays invisible to the memo until it expires.
    const shared = await request(f.app).get("/random-summary");
    expect(shared.body).toEqual(first.body); expect(f.computed).toHaveBeenCalledTimes(1);
    expect(f.aggregations.trendsRequests.completed.size).toBe(1);
    // Filtered charts still read fresh.
    expect(protoss(await request(f.app).get("/random-summary?since=2025-01-01"))).toEqual([2, 1, 1]);
    for (const entry of f.aggregations.trendsRequests.completed.values()) entry.expiresAt = 0;
    expect(protoss(await request(f.app).get("/random-summary"))).toEqual([2, 1, 1]);
    expect(f.computed).toHaveBeenCalledTimes(3);
  });
