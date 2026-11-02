// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { appendPulseId } = require("../src/services/appendPulseId");
const { UsersService } = require("../src/services/users");

let mongo, client, users;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  users = client.db("append_identity").collection("users");
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => { await users.deleteMany({}); });

test("append preserves singular legacy identity, profile fields and idempotency", async () => {
  const profile = { userId: "owner", pulseId: "legacy", displayName: "Private name", battleTag: "Private#1", region: "eu", sessionGapMinutes: 45 };
  await users.insertOne(profile);
  expect(await appendPulseId(users, "owner", "1-S2-1-42")).toEqual({ code: "added", count: 2 });
  expect(await appendPulseId(users, "owner", "1-S2-1-42")).toEqual({ code: "already_present", count: 2 });
  expect(await users.findOne({ userId: "owner" })).toMatchObject({ ...profile, pulseIds: ["legacy", "1-S2-1-42"], _schemaVersion: 1 });
});

test("an explicit empty array overrides the singular field, matching profile DTO policy", async () => {
  await users.insertOne({ userId: "owner", pulseIds: [], pulseId: "removed" });
  await appendPulseId(users, "owner", "new");
  expect(await users.findOne({ userId: "owner" })).toMatchObject({ pulseIds: ["new"], pulseId: "new" });
});

test("simultaneous existing-ingest and Settings appends retain both identities", async () => {
  await users.insertOne({ userId: "owner", pulseId: "legacy" });
  const service = new UsersService({ users });
  const results = await Promise.all([appendPulseId(users, "owner", "web"), service.addPulseId("owner", "ingest")]);
  expect(results).toEqual([{ code: "added", count: expect.any(Number) }, true]);
  const doc = await users.findOne({ userId: "owner" });
  expect(doc.pulseIds).toHaveLength(3); expect(new Set(doc.pulseIds)).toEqual(new Set(["legacy", "web", "ingest"]));
  expect(doc.pulseId).toBe("legacy");
});

test("a concurrent replacement profile wins its own write without losing the later append", async () => {
  await users.insertOne({ userId: "owner", pulseIds: ["old"], pulseId: "old", displayName: "Before" });
  let first = true;
  const wrapped = { findOne: (...args) => users.findOne(...args), updateOne: async (...args) => {
    if (first) { first = false; await users.updateOne({ userId: "owner" }, { $set: { pulseIds: ["edited"], pulseId: "edited", displayName: "After" } }); }
    return users.updateOne(...args);
  } };
  expect(await appendPulseId(wrapped, "owner", "added")).toEqual({ code: "added", count: 2 });
  expect(await users.findOne({ userId: "owner" })).toMatchObject({ pulseIds: ["edited", "added"], pulseId: "edited", displayName: "After" });
});

test("concurrent final-slot appends never exceed 20 and duplicates remain idempotent at the cap", async () => {
  const initial = Array.from({ length: 19 }, (_, i) => `existing-${i}`);
  await users.insertOne({ userId: "owner", pulseIds: initial, pulseId: initial[0] });
  const results = await Promise.all([appendPulseId(users, "owner", "last-a"), appendPulseId(users, "owner", "last-b")]);
  expect(results.map(x => x.code).sort()).toEqual(["added", "capacity"]);
  const doc = await users.findOne({ userId: "owner" });
  expect(doc.pulseIds).toHaveLength(20); expect(doc.pulseIds.slice(0, 19)).toEqual(initial);
  expect(await appendPulseId(users, "owner", doc.pulseIds[19])).toEqual({ code: "already_present", count: 20 });
});

test("a concurrent duplicate inserts only once", async () => {
  await users.insertOne({ userId: "owner" });
  const results = await Promise.all([appendPulseId(users, "owner", "same"), appendPulseId(users, "owner", "same")]);
  expect(results.map(x => x.code).sort()).toEqual(["added", "already_present"]);
  expect((await users.findOne({ userId: "owner" })).pulseIds).toEqual(["same"]);
});

test("the GDPR fence and bounded contention prevent writes; missing/invalid identities never upsert", async () => {
  await users.insertOne({ userId: "owner", _gdprMutation: { operation: "erase" }, pulseIds: ["kept"] });
  expect(await appendPulseId(users, "owner", "new")).toEqual({ code: "busy", count: 0 });
  expect(await appendPulseId(users, "missing", "new")).toEqual({ code: "missing", count: 0 });
  expect(await appendPulseId(users, "missing", { $ne: null })).toEqual({ code: "invalid", count: 0 });
  const contended = { findOne: jest.fn(async () => ({ pulseIds: [] })), updateOne: jest.fn(async () => ({ matchedCount: 0 })) };
  expect(await appendPulseId(contended, "owner", "new")).toEqual({ code: "busy", count: 0 });
  expect(contended.updateOne).toHaveBeenCalledTimes(4);
  expect(await users.countDocuments({})).toBe(1);
  expect((await users.findOne({ userId: "owner" })).pulseIds).toEqual(["kept"]);
});
