// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const express = require("express");
const request = require("supertest");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");
const { CUSTOM_BUILD_CLASSIFIER_BATCH_SIZE } = require("../src/services/customBuildPages");
const { RULES_MAX_ITEMS, SIGNATURE_MAX_ITEMS, LEGACY_STEPS_MAX_ITEMS } = require("../src/validation/customBuild");

const USER = "library-owner";
const SAME_DATE = new Date("2026-09-01T12:00:00Z");
const slugAt = (index) => `build-${String(index).padStart(3, "0")}`;
const definition = (index, extra = {}) => ({
  userId: USER,
  slug: slugAt(index),
  name: "Shared build",
  race: "Terran",
  vsRace: "Protoss",
  perspective: "you",
  rules: [{ type: "before", name: "BuildBarracks", time_lt: 100 }],
  updatedAt: SAME_DATE,
  ...extra,
});

describe("custom build library pagination", () => {
  let mongo;
  let client;
  let db;
  let builds;
  let games;
  let service;
  let app;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db("custom_build_pagination");
    builds = db.collection("custom_builds");
    games = db.collection("games");
    await builds.createIndex({ userId: 1, slug: 1 }, { unique: true });
    await games.createIndex({ userId: 1, _customBuildSlug: 1 });
    await games.createIndex({ userId: 1, _customOpponentStrategySlug: 1 });
    service = new CustomBuildsService({ games, customBuilds: builds, customBuildJobs: db.collection("custom_build_jobs") });
    app = express();
    app.use(express.json());
    app.use("/v1", buildCustomBuildsRouter({
      customBuilds: service,
      auth: (req, _res, next) => {
        req.auth = { userId: req.get("x-test-user") || USER };
        next();
      },
    }));
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({ error: { code: error.code || "test_error", message: error.message } });
    });
  });

  beforeEach(async () => {
    await Promise.all([builds.deleteMany({}), games.deleteMany({})]);
    await builds.insertMany(Array.from({ length: 137 }, (_, index) => definition(index)));
    await builds.insertMany([
      definition(0, { userId: "other-account", name: "Other account private build" }),
      definition(200, { deletedAt: SAME_DATE, name: "Deleted build" }),
    ]);
  });

  afterAll(async () => {
    if (service) await service.stopReclassifications();
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  async function page(query = {}, userId = USER) {
    const response = await request(app).get("/v1/custom-builds").set("x-test-user", userId).query(query);
    expect({ status: response.status, error: response.body.error }).toEqual({ status: 200, error: undefined });
    return response.body;
  }

  async function allPages(query = {}) {
    const items = [];
    const seen = new Set();
    let cursor;
    do {
      const body = await page({ ...query, ...(cursor ? { cursor } : {}) });
      expect(body.items.length).toBeLessThanOrEqual(Number(query.limit || 50));
      expect(body).toMatchObject({ total: 137, libraryTotal: 137, truncated: false });
      items.push(...body.items);
      cursor = body.nextCursor;
      if (cursor) {
        expect(seen.has(cursor)).toBe(false);
        seen.add(cursor);
      }
      expect(seen.size).toBeLessThan(20);
    } while (cursor);
    return items;
  }

  test("saves and edits builds beyond 100, including concurrent creates and restoring deleted builds", async () => {
    const results = await Promise.all([138, 139, 200].map((index) => request(app)
      .put(`/v1/custom-builds/${slugAt(index)}`)
      .send({ name: `New build ${index}`, race: "Zerg", rules: [{ type: "before", name: "BuildSpawningPool", time_lt: 100 }], reclassify: false })));
    for (const response of results) {
      expect(response.status).toBe(200);
      expect(response.body.saved).toBe(true);
    }
    const edited = await request(app).put(`/v1/custom-builds/${slugAt(136)}`)
      .send({ name: "Edited older build", race: "Terran", reclassify: false });
    expect(edited.status).toBe(200);
    expect(await builds.countDocuments({ userId: USER, deletedAt: { $exists: false } })).toBe(140);
    expect(await service.libraryMeta(USER)).toEqual({ total: 140, limit: null, truncated: false });
    expect((await page({ name: "Edited older build" })).items[0].slug).toBe(slugAt(136));
  });

  test.each(["updated", "name", "games", "winRate"])("walks every build exactly once across %s ties", async (sort) => {
    await games.insertMany(Array.from({ length: 137 }, (_, index) => ({
      userId: USER, gameId: `game-${index}`, date: SAME_DATE, result: "Victory", _customBuildSlug: slugAt(index),
    })));
    const rows = await allPages({ sort, limit: 23 });
    expect(rows.map((row) => row.slug)).toEqual(Array.from({ length: 137 }, (_, index) => slugAt(index)));
    expect(new Set(rows.map((row) => row.slug)).size).toBe(137);
    expect(rows.some((row) => row.name === "Deleted build" || row.name === "Other account private build")).toBe(false);
  });

  test("keeps cursor pages isolated to the account and selected query", async () => {
    const first = await page({ limit: 10 });
    for (const query of [
      { limit: 11 }, { limit: 10, sort: "name" }, { limit: 10, search: "Shared" },
      { limit: 10, matchup: "TvP" }, { limit: 10, includeGeneric: true }, { limit: 10, view: "summary" },
      { limit: 10, hideEmpty: true }, { limit: 10, normalizedName: "Shared build" },
    ]) {
      const response = await request(app).get("/v1/custom-builds").query({ ...query, cursor: first.nextCursor });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_custom_build_page");
    }
    const other = await request(app).get("/v1/custom-builds").set("x-test-user", "other-account").query({ limit: 10, cursor: first.nextCursor });
    expect(other.status).toBe(400);
    expect((await page({}, "other-account")).items).toHaveLength(1);
  });

  test.each([
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "bad" },
    { cursor: "not-json" }, { cursor: "has invalid spaces" },
    { cursor: Buffer.from(JSON.stringify({ v: 1, scope: "wrong", slug: "build-000", order: 0 })).toString("base64url") },
    { sort: "wrong" }, { matchup: "TvX" }, { hideEmpty: "1" }, { includeGeneric: "1" },
    { search: "x".repeat(201) }, { name: "x".repeat(201) },
  ])("rejects malformed pagination options %j", async (query) => {
    const response = await request(app).get("/v1/custom-builds").query(query);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_custom_build_page");
  });

  test("finds older builds by exact name, legacy slug, normalized name, notes and literal search", async () => {
    await builds.updateOne({ userId: USER, slug: slugAt(136) }, { $set: {
      name: "PvZ —  Stargate   Phoenix", notes: "Hidden search phrase [1]", description: "An older opening",
    } });
    for (const query of [
      { name: "PvZ —  Stargate   Phoenix" }, { name: slugAt(136) },
      { normalizedName: "stargate phoenix" }, { normalizedName: "PvZ: STARGATE Phoenix" },
      { search: "Hidden search phrase [1]" }, { search: "An older opening" },
    ]) {
      const result = await page(query);
      expect(result.total).toBe(1);
      expect(result.items.map((row) => row.slug)).toEqual([slugAt(136)]);
    }
    expect((await page({ search: ".*" })).items).toEqual([]);
    expect((await page({ normalizedName: "stargate phoenix", view: "summary" })).items[0].slug).toBe(slugAt(136));
  });

  test("filters matchups across the entire library and includes generic builds only on request", async () => {
    await builds.updateOne({ userId: USER, slug: slugAt(134) }, { $set: { race: "Zerg", vsRace: "Terran" } });
    await builds.updateOne({ userId: USER, slug: slugAt(135) }, { $set: { race: "Zerg", vsRace: "Any" } });
    await builds.updateOne({ userId: USER, slug: slugAt(136) }, { $set: { race: "Zerg" }, $unset: { vsRace: "" } });
    expect((await page({ matchup: "ZvT" })).items.map((row) => row.slug)).toEqual([slugAt(134)]);
    expect((await page({ matchup: "ZvT", includeGeneric: true })).items.map((row) => row.slug)).toEqual([slugAt(134), slugAt(135), slugAt(136)]);
    expect((await page({ search: "ZvT" })).items.map((row) => row.slug)).toEqual([slugAt(134)]);
  });

  test("sorts stats globally and excludes wrong-perspective, other-account and resumed replay provenance", async () => {
    await builds.updateOne({ userId: USER, slug: slugAt(133) }, { $set: { perspective: "opponent" } });
    // Legacy non-opponent values use the player's perspective, like the classifier and stats endpoint.
    await builds.updateOne({ userId: USER, slug: slugAt(135) }, { $set: { perspective: "YOU" } });
    const results = ["Victory", "win", "defeat"];
    await games.insertMany([
      ...results.map((result, index) => ({ userId: USER, gameId: `popular-${index}`, date: SAME_DATE, result, _customBuildSlug: slugAt(136) })),
      { userId: USER, gameId: "loss", date: SAME_DATE, result: "Loss", _customBuildSlug: slugAt(135) },
      ...[0, 1].map((index) => ({ userId: USER, gameId: `opponent-${index}`, date: SAME_DATE, result: "Victory", _customOpponentStrategySlug: slugAt(133) })),
      { userId: USER, gameId: "wrong-axis", date: SAME_DATE, result: "Victory", _customOpponentStrategySlug: slugAt(132) },
      { userId: USER, gameId: "wrong-opponent-axis", date: SAME_DATE, result: "Defeat", _customBuildSlug: slugAt(133) },
      { userId: "other-account", gameId: "other", date: SAME_DATE, result: "Defeat", _customBuildSlug: slugAt(136) },
      ...Array.from({ length: 5 }, (_, index) => ({ userId: USER, gameId: `resumed-${index}`, date: SAME_DATE, result: "Victory", _customBuildSlug: slugAt(134), isResumedFromReplay: true })),
    ]);
    const byGames = await page({ sort: "games", hideEmpty: true, limit: 2 });
    expect(byGames).toMatchObject({ total: 3, libraryTotal: 137 });
    expect(byGames.items.map((row) => row.slug)).toEqual([slugAt(136), slugAt(133)]);
    const remaining = await page({ sort: "games", hideEmpty: true, limit: 2, cursor: byGames.nextCursor });
    expect(remaining.items.map((row) => row.slug)).toEqual([slugAt(135)]);
    expect(remaining.nextCursor).toBeNull();
    expect((await page({ sort: "winRate", hideEmpty: true })).items.map((row) => row.slug)).toEqual([slugAt(133), slugAt(136), slugAt(135)]);
    const stats = await request(app).get("/v1/custom-builds/stats").query({ slugs: [133, 135, 136, 200].map(slugAt).join(",") });
    expect(stats.status).toBe(200);
    expect(stats.body).toHaveLength(3);
    expect(stats.body.find((row) => row.slug === slugAt(136))).toMatchObject({ wins: 2, losses: 1, total: 3, winRate: 2 / 3 });
    expect(stats.body.find((row) => row.slug === slugAt(133))).toMatchObject({ wins: 2, losses: 0, total: 2, winRate: 1 });
  });

  test("bounds requested-slug stats and can resolve builds beyond the default page", async () => {
    const exact = await request(app).get("/v1/custom-builds/stats").query({ slugs: `${slugAt(136)},${slugAt(136)},not-owned,${slugAt(200)}` });
    expect({ status: exact.status, error: exact.body.error }).toEqual({ status: 200, error: undefined });
    expect(exact.body.map((row) => row.slug)).toEqual([slugAt(136)]);
    const hundred = await request(app).get("/v1/custom-builds/stats").query({ slugs: Array.from({ length: 100 }, (_, index) => slugAt(index)).join(",") });
    expect(hundred.status).toBe(200);
    expect(hundred.body).toHaveLength(100);
    for (const slugs of [Array.from({ length: 101 }, (_, index) => slugAt(index)).join(","), "", "bad,,slug", "x".repeat(81)]) {
      const invalid = await request(app).get("/v1/custom-builds/stats").query({ slugs });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("invalid_custom_build_page");
    }
    const initial = await request(app).get("/v1/custom-builds/stats");
    expect(initial.status).toBe(200);
    expect(initial.body.length).toBeLessThanOrEqual(50);
  });

  test("projects bounded legacy leaves before list and classifier pages reach Node", async () => {
    const secret = "never-hydrate-this-unknown-child".repeat(1000);
    await builds.updateOne({ userId: USER, slug: slugAt(0) }, { $set: {
      unboundedLegacyField: secret,
      notes: "n".repeat(10000),
      rules: Array.from({ length: 60 }, () => ({ type: "before", name: "BuildBarracks", time_lt: 100, unknown: secret })),
      signature: Array.from({ length: 210 }, () => ({ unit: "Barracks", count: 1, beforeSec: 100, unknown: secret })),
      steps: Array.from({ length: 210 }, () => ({ action: "a".repeat(400), unknown: secret })),
    } });
    const aggregate = jest.spyOn(builds, "aggregate");
    try {
      const first = await page();
      const legacy = first.items.find((row) => row.slug === slugAt(0));
      expect(first.items).toHaveLength(50);
      expect(legacy.notes).toHaveLength(8000);
      expect(legacy.rules).toHaveLength(RULES_MAX_ITEMS);
      expect(legacy.signature).toHaveLength(SIGNATURE_MAX_ITEMS);
      expect(legacy.steps).toHaveLength(LEGACY_STEPS_MAX_ITEMS);
      expect(legacy.steps[0].action).toHaveLength(280);
      expect(JSON.stringify(first)).not.toContain("never-hydrate");
      const rowPipeline = aggregate.mock.calls.find(([stages]) => stages.some((stage) => stage.$sort))[0];
      expect(rowPipeline).toContainEqual({ $limit: 51 });
      expect(rowPipeline.some((stage) => stage.$project)).toBe(true);
      const batches = [];
      for await (const batch of service._iterateForClassification(USER)) {
        expect(batch.length).toBeLessThanOrEqual(CUSTOM_BUILD_CLASSIFIER_BATCH_SIZE);
        expect(JSON.stringify(batch)).not.toContain("never-hydrate");
        for (const item of batch) expect(item).not.toHaveProperty("notes");
        batches.push(batch);
      }
      expect(batches.map((batch) => batch.length)).toEqual([50, 50, 37]);
      expect(batches.flat().map((row) => row.slug)).toEqual(Array.from({ length: 137 }, (_, index) => slugAt(index)));
      const summary = await page({ view: "summary", name: "Shared build" });
      expect(summary.items).toHaveLength(50);
      for (const item of summary.items) {
        expect(Object.keys(item).sort()).toEqual(["description", "name", "perspective", "race", "slug", "sourceGameId", "updatedAt", "vsRace"].sort());
      }
      expect(JSON.stringify(summary)).not.toContain("never-hydrate");
    } finally {
      aggregate.mockRestore();
    }
  });
});
