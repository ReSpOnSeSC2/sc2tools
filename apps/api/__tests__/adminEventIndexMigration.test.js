// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect, ensureIndexes } = require("../src/db/connect");
const { COLLECTIONS } = require("../src/config/constants");

describe("admin signup-event index migration", () => {
  test(
    "replaces the deployed index without losing active-user uniqueness",
    verifyLegacyIndexMigration,
  );
});

async function verifyLegacyIndexMigration() {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  const dbName = "admin_event_index_migration";
  const seedClient = new MongoClient(uri);
  let ctx = null;

  try {
    await seedLegacyIndex(seedClient, dbName);
    await seedClient.close();
    // connect() runs the production boot path against the legacy schema. A
    // second pass proves subsequent boots remain idempotent.
    ctx = await connect({ uri, dbName });
    await ensureIndexes(ctx);
    await expectCorrectedIndex(ctx.adminEvents);
  } finally {
    if (ctx) await ctx.close();
    else await seedClient.close().catch(() => {});
    await mongo.stop();
  }
}

async function seedLegacyIndex(client, dbName) {
  await client.connect();
  const events = client.db(dbName).collection(COLLECTIONS.ADMIN_EVENTS);
  await events.createIndex(
    { "payload.clerkUserId": 1 },
    {
      unique: true,
      partialFilterExpression: { type: "user_signup" },
      name: "user_signup_unique_clerk",
    },
  );
  await events.insertMany([
    {
      eventId: "active-signup",
      type: "user_signup",
      payload: { clerkUserId: "clerk_active" },
    },
    {
      eventId: "already-anonymized",
      type: "user_signup",
      anonymizedAt: new Date(),
      payload: { clerkUserId: null },
    },
  ]);
}

async function expectCorrectedIndex(events) {
  const indexes = await events.listIndexes().toArray();
  expect(
    indexes.find((index) => index.name === "user_signup_unique_clerk"),
  ).toBeUndefined();
  expect(
    indexes.find(
      (index) => index.name === "user_signup_unique_active_clerk",
    ),
  ).toMatchObject({
    unique: true,
    partialFilterExpression: {
      type: "user_signup",
      anonymizedAt: null,
      "payload.clerkUserId": { $type: "string" },
    },
  });
  await expect(events.insertOne({
    eventId: "second-anonymized",
    type: "user_signup",
    anonymizedAt: new Date(),
    payload: { clerkUserId: null },
  })).resolves.toBeTruthy();
  await expect(events.insertOne({
    eventId: "duplicate-active",
    type: "user_signup",
    payload: { clerkUserId: "clerk_active" },
  })).rejects.toMatchObject({ code: 11000 });
}
