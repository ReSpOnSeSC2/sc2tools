// @ts-nocheck
"use strict";

// Deny-only durable disable: the rollback barrier withholds every grant without ever activating retention or clearing
// pending work, refuses a mismatched incarnation without writing, drains after both a known and an unknown outcome, and
// stops a ticket prepared before it. The owner script dry-runs by default.
const { randomUUID } = require("node:crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const { sha256 } = require("../src/util/hash");
const { DeviceAuthLease } = require("../src/services/deviceAuthLease");
const { DeviceAuthReuse } = require("../src/services/deviceAuthReuse");
const { readDeviceAuthSnapshot } = require("../src/services/deviceAuthTokenRead");
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const { DeviceCredentialWrites, AUTHORITY_KEY } = require("../src/services/deviceCredentialWrites");
const { activeAuthority } = require("./helpers/deviceAuthFixture");
const { main } = require("../scripts/disable-device-auth-retention");

let replica, client, database, authority, tokens, mono, wall, caches = [];
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(replica.getUri(), { maxPoolSize: 2 });
  database = client.db("device_auth_disable"); authority = database.collection("jobLocks"); tokens = database.collection("device_tokens");
}, 60000);
afterAll(async () => { try { await client?.close(); } finally { await replica?.stop(); } });
beforeEach(async () => { mono = 0; wall = 1000000; caches = []; await Promise.all([authority.deleteMany({}), tokens.deleteMany({})]); });
afterEach(async () => { for (const cache of caches) await cache.stopAndDrain(); jest.restoreAllMocks(); });
const stored = () => authority.findOne({ _id: AUTHORITY_KEY }, { readPreference: "primary" });
function writer(collection = authority) {
  const waits = [];
  return { waits, service: new DeviceCredentialWrites(collection, { now: () => mono, wait: async ms => { waits.push(ms); mono += ms; } }) };
}

test("disables the exact incarnation: prepared mode, a fresh generation, pending work and denyAll kept, drained before it reports", async () => {
  await authority.insertOne(activeAuthority());
  const coordinated = writer().service, operation = await coordinated.begin("owner-a", "revoke-id");
  await coordinated.uncertain(operation);
  const before = await stored();
  expect(before.pending).toHaveLength(1);
  const { service, waits } = writer(), result = await service.disable({ incarnation: before.incarnation });
  const after = await stored();
  expect(result).toEqual({ outcome: "disabled", generation: after.generation });
  expect([after.mode, after.incarnation, after.denyAll, after.pending]).toEqual(["prepared", before.incarnation, before.denyAll, before.pending]);
  expect(after.generation).not.toBe(before.generation); expect(waits).toEqual([2100]);
  await authority.updateOne({ _id: AUTHORITY_KEY }, { $set: { denyAll: true } });
  await service.disable({ incarnation: before.incarnation });
  expect((await stored()).denyAll).toBe(true);
});

test("refuses a malformed or mismatched incarnation without writing, and repeating a disable stays non-granting", async () => {
  await authority.insertOne(activeAuthority());
  const before = await stored(), { service, waits } = writer();
  await expect(service.disable({ incarnation: "not-a-uuid" })).rejects.toMatchObject({ code: "device_credential_disable_invalid" });
  expect(await service.disable({ incarnation: randomUUID() })).toEqual({ outcome: "refused" });
  expect(await stored()).toEqual(before); expect(waits).toEqual([]);
  const first = await service.disable({ incarnation: before.incarnation }), second = await service.disable({ incarnation: before.incarnation });
  expect([first.outcome, second.outcome]).toEqual(["disabled", "disabled"]);
  expect(second.generation).not.toBe(first.generation); expect((await stored()).mode).toBe("prepared");
});

test("after a disable no lease can grant, and a ticket prepared before it cannot be consumed", async () => {
  await authority.insertOne(activeAuthority());
  const row = { _id: new ObjectId(), userId: "owner-a", tokenHash: sha256("owner-a"), revokedAt: null, lastSeenAt: new Date(wall) };
  await tokens.insertOne(row);
  const lease = new DeviceAuthLease(authority, client, { now: () => mono }), liveness = new DeviceLiveness({ now: () => wall });
  const cache = new DeviceAuthReuse(lease, (hash, options) => readDeviceAuthSnapshot(tokens, liveness, hash, options), { wallNow: () => wall });
  caches.push(cache);
  const ticket = await cache.prepare(row.tokenHash);
  expect(ticket).not.toBeNull();
  await writer().service.disable({ incarnation: (await stored()).incarnation });
  expect(cache.consume(row.tokenHash, ticket)).toBeNull();
  expect(await lease.acquire()).toBeNull();
  expect(await cache.prepare(row.tokenHash)).toBeNull();
});

test("an unknown write outcome reports possibly disabled and still drains", async () => {
  await authority.insertOne(activeAuthority());
  const flaky = Object.create(authority);
  flaky.findOneAndUpdate = async (...args) => { await authority.findOneAndUpdate(...args); throw new Error("lost write acknowledgement"); };
  const { service, waits } = writer(flaky), { incarnation } = await stored();
  expect(await service.disable({ incarnation })).toEqual({ outcome: "possibly-disabled" });
  expect(waits).toEqual([2100]); expect((await stored()).mode).toBe("prepared");
});

test("the owner script dry-runs by default and disables only with the exact incarnation and --apply", async () => {
  const lines = [], log = line => lines.push(line);
  expect(await main([], database, log)).toBe(0);
  expect(lines.pop()).toMatch(/nothing to disable/);
  await authority.insertOne(activeAuthority());
  const { incarnation } = await stored();
  expect(await main([], database, log)).toBe(0);
  expect(lines.join("\n")).toContain(`Authority incarnation ${incarnation}: mode active`); expect((await stored()).mode).toBe("active");
  expect(await main(["--apply"], database, log)).toBe(2);
  expect(await main(["--incarnation", randomUUID(), "--apply"], database, log)).toBe(1);
  expect((await stored()).mode).toBe("active");
  expect(await main(["--incarnation", incarnation, "--apply"], database, log)).toBe(0);
  expect((await stored()).mode).toBe("prepared"); expect(lines.pop()).toMatch(/^Outcome: disabled \(generation /);
}, 30000);
