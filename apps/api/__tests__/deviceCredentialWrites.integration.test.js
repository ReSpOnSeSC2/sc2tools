// @ts-nocheck
"use strict";

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { ObjectId } = require("mongodb");
const express = require("express");
const request = require("supertest");
const { connect } = require("../src/db/connect");
const { DeviceCredentialWrites, AUTHORITY_KEY, WRITER_DRAIN_MS } = require("../src/services/deviceCredentialWrites");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { GdprService } = require("../src/services/gdpr");
const { buildAuth } = require("../src/middleware/auth");
const { randomToken, sha256 } = require("../src/util/hash");
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let replica, db, collection, now, coordinator, pairings;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  db = await connect({ uri: replica.getUri(), dbName: "credential_writes_integration" });
  collection = db.db.collection("jobLocks");
});
afterAll(async () => { await db.close(); await replica.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const name of ["users", "deviceTokens", "devicePairings"]) await db[name].deleteMany({});
  await collection.deleteMany({});
  await db.users.insertMany([{ userId: "a", clerkUserId: "clerk-a" }, { userId: "b", clerkUserId: "clerk-b" }]);
  now = 0;
  coordinator = new DeviceCredentialWrites(collection, { now: () => now, wait: async ms => { now += ms; } });
  pairings = new DevicePairingsService(db, { credentialWrites: coordinator });
});
afterEach(() => jest.restoreAllMocks());
async function insertToken(owner = "a") {
  const raw = randomToken(32), row = { _id: new ObjectId(), userId: owner, tokenHash: sha256(raw),
    revokedAt: null, lastSeenAt: new Date(), createdAt: new Date() };
  await db.deviceTokens.insertOne(row); return { raw, row };
}
async function claimedCode() {
  const { code } = await pairings.start({ hostname: "TEST-PC" }); await pairings.claim("a", code); return code;
}
async function holdDrain() {
  const entered = deferred(), gate = deferred();
  coordinator.wait = async ms => { entered.resolve(); await gate.promise; now += ms; };
  return { entered, gate };
}

test.each(["hash", "id"])("actual %s revoke is gated, keeps ownership/result shape and changes the original auth lookup", async kind => {
  const { row } = await insertToken(), other = await insertToken("b");
  const original = db.deviceTokens.updateOne.bind(db.deviceTokens);
  jest.spyOn(db.deviceTokens, "updateOne").mockImplementation(async (...args) => {
    if (args[1].$set?.revokedAt) {
      const authority = await collection.findOne({ _id: AUTHORITY_KEY });
      expect(authority.pending).toEqual([expect.objectContaining({ phase: "writing", kind: `revoke-${kind}` })]);
    }
    return original(...args);
  });
  if (kind === "hash") expect(await pairings.revoke("a", row.tokenHash)).toBeUndefined();
  else expect(await pairings.revokeById("a", String(row._id))).toBe(true);
  expect(await pairings.findTokenByHash(row.tokenHash)).toBeNull();
  expect(await pairings.findTokenByHash(other.row.tokenHash)).toEqual({ userId: "b", deviceId: String(other.row._id) });
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toEqual([]);
});

test("unknown/wrong-owner IDs keep their false contract and malformed IDs never dispatch coordination", async () => {
  const { row } = await insertToken("b"), run = jest.spyOn(coordinator, "run");
  expect(await pairings.revokeById("a", "invalid")).toBe(false); expect(run).not.toHaveBeenCalled();
  expect(await pairings.revokeById("a", String(row._id))).toBe(false);
  expect((await db.deviceTokens.findOne({ _id: row._id })).revokedAt).toBeNull();
});

test.each(["hash", "id"])("unacknowledged actual %s revoke cannot report success or forget its gate", async kind => {
  const { row } = await insertToken();
  jest.spyOn(db.deviceTokens, "updateOne").mockResolvedValueOnce({ acknowledged: false });
  const operation = kind === "hash" ? pairings.revoke("a", row.tokenHash) : pairings.revokeById("a", String(row._id));
  await expect(operation).rejects.toMatchObject({ code: "device_credential_write_unacknowledged" });
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("uncertain");
});

test.each(["expire", "owner-change", "erasure-fence", "expired-lease-during-erasure", "owner-deleted"])("pairing %s while coordination waits cannot issue from the earlier snapshot", async mode => {
  const code = await claimedCode(), { entered, gate } = await holdDrain();
  const polling = pairings.poll(code).catch(error => error); await entered.promise;
  let retainedExpired = [];
  if (mode === "expire") await db.devicePairings.updateOne({ code }, { $set: { expiresAt: new Date(0) } });
  else if (mode === "owner-change") await db.devicePairings.updateOne({ code }, { $set: { userId: "b" } });
  else if (mode === "owner-deleted") await db.users.deleteOne({ userId: "a" });
  else if (mode === "expired-lease-during-erasure") {
    const existing = (await db.users.findOne({ userId: "a" }))._dataMutations;
    // Preserve any earlier poll admission ID. An assert-only implementation
    // would renew that expired ID despite the active GDPR fence and issue.
    retainedExpired = (existing?.length ? existing : [{ id: "expired-prior-admission" }])
      .map(entry => ({ ...entry, leaseUntil: new Date(0) }));
    await db.users.updateOne({ userId: "a" }, {
      $set: { _dataMutations: retainedExpired, _gdprMutation: { id: "erasing", leaseUntil: new Date(Date.now() + 60000) } },
    });
  }
  else await db.users.updateOne({ userId: "a" }, { $unset: { _dataMutations: "" }, $set: { _gdprMutation: { id: "erasing", leaseUntil: new Date(Date.now() + 60000) } } });
  gate.resolve(); const result = await polling;
  expect(result).toEqual({ status: "expired" });
  expect(await db.deviceTokens.countDocuments({})).toBe(0);
  expect((await db.devicePairings.findOne({ code })).consumedAt).toBeNull();
  const owner = await db.users.findOne({ userId: "a" });
  if (owner) expect(owner._dataMutations ?? []).toEqual(mode === "expired-lease-during-erasure"
    ? retainedExpired : []);
});

test("completion metadata failure never reopens a successfully consumed pairing code", async () => {
  const code = await claimedCode(), error = new Error("completion unavailable");
  jest.spyOn(coordinator, "complete").mockRejectedValueOnce(error);
  await expect(pairings.poll(code)).rejects.toBe(error);
  expect((await db.devicePairings.findOne({ code })).consumedAt).toBeInstanceOf(Date);
  expect(await db.deviceTokens.countDocuments({})).toBe(1);
  expect((await db.users.findOne({ userId: "a" }))._dataMutations).toEqual([]);
  expect(await pairings.poll(code)).toEqual({ status: "expired" });
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("writing");
});

test("a lost issue insertion ACK preserves one-shot code and durable uncertainty", async () => {
  const code = await claimedCode(), original = db.deviceTokens.insertOne.bind(db.deviceTokens), error = new Error("lost insertion ACK");
  jest.spyOn(db.deviceTokens, "insertOne").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  await expect(pairings.poll(code)).rejects.toBe(error);
  expect(await pairings.poll(code)).toEqual({ status: "expired" });
  expect(await db.deviceTokens.countDocuments({})).toBe(1);
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("uncertain");
});

test("shutdown owns a poll until its actual user-data lease release settles", async () => {
  const code = await claimedCode(), entered = deferred(), release = deferred();
  const original = db.users.updateOne.bind(db.users);
  jest.spyOn(db.users, "updateOne").mockImplementation(async (...args) => {
    if (Array.isArray(args[1]) && args[1][0].$set?._dataMutations?.$filter) {
      entered.resolve(); await release.promise;
    }
    return original(...args);
  });
  const polling = pairings.poll(code); await entered.promise;
  expect(coordinator.pending.size).toBe(1);
  let drained = false; const stopping = coordinator.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  expect(await db.deviceTokens.countDocuments({})).toBe(1);
  release.resolve(); expect((await polling).status).toBe("ready"); await stopping;
  expect(drained).toBe(true); expect(coordinator.pending.size).toBe(0);
  expect((await db.users.findOne({ userId: "a" }))._dataMutations).toEqual([]);
});

test.each(["success", "unknown-purge", "unknown-owner-delete"])("full GDPR %s keeps the credential gate through actual purge/owner removal", async mode => {
  const { row } = await insertToken();
  const gdpr = new GdprService(db, { credentialWrites: coordinator });
  const remove = db.deviceTokens.deleteMany.bind(db.deviceTokens), ownerRemove = db.users.deleteOne.bind(db.users);
  jest.spyOn(db.deviceTokens, "deleteMany").mockImplementationOnce(async (...args) => {
    const authority = await collection.findOne({ _id: AUTHORITY_KEY });
    expect(authority.pending).toEqual([expect.objectContaining({ phase: "writing", kind: "erase" })]);
    const result = await remove(...args); if (mode === "unknown-purge") throw new Error("lost purge ACK"); return result;
  });
  jest.spyOn(db.users, "deleteOne").mockImplementationOnce(async (...args) => {
    expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("writing");
    const result = await ownerRemove(...args); if (mode === "unknown-owner-delete") throw new Error("lost owner ACK"); return result;
  });
  if (mode === "success") expect((await gdpr.deleteAll("a")).users).toBe(1);
  else await expect(gdpr.deleteAll("a")).rejects.toThrow(mode === "unknown-purge" ? "lost purge ACK" : "lost owner ACK");
  expect(await pairings.findTokenByHash(row.tokenHash)).toBeNull();
  const authority = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(authority.pending).toHaveLength(mode === "success" ? 0 : 1);
  if (mode !== "success") expect(authority.pending[0].phase).toBe("uncertain");
  expect(await db.users.findOne({ userId: "b" })).not.toBeNull();
});

test("uncertain/denyAll metadata does not lock out authoritative auth or change request metadata", async () => {
  const { raw, row } = await insertToken();
  await expect(coordinator.run("a", "revoke-hash", async () => { throw new Error("before write"); })).rejects.toThrow("before write");
  await coordinator.run(null, "erase", async () => true);
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).denyAll).toBe(true);
  const lookup = jest.spyOn(db.deviceTokens, "findOne"), app = express();
  const auth = buildAuth({ secretKey: "test", getDeviceToken: hash => pairings.findTokenByHash(hash),
    ensureUser: async () => { throw new Error("unexpected Clerk"); } });
  app.get("/auth", auth, (req, res) => res.json(req.auth));
  for (let n = 0; n < 3; n++) {
    const response = await request(app).get("/auth").set("authorization", `Bearer ${raw}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "a", source: "device", tokenHash: row.tokenHash });
  }
  expect(lookup).toHaveBeenCalledTimes(3);
  expect(now).toBe(2 * WRITER_DRAIN_MS);
});
