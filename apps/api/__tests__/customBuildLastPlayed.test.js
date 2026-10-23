// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const express = require("express");
const request = require("supertest");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");
const USER = "last-played-owner";
const slugAt = (index) => `build-${String(index).padStart(3, "0")}`;
let mongo, client, builds, games, service, app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = new MongoClient(mongo.getUri()); await client.connect();
  const db = client.db("custom_build_last_played"); builds = db.collection("custom_builds"); games = db.collection("games");
  service = new CustomBuildsService({ games, customBuilds: builds, customBuildJobs: db.collection("custom_build_jobs") });
  app = express(); app.use(express.json());
  app.use("/v1", buildCustomBuildsRouter({ customBuilds: service, auth: (req, _res, next) => { req.auth = { userId: USER }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code } }));
});
beforeEach(async () => {
  await builds.deleteMany({}); await games.deleteMany({});
  await builds.insertMany(Array.from({ length: 17 }, (_, index) => ({ userId: USER, slug: slugAt(index), name: `Build ${index}`, race: "Terran", perspective: "you", updatedAt: new Date("2026-09-01") })));
});
afterAll(async () => { await service?.stopReclassifications(); await client?.close(); await mongo?.stop(); });
async function page(query) {
  const result = await request(app).get("/v1/custom-builds").query({ sort: "lastPlayed", ...query });
  expect(result.status).toBe(200); return result.body;
}

test("last played orders authoritative perspective across numeric cursors and excludes resumed/other-owner games", async () => {
  await builds.updateOne({ userId: USER, slug: slugAt(16) }, { $set: { perspective: "opponent" } });
  await games.insertMany([
    { userId: USER, gameId: "old", date: new Date("2026-08-01"), _customBuildSlug: slugAt(15) },
    { userId: USER, gameId: "new", date: "2026-10-22T00:00:00Z", _customOpponentStrategySlug: slugAt(16) },
    { userId: USER, gameId: "wrong-side", date: new Date("2027-01-01"), _customBuildSlug: slugAt(16), _customOpponentStrategySlug: slugAt(14) },
    { userId: USER, gameId: "resume", date: new Date("2027-01-01"), _customBuildSlug: slugAt(13), isResumedFromReplay: true },
    { userId: "other-account", gameId: "other", date: new Date("2027-01-01"), _customBuildSlug: slugAt(12) },
  ]);
  const first = await page({ limit: 1 }); expect(first.items.map((row) => row.slug)).toEqual([slugAt(16)]);
  expect(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8")).order).toBe(Date.parse("2026-10-22T00:00:00Z"));
  const second = await page({ limit: 1, cursor: first.nextCursor }); expect(second.items.map((row) => row.slug)).toEqual([slugAt(15)]);
  const third = await page({ limit: 1, cursor: second.nextCursor }); expect(third.items.map((row) => row.slug)).toEqual([slugAt(0)]);
  expect(JSON.parse(Buffer.from(third.nextCursor, "base64url").toString("utf8")).order).toBe(0);
});

test("walks ties and never-played builds exactly once, and rejects invalid sorts/cursor scopes", async () => {
  await games.insertMany(Array.from({ length: 15 }, (_, index) => ({ userId: USER, gameId: `tied-${index}`, date: new Date("2026-10-20"), _customBuildSlug: slugAt(index) })));
  const ids = []; let cursor; let pages = 0;
  do { const result = await page({ limit: 4, ...(cursor ? { cursor } : {}) }); ids.push(...result.items.map((row) => row.slug)); cursor = result.nextCursor; expect(++pages).toBeLessThan(10); } while (cursor);
  expect(ids).toEqual(Array.from({ length: 17 }, (_, index) => slugAt(index)));
  const first = await page({ limit: 4 });
  expect((await request(app).get("/v1/custom-builds").query({ sort: "wrong" })).status).toBe(400);
  expect((await request(app).get("/v1/custom-builds").query({ sort: "games", limit: 4, cursor: first.nextCursor })).status).toBe(400);
});
