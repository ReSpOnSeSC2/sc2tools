// @ts-nocheck
"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const express = require("express");
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { buildCommunityQuickSearchRouter } = require("../src/routes/communityQuickSearch");
const { COMMUNITY_SEARCH_COMMENT } = require("../src/middleware/searchQueryPrivacy");

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const build = (slug, title, votes, extra = {}) => ({
  slug, title, votes, description: "Stargate in the description only", authorName: "Fixture author", ownerUserId: "owner",
  matchup: "PvZ", removed: false, publishedAt: new Date(Date.UTC(2026, 0, 1 + votes)), build: { race: "Protoss", vsRace: "Zerg", rules: [] },
  ...extra,
});
beforeAll(async () => {
  h = await createHarness();
  await h.db.communityBuilds.insertMany([
    build("build-a1", "PvZ - Stargate Opener", 9),
    build("build-a2", "Stargate into Carriers", 12, { matchup: "PvAny" }),
    build("build-a3", "Gatestargate fake", 30),
    build("build-a4", "Roach push", 3, { authorName: "StarGazer" }),
    build("build-a5", "Stargate removed", 99, { removed: true }),
    build("old.slug", "Stargate legacy dotted slug", 50),
    build("build-a6", "\u0007\u0007", 40, { authorName: "Stargate author" }),
    build("build-a7", "Stargate\u0001Phoenix", 1, { authorName: "  " }),
    build("build-a8", "1+1 Stargate", 2),
    build("build-b1", "Протосс через врата", 500),
    build("build-b2", "Тосс ранний", 5),
    build("build-b3", "Überfall Zerg", 7),
  ]);
}, 60_000);
afterAll(async () => { if (h) await h.close(); });

const quick = (query) => request(h.app).get("/v1/community/builds").query({ view: "quick", ...query });

test("matches a word start of the title or author, most votes first, with slim rows only", async () => {
  const res = await quick({ q: "star" }).expect(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body).toEqual({
    version: 1,
    items: [
      { slug: "old.slug", title: "Stargate legacy dotted slug", matchup: "PvZ", authorName: "Fixture author", votes: 50 },
      { slug: "build-a2", title: "Stargate into Carriers", matchup: null, authorName: "Fixture author", votes: 12 },
      { slug: "build-a1", title: "PvZ - Stargate Opener", matchup: "PvZ", authorName: "Fixture author", votes: 9 },
      { slug: "build-a4", title: "Roach push", matchup: "PvZ", authorName: "StarGazer", votes: 3 },
      { slug: "build-a8", title: "1+1 Stargate", matchup: "PvZ", authorName: "Fixture author", votes: 2 },
      { slug: "build-a7", title: "Stargate Phoenix", matchup: "PvZ", authorName: null, votes: 1 },
    ],
    hasMore: false,
  });
  expect(JSON.stringify(res.body)).not.toMatch(/description|ownerUserId|build-a3|build-a5|build-a6/);
});

test("treats the query literally and keeps the limit with hasMore", async () => {
  expect((await quick({ q: "1+1" }).expect(200)).body.items.map(item => item.slug)).toEqual(["build-a8"]);
  expect((await quick({ q: ".*" }).expect(200)).body.items).toEqual([]);
  const page = await quick({ q: "stargate", limit: "2" }).expect(200);
  expect(page.body.items.map(item => item.slug)).toEqual(["old.slug", "build-a2"]);
  expect(page.body.hasMore).toBe(true);
});

test("starts a word after any non-letter in any script, ignoring case, and survives a line separator", async () => {
  const slugs = async q => (await quick({ q }).expect(200)).body.items.map(item => item.slug);
  expect(await slugs("тосс")).toEqual(["build-b2"]);
  expect(await slugs("über")).toEqual(["build-b3"]);
  expect(await slugs("berfall")).toEqual([]);
  expect(await slugs(`Stargate${String.fromCharCode(0x2028)}Opener`)).toEqual([]);
});

test("refuses anything but view, a valid q and a 1-8 limit", async () => {
  for (const query of [{}, { q: "s" }, { q: "s".repeat(81) }, { q: "a\u0001b" }, { q: ["ab", "cd"] },
    { q: "stargate", limit: "9" }, { q: "stargate", limit: "0" }, { q: "stargate", sort: "top" }]) {
    const res = await quick(query).expect(400);
    expect(res.body).toEqual({ error: { code: "community_search_invalid_request" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  }
});

test("marks its read private and leaves the directory route unchanged", async () => {
  const aggregate = jest.spyOn(h.db.communityBuilds, "aggregate");
  await quick({ q: "stargate" }).expect(200);
  expect(aggregate.mock.calls[0][1]).toEqual({ maxTimeMS: 300, allowDiskUse: false, comment: COMMUNITY_SEARCH_COMMENT });
  aggregate.mockRestore();
  const directory = await request(h.app).get("/v1/community/builds").query({ q: "stargate", limit: "2" }).expect(200);
  expect(Object.keys(directory.body).sort()).toEqual(["hasMore", "items", "limit", "offset", "total"]);
  expect(directory.body.items[0].description).toBe("Stargate in the description only");
});

test("a failed read answers and logs fixed codes only", async () => {
  const warn = jest.fn();
  const app = express();
  app.use((req, _res, next) => { req.log = { warn }; next(); });
  app.use("/v1", buildCommunityQuickSearchRouter({
    quickSearchPublic: async () => { throw Object.assign(new Error("regex /Stargate/ failed"), { code: 2 }); },
  }));
  app.use("/v1", (_req, res) => res.status(204).end());
  const res = await request(app).get("/v1/community/builds?view=quick&q=Stargate").expect(503);
  expect(res.body).toEqual({ error: { code: "community_search_unavailable" } });
  expect(warn).toHaveBeenCalledWith({ code: "community_search_unavailable", mongoCode: 2 }, "community_quick_search_failed");
  await request(app).get("/v1/community/builds?q=Stargate").expect(204);
});

test("allows 120 quick searches a minute per address and never counts other reads", async () => {
  const app = express();
  app.use("/v1", buildCommunityQuickSearchRouter({ quickSearchPublic: async () => ({ version: 1, items: [], hasMore: false }) }));
  app.use("/v1", (_req, res) => res.status(204).end());
  for (let index = 0; index < 120; index += 1) await request(app).get("/v1/community/builds?q=zz").expect(204);
  const statuses = [];
  for (let index = 0; index < 121; index += 1) statuses.push((await request(app).get("/v1/community/builds?view=quick&q=zz")).status);
  expect(statuses.slice(0, 120).every(status => status === 200)).toBe(true);
  expect(statuses[120]).toBe(429);
  const limited = await request(app).get("/v1/community/builds?view=quick&q=zz").expect(429);
  expect(limited.body).toEqual({ error: { code: "community_search_rate_limited" } });
  expect(limited.headers["cache-control"]).toBe("no-store");
  await request(app).get("/v1/community/builds?q=zz").expect(204);
});
