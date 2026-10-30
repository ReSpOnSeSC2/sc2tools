// @ts-nocheck
"use strict";

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const { randomUUID } = require("crypto");
const { deviceCredentialWritesFor, AUTHORITY_KEY, WRITER_DRAIN_MS } = require("../src/services/deviceCredentialWrites");
const { prepareDeviceCredentialsForServing, READINESS_MS } = require("../src/services/deviceCredentialReadiness");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const { DEVICE_AUTH_LEASE_MS } = require("../src/services/deviceAuthLease");
const { activeAuthority, deferred } = require("./helpers/deviceAuthFixture");

let replica, client, database, authority, db, coordinator, commands;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" },
    instanceOpts: [{ args: ["--setParameter", "enableTestCommands=1"] }], replSet: { count: 1, storageEngine: "wiredTiger" } });
  const info = replica.servers[0].instanceInfo;
  process.stdout.write("[device-rest-readiness-owned-mongo] " + JSON.stringify({ pid: info.instance.mongodProcess.pid,
    killerPid: info.instance.killerProcess.pid, port: info.port }) + "\n");
  client = await MongoClient.connect(replica.getUri(), { monitorCommands: true, maxPoolSize: 1 });
  database = client.db("device_rest_readiness"); authority = database.collection("jobLocks");
  client.on("commandStarted", event => { if (["findAndModify", "find"].includes(event.commandName)) commands.push(event.command); });
});
afterAll(async () => { try { await client?.close(); } finally { await replica?.stop(); } });
beforeEach(async () => {
  commands = []; await authority.deleteMany({}); await database.collection("device_tokens").deleteMany({});
  db = { db: database, client, deviceCredentialReadiness: "causal", deviceTokens: database.collection("device_tokens"), users: database.collection("users") };
  coordinator = deviceCredentialWritesFor(db); let now = 0;
  coordinator.now = () => now; coordinator.wait = async ms => { now += ms; };
});
afterEach(async () => { await coordinator.stopAndDrain(); jest.restoreAllMocks(); });

test("production factory is singleton and boot prepares/causally validates before actual writer work", async () => {
  expect(deviceCredentialWritesFor(db)).toBe(coordinator); expect(coordinator.readiness).not.toBeNull();
  expect(await prepareDeviceCredentialsForServing(coordinator, null)).toBe(true);
  const boot = await authority.findOne({ _id: AUTHORITY_KEY });
  expect(boot).toMatchObject({ mode: "prepared", pending: [], denyAll: false });
  const prepare = commands.find(command => command.findAndModify === "jobLocks" && command.update?.$setOnInsert);
  expect(prepare.upsert).toBe(true); expect(prepare.update.$setOnInsert.mode).toBe("prepared");
  expect(prepare.writeConcern).toMatchObject({ w: "majority", j: true });
  const validation = commands.find(command => command.find === "jobLocks" && command.readConcern);
  expect(validation.readConcern.level).toBe("majority"); expect(validation.readConcern.afterClusterTime).toBeDefined();
  expect(validation.singleBatch).toBe(true);
  await coordinator.run("owner", "issue", async () => {
    const current = await authority.findOne({ _id: AUTHORITY_KEY });
    expect(current.incarnation).toBe(boot.incarnation); expect(current.mode).toBe("prepared");
    expect(current.pending[0].phase).toBe("writing"); expect(coordinator.now()).toBeGreaterThanOrEqual(WRITER_DRAIN_MS);
  });
  expect((await authority.findOne({ _id: AUTHORITY_KEY })).pending).toEqual([]);
});

test("valid uncertainty is retained exactly; readiness never clears it or activates", async () => {
  const row = { ...activeAuthority(), mode: "prepared", denyAll: true,
    pending: [{ operationId: randomUUID(), ownerHash: "a".repeat(64), kind: "issue", phase: "uncertain" }] };
  await authority.insertOne(row);
  expect(await prepareDeviceCredentialsForServing(coordinator, null)).toBe(true);
  expect(await authority.findOne({ _id: AUTHORITY_KEY })).toEqual(row);
});

test("authority replacement after successful readiness cannot enroll an old incarnation", async () => {
  const ensure = coordinator.readiness.ensure.bind(coordinator.readiness);
  jest.spyOn(coordinator.readiness, "ensure").mockImplementationOnce(async () => {
    const ready = await ensure();
    await authority.updateOne({ _id: AUTHORITY_KEY }, { $set: { incarnation: randomUUID() } });
    return ready;
  });
  const work = jest.fn(); await expect(coordinator.run("owner", "issue", work)).rejects.toThrow("authority_unavailable");
  expect(work).not.toHaveBeenCalled(); expect((await authority.findOne({ _id: AUTHORITY_KEY })).pending).toEqual([]);
});

test.each([undefined, "unavailable"])("unknown capability %s cannot bootstrap writes or retained reads", async capability => {
  const unknown = { ...db, deviceCredentialReadiness: capability }, service = deviceCredentialWritesFor(unknown), work = jest.fn();
  try {
    await expect(service.run("owner", "issue", work)).rejects.toThrow("readiness_unavailable");
    expect(work).not.toHaveBeenCalled(); expect(await authority.countDocuments({})).toBe(0);
    expect(new DevicePairingsService(unknown).createRestAuthReuse()).toBeNull();
  } finally { await service.stopAndDrain(); }
});

test("malformed readiness keeps original lookup usable and dispatches no credential callback", async () => {
  await authority.insertOne({ _id: AUTHORITY_KEY, broken: true });
  const work = jest.fn(); expect(await prepareDeviceCredentialsForServing(coordinator, null)).toBe(false);
  await expect(coordinator.run("owner", "erase", work)).rejects.toThrow("readiness_unavailable");
  expect(work).not.toHaveBeenCalled(); expect(await authority.findOne({ _id: AUTHORITY_KEY })).toEqual({ _id: AUTHORITY_KEY, broken: true });
  const token = { _id: new ObjectId(), tokenHash: "hash", userId: "owner", revokedAt: null, lastSeenAt: new Date() };
  await db.deviceTokens.insertOne(token);
  const pairings = new DevicePairingsService(db);
  expect(await pairings.findTokenByHash("hash")).toEqual({ userId: "owner", deviceId: String(token._id) });
});

test("same database adapter is shared, remains inactive and never creates authority from a read", async () => {
  const pairings = new DevicePairingsService(db, { liveness: new DeviceLiveness() });
  const other = new DevicePairingsService(db);
  const adapter = pairings.createRestAuthReuse(); expect(other.createRestAuthReuse()).toBe(adapter);
  try {
    expect(await adapter.prepare("a".repeat(64))).toBeNull();
    expect(await authority.countDocuments({})).toBe(0);
    const probes = () => commands.filter(command => command.findAndModify === "jobLocks" && command.update?.$set?.grantProbeNonce);
    const [probe] = probes(); expect(probes()).toHaveLength(1);
    expect(probe.upsert).toBe(false); expect(probe.query.mode).toBe("active");
    expect(probe.update.$set).not.toHaveProperty("mode");
    await prepareDeviceCredentialsForServing(coordinator, null);
    // This lease uses the real elapsed clock: wait out the no-grant hold-off so a real probe meets the prepared row.
    await new Promise(resolve => setTimeout(resolve, DEVICE_AUTH_LEASE_MS));
    expect(await adapter.prepare("a".repeat(64))).toBeNull(); expect(probes()).toHaveLength(2);
    expect((await authority.findOne({ _id: AUTHORITY_KEY })).mode).toBe("prepared");
  } finally { await adapter.stopAndDrain(); }
});

test("stop during readiness rejects actual writer dispatch and awaits the owned attempt", async () => {
  const original = client.db.bind(client), held = deferred(), entered = deferred();
  jest.spyOn(client, "db").mockImplementation(name => {
    const actual = original(name), command = actual.command.bind(actual);
    actual.command = async (...args) => {
      const reply = await command(...args);
      if (args[0].findAndModify && args[0].update?.$setOnInsert) { entered.resolve(); await held.promise; }
      return reply;
    };
    return actual;
  });
  const work = jest.fn(), pending = coordinator.run("owner", "issue", work).catch(error => error);
  await entered.promise; let drained = false;
  const stop = coordinator.stopAndDrain().then(() => { drained = true; }); await Promise.resolve();
  expect(drained).toBe(false); expect(coordinator.pending.size).toBe(1); expect(work).not.toHaveBeenCalled();
  held.resolve(); await stop; expect((await pending).code).toMatch(/readiness_unavailable|writer_stopping/);
  expect(work).not.toHaveBeenCalled(); expect(coordinator.pending.size).toBe(0);
});

test("readiness CSOT bounds actual pool checkout without a late preparation command", async () => {
  await client.db("admin").command({ configureFailPoint: "failCommand", mode: { times: 1 },
    data: { failCommands: ["find"], blockConnection: true, blockTimeMS: READINESS_MS + 2500 } });
  const occupied = db.deviceTokens.findOne({ fixture: "held" });
  await new Promise(resolve => setTimeout(resolve, 50));
  const before = commands.filter(command => command.update?.$setOnInsert).length;
  const result = await coordinator.readiness.ensure().catch(error => error);
  expect(result.code).toBe("device_credential_readiness_unavailable");
  await occupied;
  while (coordinator.readiness.attempt) await new Promise(resolve => setTimeout(resolve, 10));
  expect(commands.filter(command => command.update?.$setOnInsert)).toHaveLength(before);
  expect(await authority.countDocuments({})).toBe(0);
});
