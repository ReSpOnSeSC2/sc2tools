// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const { MmrExpectationService } = require("../src/services/mmrExpectation");
const { fitCalibration } = require("../src/services/mmrExpectationMath");
const { GamesService } = require("../src/services/games");
const { UserCache } = require("../src/middleware/userCache");
const { UserRevision } = require("../src/util/userRevision");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
let mongo, db;
const routes = [["matchups", "/matchups"], ["maps", "/maps"], ["mapMatchups", "/maps/matchups"], ["buildVsStrategy", "/build-vs-strategy"]];
const curve = extra => ({ _id: "corpus-1v1", ruleVersion: 1, ...fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]), ...extra });
const game = (id, extra = {}) => ({ gameId: id, date: new Date("2026-01-01T12:00:00Z"), result: "Victory", myRace: "Protoss", myLadderRace: "P", myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay", playerCount: 2, matchFormat: "1v1", isLadderGame: true, map: "Site Delta LE", durationSec: 600, myBuild: "Expand", opponent: { race: "Zerg", mmr: 4200, mmrSource: "replay", strategy: "Pool" }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("fixture did not settle"); }
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "strength_cache" }); });
beforeEach(async () => {
  jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({});
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a" }, { userId: "b", clerkUserId: "clerk-b" }]);
  await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, curve(), { upsert: true });
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
function fixture(enabled = true, legacy = false) {
  let now = 1000;
  const model = new MmrExpectationService(db, { now: () => now });
  const aggregations = new AggregationsService(db, { mmrExpectation: model });
  const revisions = new UserRevision(db.users, { enabled });
  const cache = new UserCache(revisions, { enabled, now: () => now });
  const games = new GamesService(db, { userRevision: revisions });
  const app = express();
  app.use(buildAggregationsRouter({ aggregations, userCache: legacy ? undefined : cache,
    auth: (req, _res, next) => { req.auth = { userId: req.headers["x-fixture-owner"] || "a", source: "device" }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || error.message }));
  return { app, model, aggregations, revisions, cache, games, advance: ms => { now += ms; } };
}
const get = (f, path, tag, owner = "a") => {
  const req = request(f.app).get(path).set("x-fixture-owner", owner);
  return tag ? req.set("If-None-Match", tag) : req;
};
async function holdAggregate() {
  const entered = deferred(), release = deferred(), original = db.games.aggregate.bind(db.games);
  jest.spyOn(db.games, "aggregate").mockImplementationOnce((...args) => {
    const cursor = original(...args);
    return { toArray: async () => { const value = await cursor.toArray(); entered.resolve(); await release.promise; return value; } };
  });
  return { entered, release };
}

test.each(routes)("%s matches original real aggregates, revalidates304 and retires owner writes/unknown outcomes", async (method, path) => {
  const f = fixture(); await f.games.upsert("a", game("one"));
  await f.games.upsert("a", game("two", { result: "Defeat", myMmrSource: "unknown" }));
  await f.games.upsert("b", game("private-other", { map: "Other" }));
  const baseline = JSON.parse(JSON.stringify(await f.aggregations[method]("a", {})));
  const calls = jest.spyOn(f.aggregations, method), publicCurve = jest.spyOn(f.model, "curve");
  const first = await get(f, path); expect(first.status).toBe(200); expect(first.body).toEqual(baseline);
  expect((await get(f, path, first.headers.etag)).status).toBe(304); expect(calls).toHaveBeenCalledTimes(1);
  expect(publicCurve).not.toHaveBeenCalled();
  await f.games.upsert("a", game("one", { result: "Defeat" }));
  const changed = await get(f, path, first.headers.etag); expect(changed.status).toBe(200); expect(changed.body).not.toEqual(first.body);
  const update = db.games.updateOne.bind(db.games);
  jest.spyOn(db.games, "updateOne").mockImplementationOnce(async (...args) => { await update(...args); throw new Error("lost acknowledgement"); });
  await expect(f.games.upsert("a", game("one", { result: "Victory", myBuild: "Changed" }))).rejects.toThrow("lost acknowledgement");
  const uncertain = await get(f, path, changed.headers.etag); expect(uncertain.status).toBe(200); expect(uncertain.body).not.toEqual(changed.body);
  // The semantic ACK was lost, but the subsequent revision advance is known.
  expect(uncertain.headers["cache-control"]).toBe("private, no-cache");
  expect(uncertain.headers.etag).not.toBe(changed.headers.etag);
  expect(JSON.stringify(first.body)).not.toContain("private-other");
});

test("an unknown revision acknowledgement bypasses retention without hiding the authoritative new result", async () => {
  const f = fixture(); await f.games.upsert("a", game("one")); const before = await get(f, "/maps");
  const original = db.users.findOneAndUpdate.bind(db.users);
  jest.spyOn(db.users, "findOneAndUpdate").mockImplementation(async (filter, update, options) => {
    const value = await original(filter, update, options);
    if (update.$inc?.dataRev) throw new Error("revision acknowledgement lost");
    return value;
  });
  await f.games.upsert("a", game("one", { result: "Defeat" }));
  const retired = await get(f, "/maps", before.headers.etag);
  expect(retired.status).toBe(503); expect(retired.body.error).toBe("user_cache_changed");
  const after = await get(f, "/maps", before.headers.etag);
  expect(after.status).toBe(200); expect(after.body).not.toEqual(before.body);
  expect(after.headers["cache-control"]).toBe("private, no-store"); expect(after.headers.etag).toBeUndefined();
  expect(f.revisions.counters.revision_failure).toBe(1); expect(f.cache.completed.size).toBe(0);
});

test.each(routes)("%s observes metadata-only curve change at exact memo expiry, without extending it to10minutes", async (_method, path) => {
  const f = fixture(); await f.games.upsert("a", game("one"));
  const first = await get(f, path); expect(first.status).toBe(200);
  expect([...f.cache.completed.values()][0].expiresAt).toBe(61000);
  await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, curve({ sampleGames: 500 }));
  f.advance(59999); expect((await get(f, path, first.headers.etag)).status).toBe(304);
  f.advance(1); const next = await get(f, path, first.headers.etag);
  expect(next.status).toBe(200); expect(next.headers.etag).not.toBe(first.headers.etag);
  expect(next.body[0].expectation).toMatchObject({ sampleGames: 500, supportedBins: 2 });
  expect(next.body[0].expectedWins).toBe(first.body[0].expectedWins);
});

test.each(routes)("%s OFF preserves original group/filter/body/header and per-subgroup curve calls", async (_method, path) => {
  await db.games.insertMany([game("p", { userId: "a" }), game("t", { userId: "a", myRace: "Terran" }), game("resumed", { userId: "a", isResumedFromReplay: true })]);
  const old = fixture(false, true), off = fixture(false);
  const read = jest.spyOn(db.users, "findOne"), snapshot = jest.spyOn(off.model, "snapshot"), curves = jest.spyOn(off.model, "curve");
  const query = path + "?group_by_race_played=true&map=Site%20Delta%20LE";
  const a = await get(old, query), b = await get(off, query);
  expect([b.status, b.text, b.headers["cache-control"], b.headers.etag]).toEqual([a.status, a.text, a.headers["cache-control"], a.headers.etag]);
  expect(curves).toHaveBeenCalledTimes(3); expect(snapshot).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect(off.cache.completed.size + off.cache.pending.size + off.cache.bytes + off.cache.active).toBe(0);
});

test.each(routes)("%s uses the one captured curve across all race subgroups even if the memo expires before work", async (_method, path) => {
  const f = fixture();
  for (const [letter, name] of [["P", "Protoss"], ["T", "Terran"], ["Z", "Zerg"]]) await f.games.upsert("a", game(letter, { myRace: name, myLadderRace: letter }));
  const capture = f.model.snapshot.bind(f.model), publicCurve = jest.spyOn(f.model, "curve");
  const snapshots = jest.spyOn(f.model, "snapshot").mockImplementationOnce(async () => {
    const selected = await capture();
    await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, curve({ sampleGames: 500 }));
    f.advance(60000); return selected;
  });
  const answer = await get(f, path + "?group_by_race_played=true");
  expect(answer.status).toBe(200); expect(answer.headers["cache-control"]).toBe("private, no-store");
  for (const race of ["Protoss", "Terran", "Zerg"]) expect(answer.body[race][0].expectation.sampleGames).toBe(400);
  expect(snapshots).toHaveBeenCalledTimes(1); expect(publicCurve).not.toHaveBeenCalled();
  expect(f.cache.completed.size).toBe(0); expect(answer.text).not.toContain("strength1:");
});

test.each(["expire", "publish", "unknown publish"])("%s during real work gives initiator baseline200/no-store but never reuses it for a joined follower", async change => {
  const f = fixture(); await f.games.upsert("a", game("one"));
  const hold = await holdAggregate(); const calls = jest.spyOn(f.aggregations, "maps");
  const first = get(f, "/maps").then(value => value); await hold.entered.promise;
  const joined = get(f, "/maps").then(value => value); await until(() => f.cache.stats.join === 1);
  if (change === "expire") f.advance(60000);
  else {
    if (change === "unknown publish") jest.spyOn(f.model.coll, "replaceOne").mockRejectedValueOnce(new Error("lost acknowledgement"));
    if (change === "publish") await f.model.recompute();
    else await expect(f.model.recompute()).rejects.toThrow("lost acknowledgement");
  }
  expect(f.cache.active).toBe(1); hold.release.resolve();
  const a = await first, b = await joined;
  expect(a.status).toBe(200); expect(a.headers["cache-control"]).toBe("private, no-store"); expect(a.headers.etag).toBeUndefined();
  expect(b.status).toBe(503); expect(b.body.error).toBe("user_cache_changed"); expect(b.headers["retry-after"]).toBe("1");
  expect(calls).toHaveBeenCalledTimes(1); expect(f.cache.completed.size + f.cache.active + f.cache.responses + f.cache.reserved).toBe(0);
});

test("owner mutation retains the existing stronger rejection even when the curve expires", async () => {
  const f = fixture(); await f.games.upsert("a", game("one")); const hold = await holdAggregate();
  const pending = get(f, "/maps").then(value => value); await hold.entered.promise;
  await f.games.upsert("a", game("one", { result: "Defeat" })); f.advance(60000); hold.release.resolve();
  const answer = await pending; expect(answer.status).toBe(503); expect(answer.body.error).toBe("user_cache_changed");
  expect(f.cache.completed.size + f.cache.active + f.cache.reserved).toBe(0);
});

test("real cold curve IO is response-admitted and coalesced before any game computation", async () => {
  const f = fixture(); await f.games.upsert("a", game("one"));
  const entered = deferred(), release = deferred(), original = f.model.coll.findOne.bind(f.model.coll);
  const read = jest.spyOn(f.model.coll, "findOne").mockImplementationOnce(async (...args) => {
    const value = await original(...args); entered.resolve(); await release.promise; return value;
  });
  const work = jest.spyOn(f.aggregations, "maps"), first = get(f, "/maps").then(value => value);
  await entered.promise; expect(f.cache.preparing).toBe(1); expect(f.cache.responses).toBe(1); expect(work).not.toHaveBeenCalled();
  const second = get(f, "/maps").then(value => value); await until(() => f.cache.preparing === 2);
  expect(read).toHaveBeenCalledTimes(1); release.resolve(); const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe(200); expect(b.status).toBe(200); expect(b.body).toEqual(a.body);
  expect(work).toHaveBeenCalledTimes(1); expect(f.cache.preparing + f.cache.active + f.cache.responses).toBe(0);
});
