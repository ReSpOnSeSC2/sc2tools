// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const {
  GuideFreshnessService,
  GUIDE_CONTENT_REVISION_KEY,
  INITIAL_GUIDE_REVISION,
} = require("../src/services/guideFreshness");

const NOW = Date.parse("2026-11-06T15:00:00Z");
const UUID_RE = /^[a-f0-9-]{36}$/;

describe("guide content revision persistence", () => {
  let mongo; let client; let coll; let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    coll = client.db("guide_freshness").collection("guide_stats");
    await coll.createIndex({ key: 1 }, { unique: true });
    service = new GuideFreshnessService({ guideStats: coll }, { now: () => NOW });
  });

  beforeEach(async () => { await coll.deleteMany({}); });
  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  test("starts with an opaque initial version before the first change", async () => {
    expect(await service.readRevision()).toBe(INITIAL_GUIDE_REVISION);
    expect(await coll.countDocuments()).toBe(0);
  });

  test("persists a new version across readers without content or editor fields", async () => {
    const revision = await service.markChanged();
    expect(revision).toMatch(UUID_RE);
    const stored = await coll.findOne({ key: GUIDE_CONTENT_REVISION_KEY }, { projection: { _id: 0 } });
    expect(stored).toEqual({
      key: GUIDE_CONTENT_REVISION_KEY, kind: "revision", revision,
      updatedAt: new Date(NOW), _schemaVersion: 1,
    });
    expect(await new GuideFreshnessService({ guideStats: coll }).readRevision()).toBe(revision);
    const changed = await service.markChanged();
    expect(changed).not.toBe(revision);
    expect(await service.readRevision()).toBe(changed);
    expect(await coll.countDocuments()).toBe(1);
  });

  test("survives the nightly stale-statistics sweep because computedAt is absent", async () => {
    const revision = await service.markChanged();
    await coll.insertOne({ key: "old-build", kind: "build", computedAt: new Date(NOW - 1000) });
    await coll.deleteMany({ computedAt: { $lt: new Date(NOW + 1000) }, kind: { $ne: "run" } });
    expect(await service.readRevision()).toBe(revision);
    expect(await coll.findOne({ key: "old-build" })).toBeNull();
    expect(await coll.countDocuments()).toBe(1);
  });

  test("normalizes an invalid stored version and clears accidental computedAt on write", async () => {
    await coll.insertOne({ key: GUIDE_CONTENT_REVISION_KEY, revision: "private content", computedAt: new Date(NOW) });
    expect(await service.readRevision()).toBe(INITIAL_GUIDE_REVISION);
    const revision = await service.markChanged();
    expect(await service.readRevision()).toBe(revision);
    expect(await coll.findOne({ key: GUIDE_CONTENT_REVISION_KEY })).not.toHaveProperty("computedAt");
  });
});

describe("guide content revision bounds and failures", () => {
  test("reads only the indexed singleton revision with a query deadline", async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const service = new GuideFreshnessService({ guideStats: { findOne } });
    expect(await service.readRevision()).toBe(INITIAL_GUIDE_REVISION);
    expect(findOne).toHaveBeenCalledWith(
      { key: GUIDE_CONTENT_REVISION_KEY },
      { projection: { _id: 0, revision: 1 }, maxTimeMS: 5000 },
    );
  });

  test("retries a concurrent first-insert collision as an update", async () => {
    const updateOne = jest.fn().mockRejectedValueOnce({ code: 11000 }).mockResolvedValueOnce({ matchedCount: 1 });
    const service = new GuideFreshnessService({ guideStats: { updateOne } });
    const revision = await service.markChanged();
    expect(revision).toMatch(UUID_RE);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[1]).toEqual(updateOne.mock.calls[0].slice(0, 2));
  });

  test("propagates database errors so callers do not publish a false new version", async () => {
    const failure = new Error("database unavailable");
    const service = new GuideFreshnessService({ guideStats: {
      findOne: jest.fn().mockRejectedValue(failure),
      updateOne: jest.fn().mockRejectedValue(failure),
    } });
    await expect(service.readRevision()).rejects.toBe(failure);
    await expect(service.markChanged()).rejects.toBe(failure);
  });
});
