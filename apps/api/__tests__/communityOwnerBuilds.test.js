"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
  h = await createHarness();
  await h.seedUser("creator"); await h.seedUser("other");
  const base = { ownerUserId: "u_creator", title: "A public build", matchup: "PvZ", votes: 5, upvotes: ["secret-voter-a", "secret-voter-b"], downvotes: ["secret-voter-c"], removed: false, authorName: "Creator", publishedAt: new Date("2026-03-01T00:00:00Z"), build: { race: "Protoss", vsRace: "Zerg", notes: "private-note", slug: "legacy-private" } };
  await h.db.communityBuilds.insertMany([
    { ...base, slug: "named-public", sourceSlug: "named-private", updatedAt: new Date("2026-10-01T00:00:00Z") },
    { ...base, slug: "anonymous-public", sourceSlug: "anon-private", authorName: "", publishAnonymously: true, updatedAt: new Date("2026-10-03T00:00:00Z") },
    { ...base, slug: "moderated-public", sourceSlug: "mod-private", removed: true, removedBy: "private-moderator-id", updatedAt: new Date("2026-10-04T00:00:00Z") },
    { ...base, slug: "unpublished-public", sourceSlug: "unpublished-private", removed: true, removedBy: "u_creator", updatedAt: new Date("2026-10-02T00:00:00Z") },
    { ...base, slug: "legacy-public", updatedAt: new Date("2026-09-01T00:00:00Z") },
    { ...base, slug: "other-public", sourceSlug: "other-private", ownerUserId: "u_other", updatedAt: new Date("2026-10-05T00:00:00Z") },
  ]);
  await h.db.games.insertMany(Array.from({ length: 12 }, (_, i) => ({ userId: "u_creator", gameId: `creator-game-${i}`, _customBuildSlug: "named-private", result: i < 8 ? "win" : "loss" })));
  await h.db.games.insertMany([
    { userId: "u_creator", gameId: "moderated-game", _customBuildSlug: "mod-private", result: "victory" },
    { userId: "u_other", gameId: "other-game", _customBuildSlug: "named-private", result: "win" },
    { userId: "u_creator", gameId: "resumed-game", _customBuildSlug: "named-private", result: "win", isResumedFromReplay: true },
    { userId: "u_creator", gameId: "declared-only-game", buildIntent: { declared: { slug: "named-private" } }, result: "win" },
  ]);
}, 60_000);
afterAll(async () => { if (h) await h.close(); });

test("my-builds requires auth and returns only the caller's bounded private allowlist", async () => {
  expect((await request(h.app).get("/v1/community/my-builds")).status).toBe(401);
  const response = await request(h.app).get("/v1/community/my-builds").set("authorization", "Bearer u:creator");
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body.items.map((/** @type {any} */ row) => row.slug)).toEqual(["moderated-public", "anonymous-public", "unpublished-public", "named-public", "legacy-public"]);
  const named = response.body.items.find((/** @type {any} */ row) => row.slug === "named-public");
  expect(named).toMatchObject({ sourceSlug: "named-private", upCount: 2, downCount: 1, votes: 5, total: 12, wins: 8, losses: 4, removed: false });
  expect(Object.keys(named).sort()).toEqual(["slug", "title", "matchup", "votes", "upCount", "downCount", "publishedAt", "updatedAt", "removed", "removedByModerator", "publishAnonymously", "sourceSlug", "total", "wins", "losses"].sort());
  expect(JSON.stringify(response.body)).not.toMatch(/secret-voter|upvotes|downvotes|private-note|private-moderator-id|other-private/);
  expect(response.body.items.find((/** @type {any} */ row) => row.slug === "anonymous-public").publishAnonymously).toBe(true);
  expect(response.body.items.find((/** @type {any} */ row) => row.slug === "legacy-public").sourceSlug).toBe("legacy-private");
});

test("keeps removed-build records but distinguishes moderator removal from owner unpublishing", async () => {
  const { body } = await request(h.app).get("/v1/community/my-builds").set("authorization", "Bearer u:creator");
  expect(body.items.find((/** @type {any} */ row) => row.slug === "moderated-public")).toMatchObject({ total: 1, wins: 1, removed: true, removedByModerator: true });
  expect(body.items.find((/** @type {any} */ row) => row.slug === "unpublished-public")).toMatchObject({ removed: true, removedByModerator: false });
  const other = await request(h.app).get("/v1/community/my-builds").set("authorization", "Bearer u:other");
  expect(other.body.items.map((/** @type {any} */ row) => row.slug)).toEqual(["other-public"]);
});

test("public list and detail still omit every private source and voter identity", async () => {
  const list = await request(h.app).get("/v1/community/builds");
  const detail = await request(h.app).get("/v1/community/builds/named-public");
  expect(list.status).toBe(200); expect(detail.status).toBe(200);
  for (const payload of [list.body, detail.body]) expect(JSON.stringify(payload)).not.toMatch(/sourceSlug|named-private|legacy-private|secret-voter|upvotes|downvotes|private-note/);
});

test("the owner list caps at 200 most recently updated rows", async () => {
  await h.seedUser("many");
  await h.db.communityBuilds.insertMany(Array.from({ length: 205 }, (_, i) => ({ slug: `many-public-${i}`, sourceSlug: `many-private-${i}`, ownerUserId: "u_many", title: "Fixture", updatedAt: new Date(2026, 0, 1, 0, 0, i), removed: false })));
  const response = await request(h.app).get("/v1/community/my-builds").set("authorization", "Bearer u:many");
  expect(response.body.items).toHaveLength(200); expect(response.body.items[0].slug).toBe("many-public-204"); expect(response.body.items.at(-1).slug).toBe("many-public-5");
});

test("the publish picker searches names literally across the whole paginated library", async () => {
  await h.db.customBuilds.insertMany([
    { userId: "u_creator", slug: "name-match", name: "Safe [macro]", race: "Protoss", updatedAt: new Date("2026-10-03T00:00:00Z") },
    { userId: "u_creator", slug: "notes-match", name: "Another opener", notes: "Safe [macro]", race: "Protoss", updatedAt: new Date("2026-10-04T00:00:00Z") },
    { userId: "u_other", slug: "other-name-match", name: "Safe [macro]", race: "Protoss" },
  ]);
  const response = await request(h.app).get("/v1/custom-builds").query({ view: "summary", nameSearch: "[macro]", sort: "updated", limit: 1 }).set("authorization", "Bearer u:creator");
  expect(response.status).toBe(200); expect(response.body.items.map((/** @type {any} */ row) => row.slug)).toEqual(["name-match"]); expect(response.body.total).toBe(1);
});
