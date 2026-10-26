// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { UsersService } = require("../src/services/users");

const NOW = Date.parse("2026-10-26T16:00:00Z");
const DAY = 86400000;
let mongo, client, collection, users;
const ago = ms => new Date(NOW - ms);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  const db = client.db("account_activity_throttle");
  collection = db.collection("users");
  await collection.createIndex({ userId: 1 }, { unique: true });
  users = new UsersService({ users: collection, games: db.collection("games") });
});

beforeEach(async () => {
  await collection.deleteMany({});
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });

async function touchResult(service = users) {
  const spy = jest.spyOn(collection, "updateOne");
  await service.touch("owner");
  return spy.mock.results.at(-1).value;
}

test("recent activity makes no document write or unrelated account change", async () => {
  const original = { userId: "owner", createdAt: ago(20 * DAY), lastSeenAt: ago(60000), role: "admin", activation: { other: "kept" } };
  await collection.insertOne(original);
  await expect(touchResult()).resolves.toMatchObject({ matchedCount: 0, modifiedCount: 0 });
  expect(await collection.findOne({ userId: "owner" })).toEqual(original);
});

test("concurrent service instances write stale activity once at the five-minute boundary", async () => {
  await collection.insertOne({ userId: "owner", createdAt: ago(20 * DAY), lastSeenAt: ago(5 * 60000), activation: { other: "kept" } });
  const second = new UsersService({ users: collection });
  const spy = jest.spyOn(collection, "updateOne");
  await Promise.all([users.touch("owner"), second.touch("owner"), users.touch("owner")]);
  const results = await Promise.all(spy.mock.results.map(result => result.value));
  expect(results.reduce((sum, result) => sum + result.modifiedCount, 0)).toBe(1);
  expect(await collection.findOne({ userId: "owner" })).toMatchObject({ lastSeenAt: new Date(NOW), activation: { other: "kept" } });
});

test.each([undefined, null, "legacy-string", [], [new Date(NOW + DAY)], { malformed: true }])("repairs a missing or non-Date activity timestamp: %s", async value => {
  const row = { userId: "owner", createdAt: ago(DAY) };
  if (value !== undefined) row.lastSeenAt = value;
  await collection.insertOne(row);
  await expect(touchResult()).resolves.toMatchObject({ modifiedCount: 1 });
  expect((await collection.findOne({ userId: "owner" })).lastSeenAt).toEqual(new Date(NOW));
});

test("a first week-two visit counts despite recent activity and preserves other activation fields", async () => {
  await collection.insertOne({ userId: "owner", createdAt: ago(7 * DAY), lastSeenAt: ago(1), activation: { downloadedAt: ago(DAY), other: "kept" } });
  await expect(touchResult()).resolves.toMatchObject({ modifiedCount: 1 });
  const row = await collection.findOne({ userId: "owner" });
  expect(row.activation).toEqual({ downloadedAt: ago(DAY), other: "kept", week2ReturnAt: new Date(NOW) });
  await expect(touchResult()).resolves.toMatchObject({ modifiedCount: 0 });
});

test.each([6, 14, 20])("does not invent a week-two return at account age %i days", async days => {
  await collection.insertOne({ userId: "owner", createdAt: ago(days * DAY), lastSeenAt: ago(10 * 60000), activation: { other: "kept" } });
  await users.touch("owner");
  expect((await collection.findOne({ userId: "owner" })).activation).toEqual({ other: "kept" });
});

test("later visits retain the original week-two timestamp", async () => {
  await collection.insertOne({ userId: "owner", createdAt: ago(9 * DAY), lastSeenAt: ago(10 * 60000), activation: { week2ReturnAt: ago(DAY), other: "kept" } });
  await users.touch("owner");
  expect((await collection.findOne({ userId: "owner" })).activation).toEqual({ week2ReturnAt: ago(DAY), other: "kept" });
});

test("activity is owner scoped and a missing account is never recreated", async () => {
  const other = { userId: "other", lastSeenAt: ago(DAY) };
  await collection.insertOne(other);
  await expect(touchResult()).resolves.toMatchObject({ matchedCount: 0, modifiedCount: 0 });
  expect(await collection.findOne({ userId: "owner" })).toBeNull();
  expect(await collection.findOne({ userId: "other" })).toEqual(other);
});

test("a failed attempt propagates and does not suppress a successful retry", async () => {
  await collection.insertOne({ userId: "owner", createdAt: ago(DAY), lastSeenAt: ago(DAY) });
  const spy = jest.spyOn(collection, "updateOne").mockRejectedValueOnce(new Error("offline"));
  await expect(users.touch("owner")).rejects.toThrow("offline");
  spy.mockRestore();
  await expect(touchResult()).resolves.toMatchObject({ modifiedCount: 1 });
});

test("a lost acknowledgement is retryable without another document change", async () => {
  await collection.insertOne({ userId: "owner", createdAt: ago(9 * DAY), lastSeenAt: ago(DAY) });
  const update = collection.updateOne.bind(collection);
  const spy = jest.spyOn(collection, "updateOne").mockImplementationOnce(async (...args) => {
    await update(...args);
    throw new Error("acknowledgement lost");
  });
  await expect(users.touch("owner")).rejects.toThrow("acknowledgement lost");
  spy.mockRestore();
  await expect(touchResult()).resolves.toMatchObject({ modifiedCount: 0 });
  expect((await collection.findOne({ userId: "owner" })).activation.week2ReturnAt).toEqual(new Date(NOW));
});
