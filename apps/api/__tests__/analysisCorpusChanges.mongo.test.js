// @ts-nocheck
"use strict";
// Real-Mongo changed-since reads of the analysis corpus through the full app: the snapshot's first page carries the
// corpus version and watermark, a delta returns stamped corpus rows like snapshot items and departed rows as removals,
// pages follow a cursor to a watermark, and a hard delete or a watermark from before change stamps needs a snapshot.
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { STAMP_FLOOR_ID, OVERLAP_MS } = require("../src/services/analysisCorpusChanges");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "owner-a" || token === "owner-b") return { sub: `clerk-${token.slice(-1)}` };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({ users: { getUser: jest.fn() } })),
}));

let mongo, db, app, services;
const config = { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "corpus_changes", clerkSecretKey: "sk_test",
  serverPepper: Buffer.alloc(32, 9), corsAllowedOrigins: [], rateLimitPerMinute: 5000, pythonExe: null,
  pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [] };
const game = (gameId, overrides = {}) => ({ gameId, date: new Date(Date.now() - 3600000), result: "Victory", myRace: "Protoss",
  map: "Site Delta LE", durationSec: 600, opponent: { race: "Zerg", pulseId: "p1", displayName: "Opponent" }, ...overrides });
const get = (path, query = {}, owner = "a") => request(app).get(`/v1/games/${path}`).query(query).set("Authorization", `Bearer owner-${owner}`);
const changes = (since, version, extra = {}) => get("analysis-corpus/changes", { since, corpus_version: String(version), ...extra });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "corpus_changes" });
  ({ app, services } = buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config }));
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });
beforeEach(async () => {
  for (const name of ["users", "games", "gameDetails", "opponents", "userBackups"]) await db[name].deleteMany({});
  await db.siteConfig.deleteMany({ _id: STAMP_FLOOR_ID });
  await db.siteConfig.insertOne({ _id: STAMP_FLOOR_ID, since: new Date(0) });
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a" }, { userId: "b", clerkUserId: "clerk-b" }]);
});

test("the snapshot's first page carries the version and watermark, and a delta returns stamped rows like snapshot items", async () => {
  await services.games.upsert("a", game("g1")); await services.games.upsert("a", game("g2", { result: "Defeat" }));
  await services.games.upsert("b", game("other"));
  const before = Date.now(), snapshot = (await get("analysis-corpus").expect(200)).body;
  expect(snapshot.corpusVersion).toBe(0);
  expect(Math.abs(new Date(snapshot.watermark).getTime() - (before - OVERLAP_MS))).toBeLessThan(5000);
  const first = (await get("analysis-corpus", { limit: "1" }).expect(200)).body;
  expect(first).toMatchObject({ corpusVersion: 0, watermark: expect.any(String), nextCursor: expect.any(String) });
  const second = (await get("analysis-corpus", { limit: "1", cursor: first.nextCursor }).expect(200)).body;
  expect([second.items.length, "watermark" in second, "corpusVersion" in second]).toEqual([1, false, false]);
  const delta = (await changes(snapshot.watermark, 0).expect(200)).body;
  expect(delta.corpusVersion).toBe(0); expect(delta.nextCursor).toBeNull();
  expect(delta.items.map(item => item.gameId).sort()).toEqual(["g1", "g2"]);
  const byId = Object.fromEntries(snapshot.items.map(item => [item.gameId, item]));
  for (const item of delta.items) expect(item).toEqual(byId[item.gameId]);
  expect(new Date(delta.watermark).getTime()).toBeGreaterThanOrEqual(new Date(snapshot.watermark).getTime());
  expect(new Date(delta.watermark).getTime()).toBeLessThanOrEqual(Date.now() - OVERLAP_MS + 1000);
});

test("rows one bulk write stamped alike all page through, ordered by _id within the stamp", async () => {
  for (const id of ["s1", "s2", "s3"]) await services.games.upsert("a", game(id));
  const same = new Date(Date.now() - 1000);
  await db.games.updateMany({ userId: "a" }, { $set: { updatedAt: same } });
  const since = new Date(same.getTime() - 1).toISOString(), seen = [];
  let page = (await changes(since, 0, { limit: "1" }).expect(200)).body;
  for (;;) {
    seen.push(...page.items.map(item => item.gameId));
    if (!page.nextCursor) break;
    page = (await changes(since, 0, { limit: "1", cursor: page.nextCursor }).expect(200)).body;
  }
  expect(seen.sort()).toEqual(["s1", "s2", "s3"]);
});

test("rows that leave the corpus come back as removals, and pages follow a cursor to a watermark", async () => {
  for (const id of ["g1", "g2", "g3", "g4"]) await services.games.upsert("a", game(id));
  const since = (await get("analysis-corpus").expect(200)).body.watermark;
  await services.gameControls.setExcluded("a", "g1", { excluded: true, reason: "friend_played" });
  await services.gameControls.deleteGame("a", "g2");
  await services.games.quarantineResumedReplay("a", game("g3"));
  const seen = []; let page = (await changes(since, 0, { limit: "1" }).expect(200)).body, pages = 1;
  for (;;) {
    seen.push(...page.items);
    if (!page.nextCursor) break;
    expect(page.watermark).toBeNull();
    page = (await changes(since, 0, { limit: "1", cursor: page.nextCursor }).expect(200)).body; pages += 1;
  }
  expect(pages).toBe(4); expect(page.watermark).toEqual(expect.any(String));
  const last = Object.fromEntries(seen.map(item => [item.gameId, item]));
  expect([last.g1, last.g2, last.g3]).toEqual([{ gameId: "g1", removed: true }, { gameId: "g2", removed: true }, { gameId: "g3", removed: true }]);
  expect(last.g4).toMatchObject({ gameId: "g4", result: "Victory" });
});

test("a history wipe and a restore bump the corpus version, so an older client must take a snapshot", async () => {
  await services.games.upsert("a", game("g1"));
  const { watermark } = (await get("analysis-corpus").expect(200)).body, saved = await services.gdpr.snapshot("a");
  await services.gdpr.wipeGames("a");
  expect((await changes(watermark, 0).expect(200)).body).toEqual({ snapshotRequired: "corpus_version", corpusVersion: 2 });
  await services.gdpr.restoreSnapshot("a", saved.id);
  const after = (await get("analysis-corpus").expect(200)).body;
  expect(after.corpusVersion).toBe(4); expect(after.items.map(item => item.gameId)).toEqual(["g1"]);
  expect((await changes(after.watermark, 4).expect(200)).body.snapshotRequired).toBeUndefined();
});

test("a watermark from before change stamps needs a snapshot, and the floor is created once", async () => {
  await db.siteConfig.deleteMany({ _id: STAMP_FLOOR_ID });
  const old = new Date(Date.now() - 60000).toISOString();
  expect((await changes(old, 0).expect(200)).body).toEqual({ snapshotRequired: "before_stamps", corpusVersion: 0 });
  const floor = (await db.siteConfig.findOne({ _id: STAMP_FLOOR_ID })).since;
  expect(floor.getTime()).toBeGreaterThan(Date.now());
  await changes(old, 0).expect(200);
  expect((await db.siteConfig.findOne({ _id: STAMP_FLOOR_ID })).since).toEqual(floor);
});

test("another owner's changes never appear, and malformed inputs are refused", async () => {
  await services.games.upsert("b", game("other")); await services.games.upsert("a", game("mine"));
  const since = new Date(Date.now() - 600000).toISOString();
  expect((await changes(since, 0).expect(200)).body.items.map(item => item.gameId)).toEqual(["mine"]);
  for (const query of [{ since: "yesterday", corpus_version: "0" }, { since }, { since, corpus_version: "-1" },
    { since, corpus_version: "0", cursor: "not-a-cursor" }]) {
    expect((await get("analysis-corpus/changes", query).expect(400)).body.error.code).toBe("bad_request");
  }
});
