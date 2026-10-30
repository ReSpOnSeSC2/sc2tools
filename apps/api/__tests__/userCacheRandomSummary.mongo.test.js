// @ts-nocheck
"use strict";
// Random summary under the default-off cache, through the production composition (buildApp). Its one-minute
// completed memo answers only while the cache is off, so a finished request that skipped the guard cannot leave a
// body that a later guarded GET retains. An in-flight join stays the residual ADR 0072 allows for every covered kind.
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { GamesService } = require("../src/services/games");
const { createBackupStore } = require("./helpers/userBackupsStore");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "owner-a") return { sub: "clerk-a" };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({ users: { getUser: jest.fn() } })),
}));

let mongo, db, on, off;
const config = userCacheEnabled => ({ port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "cache_random_summary",
  clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 5), corsAllowedOrigins: [], rateLimitPerMinute: 5000,
  pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [], userCacheEnabled });
const game = (gameId, overrides = {}) => ({ gameId, date: new Date("2026-01-01T12:00:00Z"), result: "Victory",
  myRace: "Protoss", myLadderRace: "P", myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay",
  playerCount: 2, isLadderGame: true, map: "Site Delta LE", durationSec: 600,
  opponent: { race: "Zerg", strategy: "Pool", displayName: "Opponent" }, ...overrides });
const two = () => game("two", { date: new Date("2026-03-01T12:00:00Z"), result: "Defeat" });
// Another API process: its write reaches none of this process's invalidators; only the stored dataRev moves.
async function peerWrite(row) {
  await new GamesService(db).upsert("a", row);
  await db.users.updateOne({ userId: "a" }, { $inc: { dataRev: 1 } });
}
const send = (target, method, query = "", tag) => {
  const req = request(target.app)[method](`/v1/random-summary${query}`).set("Authorization", "Bearer owner-a");
  return tag ? req.set("If-None-Match", tag) : req;
};
const protoss = res => [res.body.total, res.body.perRace.Protoss.wins, res.body.perRace.Protoss.losses];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_random_summary" });
  [on, off] = [true, false].map(enabled => buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config: config(enabled) }));
});
afterAll(async () => {
  for (const target of [on, off]) await target.services.customBuilds.stopReclassifications();
  await db.close(); await mongo.stop();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const name of ["users", "games", "gameDetails", "opponents"]) await db[name].deleteMany({});
  // Each test starts as the process's first observation of the owner, with no memo left from an earlier test.
  on.services.userRevision.forget("a");
  for (const target of [on, off]) target.services.aggregations.trendsRequests.invalidateForUser("a");
  await db.users.insertOne({ userId: "a", clerkUserId: "clerk-a", dataRev: 0 });
});

test("a HEAD that finished before another process's write leaves nothing the first guarded GET can retain", async () => {
  const computed = jest.spyOn(on.services.aggregations, "_randomSummaryOnce");
  await peerWrite(game("one"));
  // HEAD skips the guard but runs the route's work; a completed memo would keep this one-game answer for a minute.
  expect((await send(on, "head")).status).toBe(200);
  await peerWrite(two());
  // The process has never observed the owner, so the GET adopts dataRev 2 without retiring anything.
  const fresh = await send(on, "get");
  expect(fresh.status).toBe(200); expect(protoss(fresh)).toEqual([2, 1, 1]);
  const hit = await send(on, "get");
  expect(hit.body).toEqual(fresh.body); expect(hit.headers.etag).toBe(fresh.headers.etag);
  expect((await send(on, "get", "", fresh.headers.etag)).status).toBe(304);
  expect(computed).toHaveBeenCalledTimes(2); expect(on.services.aggregations.trendsRequests.completed.size).toBe(0);
});

test("after another process's write, an observed owner's GET is retired and then reads fresh, never the old body", async () => {
  await peerWrite(game("one"));
  const first = await send(on, "get"); expect(protoss(first)).toEqual([1, 1, 0]);
  expect((await send(on, "head")).status).toBe(200);
  await peerWrite(two());
  const retired = await send(on, "get", "", first.headers.etag);
  expect(retired.status).toBe(503); expect(retired.headers["retry-after"]).toBe("1");
  const fresh = await send(on, "get", "", first.headers.etag);
  expect(fresh.status).toBe(200); expect(protoss(fresh)).toEqual([2, 1, 1]);
  expect(fresh.headers.etag).not.toBe(first.headers.etag);
});

test("filtered, unfiltered and race-filtered requests keep separate bodies and validators, and a local write retires each", async () => {
  await peerWrite(game("one")); await peerWrite(two());
  const all = await send(on, "get"), since = await send(on, "get", "?since=2026-02-01"), race = await send(on, "get", "?race=Z");
  expect(protoss(all)).toEqual([2, 1, 1]); expect(protoss(since)).toEqual([1, 0, 1]);
  // The service ignores the race filter, but the key keeps it, so that request never shares the unfiltered entry.
  expect(race.body).toEqual(all.body); expect(new Set([all, since, race].map(res => res.headers.etag)).size).toBe(3);
  expect((await send(on, "get", "?since=2026-02-01", all.headers.etag)).status).toBe(200);
  expect((await send(on, "get", "", all.headers.etag)).status).toBe(304);
  expect((await send(on, "get", "?race=Z", race.headers.etag)).status).toBe(304);
  await on.services.games.upsert("a", game("three", { date: new Date("2026-04-01T12:00:00Z") }));
  for (const [query, tag, expected] of [["", all.headers.etag, [3, 2, 1]], ["?since=2026-02-01", since.headers.etag, [2, 1, 1]],
    ["?race=Z", race.headers.etag, [3, 2, 1]]]) {
    const changed = await send(on, "get", query, tag);
    expect(changed.status).toBe(200); expect(protoss(changed)).toEqual(expected);
  }
  expect(on.services.aggregations.trendsRequests.completed.size).toBe(0);
});

test("with the cache off, the unfiltered memo still shares one answer for its minute, race-only requests included", async () => {
  const computed = jest.spyOn(off.services.aggregations, "_randomSummaryOnce");
  await peerWrite(game("one"));
  const first = await send(off, "get"); expect(protoss(first)).toEqual([1, 1, 0]);
  expect(protoss(await send(off, "get", "?since=2025-01-01"))).toEqual([1, 1, 0]);
  expect((await send(off, "head")).status).toBe(200);
  await peerWrite(two());
  // Unchanged flag-off behaviour: another process's write stays invisible to the memo until it expires, and the
  // service drops the race filter, so a race-only request shares the same answer.
  expect((await send(off, "get")).body).toEqual(first.body);
  expect((await send(off, "get", "?race=Z")).body).toEqual(first.body);
  expect(computed).toHaveBeenCalledTimes(2);
  // Filtered charts still read fresh.
  expect(protoss(await send(off, "get", "?since=2025-01-01"))).toEqual([2, 1, 1]);
  for (const entry of off.services.aggregations.trendsRequests.completed.values()) entry.expiresAt = 0;
  expect(protoss(await send(off, "get"))).toEqual([2, 1, 1]);
  expect(computed).toHaveBeenCalledTimes(4);
});
