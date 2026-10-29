// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { deviceCredentialWritesFor, AUTHORITY_KEY } = require("../src/services/deviceCredentialWrites");
const { DevicePairingsService } = require("../src/services/devicePairings");
let mongo, db, coordinator;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  const info = mongo.instanceInfo;
  process.stdout.write("[device-writer-only-owned-mongo] " + JSON.stringify({ pid: info.instance.mongodProcess.pid,
    killerPid: info.instance.killerProcess.pid, port: info.port }) + "\n");
  db = await connect({ uri: mongo.getUri(), dbName: "writer_only_standalone" });
});
afterAll(async () => { try { await coordinator?.stopAndDrain(); await db?.close(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await db.db.collection("jobLocks").deleteMany({}); coordinator = deviceCredentialWritesFor(db);
  let now = 0; coordinator.now = () => now; coordinator.wait = async ms => { now += ms; };
});

test("actual positively identified standalone preserves coordinated writes and permanently declines retained adapter", async () => {
  expect(db.deviceCredentialReadiness).toBe("writer-only-standalone"); expect(db.gameStatsTransactions).toBe(false);
  let calls = 0;
  await coordinator.run("owner", "issue", async () => { calls += 1; });
  expect(calls).toBe(1);
  const row = await db.db.collection("jobLocks").findOne({ _id: AUTHORITY_KEY });
  expect(row.mode).toBe("prepared"); expect(row.pending).toEqual([]);
  expect(new DevicePairingsService(db).createRestAuthReuse()).toBeNull();
  await db.db.collection("jobLocks").updateOne({ _id: AUTHORITY_KEY }, { $set: { mode: "active" } });
  expect(new DevicePairingsService(db).createRestAuthReuse()).toBeNull();
});

test("malformed standalone authority still refuses credential callback without suppressing public lookup", async () => {
  await db.db.collection("jobLocks").insertOne({ _id: AUTHORITY_KEY, malformed: true });
  const work = jest.fn(); await expect(coordinator.run("owner", "erase", work)).rejects.toThrow("readiness_unavailable");
  expect(work).not.toHaveBeenCalled();
  await db.deviceTokens.insertOne({ tokenHash: "hash", userId: "owner", lastSeenAt: new Date(), revokedAt: null });
  expect((await new DevicePairingsService(db).findTokenByHash("hash")).userId).toBe("owner");
});
