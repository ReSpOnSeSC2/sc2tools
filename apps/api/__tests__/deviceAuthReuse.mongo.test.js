// @ts-nocheck
"use strict";

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const { sha256 } = require("../src/util/hash");
const { DeviceAuthLease, DEVICE_AUTH_LEASE_MS } = require("../src/services/deviceAuthLease");
const { DeviceAuthReuse } = require("../src/services/deviceAuthReuse");
const { readDeviceAuthSnapshot } = require("../src/services/deviceAuthTokenRead");
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const { DeviceCredentialWrites, AUTHORITY_KEY } = require("../src/services/deviceCredentialWrites");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { activeAuthority, deferred } = require("./helpers/deviceAuthFixture");

let replica, client, database, authority, tokens, mono, wall, commands, caches = [];
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" },
    instanceOpts: [{ args: ["--setParameter", "enableTestCommands=1"] }], replSet: { count: 1, storageEngine: "wiredTiger" } });
  expect(replica.servers).toHaveLength(1);
  const info = replica.servers[0].instanceInfo;
  process.stdout.write("[device-auth-owned-mongo] " + JSON.stringify({ pid: info.instance.mongodProcess.pid,
    killerPid: info.instance.killerProcess.pid, port: info.port }) + "\n");
  client = await MongoClient.connect(replica.getUri(), { monitorCommands: true, maxPoolSize: 1 });
  database = client.db("device_auth_reuse"); authority = database.collection("jobLocks");
  // A collection-level override tests the cold read without making initial
  // client.connect wait for a nonexistent secondary in this one-member set.
  tokens = database.collection("device_tokens", { readPreference: "secondary" });
  client.on("commandStarted", event => { if (["findAndModify", "find"].includes(event.commandName)) commands.push(event.command); });
});
afterAll(async () => { try { await client?.close(); } finally { await replica?.stop(); } });
beforeEach(async () => {
  commands = []; caches = []; mono = 0; wall = 1000000;
  await Promise.all([authority.deleteMany({}), tokens.deleteMany({})]);
  await authority.insertOne(activeAuthority());
});
afterEach(async () => { for (const cache of caches) await cache.stopAndDrain(); jest.restoreAllMocks(); });

async function token(owner = "owner-a") {
  const row = { _id: new ObjectId(), userId: owner, tokenHash: sha256(owner), revokedAt: null, lastSeenAt: new Date(wall) };
  await tokens.insertOne(row); return row;
}
function service() {
  const lease = new DeviceAuthLease(authority, client, { now: () => mono }), liveness = new DeviceLiveness({ now: () => wall });
  const cache = new DeviceAuthReuse(lease, (hash, options) => readDeviceAuthSnapshot(tokens, liveness, hash, options), { wallNow: () => wall });
  caches.push(cache); return { lease, cache, liveness };
}
function writer() {
  let writerNow = 0;
  return new DeviceCredentialWrites(authority, { now: () => writerNow,
    wait: async ms => { writerNow += ms; mono += ms; } });
}

test("real command monitoring proves nonce-changing majority grant and per-load causal snapshot floor", async () => {
  const row = await token(), { lease, cache } = service();
  const ticket = await cache.prepare(row.tokenHash), grant = lease.current();
  expect(cache.consume(row.tokenHash, ticket)).toEqual({ userId: row.userId, deviceId: String(row._id) });
  const claim = commands.find(command => command.findAndModify === "jobLocks");
  expect(claim.update.$set.grantProbeNonce).toEqual(expect.any(String));
  expect(claim.writeConcern).toMatchObject({ w: "majority", j: true });
  const read = commands.find(command => command.find === "device_tokens");
  expect(read.filter).toEqual({ tokenHash: row.tokenHash, revokedAt: null });
  expect(read.projection).toEqual({ _id: 1, userId: 1, lastSeenAt: 1 });
  expect(read.readConcern.level).toBe("majority");
  expect(read.readConcern.afterClusterTime.greaterThanOrEqual(grant.operationTime)).toBe(true);
  expect(commands.filter(command => command.find === "device_tokens")).toHaveLength(1);
});

test("another coordinated writer drains the old grant before revoke and retires its warmed positive", async () => {
  const row = await token(), a = service(), other = writer();
  const old = await a.cache.prepare(row.tokenHash); expect(old).not.toBeNull();
  await other.run(row.userId, "revoke-hash", async () => {
    expect(mono).toBe(2100); expect(a.cache.consume(row.tokenHash, old)).toBeNull();
    return tokens.updateOne({ tokenHash: row.tokenHash }, { $set: { revokedAt: new Date(wall) } });
  });
  expect(await a.cache.prepare(row.tokenHash)).toBeNull();
  expect(await tokens.findOne({ tokenHash: row.tokenHash, revokedAt: null }, { readPreference: "primary" })).toBeNull();
  expect((await authority.findOne({ _id: AUTHORITY_KEY }, { readPreference: "primary" })).pending).toEqual([]);
});

test("unknown writer outcome denies only retained reuse while a new original lookup stays independent", async () => {
  const row = await token(), b = await token("owner-b"), a = service(), other = writer();
  await expect(other.run(row.userId, "revoke-hash", async () => { throw new Error("unknown credential outcome"); })).rejects.toThrow("unknown credential");
  expect(await a.cache.prepare(row.tokenHash)).toBeNull();
  const original = new DevicePairingsService({ deviceTokens: database.collection("device_tokens", { readPreference: "primary" }) }, { liveness: a.liveness, credentialWrites: other });
  expect(await original.findTokenByHash(row.tokenHash)).toEqual({ userId: row.userId, deviceId: String(row._id) });
  expect(a.cache.consume(b.tokenHash, await a.cache.prepare(b.tokenHash))).toEqual({ userId: b.userId, deviceId: String(b._id) });
  const pending = (await authority.findOne({ _id: AUTHORITY_KEY }, { readPreference: "primary" })).pending;
  expect(pending).toHaveLength(1); expect(pending[0].phase).toBe("uncertain");
});

test("missing or recreated prepared authority never auto-activates and unknown grant ACK never publishes", async () => {
  const probes = () => commands.filter(command => command.findAndModify === "jobLocks" && command.update?.$set?.grantProbeNonce).length;
  await authority.deleteMany({}); const a = service();
  expect(await a.lease.acquire()).toBeNull(); expect(await authority.countDocuments({})).toBe(0); expect(probes()).toBe(1);
  // Each later step waits out the no-grant hold-off, so every acquire dispatches a real probe.
  await writer().prepare(); mono += DEVICE_AUTH_LEASE_MS; expect(await a.lease.acquire()).toBeNull(); expect(probes()).toBe(2);
  expect((await authority.findOne({ _id: AUTHORITY_KEY }, { readPreference: "primary" })).mode).toBe("prepared");
  await authority.replaceOne({ _id: AUTHORITY_KEY }, activeAuthority());
  const actual = client.db(authority.dbName);
  jest.spyOn(client, "db").mockReturnValueOnce({ command: async (...args) => { await actual.command(...args); throw new Error("lost grant ACK"); } });
  mono += DEVICE_AUTH_LEASE_MS; expect(await a.lease.acquire()).toBeNull(); expect(a.lease.current()).toBeNull();
  expect(probes()).toBe(3);
});

test("real pool pressure is bounded by command CSOT without a late grant after checkout", async () => {
  const row = await token(), a = service(), entered = deferred();
  const admin = client.db("admin");
  await admin.command({ configureFailPoint: "failCommand", mode: { times: 1 },
    data: { failCommands: ["find"], blockConnection: true, blockTimeMS: 10000 } });
  const onCommand = event => { if (event.command.comment === "owned-pool-hold") entered.resolve(); };
  client.on("commandStarted", onCommand);
  let finished = false;
  const held = tokens.findOne({ tokenHash: row.tokenHash }, { readPreference: "primary", comment: "owned-pool-hold" })
    .finally(() => { finished = true; });
  try {
    await entered.promise; expect(await a.lease.acquire()).toBeNull(); expect(finished).toBe(false);
    expect(commands.filter(command => command.findAndModify === "jobLocks")).toHaveLength(0);
    await a.lease.stopAndDrain(); expect(a.lease.current()).toBeNull();
  } finally { await held; client.off("commandStarted", onCommand); }
  expect(commands.filter(command => command.findAndModify === "jobLocks")).toHaveLength(0);
});
