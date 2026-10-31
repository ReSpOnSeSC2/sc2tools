// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const request = require("supertest");
const { randomToken, sha256 } = require("../src/util/hash");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { stamped, original } = require("./helpers/corpusStamp");
let mongo, db, app, services, store;
const game = () => ({ userId: "a", gameId: "game", date: new Date(), result: "Victory", myRace: "Protoss", map: "Site Delta LE", durationSec: 600 });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "revision_destructive_writers" }); store = createBackupStore();
  ({ app, services } = buildApp({ db, userBackupsStore: store, logger: pino({ level: "silent" }), clerkClient: { deleteUser: async () => {} },
    config: { nodeEnv: "test", userCacheEnabled: true, clerkSecretKey: "", serverPepper: Buffer.alloc(32, 3), rateLimitPerMinute: 1000, corsAllowedOrigins: [], adminUserIds: [], pythonAnalyzerDir: "/none", pythonExe: null } }));
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks(); for (const name of ["users", "games", "gameDetails", "opponents", "opponentNotes", "customBuilds", "macroJobs", "userBackups", "pendingIdentityDeletions", "deviceTokens"]) await db[name].deleteMany({});
  await db.db.collection("backup_restore_staging").deleteMany({}); store.objects.clear(); services.userRevision.forget("a");
  await db.users.insertOne({ userId: "a", clerkUserId: "clerk-a", dataRev: 5 }); await db.games.insertOne(game());
});
test("hide, unhide and pending/tombstone deletion retire private results while preserving owner scope", async () => {
  await db.users.insertOne({ userId: "b" }); await db.games.insertOne({ ...game(), userId: "b" });
  for (const operation of [() => services.gameControls.setExcluded("a", "game", { excluded: true, reason: "friend_played" }),
    () => services.gameControls.setExcluded("a", "game", { excluded: false }), () => services.gameControls.deleteGame("a", "game")]) {
    const before = await services.userRevision.snapshot("a"); await operation(); expect(services.userRevision.current(before)).toBe(false);
  }
  expect(await db.games.findOne({ userId: "a" })).toMatchObject({ _deleted: true, excluded: true });
  expect((await db.games.findOne({ userId: "b" }))._deleted).toBeUndefined();
});
test("known and partial/unknown wipes retire and retain the original failure", async () => {
  let before = await services.userRevision.snapshot("a"); await services.gdpr.wipeGames("a"); expect(services.userRevision.current(before)).toBe(false);
  await db.games.insertOne(game()); const error = new Error("unknown delete ack"), original = db.games.deleteMany.bind(db.games);
  const spy = jest.spyOn(db.games, "deleteMany").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  before = await services.userRevision.snapshot("a"); await expect(services.gdpr.wipeGames("a")).rejects.toBe(error); spy.mockRestore();
  expect(services.userRevision.current(before)).toBe(false); expect(await db.games.countDocuments({ userId: "a" })).toBe(0);
});
test("restore never rolls dataRev back, including an archive with an older full users row", async () => {
  const saved = await services.gdpr.snapshot("a"); await services.games.upsert("a", { ...game(), macroScore: 99 });
  const revision = (await db.users.findOne({ userId: "a" })).dataRev;
  const before = await services.userRevision.snapshot("a"); await services.gdpr.restoreSnapshot("a", saved.id);
  expect(services.userRevision.current(before)).toBe(false);
  expect((await db.users.findOne({ userId: "a" })).dataRev).toBeGreaterThan(revision);
  expect((await db.games.findOne({ userId: "a" })).macroScore).toBeUndefined();
});
test("restore's committed insert followed by failure retires the partial result", async () => {
  const saved = await services.gdpr.snapshot("a"); const error = new Error("unknown restore insert"), original = db.games.insertMany.bind(db.games);
  const spy = jest.spyOn(db.games, "insertMany").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  const before = await services.userRevision.snapshot("a");
  await expect(services.gdpr.restoreSnapshot("a", saved.id)).rejects.toBe(error); spy.mockRestore();
  expect(services.userRevision.current(before)).toBe(false); expect(await db.games.countDocuments({ userId: "a" })).toBe(1);
});
test("a visibility acknowledgement failure and a tombstone failure still retire", async () => {
  const error = new Error("unknown visibility"), update = db.games.updateOne.bind(db.games);
  let spy = jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => {
    const value = await update(...args), own = Array.isArray(args[1]) ? original(args[1])[0] : args[1];
    if (own?.$set?.excluded) throw error; return value;
  });
  let before = await services.userRevision.snapshot("a");
  await expect(services.gameControls.setExcluded("a", "game", { excluded: true, reason: "friend_played" })).rejects.toBe(error);
  spy.mockRestore(); expect(services.userRevision.current(before)).toBe(false);
  const replace = db.games.replaceOne.bind(db.games); spy = jest.spyOn(db.games, "replaceOne").mockImplementationOnce(async (...args) => { await replace(...args); throw error; });
  before = await services.userRevision.snapshot("a"); await expect(services.gameControls.deleteGame("a", "game")).rejects.toBe(error);
  spy.mockRestore(); expect(services.userRevision.current(before)).toBe(false);
});
test("account erasure forgets every late fill and cannot recreate users during a later finalizer", async () => {
  const before = await services.userRevision.snapshot("a"); await services.gdpr.deleteAll("a");
  expect(await db.users.findOne({ userId: "a" })).toBeNull(); expect(services.userRevision.current(before)).toBe(false);
  await services.userRevision.run("a", async () => undefined);
  expect(await db.users.findOne({ userId: "a" })).toBeNull();
  await expect(services.userRevision.snapshot("a")).rejects.toMatchObject({ status: 401 });
});

test.each(["ingest", "hide", "wipe"])("a held real chart DTO cannot be published after completed %s; the next explicit request is fresh", async (mutation) => {
  const token = randomToken(32);
  await db.deviceTokens.insertOne({ tokenHash: sha256(token), userId: "a", revokedAt: null, createdAt: new Date() });
  const original = services.aggregations.timeseries.bind(services.aggregations);
  let release, started;
  const held = new Promise((resolve) => { release = resolve; }), captured = new Promise((resolve) => { started = resolve; });
  const spy = jest.spyOn(services.aggregations, "timeseries").mockImplementationOnce(async (...args) => {
    const dto = await original(...args); started(); await held; return dto;
  });
  const chart = () => request(app).get("/v1/timeseries?interval=day&tz=UTC").set("authorization", `Bearer ${token}`);
  const oldResponse = chart().then((response) => response);
  try {
    await captured;
    if (mutation === "ingest") await services.games.upsert("a", { ...game(), macroScore: 90 });
    else if (mutation === "hide") await services.gameControls.setExcluded("a", "game", { excluded: true, reason: "friend_played" });
    else await services.gdpr.wipeGames("a");
    release(); const old = await oldResponse;
    expect(old.status).toBe(503); expect(old.headers["retry-after"]).toBe("1");
    expect(Object.keys(old.body)).toEqual(["error"]);
    expect(old.body.error).toMatchObject({ code: "user_cache_changed", message: "internal_error" });
    expect(old.text).not.toContain('"points"'); expect(spy).toHaveBeenCalledTimes(1);
    const fresh = await chart(); expect(fresh.status).toBe(200); expect(spy).toHaveBeenCalledTimes(2);
    if (mutation === "ingest") expect(fresh.body.points[0].avgMacroScore).toBe(90);
    else expect(fresh.body.points).toEqual([]);
  } finally { release(); await oldResponse; spy.mockRestore(); }
});
