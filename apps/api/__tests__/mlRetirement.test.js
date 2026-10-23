// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { buildMlRouter } = require("../src/routes/ml");
const { retireMlCollections } = require("../src/db/migrations/2026-10-23-retire-ml");
const { auditRetiredMl } = require("../scripts/audit-retired-ml");

describe("retired ML routes", () => {
  const app = express();
  app.use("/v1", buildMlRouter({ auth: (req, _res, next) => {
    if (req.headers.authorization) req.auth = { userId: "test-user" };
    next();
  } }));

  test.each(["status", "train", "predict", "pregame", "options"])("%s returns Gone without a service dependency", async (route) => {
    const response = await request(app).post(`/v1/ml/${route}`).set("Authorization", "test");
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe("ml_retired");
  });
  test("keeps authentication required", async () => {
    expect((await request(app).get("/v1/ml/status")).status).toBe(401);
  });
});

describe("forward-only ML collection cleanup", () => {
  let mongo; let client; let db;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db("ml-retirement-test");
  });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });

  test("dry run and audit preserve data; cleanup drops only retired collections and is idempotent", async () => {
    await db.collection("ml_models").insertOne({ model: "legacy" });
    await db.collection("ml_jobs").insertOne({ status: "finished" });
    await db.collection("games").insertOne({ gameId: "keep" });
    expect(await auditRetiredMl(db)).toEqual([
      { collection: "ml_models", exists: true, documents: 1 },
      { collection: "ml_jobs", exists: true, documents: 1 },
    ]);
    expect(await retireMlCollections(db, { dryRun: true })).toEqual([
      { collection: "ml_models", documents: 1, dropped: false },
      { collection: "ml_jobs", documents: 1, dropped: false },
    ]);
    expect(await db.collection("ml_models").countDocuments()).toBe(1);
    expect(await retireMlCollections(db)).toEqual([
      { collection: "ml_models", documents: 1, dropped: true },
      { collection: "ml_jobs", documents: 1, dropped: true },
    ]);
    expect(await retireMlCollections(db)).toEqual([]);
    expect(await db.collection("games").findOne({ gameId: "keep" })).toBeTruthy();
    expect((await auditRetiredMl(db)).every((row) => !row.exists && row.documents === 0)).toBe(true);
  });
});
