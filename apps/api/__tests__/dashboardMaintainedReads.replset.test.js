// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { randomUUID } = require("crypto");
const { ObjectId } = require("mongodb");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildMeRouter } = require("../src/routes/me");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { UsersService } = require("../src/services/users");
const { GamesService } = require("../src/services/games");
const { GameStatsWrites } = require("../src/services/gameStatsWrites");
const { MAINTENANCE_VERSION, statsMatch } = require("../src/services/gameStatsMaintenance");

const userId = "dashboard-reader", other = "dashboard-other";
const played = new Date("2026-10-20T12:00:00Z"), logger = pino({ level: "silent" });
let mongo, db, writer, users, games, app, ownedMongo, stats, commands;
const pairings = { latestAgent: jest.fn(), listDevices: jest.fn() };
const auth = (req, _res, next) => { req.auth = { userId: req.get("x-test-owner") || userId, source: "device" }; next(); };

beforeAll(async () => {
  // Actual handlers/services/Mongo; only unrelated device/import providers and
  // authentication are local adapters. No provider credentials or requests.
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  ownedMongo = { pid: mongo.servers[0].instanceInfo.instance.mongodProcess.pid, port: mongo.servers[0].instanceInfo.port };
  process.stdout.write(`dashboard_reader_owned_process ${JSON.stringify(ownedMongo)}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "dashboard_maintained_reads", awaitBackgroundIndexes: true }, { logger });
  db.client.on("commandStarted", event => commands.push(event.command));
  writer = new GameStatsWrites(db); users = new UsersService(db); games = new GamesService(db);
  app = express(); app.use(express.json());
  app.use("/v1", buildMeRouter({ users, games, pairings, auth, imports: { activeJob: async () => null }, replayArchiveEnabled: false }));
  app.use(buildErrorHandler(logger));
});

beforeEach(async () => {
  jest.restoreAllMocks(); commands = [];
  await db.games.deleteMany({}); await db.users.deleteMany({});
  await db.users.insertMany([
    { userId, clerkUserId: "local-reader-clerk", email: "reader@example.invalid", battleTag: "Reader#123", sessionGapMinutes: null,
      preferences: { onboarding: { goals: ["improve"], dismissedAt: null }, replayArchive: { version: 1, resyncRequestedAt: "2026-10-20T00:00:00Z" } } },
    { userId: other, clerkUserId: "local-other-clerk", email: "other@example.invalid" },
  ]);
  pairings.latestAgent.mockResolvedValue({ paired: true, version: "1.0.0", lastSeenAt: played });
  pairings.listDevices.mockResolvedValue([{ deviceId: "local-fixture" }]);
  stats = jest.spyOn(games, "stats");
});

afterAll(async () => {
  await writer?.stopAndDrain(); await db?.close(); await mongo?.stop();
  if (ownedMongo) {
    expect(() => process.kill(ownedMongo.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    process.stdout.write(`dashboard_reader_owned_process_stopped ${JSON.stringify(ownedMongo)}\n`);
  }
});

async function seed(rows = [{ gameId: "one", date: played }, { gameId: "two", date: played, result: "Draw" }], ownerId = userId) {
  const owner = await writer.capture(ownerId);
  await writer.write(owner, session => rows.length ? db.games.insertMany(rows.map(row => ({ userId: ownerId, ...row })), { session }) : Promise.resolve(),
    { selection: { gameIds: rows.map(row => row.gameId) } });
  expect((await db.users.findOne({ userId: ownerId })).gameStatsMaintenance.version).toBe(MAINTENANCE_VERSION);
}

async function read(path = "/me", ownerId = userId, target = app) {
  commands.length = 0; stats.mockClear();
  return request(target).get(`/v1${path}`).set("x-test-owner", ownerId);
}

function expectReadCosts(fallback, ownerId = userId) {
  expect(stats).toHaveBeenCalledTimes(fallback ? 1 : 0);
  if (fallback) expect(stats).toHaveBeenCalledWith(ownerId);
  const ownerReads = commands.filter(command => command.find === "users");
  expect(ownerReads).toHaveLength(1);
  expect(ownerReads[0].filter).toEqual({ userId: ownerId });
  const gameReads = commands.filter(command => command.find === "games" || command.aggregate === "games");
  expect(gameReads).toHaveLength(fallback ? 2 : 0);
  if (fallback) {
    expect(gameReads.find(command => command.aggregate === "games").pipeline[0]).toEqual({ $match: statsMatch(ownerId) });
    const latest = gameReads.find(command => command.find === "games");
    expect(latest.filter).toEqual(statsMatch(ownerId)); expect(latest.sort).toBeInstanceOf(Map);
    expect([...latest.sort.entries()]).toEqual([["date", -1]]); expect(latest.limit).toBe(1);
    expect(latest.projection).toEqual({ date: 1, _id: 0 });
  }
}

test("qualified /me keeps its exact DTO, one owner/prefs read, and zero stats queries", async () => {
  await seed();
  const summary = jest.spyOn(users, "getSummary"), prefs = jest.spyOn(users, "getPreferences");
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ userId, source: "device", games: { total: 2, latest: played.toISOString() },
    email: "reader@example.invalid", agentVersion: "1.0.0", agentPaired: true, agentLastSeenAt: played.toISOString(),
    activeImportJob: null, onboarding: { goals: ["improve"], dismissedAt: null }, isAdmin: false });
  expect(summary).not.toHaveBeenCalled(); expect(prefs).not.toHaveBeenCalled(); expectReadCosts(false);
  const projection = commands.find(command => command.find === "users").projection;
  expect(projection["preferences.onboarding"]).toBe(1); expect(projection["preferences.replayArchive"]).toBeUndefined();
});

test.each([[[]], [[{ gameId: "missing-date" }]], [[{ gameId: "null-date", date: null }]]])("ready empty/positive-null tuples preserve Doctor's strict no_games rule: %j", async rows => {
  await seed(rows);
  const response = await read("/me/doctor");
  // This router's existing Doctor handler does not set Cache-Control. The
  // maintained read must not turn it into a different HTTP cache contract.
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBeUndefined();
  expect(response.body).toEqual({ ok: true, warnings: rows.length ? [] : [{ id: "no_games", severity: "info",
    message: "No games recorded yet. The agent will import your recent replays automatically after pairing." }] });
  expectReadCosts(false);
});

test("qualified Doctor combines real normalized profile/archive prefs without exposing proof", async () => {
  await seed();
  const profile = jest.spyOn(users, "getProfile"), prefs = jest.spyOn(users, "getPreferences");
  const response = await read("/me/doctor");
  expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true, warnings: [] }); expectReadCosts(false);
  expect(profile).not.toHaveBeenCalled(); expect(prefs).not.toHaveBeenCalled();
  const projection = commands.find(command => command.find === "users").projection;
  expect(projection["preferences.replayArchive"]).toBe(1); expect(projection["preferences.onboarding"]).toBeUndefined();
});

test("enabled archive diagnostics retain the original counts and same-row resync preferences", async () => {
  await seed(); const archive = jest.spyOn(games, "replayArchiveStatus");
  const target = express(); target.use("/v1", buildMeRouter({ users, games, pairings, auth, replayArchiveEnabled: true })); target.use(buildErrorHandler(logger));
  const before = await read("/me/doctor", userId, target);
  expect(before.status).toBe(200); expect(before.body).toEqual({ ok: true, warnings: [] });
  expect(stats).not.toHaveBeenCalled(); expect(archive).toHaveBeenCalledWith(userId);
  expect(commands.filter(command => command.find === "users")).toHaveLength(1);
  expect(commands.filter(command => command.aggregate === "games")).toHaveLength(2);
  await db.users.updateOne({ userId }, { $set: { "preferences.replayArchive": {} } });
  const after = await read("/me/doctor", userId, target);
  expect(after.body).toEqual({ ok: false, warnings: [{ id: "replay_archive_incomplete", severity: "warn",
    message: "2 saved games are missing the original replay file. Update to the latest desktop agent, then open it and click Re-sync once. The agent will archive replay files still on this PC; files already deleted locally will remain unavailable.",
    cta: { label: "Update agent", href: "/download" } }] });
  expect(stats).not.toHaveBeenCalled(); expect(commands.filter(command => command.find === "users")).toHaveLength(1);
});

test.each([
  ["maintenance1", { "gameStatsMaintenance.version": 1 }],
  ["protocol1", { gameStatsProtocolVersion: 1 }],
  ["wrong-owner", { "gameStatsMaintenance.ownerId": new ObjectId() }],
  ["revision-mismatch", { gameStatsRevision: randomUUID() }],
  ["epoch-mismatch", { gameStatsMutationEpoch: randomUUID() }],
  ["unsupported-latest", { "gameStats.latest": "raw legacy date", "gameStatsMaintenance.status": "unsupported_latest" }],
  ["malformed-count", { "gameStats.total": -1 }],
  ["expired-fence", { _gdprMutation: { id: "expired", leaseUntil: new Date(0) } }],
  ["falsy-fence", { _gdprMutation: null }],
])("/me %s proof misses once and executes the exact original Mongo queries", async (_name, update) => {
  await seed(); await db.users.updateOne({ userId }, { $set: update });
  const response = await read();
  expect(response.status).toBe(200); expect(response.body.games).toEqual({ total: 2, latest: played.toISOString() });
  expectReadCosts(true);
});

test("unqualified legacy BSON arrays retain Mongo eligibility and raw sorted-date result", async () => {
  const raw = ["legacy-sort-value"];
  await seed([{ gameId: "kept", date: raw }, { gameId: "array-excluded", excluded: [true], date: played },
    { gameId: "array-deleted", _deleted: [true], date: played }, { gameId: "array-resumed", isResumedFromReplay: [true], date: played }]);
  const response = await read();
  expect(response.status).toBe(200); expect(response.body.games).toEqual({ total: 1, latest: raw }); expectReadCosts(true);
});

test.each(["/me", "/me/doctor"])("missing owner in %s falls back to actual orphan-game count instead of zero", async path => {
  await db.users.deleteOne({ userId }); await db.games.insertOne({ userId, gameId: "orphan", date: played });
  const response = await read(path);
  expect(response.status).toBe(200); expectReadCosts(true);
  if (path === "/me") { expect(response.body.games.total).toBe(1); expect(response.body.email).toBeNull(); expect(response.body.onboarding).toEqual({}); }
  else expect(response.body.warnings.map(warning => warning.id)).toEqual(["no_profile"]);
});

test("every request rereads authority across owner replacement, preferences, and account switch", async () => {
  await seed(); const before = await read(); expect(before.body.games.total).toBe(2); expectReadCosts(false);
  const old = await db.users.findOne({ userId }); await db.users.deleteOne({ userId });
  await db.users.insertOne({ ...old, _id: new ObjectId(), preferences: { onboarding: { goals: ["stream"] } } });
  const replaced = await read(); expect(replaced.body.onboarding).toEqual({ goals: ["stream"] }); expectReadCosts(true);
  await seed([], other); const switched = await read("/me", other);
  expect(switched.body).toMatchObject({ userId: other, email: "other@example.invalid", games: { total: 0, latest: null }, onboarding: {} });
  expectReadCosts(false, other);
});

test("fence acquisition invalidates ready reuse and release with stale epoch stays fallback until eager refresh", async () => {
  await seed(); const epoch = randomUUID();
  await db.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: epoch, _gdprMutation: { id: "held" } } });
  expect((await read()).body.games.total).toBe(2); expectReadCosts(true);
  await db.users.updateOne({ userId }, { $unset: { _gdprMutation: "" } });
  expect((await read()).body.games.total).toBe(2); expectReadCosts(true);
  await seed([]); expect((await read()).body.games.total).toBe(2); expectReadCosts(false);
});

test.each([
  [{ _gdprMutation: { id: "busy" }, sessionGapMinutes: 0 }, "gdpr_operation_busy"],
  [{ sessionGapMinutes: 0 }, "session_policy_invalid"],
])("Doctor preserves profile error precedence without issuing games stats: %s", async (update, code) => {
  await seed(); await db.users.updateOne({ userId }, { $set: update });
  const response = await read("/me/doctor");
  expect(response.status).toBe(503); expect(response.body.error.code).toBe(code); expectReadCosts(false);
});

test("Doctor falsy-fence residue preserves profile success and original stats fallback", async () => {
  await seed(); await db.users.updateOne({ userId }, { $set: { _gdprMutation: false } });
  const response = await read("/me/doctor");
  expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true, warnings: [] }); expectReadCosts(true);
});

test("owner-query errors propagate, while fallback errors retain original route failure", async () => {
  await seed(); const outage = Object.assign(new Error("synthetic query outage"), { status: 503, code: "synthetic_db_unavailable" });
  jest.spyOn(db.users, "findOne").mockRejectedValueOnce(outage);
  const failedOwner = await read(); expect(failedOwner.status).toBe(503); expect(failedOwner.body.error.code).toBe(outage.code); expect(stats).not.toHaveBeenCalled();
  jest.restoreAllMocks(); stats = jest.spyOn(games, "stats").mockRejectedValueOnce(outage);
  await db.users.updateOne({ userId }, { $unset: { gameStatsMaintenance: "" } });
  const failedFallback = await read(); expect(failedFallback.status).toBe(503); expect(failedFallback.body.error.code).toBe(outage.code); expect(stats).toHaveBeenCalledTimes(1);
});

test("unsupported transaction contexts never reuse an otherwise ready tuple", async () => {
  await seed(); db.gameStatsTransactions = false;
  try {
    expect((await read()).body.games).toEqual({ total: 2, latest: played.toISOString() }); expectReadCosts(true);
  } finally { db.gameStatsTransactions = true; }
});

test("older injected services use their original summary/profile/prefs and stats methods", async () => {
  await seed(); const legacy = { touch: users.touch.bind(users), getSummary: jest.fn(users.getSummary.bind(users)),
    getProfile: jest.fn(users.getProfile.bind(users)), getPreferences: jest.fn(users.getPreferences.bind(users)) };
  const target = express(); target.use("/v1", buildMeRouter({ users: legacy, games, pairings, auth })); target.use(buildErrorHandler(logger));
  expect((await read("/me", userId, target)).body.games.total).toBe(2);
  expect(stats).toHaveBeenCalledTimes(1); expect(legacy.getSummary).toHaveBeenCalledWith(userId); expect(legacy.getPreferences).toHaveBeenCalledWith(userId, "onboarding");
  expect((await read("/me/doctor", userId, target)).body).toEqual({ ok: true, warnings: [] });
  expect(stats).toHaveBeenCalledTimes(1); expect(legacy.getProfile).toHaveBeenCalledWith(userId); expect(legacy.getPreferences).toHaveBeenCalledWith(userId, "replayArchive");
});
