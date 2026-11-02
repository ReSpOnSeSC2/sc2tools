// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { ObjectId } = require("mongodb");
const pino = require("pino");
const request = require("supertest");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const { randomToken, sha256 } = require("../src/util/hash");
const { createBackupStore } = require("./helpers/userBackupsStore");
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let mongo, db, now, service, liveness;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "device_liveness" });
});
afterAll(async () => { await db.close(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const name of ["users", "deviceTokens", "devicePairings", "games", "gameDetails", "opponents", "opponentNotes", "customBuilds", "macroJobs", "userBackups", "pendingIdentityDeletions"]) await db[name].deleteMany({});
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk_device_liveness_a" }, { userId: "b", clerkUserId: "clerk_device_liveness_b" }]);
  now = Date.now(); liveness = new DeviceLiveness({ now: () => now }); service = new DevicePairingsService(db, { liveness });
});
afterEach(() => jest.restoreAllMocks());
async function token(fields = {}) {
  const row = { _id: new ObjectId(), tokenHash: sha256(randomToken(32)), userId: "a", createdAt: new Date(now), lastSeenAt: new Date(now), revokedAt: null, ...fields };
  await db.deviceTokens.insertOne(row); return row;
}
async function settleTouches() { await Promise.all([...liveness.touches.values()]); }

test("each auth performs one narrow active-token read; fresh REST calls do not issue touch commands", async () => {
  const row = await token(), read = jest.spyOn(db.deviceTokens, "findOne"), write = jest.spyOn(db.deviceTokens, "updateOne");
  for (let n = 0; n < 10; n++) expect(await service.findTokenByHash(row.tokenHash)).toEqual({ userId: "a", deviceId: String(row._id) });
  now += 59999; await service.findTokenByHash(row.tokenHash); expect(write).not.toHaveBeenCalled();
  now += 1; await service.findTokenByHash(row.tokenHash); await settleTouches();
  expect(read).toHaveBeenCalledTimes(12); expect(read).toHaveBeenCalledWith({ tokenHash: row.tokenHash, revokedAt: null }, { projection: { _id: 1, userId: 1, lastSeenAt: 1 } });
  expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0][2]).toEqual({ upsert: false });
});

test("concurrent stale REST lookups retain their auth results while exactly one touch is held", async () => {
  const row = await token({ lastSeenAt: null }), gate = deferred(), entered = deferred(), original = db.deviceTokens.updateOne.bind(db.deviceTokens);
  const write = jest.spyOn(db.deviceTokens, "updateOne").mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  const answers = await Promise.all(Array.from({ length: 20 }, () => service.findTokenByHash(row.tokenHash))); await entered.promise;
  expect(answers.every(answer => answer.deviceId === String(row._id))).toBe(true); expect(write).toHaveBeenCalledTimes(1);
  try { expect(liveness.touches.size).toBe(1); } finally { gate.resolve(); await settleTouches(); }
  expect((await db.deviceTokens.findOne({ _id: row._id })).lastSeenAt).toEqual(new Date(now));
});

test.each([null, "legacy", 0, { invalid: true }])("a malformed lastSeenAt %j is repaired once without changing auth shape", async lastSeenAt => {
  const row = await token({ lastSeenAt });
  expect(await service.findTokenByHash(row.tokenHash)).toEqual({ userId: "a", deviceId: String(row._id) }); await settleTouches();
  expect((await db.deviceTokens.findOne({ _id: row._id })).lastSeenAt).toEqual(new Date(now));
});

test("an older held REST touch cannot overwrite a newer heartbeat or its literal metadata", async () => {
  const row = await token({ lastSeenAt: new Date(now - 60000) }), gate = deferred(), entered = deferred(), original = db.deviceTokens.updateOne.bind(db.deviceTokens);
  jest.spyOn(db.deviceTokens, "updateOne").mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  await service.findTokenByHash(row.tokenHash); await entered.promise; now += 10000;
  try { await service.recordHeartbeat("a", row.tokenHash, { version: "$version", hostname: "$host", os: "Windows" }); }
  finally { gate.resolve(); await settleTouches(); }
  const saved = await db.deviceTokens.findOne({ _id: row._id });
  expect(saved).toMatchObject({ lastSeenAt: new Date(now), agentVersion: "$version", hostname: "$host", agentOs: "Windows" });
});

test.each(["failed", "unknown"])("a %s touch ACK is nonfatal and the next authoritative read decides whether to retry", async outcome => {
  const row = await token({ lastSeenAt: null }), original = db.deviceTokens.updateOne.bind(db.deviceTokens);
  const write = jest.spyOn(db.deviceTokens, "updateOne").mockImplementationOnce(async (...args) => {
    if (outcome === "unknown") await original(...args); throw new Error("lost touch acknowledgement");
  });
  expect(await service.findTokenByHash(row.tokenHash)).not.toBeNull(); await settleTouches();
  expect(await service.findTokenByHash(row.tokenHash)).not.toBeNull(); await settleTouches();
  expect(write).toHaveBeenCalledTimes(outcome === "failed" ? 2 : 1);
  expect((await db.deviceTokens.findOne({ _id: row._id })).lastSeenAt).toEqual(new Date(now));
});

test.each(["hash", "id"])("a held touch cannot modify a row revoked by %s", async method => {
  const row = await token({ lastSeenAt: null }), gate = deferred(), entered = deferred(), original = db.deviceTokens.updateOne.bind(db.deviceTokens);
  jest.spyOn(db.deviceTokens, "updateOne").mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  await service.findTokenByHash(row.tokenHash); await entered.promise;
  try { if (method === "hash") await service.revoke("a", row.tokenHash); else expect(await service.revokeById("a", String(row._id))).toBe(true); }
  finally { gate.resolve(); await settleTouches(); }
  const saved = await db.deviceTokens.findOne({ _id: row._id }); expect(saved.revokedAt).toBeInstanceOf(Date); expect(saved.lastSeenAt).toBeNull();
  expect(await service.findTokenByHash(row.tokenHash)).toBeNull();
});

test("latestAgent preserves paired/null distinctions, newest-row selection, owner scope and large legacy versions", async () => {
  expect(await service.latestAgent("a")).toEqual({ paired: false, version: null, lastSeenAt: null });
  await liveness.mutate("a", () => token({ agentVersion: "", lastSeenAt: null }));
  expect(await service.latestAgent("a")).toEqual({ paired: true, version: null, lastSeenAt: null });
  await liveness.mutate("a", () => token({ agentVersion: "界".repeat(10000), lastSeenAt: new Date(now + 1) }));
  const read = jest.spyOn(db.deviceTokens, "findOne");
  expect((await service.latestAgent("a")).version).toBe("界".repeat(10000)); expect((await service.latestAgent("a")).version).toBe("界".repeat(10000));
  expect(read).toHaveBeenCalledTimes(2); expect(await service.latestAgent("b")).toEqual({ paired: false, version: null, lastSeenAt: null });
});

test.each(["known", "unknown"])("token issuance with a %s ACK retires a cached unpaired result", async outcome => {
  expect((await service.latestAgent("a")).paired).toBe(false);
  const { code } = await service.start(); await service.claim("a", code);
  if (outcome === "unknown") {
    const original = db.deviceTokens.insertOne.bind(db.deviceTokens);
    jest.spyOn(db.deviceTokens, "insertOne").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("unknown issuance"); });
    await expect(service.poll(code)).rejects.toThrow("unknown issuance");
  } else expect((await service.poll(code)).status).toBe("ready");
  expect(await service.latestAgent("a")).toEqual({ paired: true, version: null, lastSeenAt: null });
});

test("fresh REST throttle never skips heartbeat metadata, connection-event retry or onHeartbeat", async () => {
  const row = await token(), events = jest.fn().mockRejectedValueOnce(new Error("notification outage")).mockResolvedValue({ eventId: "event" });
  service.adminEvents = { recordAgentConnection: events }; service.onHeartbeat = jest.fn(async () => {});
  await service.latestAgent("a"); await service.findTokenByHash(row.tokenHash); await settleTouches();
  await service.recordHeartbeat("a", row.tokenHash, { version: "2", os: "Windows", osRelease: "11", hostname: "PC" });
  expect((await db.deviceTokens.findOne({ _id: row._id })).connectedEventRecordedAt).toBeUndefined();
  now += 1; await service.recordHeartbeat("a", row.tokenHash, { version: "3", hostname: "PC-new" });
  expect(events).toHaveBeenCalledTimes(2); expect(service.onHeartbeat).toHaveBeenCalledTimes(2);
  expect(await service.latestAgent("a")).toEqual({ paired: true, version: "3", lastSeenAt: new Date(now) });
  expect(await db.deviceTokens.findOne({ _id: row._id })).toMatchObject({ hostname: "PC-new", agentOs: "Windows", agentOsRelease: "11", connectedEventRecordedAt: new Date(now) });
});

test("a delayed older heartbeat retains newer liveness while still applying its metadata", async () => {
  const row = await token({ lastSeenAt: new Date(now + 10000) });
  await service.recordHeartbeat("a", row.tokenHash, { version: "still-applied" });
  expect(await service.latestAgent("a")).toEqual({ paired: true, version: "still-applied", lastSeenAt: new Date(now + 10000) });
});

test("a delayed older sync report never replaces a newer one, while its metadata still applies", async () => {
  const row = await token(), reportedAt = new Date(now);
  expect(await service.recordHeartbeat("a", row.tokenHash, { version: "1.0.0", sync: { pending: 5 } })).toEqual({ receivedAt: reportedAt, syncAccepted: true });
  now -= 10000;
  await service.recordHeartbeat("a", row.tokenHash, { version: "1.0.1", sync: { pending: 1, paused: true } });
  expect(await db.deviceTokens.findOne({ _id: row._id })).toMatchObject({ agentVersion: "1.0.1", sync: { pending: 5 }, syncReportedAt: reportedAt, lastSeenAt: reportedAt });
  now += 10000;
  await service.recordHeartbeat("a", row.tokenHash, { sync: { pending: 2, lastErrorCode: "upload_timeout" } });
  expect((await db.deviceTokens.findOne({ _id: row._id })).sync).toEqual({ pending: 2, lastErrorCode: "upload_timeout" });
  now += 1;
  await service.recordHeartbeat("a", row.tokenHash, { sync: { paused: false } });
  const saved = await db.deviceTokens.findOne({ _id: row._id });
  expect(saved).toMatchObject({ sync: { paused: false }, syncReportedAt: new Date(now) });
  expect(saved.sync.pending).toBeUndefined();
});

test.each(["hash", "id"])("a held latestAgent snapshot may finish after %s revocation but cannot refill its cache", async method => {
  const row = await token({ agentVersion: "private-old" }), gate = deferred(), entered = deferred(), original = db.deviceTokens.findOne.bind(db.deviceTokens);
  const read = jest.spyOn(db.deviceTokens, "findOne").mockImplementationOnce(async (...args) => { const result = await original(...args); entered.resolve(); await gate.promise; return result; });
  const old = service.latestAgent("a").catch(error => error); await entered.promise;
  try { if (method === "hash") await service.revoke("a", row.tokenHash); else await service.revokeById("a", String(row._id)); }
  finally { gate.resolve(); }
  expect(await old).toEqual({ paired: true, version: "private-old", lastSeenAt: new Date(now) }); expect(await service.latestAgent("a")).toEqual({ paired: false, version: null, lastSeenAt: null });
  expect(read).toHaveBeenCalledTimes(2);
});

test.each(["hash", "id"])("an unknown %s revoke acknowledgement still retires a previously paired cache entry", async method => {
  const row = await token({ agentVersion: "old" }); expect((await service.latestAgent("a")).paired).toBe(true);
  const original = db.deviceTokens.updateOne.bind(db.deviceTokens), failure = new Error("unknown revoke");
  jest.spyOn(db.deviceTokens, "updateOne").mockImplementationOnce(async (...args) => { await original(...args); throw failure; });
  const pending = method === "hash" ? service.revoke("a", row.tokenHash) : service.revokeById("a", String(row._id));
  await expect(pending).rejects.toBe(failure);
  expect(await service.latestAgent("a")).toEqual({ paired: false, version: null, lastSeenAt: null });
});

test.each([[false, "success"], [false, "unknown"], [true, "success"], [true, "unknown"]])("actual app/GDPR retires cache while preserving baseline metadata snapshots with chart cache %s and erase %s", async (enabled, outcome) => {
  const row = await token({ agentVersion: "erased-version" }), store = createBackupStore();
  const { services } = buildApp({ db, userBackupsStore: store, logger: pino({ level: "silent" }), clerkClient: { deleteUser: async () => {} },
    config: { nodeEnv: "test", userCacheEnabled: enabled, clerkSecretKey: "", serverPepper: Buffer.alloc(32, 3), rateLimitPerMinute: 1000, corsAllowedOrigins: [], adminUserIds: [], pythonAnalyzerDir: "/none", pythonExe: null } });
  const readGate = deferred(), readEntered = deferred(), eraseGate = deferred(), eraseEntered = deferred(), originalRead = db.deviceTokens.findOne.bind(db.deviceTokens);
  jest.spyOn(db.deviceTokens, "findOne").mockImplementationOnce(async (...args) => { const result = await originalRead(...args); readEntered.resolve(); await readGate.promise; return result; });
  const old = services.pairings.latestAgent("a").catch(error => error); await readEntered.promise;
  jest.spyOn(services.gdpr, "_assertReplayCleanupAvailable").mockImplementationOnce(async () => { eraseEntered.resolve(); await eraseGate.promise; });
  if (outcome === "unknown") {
    const remove = db.deviceTokens.deleteMany.bind(db.deviceTokens);
    jest.spyOn(db.deviceTokens, "deleteMany").mockImplementationOnce(async (...args) => { await remove(...args); throw new Error("unknown device purge"); });
  }
  const erasing = services.gdpr.deleteAll("a").catch(error => error);
  try {
    await eraseEntered.promise; expect(await originalRead({ _id: row._id })).not.toBeNull();
    expect(await services.pairings.latestAgent("a")).toEqual({ paired: true, version: "erased-version", lastSeenAt: row.lastSeenAt });
    readGate.resolve(); expect(await old).toEqual({ paired: true, version: "erased-version", lastSeenAt: row.lastSeenAt });
    eraseGate.resolve(); const result = await erasing;
    if (outcome === "unknown") expect(result.message).toBe("unknown device purge"); else expect(result.users).toBe(1);
    expect(await services.pairings.latestAgent("a")).toEqual({ paired: false, version: null, lastSeenAt: null });
  } finally { readGate.resolve(); eraseGate.resolve(); await old; await erasing; await services.customBuilds.stopReclassifications(); }
});

function httpApp() {
  return buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }), clerkClient: { deleteUser: async () => {} },
    config: { nodeEnv: "test", userCacheEnabled: false, clerkSecretKey: "", serverPepper: Buffer.alloc(32, 3), rateLimitPerMinute: 1000, corsAllowedOrigins: [], adminUserIds: [], pythonAnalyzerDir: "/none", pythonExe: null } });
}

test("actual HTTP /me admits a fifth distinct cold owner while all four cache loads remain held", async () => {
  const owners = ["a", "b", "c", "d", "e"], credentials = new Map();
  await db.users.insertMany(owners.slice(2).map(userId => ({ userId, clerkUserId: `clerk_device_liveness_${userId}` })));
  for (const userId of owners) {
    const raw = randomToken(32); credentials.set(userId, raw);
    await token({ userId, tokenHash: sha256(raw), agentVersion: `version-${userId}` });
  }
  const { app, services } = httpApp(), gate = deferred(), entered = deferred(), original = db.deviceTokens.findOne.bind(db.deviceTokens);
  let latestQueries = 0;
  jest.spyOn(db.deviceTokens, "findOne").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (args[1]?.sort?.lastSeenAt === -1) {
      latestQueries += 1; if (latestQueries === 4) entered.resolve();
      if (latestQueries <= 4) await gate.promise;
    }
    return value;
  });
  const get = owner => request(app).get("/v1/me").set("authorization", `Bearer ${credentials.get(owner)}`);
  const first = owners.slice(0, 4).map(owner => get(owner).then(response => response));
  try {
    await entered.promise; const fifth = await get("e");
    expect(fifth.status).toBe(200); expect(fifth.body).toMatchObject({ userId: "e", agentPaired: true, agentVersion: "version-e" });
    expect(latestQueries).toBe(5); expect(services.pairings.liveness.reads).toBe(4);
    gate.resolve();
    const answers = await Promise.all(first);
    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200]);
    expect(answers.map(answer => answer.body.agentVersion)).toEqual(owners.slice(0, 4).map(owner => `version-${owner}`));
    expect(latestQueries).toBe(5);
  } finally { gate.resolve(); await Promise.all(first); await services.customBuilds.stopReclassifications(); }
});

test.each(["touch", "heartbeat"])("actual HTTP /me returns honest metadata during an ordinary held %s without a new availability error", async kind => {
  const raw = randomToken(32), row = await token({ tokenHash: sha256(raw), agentVersion: "before", lastSeenAt: kind === "touch" ? null : new Date(now) });
  const { app, services } = httpApp(), pairings = services.pairings;
  // This test owns metadata availability; the separate real service case covers
  // connection-event retry and callback invocation without a provider dependency.
  pairings.onHeartbeat = jest.fn(async () => {});
  pairings.adminEvents = { recordAgentConnection: jest.fn(async () => null) };
  await pairings.latestAgent("a");
  const gate = deferred(), entered = deferred(); let latestQueries = 0;
  const originalRead = db.deviceTokens.findOne.bind(db.deviceTokens);
  jest.spyOn(db.deviceTokens, "findOne").mockImplementation(async (...args) => {
    if (args[1]?.sort?.lastSeenAt === -1) latestQueries += 1;
    return originalRead(...args);
  });
  const method = kind === "touch" ? "updateOne" : "findOneAndUpdate", originalWrite = db.deviceTokens[method].bind(db.deviceTokens);
  jest.spyOn(db.deviceTokens, method).mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return originalWrite(...args); });
  const writing = kind === "touch" ? pairings.findTokenByHash(row.tokenHash) : pairings.recordHeartbeat("a", row.tokenHash, { version: "after" });
  const get = () => request(app).get("/v1/me").set("authorization", `Bearer ${raw}`);
  try {
    await entered.promise; const during = await get();
    expect(during.status).toBe(200); expect(during.body).toMatchObject({ userId: "a", agentPaired: true, agentVersion: "before" });
    expect(during.body.agentLastSeenAt).toEqual(row.lastSeenAt?.toISOString() || null);
    expect(latestQueries).toBe(1);
    gate.resolve(); await writing; await Promise.all([...pairings.liveness.touches.values()]);
    const fresh = await get(); expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ agentPaired: true, agentVersion: kind === "heartbeat" ? "after" : "before", agentLastSeenAt: expect.any(String) });
    expect(latestQueries).toBe(2);
  } finally {
    gate.resolve(); await writing; await Promise.all([...pairings.liveness.touches.values()]);
    await services.customBuilds.stopReclassifications();
  }
});
