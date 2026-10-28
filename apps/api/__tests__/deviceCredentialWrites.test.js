// @ts-nocheck
"use strict";

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { randomUUID } = require("crypto");
const { sha256 } = require("../src/util/hash");
const { DeviceCredentialWrites, AUTHORITY_KEY, OWNER_NAMESPACE, PENDING_LIMIT,
  ACTIVE_LIMIT, WRITER_DRAIN_MS } = require("../src/services/deviceCredentialWrites");
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let replica, client, database, collection, now, service, wait;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(replica.getUri()); database = client.db("credential_writes");
  collection = database.collection("jobLocks");
  await collection.createIndex({ key: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
});
afterAll(async () => { await client.close(); await replica.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks(); await collection.deleteMany({}); now = 0;
  wait = jest.fn(async ms => { now += ms; });
  service = new DeviceCredentialWrites(collection, { now: () => now, wait });
});
afterEach(() => jest.restoreAllMocks());

test("fresh majority gates bracket work, preserve opaque scope, and cannot be reaped as an expiring/owned job lock", async () => {
  const update = jest.spyOn(collection, "findOneAndUpdate");
  let writing;
  const result = await service.run("user-a", "revoke-hash", async () => {
    writing = await collection.findOne({ _id: AUTHORITY_KEY });
    expect(writing.pending).toEqual([{ operationId: expect.any(String),
      ownerHash: sha256(`${OWNER_NAMESPACE}\0user-a`), kind: "revoke-hash", phase: "writing" }]);
    expect(writing.grantsEverEnabled).toBe(true); expect(writing.mode).toBe("prepared");
    expect(writing.expiresAt).toBeUndefined(); expect(writing.owner).toBeUndefined();
    expect(JSON.stringify(writing)).not.toContain("user-a");
    return { acknowledged: true, matchedCount: 0 };
  });
  expect(result).toEqual({ acknowledged: true, matchedCount: 0 });
  expect(wait).toHaveBeenCalledWith(WRITER_DRAIN_MS);
  const after = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(after.pending).toEqual([]); expect(after.generation).not.toBe(writing.generation);
  for (const call of update.mock.calls) expect(call[2].writeConcern).toEqual({ w: "majority", j: true, wtimeoutMS: 5000 });
  await collection.insertOne({ key: "ordinary-lock", owner: "process", expiresAt: new Date(0) });
  await collection.deleteMany({ $or: [{ owner: "process" }, { expiresAt: { $lte: new Date() } }] });
  expect(await collection.findOne({ _id: AUTHORITY_KEY })).not.toBeNull();
  expect((await collection.indexes()).find(index => index.key.expiresAt === 1).expireAfterSeconds).toBe(0);
});

test("separate coordinator instances publish distinct bounded gates without losing another writer", async () => {
  const enteredA = deferred(), enteredB = deferred(), gate = deferred();
  const other = new DeviceCredentialWrites(collection, { now: () => now, wait });
  const a = service.run("a", "issue", async () => { enteredA.resolve(); await gate.promise; return "a"; });
  const b = other.run("b", "erase", async () => { enteredB.resolve(); await gate.promise; return "b"; });
  await Promise.all([enteredA.promise, enteredB.promise]);
  const row = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(new Set(row.pending.map(entry => entry.operationId)).size).toBe(2);
  expect(row.pending.map(entry => entry.ownerHash).sort()).toEqual([service.ownerHash("a"), service.ownerHash("b")].sort());
  gate.resolve(); expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toEqual([]);
});

test("a pending-publication commit followed by lost ACK never dispatches credential work or forgets its gate", async () => {
  await service.prepare();
  const original = collection.findOneAndUpdate.bind(collection), error = new Error("lost gate ACK"), work = jest.fn();
  jest.spyOn(collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  await expect(service.run("a", "revoke-id", work)).rejects.toBe(error);
  expect(work).not.toHaveBeenCalled();
  const before = await collection.findOne({ _id: AUTHORITY_KEY }); expect(before.pending).toHaveLength(1);
  const restarted = new DeviceCredentialWrites(collection, { now: () => now, wait });
  expect(await restarted.run("b", "issue", async () => "normal")).toBe("normal");
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toEqual(before.pending);
});

test.each(["before-write", "commit-then-reject"])("a transient %s preparation error can retry without resetting history", async mode => {
  const original = collection.updateOne.bind(collection), work = jest.fn(async () => "done");
  jest.spyOn(collection, "updateOne").mockImplementationOnce(async (...args) => {
    if (mode === "commit-then-reject") await original(...args);
    throw new Error("initial metadata unavailable");
  });
  await expect(service.run("a", "issue", work)).rejects.toThrow("initial metadata unavailable");
  expect(work).not.toHaveBeenCalled();
  const possible = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(await service.run("a", "issue", work)).toBe("done");
  const after = await collection.findOne({ _id: AUTHORITY_KEY });
  if (possible) expect(after.incarnation).toBe(possible.incarnation);
  expect(after.grantsEverEnabled).toBe(true); expect(after.mode).toBe("prepared");
});

test.each(["no-dispatch", "commit-then-reject"])("%s credential failure is original and remains durable across restart", async mode => {
  const error = new Error("unknown token ACK"), tokens = database.collection("device_tokens");
  await tokens.deleteMany({}); await tokens.insertOne({ tokenHash: "token", revokedAt: null });
  await expect(service.run("a", "revoke-hash", async () => {
    if (mode === "commit-then-reject") await tokens.updateOne({ tokenHash: "token" }, { $set: { revokedAt: new Date() } });
    throw error;
  })).rejects.toBe(error);
  const row = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(row.pending).toHaveLength(1); expect(row.pending[0].phase).toBe("uncertain");
  expect(Boolean((await tokens.findOne({ tokenHash: "token" })).revokedAt)).toBe(mode === "commit-then-reject");
  await new DeviceCredentialWrites(collection, { now: () => now, wait }).prepare();
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toEqual(row.pending);
});

test("unacknowledged results cannot report success and do not release pending retention scope", async () => {
  const result = { acknowledged: false };
  await expect(service.run("a", "revoke-id", async () => result)).rejects.toThrow("device_credential_write_unacknowledged");
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("uncertain");
});

test("failed uncertainty diagnostics cannot replace the original write rejection", async () => {
  const original = collection.updateOne.bind(collection), failure = new Error("credential failure");
  jest.spyOn(collection, "updateOne").mockImplementation((...args) => {
    if (args[1].$set?.["pending.$.phase"] === "uncertain") throw new Error("metadata unavailable");
    return original(...args);
  });
  await expect(service.run("a", "erase", async () => { throw failure; })).rejects.toBe(failure);
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("writing");
});

test("completion failure cannot replay successful work or clear its pending scope", async () => {
  const original = collection.updateOne.bind(collection), work = jest.fn(async () => "written");
  jest.spyOn(collection, "updateOne").mockImplementation((...args) => {
    if (args[1].$pull) throw new Error("lost completion ACK");
    return original(...args);
  });
  await expect(service.run("a", "issue", work)).rejects.toThrow("lost completion ACK");
  expect(work).toHaveBeenCalledTimes(1);
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("writing");
});

test("durable pending capacity and missing owner use sticky bounded denyAll without evicting uncertainty", async () => {
  for (let n = 0; n < PENDING_LIMIT; n++) {
    await expect(service.run(`owner-${n}`, "revoke-hash", async () => { throw new Error("unknown"); })).rejects.toThrow("unknown");
  }
  const before = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(await service.run("overflow", "issue", async () => "written")).toBe("written");
  expect(await service.run(null, "erase", async () => "missing-owner")).toBe("missing-owner");
  const after = await collection.findOne({ _id: AUTHORITY_KEY });
  expect(after.denyAll).toBe(true); expect(after.pending).toEqual(before.pending);
  expect(after.pending).toHaveLength(PENDING_LIMIT);
  await new DeviceCredentialWrites(collection, { now: () => now, wait }).prepare();
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).denyAll).toBe(true);
});

test.each(["namespace", "protocol", "malformed-pending", "active-without-history", "expiry-field", "owner-field"])("%s cannot dispatch work or reset authority", async kind => {
  await service.prepare();
  const set = kind === "namespace" ? { ownerHashNamespace: "other-pepper-namespace" }
    : kind === "protocol" ? { protocolVersion: 2 }
      : kind === "malformed-pending" ? { pending: "bad" }
        : kind === "expiry-field" ? { expiresAt: new Date(Date.now() + 60000) }
          : kind === "owner-field" ? { owner: "ordinary-lock-holder" } : { mode: "active", grantsEverEnabled: false };
  await collection.updateOne({ _id: AUTHORITY_KEY }, { $set: set });
  const work = jest.fn(); await expect(service.run("a", "issue", work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(await collection.findOne({ _id: AUTHORITY_KEY })).toMatchObject(set);
});

test.each(["array-id", "duplicate-id"])("malformed %s scopes cannot dispatch a new writer", async mode => {
  await service.prepare();
  const entry = { operationId: randomUUID(), ownerHash: service.ownerHash("a"), kind: "issue", phase: "uncertain" };
  const pending = mode === "array-id" ? [{ ...entry, operationId: [entry.operationId] }]
    : [entry, { ...entry, ownerHash: service.ownerHash("b") }];
  await collection.updateOne({ _id: AUTHORITY_KEY }, { $set: { pending } });
  const work = jest.fn(); await expect(service.run("c", "issue", work)).rejects.toThrow("device_credential_authority_unavailable");
  expect(work).not.toHaveBeenCalled();
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending.slice(0, pending.length)).toEqual(pending);
});

test("an overflow writer rechecks sticky global authority after the drain before dispatch", async () => {
  await service.prepare(); await collection.updateOne({ _id: AUTHORITY_KEY }, { $set: { denyAll: true } });
  const gate = deferred(), entered = deferred();
  service.wait = async ms => { entered.resolve(); await gate.promise; now += ms; };
  const work = jest.fn(), running = service.run(null, "erase", work).catch(error => error);
  await entered.promise;
  await collection.updateOne({ _id: AUTHORITY_KEY }, { $set: { incarnation: randomUUID() } });
  gate.resolve(); expect((await running).message).toBe("device_credential_operation_retired");
  expect(work).not.toHaveBeenCalled();
});

test("missing authority is recreated prepared with unknown history and a full drain before work", async () => {
  await service.prepare(); const first = await collection.findOne({ _id: AUTHORITY_KEY });
  await collection.deleteOne({ _id: AUTHORITY_KEY });
  await service.run("a", "issue", async () => {
    expect(now).toBeGreaterThanOrEqual(WRITER_DRAIN_MS);
    const row = await collection.findOne({ _id: AUTHORITY_KEY });
    expect(row.incarnation).not.toBe(first.incarnation); expect(row.grantsEverEnabled).toBe(true);
    expect(row.mode).toBe("prepared");
  });
});

test("the full elapsed drain starts after publication ACK; early timers cannot dispatch work early", async () => {
  const gate = deferred(), entered = deferred();
  const custom = new DeviceCredentialWrites(collection, { now: () => now, wait: jest.fn(async ms => {
    entered.resolve(); await gate.promise; now += ms === WRITER_DRAIN_MS ? 100 : ms;
  }) });
  const work = jest.fn(async () => now); const pending = custom.run("a", "revoke-id", work);
  await entered.promise; expect(work).not.toHaveBeenCalled();
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending[0].phase).toBe("draining");
  gate.resolve(); expect(await pending).toBeGreaterThanOrEqual(WRITER_DRAIN_MS);
  expect(custom.wait.mock.calls.map(call => call[0])).toEqual([WRITER_DRAIN_MS, WRITER_DRAIN_MS - 100]);
});

test("backwards clock refuses credential dispatch and leaves a durable gate", async () => {
  now = 10; const work = jest.fn();
  const custom = new DeviceCredentialWrites(collection, { now: () => now, wait: async () => { now = 9; } });
  await expect(custom.run("a", "issue", work)).rejects.toThrow("device_credential_clock_invalid");
  expect(work).not.toHaveBeenCalled(); expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toHaveLength(1);
});

test("bounded admitted work stays owned through actual settlement and shutdown drains it", async () => {
  const gate = deferred(), entered = Array.from({ length: ACTIVE_LIMIT }, () => deferred());
  const tasks = entered.map((signal, n) => service.run(String(n), "issue", async () => { signal.resolve(); await gate.promise; return n; }));
  await Promise.all(entered.map(signal => signal.promise));
  await expect(service.run("overflow", "issue", async () => true)).rejects.toThrow("device_credential_writer_busy");
  let stopped = false; const draining = service.stopAndDrain().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(service.pending.size).toBe(ACTIVE_LIMIT);
  await expect(service.run("late", "issue", async () => true)).rejects.toThrow("device_credential_writer_stopping");
  gate.resolve(); await Promise.all(tasks); await draining;
  expect(stopped).toBe(true); expect(service.pending.size).toBe(0);
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toEqual([]);
});

test("different operation identity cannot complete another or a replacement authority", async () => {
  const operation = await service.begin("a", "issue");
  await expect(service.complete({ ...operation, operationId: randomUUID() })).rejects.toThrow("device_credential_completion_unavailable");
  const original = await collection.findOne({ _id: AUTHORITY_KEY });
  await collection.updateOne({ _id: AUTHORITY_KEY }, { $set: { incarnation: randomUUID() } });
  await expect(service.complete(operation)).rejects.toThrow("device_credential_completion_unavailable");
  expect((await collection.findOne({ _id: AUTHORITY_KEY })).pending).toEqual(original.pending);
});
