"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Decimal128, Long, ObjectId } = require("mongodb");
const request = require("supertest");
const { pino } = require("pino");
const fixtures = require("../../../shared/fixtures/sessions.json");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { loadConfig } = require("../src/config/loader");
const { SessionPolicyService } = require("../src/services/sessionPolicy");
const { AggregationsService } = require("../src/services/aggregations");
const { GamesService } = require("../src/services/games");
const { UsersService } = require("../src/services/users");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { GdprService } = require("../src/services/gdpr");
const { mongoOrder, instant } = require("../src/services/sessions");
const { sha256 } = require("../src/util/hash");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
/** @type {MongoMemoryServer} */
let mongo;
/** @type {import("../src/db/connect").DbContext} */
let db;
/** @type {import("mongodb").Collection<Record<string, unknown>>} */
let sequence;
const rawToken = "session-core-owner-a-device-token-0123456789";
const authorization = `Bearer ${rawToken}`;
/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
  /** @type {() => void} */
  let resolve = () => { throw new Error("deferred resolver not initialized"); };
  /** @type {Promise<void>} */
  const promise = new Promise(done => { resolve = () => done(); });
  return { promise, resolve };
}
/** @param {boolean} enabled */
function appFor(enabled) {
  // Complete configuration from an explicit synthetic environment; never read process.env.
  const config = loadConfig({
    MONGODB_URI: "mongodb://127.0.0.1:27017/sessions_core_fixture",
    CLERK_SECRET_KEY: "synthetic-unused-clerk-key",
    SERVER_PEPPER_HEX: "08".repeat(32),
    NODE_ENV: "test", USER_CACHE_ENABLED: String(enabled),
    RATE_LIMIT_PER_MINUTE: "5000", SC2_PY_ANALYZER_DIR: "/none",
  });
  const built = buildApp({
    db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { getEmail: async () => null, deleteUser: async () => {} },
    config: { ...config, clerkSecretKey: "" },
  });
  const { services } = built;
  // buildApp intentionally exposes object; validate the real instances used by these tests.
  if (!("sessionPolicy" in services) || !(services.sessionPolicy instanceof SessionPolicyService)
    || !("aggregations" in services) || !(services.aggregations instanceof AggregationsService)
    || !("games" in services) || !(services.games instanceof GamesService)
    || !("users" in services) || !(services.users instanceof UsersService)
    || !("overlayTokens" in services) || !(services.overlayTokens instanceof OverlayTokensService)
    || !("gdpr" in services) || !(services.gdpr instanceof GdprService)) {
    throw new Error("Expected real session integration services");
  }
  return { ...built, services: {
    sessionPolicy: services.sessionPolicy, aggregations: services.aggregations,
    games: services.games, users: services.users, overlayTokens: services.overlayTokens, gdpr: services.gdpr,
  } };
}
/** @param {import("express").Express} app @param {string} path */
const get = (app, path) => request(app).get(path).set("authorization", authorization);
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "sessions_core_proposal" });
  await db.db.createCollection("session_order_fixtures", { collation: { locale: "en", strength: 1 } });
  // Production's materialization target is simple: its unique _id index must match $merge.
  // Only session_order_fixtures deliberately has a non-simple default for traversal coverage.
  await db.db.createCollection("admin_global_trends_history");
  sequence = db.db.collection("session_order_fixtures");
});
afterAll(async () => { await db.close(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.deviceTokens, db.overlayTokens, db.games, db.gameDetails, db.pendingIdentityDeletions]) await collection.deleteMany({});
  await sequence.deleteMany({});
  await db.users.insertOne({ userId: "a", clerkUserId: "clerk_sessions_a", dataRev: 0 });
  await db.deviceTokens.insertOne({ userId: "a", tokenHash: sha256(rawToken), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
});
afterEach(() => jest.restoreAllMocks());

test.each(fixtures)("Mongo single-object documentNumber matches shared view: $name", async fixture => {
  // Fixture normalization is explicit test setup, never a production rescue scan.
  const supported = fixture.games.flatMap(row => {
    const time = instant(row.date); return time === null ? [] : [{ ...row, date: new Date(time) }];
  });
  if (supported.length) await sequence.insertMany(supported);
  const rows = await sequence.aggregate([
    { $addFields: { _sessionOrder: mongoOrder() } },
    { $setWindowFields: { sortBy: { _sessionOrder: 1 }, output: { position: { $documentNumber: {} } } } },
  ], { collation: { locale: "simple" } }).toArray();
  expect(rows.map(row => row.fixture)).toEqual(fixture.groups.flat());
  expect(rows.map(row => row.position)).toEqual(rows.map((_, index) => index + 1));
});

test("unsupported legacy scalar kinds do not add a row filter or availability error", async () => {
  const values = [Decimal128.fromString("1.1"), Long.fromString("9007199254740993"), NaN, Infinity, new Date(0), new ObjectId(), [], {}];
  await sequence.insertMany(values.map((myMmr, index) => ({ date: new Date(0), gameId: `legacy-${index}`, myMmr })));
  const rows = await sequence.aggregate([{ $addFields: { _sessionOrder: mongoOrder() } }, { $sort: { _sessionOrder: 1 } }], { collation: { locale: "simple" } }).toArray();
  expect(rows).toHaveLength(values.length);
  expect(rows.map(row => row.gameId).sort()).toEqual(values.map((_, index) => `legacy-${index}`).sort());
  // No universal legacy BSON->JSON ordering assertion: these are outside it.
});

test.each([false, true])("actual policy/Profile transport and omitted legacy patch with cache%s", async enabled => {
  const { app } = appFor(enabled);
  const auto = await get(app, "/v1/me/session-policy");
  expect(auto.status).toBe(200); expect(auto.headers["cache-control"]).toBe("private, no-store");
  expect(auto.body).toEqual({ gapMinutes: 90, source: "auto-player", storedGapMinutes: null });
  expect((await get(app, "/v1/me/session-policy?gap=240")).status).toBe(400);
  const save = await request(app).put("/v1/me/profile").set("authorization", authorization).send({ sessionGapMinutes: 15 });
  expect(save.status).toBe(200); expect(save.body.sessionPolicy).toEqual({ gapMinutes: 15, source: "preference", storedGapMinutes: 15 });
  expect((await request(app).put("/v1/me/profile").set("authorization", authorization).send({ displayName: "Owner" })).status).toBe(200);
  expect((await get(app, "/v1/me/session-policy")).body.gapMinutes).toBe(15);
  for (const value of [14, 481, "90", 90.1]) expect((await request(app).put("/v1/me/profile").set("authorization", authorization).send({ sessionGapMinutes: value })).status).toBe(400);
});

test.each([false, true])("actual unknown token insertion invalidates Auto and holds no invented ACK with cache%s", async enabled => {
  const { services } = appFor(enabled), entered = deferred(), release = deferred();
  expect(await services.sessionPolicy.resolve("a")).toMatchObject({ gapMinutes: 90 });
  const old = services.sessionPolicy.lease("a"), original = db.overlayTokens.insertOne.bind(db.overlayTokens);
  jest.spyOn(db.overlayTokens, "insertOne").mockImplementationOnce(async row => { await original(row); entered.resolve(); await release.promise; throw new Error("unknown token ACK"); });
  const write = services.overlayTokens.create("a", "Test"); await entered.promise;
  try { expect(await db.overlayTokens.countDocuments({ userId: "a" })).toBe(1); }
  finally { release.resolve(); }
  await expect(write).rejects.toThrow("unknown token ACK");
  expect(() => services.sessionPolicy.assertCurrent(old)).toThrow("session_policy_changed");
  expect(await services.sessionPolicy.resolve("a")).toEqual({ gapMinutes: 240, source: "auto-overlay", storedGapMinutes: null });
  const row = await db.overlayTokens.findOne({ userId: "a" });
  if (!row || typeof row.token !== "string") throw new Error("Expected the persisted overlay token");
  await services.overlayTokens.revoke("a", row.token);
  expect(await services.sessionPolicy.resolve("a")).toMatchObject({ gapMinutes: 240 });
});

test.each([false, true])("all-row bridge and decided positions preserve real momentum with cache%s", async enabled => {
  const { app } = appFor(enabled);
  await db.games.insertMany(["Victory", "Tie", "Victory"].map((result, index) => ({ userId: "a", gameId: `bridge-${index}`, date: new Date(index * 60 * 60000), result, myRace: "Protoss", map: "Test" })));
  const response = await get(app, "/v1/momentum");
  expect(response.status).toBe(200); expect(response.body.sessionGapMinutes).toBe(90);
  expect(response.body.baseline).toMatchObject({ wins: 2, losses: 0, total: 2 });
  expect(response.body.postWin).toMatchObject({ wins: 1, total: 1 });
  expect(response.body.sessionPositions.map((/** @type {{pos: number, total: number}} */ row) => [row.pos, row.total])).toEqual([[1, 1], [2, 1]]);
});

test.each([-1, 0, 1])("real momentum breaks only above the exact gap by%dms", async delta => {
  const { services } = appFor(false);
  await db.games.insertMany([0, 5400000 + delta].map((date, index) => ({ userId: "a", gameId: `boundary-${index}`, date: new Date(date), result: "Victory", myRace: "Protoss", map: "Test" })));
  const value = await services.aggregations.momentum("a", {}, { sessionGapMinutes: 90 });
  expect(value.baseline.total).toBe(2); expect(value.postWin.total).toBe(delta > 0 ? 0 : 1);
  expect(value.sessionPositions.map((/** @type {{pos: number, total: number}} */ row) => [row.pos, row.total])).toEqual(delta > 0 ? [[1, 2]] : [[1, 1], [2, 1]]);
});

test("global sequence retains simple collation and player contexts without personal policy IO", async () => {
  await db.games.insertMany([
    { userId: "a", gameId: "a", result: "Defeat" }, { userId: "a", gameId: "A", result: "Victory" },
    { userId: "b", gameId: "B", result: "Victory" },
  ].map(row => ({ ...row, date: new Date(0), myRace: "Protoss", myLadderRace: "Protoss", isLadderGame: true, playerCount: 2, map: "Test" })));
  const users = jest.spyOn(db.users, "findOne"), tokens = jest.spyOn(db.overlayTokens, "findOne");
  const service = new AdminGlobalTrendsService({ db });
  const value = await service.run("momentum", {}, { sessionGapMinutes: 90 });
  expect(value.baseline.total).toBe(3); expect(value.postWin).toMatchObject({ total: 1, losses: 1 });
  expect(value.postLoss).toMatchObject({ total: 0 });
  expect(value.sessionPositions.map((/** @type {{pos: number, total: number}} */ row) => [row.pos, row.total])).toEqual([[1, 2], [2, 1]]);
  expect(users).not.toHaveBeenCalled(); expect(tokens).not.toHaveBeenCalled();
});

test.each([false, true])("held momentum cannot publish across an actual Profile policy write with cache%s", async enabled => {
  const { app, services } = appFor(enabled), entered = deferred(), release = deferred(), aggregate = db.games.aggregate.bind(db.games);
  jest.spyOn(db.games, "aggregate").mockImplementation((pipeline, options) => {
    const cursor = aggregate(pipeline, options);
    if ((pipeline || []).some(stage => stage.$setWindowFields)) {
      const toArray = cursor.toArray.bind(cursor);
      jest.spyOn(cursor, "toArray").mockImplementation(async () => {
        entered.resolve(); await release.promise; return toArray();
      });
    }
    return cursor;
  });
  const old = get(app, "/v1/momentum").then(response => response); await entered.promise;
  try { await services.users.updateProfile("a", { sessionGapMinutes: 15 }); }
  finally { release.resolve(); }
  const rejected = await old; expect([409, 503]).toContain(rejected.status); expect(rejected.body.error).toBeDefined();
  const fresh = await get(app, "/v1/momentum"); expect(fresh.status).toBe(200); expect(fresh.body.sessionGapMinutes).toBe(15);
});

test.each([false, true])("actual erasure fence brackets failed acquisition even with cache%s", async enabled => {
  const { services } = appFor(enabled), old = services.sessionPolicy.lease("a");
  await services.sessionPolicy.resolve("a");
  jest.spyOn(services.gdpr, "_acquireMutationFenceCore").mockRejectedValueOnce(new Error("unknown fence ACK"));
  await expect(services.gdpr._acquireMutationFence("a", "delete_all")).rejects.toThrow("unknown fence ACK");
  expect(() => services.sessionPolicy.assertCurrent(old)).toThrow("session_policy_changed");
  expect(await services.sessionPolicy.resolve("a")).toMatchObject({ gapMinutes: 90 });
});

// Scalar-Date regressions share the real Mongo fixtures and indexed bounds.
test("scalar Date guard precedes numeric ordering without changing indexed bounds", async () => {
  const since = new Date(0), until = new Date(120 * 60000);
  /** @type {import("mongodb").Filter<Record<string, unknown>>} */
  const indexed = { date: { $type: "date", $gte: since, $lte: until } };
  await sequence.insertMany([
    { gameId: "scalar-zero", date: since }, { gameId: "scalar-end", date: until },
    { gameId: "array", date: [new Date(60 * 60000)] },
    { gameId: "mixed-array", date: [new Date(60 * 60000), "legacy"] },
    { gameId: "string", date: new Date(60 * 60000).toISOString() },
    { gameId: "number", date: 60 * 60000 }, { gameId: "null", date: null },
    { gameId: "missing" }, { gameId: "before", date: new Date(-1) },
    { gameId: "after", date: new Date(until.getTime() + 1) },
  ]);
  // This witnesses the Mongo QUERY-type distinction that motivated the guard.
  const candidates = await sequence.find(indexed).toArray();
  expect(candidates.map(row => row.gameId)).toEqual(expect.arrayContaining(["array", "mixed-array"]));
  const rows = await sequence.aggregate([
    { $match: indexed },
    { $match: { $expr: { $eq: [{ $type: "$date" }, "date"] } } },
    { $addFields: { _sessionOrder: mongoOrder() } },
    { $setWindowFields: { sortBy: { _sessionOrder: 1 }, output: { position: { $documentNumber: {} } } } },
  ], { collation: { locale: "simple" } }).toArray();
  expect(rows.map(row => [row.gameId, row.position])).toEqual([["scalar-zero", 1], ["scalar-end", 2]]);
  expect(indexed).toEqual({ date: { $type: "date", $gte: since, $lte: until } });
});

test.each([
  { enabled: false, bounded: false }, { enabled: true, bounded: false },
  { enabled: false, bounded: true }, { enabled: true, bounded: true },
])("personal momentum excludes date arrays before all-row bridging cache$enabled bounds$bounded", async ({ enabled, bounded }) => {
  const { app } = appFor(enabled);
  const end = 120 * 60000;
  const rows = [
    { gameId: "scalar-win", date: new Date(0), result: "Victory" },
    { gameId: "scalar-bridge", date: new Date(60 * 60000), result: "Tie" },
    { gameId: "scalar-loss", date: new Date(end), result: "Defeat" },
    { gameId: "array-undecided", date: [new Date(30 * 60000)], result: "Tie" },
    { gameId: "array-decided", date: [new Date(90 * 60000)], result: "Victory" },
    { gameId: "legacy-string", date: new Date(60 * 60000).toISOString(), result: "Victory" },
    { gameId: "legacy-number", date: 60 * 60000, result: "Victory" },
    { gameId: "null-date", date: null, result: "Victory" },
    { gameId: "missing-date", result: "Victory" },
    ...(bounded ? [{ gameId: "before-bounds", date: new Date(-1), result: "Victory" },
      { gameId: "after-bounds", date: new Date(end + 1), result: "Victory" }] : []),
  ];
  await db.games.insertMany(rows.map(row => ({ userId: "a", myRace: "Protoss", map: "Test", ...row })));
  const path = bounded ? `/v1/momentum?since=${encodeURIComponent(new Date(0).toISOString())}&until=${encodeURIComponent(new Date(end).toISOString())}` : "/v1/momentum";
  const response = await get(app, path);
  expect(response.status).toBe(200);
  expect(response.body.sessionGapMinutes).toBe(90);
  expect(response.body.baseline).toMatchObject({ wins: 1, losses: 1, total: 2 });
  expect(response.body.postWin).toMatchObject({ wins: 0, losses: 1, total: 1 });
  expect(response.body.sessionPositions.map((/** @type {{pos: number, total: number}} */ row) => [row.pos, row.total])).toEqual([[1, 1], [2, 1]]);
});

test("global momentum inherits scalar Date guard without joining player contexts or reading personal policy", async () => {
  await db.games.insertMany([
    { userId: "a", gameId: "a-win", date: new Date(0), result: "Victory" },
    { userId: "a", gameId: "a-bridge", date: new Date(60 * 60000), result: "Tie" },
    { userId: "a", gameId: "a-loss", date: new Date(120 * 60000), result: "Defeat" },
    { userId: "a", gameId: "a-array", date: [new Date(30 * 60000)], result: "Tie" },
    { userId: "b", gameId: "b-only", date: new Date(0), result: "Victory" },
    { userId: "b", gameId: "b-array", date: [new Date(60 * 60000)], result: "Victory" },
  ].map(row => ({ myRace: "Protoss", myLadderRace: "Protoss", isLadderGame: true, playerCount: 2, map: "Test", ...row })));
  const userReads = jest.spyOn(db.users, "findOne"), tokenReads = jest.spyOn(db.overlayTokens, "findOne");
  const service = new AdminGlobalTrendsService({ db });
  const value = await service.run("momentum", {}, { sessionGapMinutes: 90 });
  expect(value.baseline).toMatchObject({ wins: 2, losses: 1, total: 3 });
  expect(value.postWin).toMatchObject({ wins: 0, losses: 1, total: 1 });
  expect(value.sessionPositions.map((/** @type {{pos: number, total: number}} */ row) => [row.pos, row.total])).toEqual([[1, 2], [2, 1]]);
  expect(userReads).not.toHaveBeenCalled(); expect(tokenReads).not.toHaveBeenCalled();
});
test.each([false, true])("Today and personal momentum resolve Auto, preference and Auto reset consistently cache%s", async enabled => {
  const { services } = appFor(enabled), now = Date.now();
  await db.games.insertMany([
    { gameId: "old-window", date: new Date(now - 15 * 86400000), result: "Victory", myMmr: 4000 },
    { gameId: "first", date: new Date(now - 120 * 60000), result: "Defeat", myMmr: 4100 },
    { gameId: "last", date: new Date(now - 60000), result: "Victory", myMmr: 4120 },
    { gameId: "future", date: new Date(now + 3600000), result: "Victory", myMmr: 9000 },
  ].map(row => ({ userId: "a", myRace: "Protoss", myToonHandle: "1-S2-1-123", opponent: { race: "Zerg", toonHandle: "1-S2-1-456" }, isLadderGame: true, map: "Test", ...row })));
  const personal = async () => services.aggregations.momentum("a", { until: new Date(now) });
  let current = await services.games.todaySession("a", "UTC", { reuseRecent: true });
  expect(current).toMatchObject({ games: 1, wins: 1, losses: 0, sessionGapMinutes: 90, sessionPolicySource: "auto-player" });
  expect((await personal()).sessionGapMinutes).toBe(90);
  await services.overlayTokens.create("a", "Session contract");
  current = await services.games.todaySession("a", "America/New_York", { reuseRecent: true });
  expect(current).toMatchObject({ games: 2, wins: 1, losses: 1, sessionGapMinutes: 240, sessionPolicySource: "auto-overlay" });
  expect((await personal()).sessionGapMinutes).toBe(240);
  await services.users.updateProfile("a", { sessionGapMinutes: 15 });
  current = await services.games.todaySession("a", "UTC", { reuseRecent: true });
  expect(current).toMatchObject({ games: 1, wins: 1, losses: 0, sessionGapMinutes: 15, sessionPolicySource: "preference" });
  expect((await personal()).sessionGapMinutes).toBe(15);
  await services.users.updateProfile("a", { sessionGapMinutes: null });
  current = await services.games.todaySession("a", "UTC", { reuseRecent: true });
  expect(current).toMatchObject({ games: 2, wins: 1, losses: 1, sessionGapMinutes: 240, sessionPolicySource: "auto-overlay" });
  expect((await personal()).sessionGapMinutes).toBe(240);
});

test.each([false, true])("snapshot restore preserves the session preference and retires prior policy cache%s", async enabled => {
  const { services } = appFor(enabled);
  await services.users.updateProfile("a", { sessionGapMinutes: 15 });
  const snapshot = await services.gdpr.snapshot("a");
  await services.users.updateProfile("a", { sessionGapMinutes: 240 });
  expect(await services.sessionPolicy.resolve("a")).toMatchObject({ gapMinutes: 240, source: "preference" });
  const prior = services.sessionPolicy.lease("a");
  await services.gdpr.restoreSnapshot("a", snapshot.id);
  expect(() => services.sessionPolicy.assertCurrent(prior)).toThrow("session_policy_changed");
  expect((await db.users.findOne({ userId: "a" }))?.sessionGapMinutes).toBe(15);
  expect(await services.sessionPolicy.resolve("a")).toEqual({ gapMinutes: 15, source: "preference", storedGapMinutes: 15 });
});
