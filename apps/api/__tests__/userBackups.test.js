// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const request = require("supertest");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => ({ sub: token === "two" ? "clerk-two" : "clerk-one" })) }));

describe("streamed snapshots and safe restore (real Mongo)", () => {
  let mongo; let db; let app; let services; let store;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "backup_test" });
    store = createBackupStore();
    const built = buildApp({ db, userBackupsStore: store, logger: pino({ level: "silent" }), config: { nodeEnv: "test", clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 3), rateLimitPerMinute: 10000, corsAllowedOrigins: [], adminUserIds: [], pythonAnalyzerDir: "/none", pythonExe: null } });
    app = built.app; services = built.services;
  });
  afterAll(async () => { await db.close(); await mongo.stop(); });
  beforeEach(async () => {
    for (const name of ["games", "gameDetails", "users", "userBackups", "notifications", "customBuilds", "opponentNotes", "overlayTokens", "deviceTokens"]) await db[name].deleteMany({});
    await db.db.collection("backup_restore_staging").deleteMany({}); store.objects.clear();
    await db.users.insertMany([{ userId: "u1", clerkUserId: "clerk-one" }, { userId: "u2", clerkUserId: "clerk-two" }]);
  });
  const api = (method, path, token = "one") => request(app)[method](`/v1${path}`).set("Authorization", `Bearer ${token}`);
  test("metadata stays small for an archive beyond Mongo's16MB limit and Dates survive the round trip", async () => {
    const played = new Date("2026-10-20T12:00:00Z"); const chunk = "x".repeat(200_000);
    await db.games.insertMany(Array.from({ length: 90 }, (_, n) => ({ userId: "u1", gameId: `large-${n}`, date: played, annotation: chunk })));
    const saved = await services.gdpr.snapshot("u1"); const metadata = await db.userBackups.findOne({ id: saved.id });
    expect(metadata.payload).toBeUndefined(); expect(metadata.counts.games).toBe(90);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(2000);
    let bytes = 0; for await (const line of store.read("u1", saved.id)) bytes += Buffer.byteLength(line);
    expect(bytes).toBeGreaterThan(16 * 1024 * 1024);
    await db.games.deleteMany({ userId: "u1" }); await services.gdpr.restoreSnapshot("u1", saved.id);
    expect(await db.games.countDocuments({ userId: "u1" })).toBe(90);
    expect((await db.games.findOne({ gameId: "large-0" })).date).toEqual(played);
    expect(await db.db.collection("backup_restore_staging").countDocuments()).toBe(0);
  });
  test("preview and restore preserve intersection details/replays, purge only removed games and verify present-day markers", async () => {
    const marker = { available: true, storedAt: new Date(), sha256: "abc", sizeBytes: 123 };
    await db.games.insertMany([{ userId: "u1", gameId: "kept", replayFile: { ...marker, sha256: "historical" } }, { userId: "u1", gameId: "added" }]);
    await db.customBuilds.insertOne({ userId: "u1", slug: "build-one" });
    const snapshot = await services.gdpr.snapshot("u1");
    await db.games.deleteOne({ gameId: "added" });
    await db.games.updateOne({ gameId: "kept" }, { $set: { replayFile: marker, _customBuildReclassify: "stale" } });
    await db.games.insertOne({ userId: "u1", gameId: "removed", replayFile: marker });
    await db.gameDetails.insertMany([{ userId: "u1", gameId: "kept", buildLog: ["survives"] }, { userId: "u1", gameId: "removed" }, { userId: "u2", gameId: "removed" }]);
    await db.deviceTokens.insertOne({ userId: "u1", deviceId: "current-device" });
    const replayFiles = services.gdpr.replayFiles;
    services.gdpr.replayFiles = { verifyAvailableMarker: jest.fn(async () => true), deleteMany: jest.fn(async () => {}) };
    try {
      const preview = await api("get", `/me/backups/${snapshot.id}/preview`).expect(200);
      expect(preview.body).toEqual({ games: { kept: 1, removed: 1, added: 1 }, customBuilds: 1, opponentNotes: 0, overlayTokens: 0, currentRevision: expect.stringMatching(/^[a-f0-9]{24}$/) });
      await api("post", `/me/backups/${snapshot.id}/restore`).send({}).expect(200);
      expect(await db.games.findOne({ userId: "u1", gameId: "removed" })).toBeNull();
      expect((await db.games.findOne({ userId: "u1", gameId: "kept" })).replayFile.sha256).toBe("abc");
      expect((await db.gameDetails.findOne({ userId: "u1", gameId: "kept" })).buildLog).toEqual(["survives"]);
      expect(await db.gameDetails.findOne({ userId: "u1", gameId: "removed" })).toBeNull();
      expect(await db.gameDetails.countDocuments({ userId: "u2" })).toBe(1);
      expect(services.gdpr.replayFiles.deleteMany).toHaveBeenCalledWith("u1", ["removed"]);
      expect(services.gdpr.replayFiles.verifyAvailableMarker).toHaveBeenCalledWith("u1", "kept", expect.objectContaining({ sha256: "abc" }), { clearStale: false });
      expect(await db.deviceTokens.countDocuments({ userId: "u1" })).toBe(1);
      expect(await db.userBackups.countDocuments({ userId: "u1", type: "pre_action" })).toBe(1);
    } finally { services.gdpr.replayFiles = replayFiles; }
  });
  test("corrupt or missing storage aborts before changes and leaves no staging rows", async () => {
    await db.games.insertOne({ userId: "u1", gameId: "safe" }); const saved = await services.gdpr.snapshot("u1");
    store.objects.set(store.keyFor("u1", saved.id), Buffer.from("corrupt"));
    await expect(services.gdpr.restoreSnapshot("u1", saved.id)).rejects.toThrow();
    expect(await db.games.countDocuments({ userId: "u1" })).toBe(1);
    expect(await db.db.collection("backup_restore_staging").countDocuments()).toBe(0);
    const backupStore = services.gdpr.backups.store; services.gdpr.backups.store = null;
    try { await expect(services.gdpr.wipeGames("u1")).rejects.toThrow("backups_unavailable"); }
    finally { services.gdpr.backups.store = backupStore; }
    expect(await db.games.countDocuments({ userId: "u1" })).toBe(1);
  });
  test("label, download, delete and preview are authenticated and owner scoped", async () => {
    const saved = (await api("post", "/me/backups").send({}).expect(201)).body;
    await request(app).get(`/v1/me/backups/${saved.id}/download`).expect(401);
    for (const action of ["download", "preview"]) await api("get", `/me/backups/${saved.id}/${action}`, "two").expect(404);
    await api("patch", `/me/backups/${saved.id}`, "two").send({ label: "theft" }).expect(404);
    await api("delete", `/me/backups/${saved.id}`, "two").expect(404);
    await api("patch", `/me/backups/${saved.id}`).send({ label: "x".repeat(81) }).expect(400);
    await api("patch", `/me/backups/${saved.id}`).send({ label: " Before season " }).expect(200, { label: "Before season" });
    expect((await api("get", `/me/backups/${saved.id}/download`).expect(200)).body.expiresIn).toBe(60);
    await api("delete", `/me/backups/${saved.id}`).expect(200); expect(store.objects.size).toBe(0);
  });
  test("retains five manual, two ISO-week automatic and three pre-action snapshots independently", async () => {
    for (let n = 0; n < 7; n++) await services.gdpr.snapshot("u1");
    expect(await db.userBackups.countDocuments({ userId: "u1", type: "manual" })).toBe(5);
    for (const day of ["2026-10-05", "2026-10-12", "2026-10-19"]) await services.gdpr.backups.weekly("u1", new Date(day));
    await Promise.all([services.gdpr.backups.weekly("u1", new Date("2026-10-25")), services.gdpr.backups.weekly("u1", new Date("2026-10-25"))]);
    expect(await db.userBackups.countDocuments({ userId: "u1", type: "auto" })).toBe(2);
    for (let n = 0; n < 4; n++) await services.gdpr.backups.create("u1", { type: "pre_action" });
    expect(await db.userBackups.countDocuments({ userId: "u1", type: "pre_action" })).toBe(3);
    expect(store.objects.size).toBe(10);
  });
  test("legacy migration keeps its ID and age, drops embedded data only after upload, and remains restorable", async () => {
    const id = "bk_legacy"; const createdAt = new Date("2026-01-03T00:00:00Z");
    await db.userBackups.insertOne({ userId: "u1", id, createdAt, type: "manual", payload: { data: { games: [{ userId: "u1", gameId: "legacy-game", date: createdAt }] } } });
    const put = jest.spyOn(store, "put").mockRejectedValueOnce(new Error("object store failed"));
    await expect(services.gdpr.backups.migrateLegacy("u1", id, async () => {})).rejects.toThrow("object store failed");
    expect((await db.userBackups.findOne({ id })).payload.data.games).toHaveLength(1);
    put.mockRestore(); await services.gdpr.backups.migrateLegacy("u1", id, async () => {});
    const metadata = await db.userBackups.findOne({ id }); expect(metadata.createdAt).toEqual(createdAt); expect(metadata.payload).toBeUndefined();
    await services.gdpr.restoreSnapshot("u1", id); expect((await db.games.findOne({ userId: "u1" })).gameId).toBe("legacy-game");
  });
  test("actual HEAD verification preserves normal stored markers and clears a missing object's stale marker", async () => {
    const { ReplayFilesService } = require("../src/services/replayFiles");
    const marker = { version: 1, storedAt: new Date(), sha256: "a".repeat(64), sizeBytes: 123 };
    await db.games.insertMany(["present", "missing"].map((gameId) => ({ userId: "u1", gameId, replayFile: marker })));
    const saved = await services.gdpr.snapshot("u1");
    const client = { send: jest.fn(async (command) => {
      if (command.constructor.name !== "HeadObjectCommand") throw new Error("unexpected object mutation");
      if (command.input.Key.endsWith("/missing.SC2Replay")) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: 123, Metadata: { sha256: marker.sha256 } };
    }) };
    const original = services.gdpr.replayFiles;
    services.gdpr.replayFiles = new ReplayFilesService({ games: db.games, client, bucket: "raw-test" });
    try {
      const create = jest.spyOn(services.gdpr.backups, "create").mockRejectedValueOnce(new Error("backup upload failed"));
      await expect(services.gdpr.restoreSnapshot("u1", saved.id)).rejects.toThrow("backup upload failed");
      expect((await db.games.findOne({ gameId: "missing" })).replayFile.sha256).toBe(marker.sha256);
      create.mockRestore();
      await services.gdpr.restoreSnapshot("u1", saved.id);
      expect((await db.games.findOne({ gameId: "present" })).replayFile.sha256).toBe(marker.sha256);
      expect((await db.games.findOne({ gameId: "missing" })).replayFile).toBeUndefined();
      expect(client.send).toHaveBeenCalledTimes(4);
    } finally { services.gdpr.replayFiles = original; }
  });
  test("a live write lease and a destructive fence exclude each other on the same Mongo user row", async () => {
    const { claimUserDataLease } = require("../src/middleware/userDataWriteFence");
    const lease = await claimUserDataLease(db.users, "u1");
    let saved = false; const snapshot = services.gdpr.snapshot("u1").then((answer) => { saved = true; return answer; });
    await new Promise((resolve) => setTimeout(resolve, 80)); expect(saved).toBe(false);
    await lease.release(); await snapshot;
    const fence = await services.gdpr._acquireMutationFence("u1", "test_restore");
    try {
      await api("put", "/me/profile").send({ displayName: "must not save" }).expect(409);
      await expect(claimUserDataLease(db.users, "u1")).rejects.toMatchObject({ status: 409 });
      expect((await db.users.findOne({ userId: "u1" }))._gdprMutation.id).toBe(fence.id);
    } finally { await services.gdpr._releaseMutationFence("u1", fence); }
  });
  test("a stale preview refuses restore before a pre-action capture or deletion", async () => {
    await db.games.insertOne({ userId: "u1", gameId: "original" }); const saved = await services.gdpr.snapshot("u1");
    const preview = (await api("get", `/me/backups/${saved.id}/preview`).expect(200)).body;
    await db.games.insertOne({ userId: "u1", gameId: "newly-synced" });
    const answer = await api("post", `/me/backups/${saved.id}/restore`).send({ currentRevision: preview.currentRevision }).expect(409);
    expect(answer.body.error.code).toBe("backup_preview_changed");
    expect(await db.games.distinct("gameId", { userId: "u1" })).toEqual(["newly-synced", "original"]);
    expect(await db.userBackups.countDocuments({ userId: "u1", type: "pre_action" })).toBe(0);
    expect(await db.db.collection("backup_restore_staging").countDocuments()).toBe(0);
  });
  test("an interrupted response retains its expiring lease while its handler may still write", async () => {
    const { EventEmitter } = require("events"); const { withUserDataWriteFence } = require("../src/middleware/userDataWriteFence");
    const res = new EventEmitter(); res.destroyed = false;
    const req = { auth: { userId: "u1" }, method: "POST", originalUrl: "/v1/games" };
    const middleware = withUserDataWriteFence((_req, _res, next) => next(), db.users);
    await new Promise((resolve, reject) => middleware(req, res, (error) => error ? reject(error) : resolve()));
    res.emit("close");
    const user = await db.users.findOne({ userId: "u1" });
    expect(user._dataMutations).toHaveLength(1); expect(user._dataMutations[0].leaseUntil.getTime()).toBeGreaterThan(Date.now());
    // This local fixture has stopped its handler; clear it explicitly rather
    // than waiting fifteen minutes for a crash-residue lease to expire.
    await db.users.updateOne({ userId: "u1" }, { $unset: { _dataMutations: "" } });
  });
  test("account erasure purges streamed backup objects including an orphan without metadata", async () => {
    await services.gdpr.snapshot("u1"); await services.gdpr.snapshot("u2");
    store.objects.set(store.keyFor("u1", "bk_orphan"), Buffer.from("orphan"));
    await services.gdpr.deleteAll("u1");
    expect([...store.objects.keys()]).toHaveLength(1); expect([...store.objects.keys()][0]).toContain("user-backups/u2/");
    expect(await db.userBackups.countDocuments({ userId: "u1" })).toBe(0);
  });
  test("settings restore uses literal fields while retaining identity, goals, checklist and notification choices", async () => {
    await db.users.updateOne({ userId: "u1" }, { $set: { displayName: "$saved-name", preferences: { misc: { tab: "$saved" }, voice: { enabled: true }, onboarding: { goals: ["stream"], dismissedAt: "old" }, notifications: { muted: ["data.repair"] } }, isAdmin: false } });
    const saved = await services.gdpr.snapshot("u1");
    await db.users.updateOne({ userId: "u1" }, { $set: { displayName: "current-name", "preferences.misc": { tab: "new" }, "preferences.onboarding": { goals: ["improve"], checklistRestoredAt: "now", futureField: true }, "preferences.notifications": { muted: [] }, isAdmin: true } });
    await services.gdpr.restoreSnapshot("u1", saved.id);
    const user = await db.users.findOne({ userId: "u1" });
    expect(user.clerkUserId).toBe("clerk-one"); expect(user.isAdmin).toBe(true); expect(user.displayName).toBe("$saved-name");
    expect(user.preferences.misc).toEqual({ tab: "$saved" });
    expect(user.preferences.onboarding).toEqual({ goals: ["improve"], checklistRestoredAt: "now", futureField: true });
    expect(user.preferences.notifications).toEqual({ muted: [] });
  });
  test("opponent repair takes a pre-action snapshot, returns202, notifies completion and CAS-limits concurrent repeats", async () => {
    const first = await api("post", "/me/repair/opponents").send({}).expect(202);
    for (let attempt = 0; attempt < 100 && services.dataRepairs.active.size; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    await api("post", "/me/repair/opponents").send({}).expect(429);
    expect(await db.userBackups.countDocuments({ userId: "u1", type: "pre_action" })).toBe(1);
    const status = (await db.users.findOne({ userId: "u1" })).repairs.opponents;
    expect(status).toMatchObject({ id: first.body.id, status: "complete" });
    const deliveryKey = require("crypto").createHash("sha256").update(`repair:${first.body.id}`).digest("base64url");
    for (let attempt = 0; attempt < 100 && !await db.notifications.countDocuments({ userId: "u1", deliveryKeys: deliveryKey }); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await db.notifications.countDocuments({ userId: "u1", kind: "data.repair", deliveryKeys: deliveryKey })).toBe(1);
    expect((await db.users.findOne({ userId: "u1" }))._gdprMutation).toBeUndefined();
  });
});
