// @ts-nocheck
"use strict";
// Matchup time series as a curve-dependent kind of the default-off cache, on real Mongo with the real curve service:
// one captured proof keys the body and drives the Mongo expectation and every rating window, work under a proof never
// joins in-flight chart work, a retired proof is a 200/no-store baseline, and the off path is unchanged.
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { MmrExpectationService } = require("../src/services/mmrExpectation");
const { fitCalibration } = require("../src/services/mmrExpectationMath");
const { GamesService } = require("../src/services/games");
const { UserCache } = require("../src/middleware/userCache");
const { UserRevision } = require("../src/util/userRevision");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
let mongo, db;
const PATH = "/timeseries/matchups";
const curve = extra => ({ _id: "corpus-1v1", ruleVersion: 1, ...fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]), ...extra });
// Different anchors as well as metadata, so a curve read in only one of Mongo or shaping changes the body.
const other = () => ({ _id: "corpus-1v1", ruleVersion: 1, ...fitCalibration([{ bin: 0, n: 300, wins: 240 }, { bin: 23, n: 300, wins: 120 }]) });
const game = (id, extra = {}) => ({ gameId: id, date: new Date("2026-01-01T12:00:00Z"), result: "Victory", myRace: "Protoss", myLadderRace: "P",
  myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay", playerCount: 2, matchFormat: "1v1", isLadderGame: true, map: "Site Delta LE",
  durationSec: 600, myBuild: "Expand", opponent: { race: "Zerg", mmr: 4200, mmrSource: "replay", strategy: "Pool" }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("fixture did not settle"); }
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "matchup_timeseries_cache" }); });
beforeEach(async () => {
  jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({});
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a" }, { userId: "b", clerkUserId: "clerk-b" }]);
  await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, curve(), { upsert: true });
});
afterAll(async () => { await db?.close(); await mongo?.stop(); }); const holds = []; afterEach(() => { for (const hold of holds.splice(0)) hold.release.resolve(); }); // A test that fails mid-hold still lets its held work finish.
function fixture(enabled = true, legacy = false) {
  let now = 1000;
  const model = new MmrExpectationService(db, { now: () => now });
  const aggregations = new AggregationsService(db, { mmrExpectation: model });
  const revisions = new UserRevision(db.users, { enabled });
  const cache = new UserCache(revisions, { enabled, now: () => now });
  // Production composition: a retirement also drops the owner's inner joins.
  if (revisions.enabled) revisions.addInvalidator(owner => aggregations.trendsRequests.invalidateForUser(owner));
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
  const hold = { entered, release }; holds.push(hold); return hold;
}
// Four rated race pairs on separate days, plus another owner's private game.
async function seed(f) {
  for (const [id, myRace, letter, opp, day, result, mmr] of [["pz1", "Protoss", "P", "Zerg", 1, "Victory", 4200], ["pz2", "Protoss", "P", "Zerg", 2, "Defeat", 4300],
    ["pt", "Protoss", "P", "Terran", 3, "Victory", 4100], ["tz", "Terran", "T", "Zerg", 4, "Defeat", 3900], ["zp", "Zerg", "Z", "Protoss", 5, "Victory", 4250]]) {
    await f.games.upsert("a", game(id, { myRace, myLadderRace: letter, date: new Date(`2026-01-0${day}T12:00:00Z`), result,
      opponent: { race: opp, mmr, mmrSource: "replay", strategy: "Pool" } }));
  }
  await f.games.upsert("b", game("private-other", { map: "Other" }));
}
// The original route body under the stored curve, from a router without any cache.
const baseline = async path => (await get(fixture(false, true), path)).body;

test.each([["daily matchups", "?interval=day&tz=UTC&group_by=matchup"], ["default", ""], ["race-played split", "?group_by_race_played=true"]])(
  "%s matches the original body under the captured curve, revalidates 304 and never reads the public curve", async (_label, query) => {
    const f = fixture(); await seed(f); const expected = await baseline(PATH + query);
    const calls = jest.spyOn(f.aggregations, "matchupTimeseries"), publicCurve = jest.spyOn(f.model, "curve"), snapshots = jest.spyOn(f.model, "snapshot");
    const first = await get(f, PATH + query);
    expect(first.status).toBe(200); expect(first.headers["cache-control"]).toBe("private, no-cache"); expect(first.body).toEqual(expected);
    expect(first.body.ratingSeries.map(row => row.matchup)).toEqual(["PvT", "PvZ", "TvZ", "ZvP"]);
    for (const row of first.body.ratingSeries) expect(row.expectation).toMatchObject({ method: "calibrated", sampleGames: 400, supportedBins: 2 });
    expect((await get(f, PATH + query, first.headers.etag)).status).toBe(304);
    expect(calls).toHaveBeenCalledTimes(1); expect(calls.mock.calls[0]).toHaveLength(4);
    expect(publicCurve).not.toHaveBeenCalled(); expect(snapshots).toHaveBeenCalledTimes(2);
    expect(first.text).not.toContain("private-other"); expect(first.text).not.toContain("strength1:");
  });

test("one captured curve drives the Mongo expectation and every rating pair even if the memo changes before work", async () => {
  const f = fixture(); await seed(f); const path = PATH + "?group_by=matchup", expected = await baseline(path);
  const capture = f.model.snapshot.bind(f.model), publicCurve = jest.spyOn(f.model, "curve");
  jest.spyOn(f.model, "snapshot").mockImplementationOnce(async () => {
    const selected = await capture();
    await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, other());
    f.advance(60000); return selected;
  });
  const answer = await get(f, path);
  expect(answer.status).toBe(200); expect(answer.headers["cache-control"]).toBe("private, no-store"); expect(answer.body).toEqual(expected);
  expect(publicCurve).not.toHaveBeenCalled(); expect(f.cache.completed.size).toBe(0); expect(answer.text).not.toContain("strength1:");
  // The replacement curve really changes the body, so a curve read anywhere else would have been caught.
  expect(await baseline(path)).not.toEqual(expected);
});

test.each(["expire", "retire"])("after a curve %s, the next request runs its own computation instead of joining the old one", async change => {
  const f = fixture(); await seed(f); const path = PATH + "?interval=month&group_by=matchup", before = await baseline(path);
  const hold = await holdAggregate();
  const first = get(f, path).then(value => value); await hold.entered.promise;
  if (change === "expire") { await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, other()); f.advance(60000); }
  else f.model.snapshots.retire();
  const started = db.games.aggregate.mock.calls.length;
  const second = get(f, path).then(value => value); await until(() => db.games.aggregate.mock.calls.length > started);
  hold.release.resolve(); const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe(200); expect(a.headers["cache-control"]).toBe("private, no-store"); expect(a.headers.etag).toBeUndefined();
  expect(b.status).toBe(200);
  if (change === "expire") {
    // The reloaded memo issues a new proof, so the body follows the new curve and is retained under it.
    expect(b.headers["cache-control"]).toBe("private, no-cache"); expect(b.body).toEqual(await baseline(path)); expect(b.body).not.toEqual(before);
    expect((await get(f, path, b.headers.etag)).status).toBe(304); expect(f.cache.completed.size).toBe(1);
  } else {
    // A retired memo issues no new proof until it reloads: same curve, its own computation, nothing retained.
    expect(b.headers["cache-control"]).toBe("private, no-store"); expect(b.headers.etag).toBeUndefined(); expect(b.body).toEqual(before);
    expect(f.cache.completed.size).toBe(0);
  }
});

test.each(["expire", "publish", "unknown publish"])("%s during real work gives the initiator a 200/no-store baseline and a joined follower 503", async change => {
  const f = fixture(); await seed(f); const path = PATH + "?interval=month";
  const hold = await holdAggregate(); const calls = jest.spyOn(f.aggregations, "matchupTimeseries");
  const first = get(f, path).then(value => value); await hold.entered.promise;
  const joined = get(f, path).then(value => value); await until(() => f.cache.stats.join === 1);
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

test("a retained body expires with its curve proof: 304 until the memo expires, then a fresh 200 under the new curve", async () => {
  const f = fixture(); await seed(f); const path = PATH + "?group_by=matchup";
  const first = await get(f, path); expect(first.status).toBe(200);
  expect([...f.cache.completed.values()][0].expiresAt).toBe(61000);
  await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, other());
  f.advance(59999); expect((await get(f, path, first.headers.etag)).status).toBe(304);
  f.advance(1); const next = await get(f, path, first.headers.etag);
  expect(next.status).toBe(200); expect(next.headers.etag).not.toBe(first.headers.etag);
  for (const row of next.body.ratingSeries) expect(row.expectation).toMatchObject({ sampleGames: 600, supportedBins: 2 });
});

test("after an unknown curve publish, revalidation is a 200/no-store baseline, never a 304", async () => {
  const f = fixture(); await seed(f); const path = PATH + "?group_by=matchup";
  const first = await get(f, path); expect(first.headers["cache-control"]).toBe("private, no-cache");
  jest.spyOn(f.model.coll, "replaceOne").mockRejectedValueOnce(new Error("lost acknowledgement"));
  await expect(f.model.recompute()).rejects.toThrow("lost acknowledgement");
  const answer = await get(f, path, first.headers.etag);
  expect(answer.status).toBe(200); expect(answer.headers["cache-control"]).toBe("private, no-store"); expect(answer.headers.etag).toBeUndefined();
});

test("off is identical to the original route, reads the curve once per computation and keeps the inner join", async () => {
  const old = fixture(false, true), off = fixture(false); await seed(old);
  const read = jest.spyOn(db.users, "findOne"), snapshot = jest.spyOn(off.model, "snapshot"), curves = jest.spyOn(off.model, "curve");
  const calls = jest.spyOn(off.aggregations, "matchupTimeseries");
  const query = PATH + "?interval=day&tz=UTC&group_by=matchup&group_by_race_played=true&map=Site%20Delta%20LE";
  const a = await get(old, query), b = await get(off, query);
  expect([b.status, b.text, b.headers["cache-control"], b.headers.etag]).toEqual([a.status, a.text, a.headers["cache-control"], a.headers.etag]);
  expect(curves).toHaveBeenCalledTimes(1); expect(calls.mock.calls[0]).toHaveLength(3);
  expect(snapshot).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect(off.cache.completed.size + off.cache.pending.size + off.cache.bytes + off.cache.active).toBe(0);
  // Two concurrent off requests still share one computation: one facet aggregate and one more curve read.
  const hold = await holdAggregate();
  const one = get(off, query).then(value => value); await hold.entered.promise;
  const two = get(off, query).then(value => value); await until(() => calls.mock.calls.length === 3);
  hold.release.resolve(); const [x, y] = await Promise.all([one, two]);
  expect(y.text).toBe(x.text); expect(curves).toHaveBeenCalledTimes(2);
  expect(db.games.aggregate.mock.calls.filter(([pipeline]) => pipeline.some(stage => stage.$facet))).toHaveLength(1);
});

test("a HEAD never captures a proof, and a GET under a newer curve never adopts the HEAD's in-flight computation", async () => {
  const f = fixture(); await seed(f); const path = PATH + "?interval=month&group_by=matchup", before = await baseline(path);
  const snapshots = jest.spyOn(f.model, "snapshot"), curves = jest.spyOn(f.model, "curve");
  const hold = await holdAggregate();
  const head = request(f.app).head(path).set("x-fixture-owner", "a").then(value => value); await hold.entered.promise;
  expect(snapshots).not.toHaveBeenCalled(); expect(curves).toHaveBeenCalledTimes(1);
  await db.db.collection("mmr_expectation").replaceOne({ _id: "corpus-1v1" }, other()); f.advance(60000);
  const started = db.games.aggregate.mock.calls.length;
  const getting = get(f, path).then(value => value); await until(() => db.games.aggregate.mock.calls.length > started);
  hold.release.resolve(); const [h, g] = await Promise.all([head, getting]);
  expect(h.status).toBe(200);
  expect(g.status).toBe(200); expect(g.headers["cache-control"]).toBe("private, no-cache");
  expect(g.body).toEqual(await baseline(path)); expect(g.body).not.toEqual(before); expect(f.cache.completed.size).toBe(1);
});

test("admin global trends keeps its three-argument call, its own curve read and no proof", async () => {
  const f = fixture(false, true); await seed(f);
  const admin = new AdminGlobalTrendsService({ db, mmrExpectation: f.model });
  const calls = jest.spyOn(AggregationsService.prototype, "matchupTimeseries");
  const snapshots = jest.spyOn(f.model, "snapshot"), curves = jest.spyOn(f.model, "curve");
  const result = await admin.run("matchupTimeseries", {}, { interval: "day", groupByOwnRace: true });
  expect(result.ratingSeries.length).toBeGreaterThan(0);
  expect(calls).toHaveBeenCalled(); for (const call of calls.mock.calls) expect(call).toHaveLength(3);
  expect(snapshots).not.toHaveBeenCalled(); expect(curves).toHaveBeenCalled();
});
