"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const rows = [
  { slug: "pvt-diamond", race: "Protoss", vsRace: "Terran", skillLevel: "diamond", title: "Safe opener", votes: 10, day: 1, updated: 1 },
  { slug: "pvany-diamond", race: "Protoss", vsRace: "Any", skillLevel: "diamond", title: "Roach safe macro", votes: 2, day: 2, updated: 3 },
  { slug: "pvz-null", race: "Protoss", vsRace: "Zerg", skillLevel: null, title: "Roach scouts", votes: 4, day: 3, updated: 2 },
  { slug: "zvt-diamond", race: "Zerg", vsRace: "Terran", skillLevel: "diamond", title: "Roach rush", votes: 0, day: 4, updated: 3 },
  { slug: "tvz-gold", race: "Terran", vsRace: "Zerg", skillLevel: "gold", title: "Marine push", votes: 1, day: 5, updated: 0 },
];
beforeAll(async () => {
  h = await createHarness();
  await h.db.communityBuilds.insertMany(rows.map((row) => ({
    slug: row.slug, title: row.title, description: "A public build", authorName: "Fixture author", ownerUserId: "fixture-owner",
    matchup: row.race[0] + "v" + (row.vsRace === "Any" ? "Any" : row.vsRace[0]),
    votes: row.votes, upvotes: ["up-a", "up-b"], downvotes: ["down-a", "down-b"], removed: false, publishedAt: new Date(`2026-01-0${row.day}T00:00:00Z`), updatedAt: new Date(`2026-10-0${row.updated + 1}T00:00:00Z`),
    build: { race: row.race, vsRace: row.vsRace, skillLevel: row.skillLevel, rules: [] },
  })));
  await h.db.communityBuilds.insertOne({ slug: "removed", title: "Roach hidden", removed: true, votes: 999, build: { race: "Protoss", vsRace: "Terran", skillLevel: "diamond" } });
}, 60_000);
afterAll(async () => { if (h) await h.close(); });

/** @param {Record<string, string>} query */
async function list(query) {
  const response = await request(h.app).get("/v1/community/builds").query(query);
  expect(response.status).toBe(200);
  return response.body;
}
/** @param {{items: Array<{slug: string}>}} body */
const slugs = (body) => body.items.map((item) => item.slug);

test("race accepts codes and full names, excluding other races and removed builds", async () => {
  expect(slugs(await list({ race: "P" })).sort()).toEqual(["pvany-diamond", "pvt-diamond", "pvz-null"]);
  expect(slugs(await list({ race: "Zerg" }))).toEqual(["zvt-diamond"]);
});

test("opponent race includes Any and combines with own race, skill and literal search", async () => {
  expect(slugs(await list({ vsRace: "T" })).sort()).toEqual(["pvany-diamond", "pvt-diamond", "zvt-diamond"]);
  expect(slugs(await list({ race: "Protoss", vsRace: "Terran", skill: "diamond", q: "roach" }))).toEqual(["pvany-diamond"]);
  expect(slugs(await list({ race: "P", vsRace: "T", q: ".*" }))).toEqual([]);
});

test("skill excludes unlabelled builds only when it is set and invalid values are ignored", async () => {
  expect(slugs(await list({ race: "P", skill: "diamond" })).sort()).toEqual(["pvany-diamond", "pvt-diamond"]);
  expect((await list({ race: "P" })).total).toBe(3);
  /** @type {Array<Record<string, string>>} */
  const invalid = [{ race: "Random" }, { vsRace: "Any" }, { skill: "professional" }, { race: ".*", vsRace: "P|T", skill: "<gold>" }];
  for (const query of invalid) {
    expect((await list(query)).total).toBe(5);
  }
});

test("Recently updated sorts by update then publication, with honest counts and pagination", async () => {
  const page = await list({ sort: "updated", limit: "2", offset: "0" });
  expect(slugs(page)).toEqual(["zvt-diamond", "pvany-diamond"]); expect(page.total).toBe(5); expect(page.hasMore).toBe(true);
  expect(slugs(await list({ sort: "updated", limit: "2", offset: "2" }))).toEqual(["pvz-null", "pvt-diamond"]);
});

test("legacy matchup remains exact and combines with the new filters", async () => {
  expect(slugs(await list({ matchup: "PvT" }))).toEqual(["pvt-diamond"]);
  expect(slugs(await list({ matchup: "PvT", race: "Z" }))).toEqual([]);
});

test("controversial aggregation keeps all filters and its vote identities private", async () => {
  const body = await list({ race: "P", vsRace: "T", skill: "diamond", q: "roach", sort: "controversial" });
  expect(slugs(body)).toEqual(["pvany-diamond"]); expect(body.total).toBe(1);
  expect(JSON.stringify(body)).not.toMatch(/up-a|down-a|upvotes|downvotes|controversy/);
});

test("the requested race, skill and update indexes exist", async () => {
  const indexes = await h.db.communityBuilds.indexes();
  const keys = indexes.map((index) => index.key);
  expect(keys).toContainEqual({ removed: 1, "build.race": 1, "build.vsRace": 1, votes: -1 });
  expect(keys).toContainEqual({ removed: 1, "build.skillLevel": 1, votes: -1 });
  expect(keys).toContainEqual({ removed: 1, updatedAt: -1 });
});
