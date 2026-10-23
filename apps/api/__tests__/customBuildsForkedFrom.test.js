// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * ``forkedFrom`` — the community provenance a "Save to my library" copy
 * carries ({communitySlug, version, savedAt}). It is validated and bounded
 * like every other field, persisted and read back privately, filterable on
 * ``GET /v1/custom-builds?forkedFrom=<slug>`` (so the community page can
 * show "In your library" instead of saving a duplicate), and never part of
 * the public community snapshot. Real Mongo, route + service.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const express = require("express");
const request = require("supertest");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");
const { validateCustomBuild } = require("../src/validation/customBuild");
const { publicBuildSnapshot } = require("../src/services/communityBuildSnapshot");

const USER = "fork-owner";
const FORKED_FROM = Object.freeze({
  communitySlug: "pvz-stargate-glaives-a1b2c3",
  version: "2026-09-01T12:00:00.000Z",
  savedAt: "2026-10-20T08:30:00.000Z",
});

const build = (extra = {}) => ({
  name: "Stargate into Glaives",
  race: "Protoss",
  vsRace: "Zerg",
  rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
  reclassify: false,
  ...extra,
});

describe("validateCustomBuild forkedFrom", () => {
  test("accepts the provenance and drops unknown nested keys", () => {
    const result = validateCustomBuild({
      slug: "copy",
      name: "Copy",
      race: "Protoss",
      forkedFrom: { ...FORKED_FROM, giant: "x".repeat(100_000) },
    });
    expect(result.valid).toBe(true);
    expect(result.value.forkedFrom).toEqual(FORKED_FROM);
  });

  test("accepts null version and savedAt (a read build sent straight back)", () => {
    const result = validateCustomBuild({
      slug: "copy",
      name: "Copy",
      race: "Protoss",
      forkedFrom: { communitySlug: "abc", version: null, savedAt: null },
    });
    expect(result.valid).toBe(true);
  });

  test.each([
    ["a non-object", "pvz-build"],
    ["a missing slug", { version: "v1" }],
    ["a slug with a slash", { communitySlug: "../other" }],
    ["an over-long slug", { communitySlug: "a".repeat(81) }],
    ["a savedAt that is not a date", { communitySlug: "abc", savedAt: "yesterday" }],
  ])("rejects %s", (_label, forkedFrom) => {
    const result = validateCustomBuild({ slug: "copy", name: "Copy", race: "Protoss", forkedFrom });
    expect(result.valid).toBe(false);
  });

  test("is private: the public community snapshot never carries it", () => {
    const snapshot = publicBuildSnapshot({ ...build(), slug: "copy", forkedFrom: FORKED_FROM });
    expect(snapshot).not.toHaveProperty("forkedFrom");
  });
});

describe("custom builds forkedFrom (route + Mongo)", () => {
  let mongo;
  let client;
  let builds;
  let service;
  let app;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    const db = client.db("custom_builds_forked_from");
    builds = db.collection("custom_builds");
    await builds.createIndex({ userId: 1, slug: 1 }, { unique: true });
    service = new CustomBuildsService({
      games: db.collection("games"),
      customBuilds: builds,
      customBuildJobs: db.collection("custom_build_jobs"),
    });
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
    await builds.deleteMany({});
  });

  afterAll(async () => {
    if (service) await service.stopReclassifications();
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  const put = (slug, body, user = USER) =>
    request(app).put(`/v1/custom-builds/${slug}`).set("x-test-user", user).send(body);
  const list = (query, user = USER) =>
    request(app).get("/v1/custom-builds").set("x-test-user", user).query(query);

  test("persists the provenance and reads it back on the build", async () => {
    await put("glaives-copy", build({ forkedFrom: FORKED_FROM })).expect(200);
    const res = await request(app).get("/v1/custom-builds/glaives-copy").set("x-test-user", USER).expect(200);
    expect(res.body.forkedFrom).toEqual(FORKED_FROM);
    const stored = await builds.findOne({ userId: USER, slug: "glaives-copy" });
    expect(stored.forkedFrom).toEqual(FORKED_FROM);
  });

  test("an edit that omits it keeps the provenance", async () => {
    await put("glaives-copy", build({ forkedFrom: FORKED_FROM })).expect(200);
    await put("glaives-copy", build({ name: "My Glaives" })).expect(200);
    const stored = await builds.findOne({ userId: USER, slug: "glaives-copy" });
    expect(stored).toEqual(expect.objectContaining({ name: "My Glaives", forkedFrom: FORKED_FROM }));
  });

  test("builds without it read back forkedFrom: null", async () => {
    await put("own-build", build()).expect(200);
    const res = await request(app).get("/v1/custom-builds/own-build").set("x-test-user", USER).expect(200);
    expect(res.body.forkedFrom).toBeNull();
  });

  test("lists only this account's live copies of one community build", async () => {
    await put("glaives-copy", build({ forkedFrom: FORKED_FROM })).expect(200);
    await put("other-copy", build({ forkedFrom: { communitySlug: "other-build" } })).expect(200);
    await put("own-build", build()).expect(200);
    await put("deleted-copy", build({ forkedFrom: FORKED_FROM })).expect(200);
    await request(app).delete("/v1/custom-builds/deleted-copy").set("x-test-user", USER).expect(204);
    await put("someone-elses", build({ forkedFrom: FORKED_FROM }), "another-account").expect(200);

    const res = await list({ forkedFrom: FORKED_FROM.communitySlug, limit: "1", view: "summary" }).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items.map((item) => item.slug)).toEqual(["glaives-copy"]);

    const none = await list({ forkedFrom: "never-saved" }).expect(200);
    expect(none.body).toEqual(expect.objectContaining({ items: [], total: 0 }));
  });

  test("rejects a malformed forkedFrom filter", async () => {
    const res = await list({ forkedFrom: "../escape" }).expect(400);
    expect(res.body.error.code).toBe("invalid_custom_build_page");
  });
});
