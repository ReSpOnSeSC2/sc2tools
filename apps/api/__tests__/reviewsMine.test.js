// @ts-nocheck
"use strict";

const request = require("supertest");
const { createHarness, SECRET_NEEDLES } = require("./helpers/reviewsHarness");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
let h;
const id = (value, prefix = "R") => prefix + String(value).padStart(15, "0");
const get = (query = "", user = "owner") => request(h.app).get(`/v1/me/reviews${query}`).set("authorization", h.bearer(user));
const stamp = new Date("2026-10-20T12:00:00Z");
function row(value, patch = {}) {
  return { _id: id(value), userId: "u_owner", gameId: `private-game-${value}`, status: "open", reviewCount: 1,
    question: `How should I defend the attack in game ${value}?`, matchup: "PvZ", map: "Fixture LE", result: "Loss", durationSec: 600,
    myRace: "Protoss", askerDisplay: "anonymous", desiredLevel: "anyone", visibility: "public", createdAt: stamp, ...patch };
}
function comment(value, patch = {}) {
  return { _id: id(value, "C"), authorId: "u_owner", requestId: id(1000), parentId: null, isAskerComment: false,
    body: `Scout the third base before attacking in review ${value}.`, upvotes: value % 7, status: "visible", createdAt: stamp, ...patch };
}
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.db.reviewRequests.deleteMany({}); await h.db.reviewComments.deleteMany({}); });

test("status counts include hidden own requests, exclude removed/other owners, and preserve the bounded legacy shape", async () => {
  await h.db.reviewRequests.insertMany([row(1), row(2, { hidden: true }), row(3, { reviewCount: 0 }),
    row(4, { status: "answered", bestCommentId: id(1, "C") }), row(5, { status: "closed" }),
    row(6, { status: "removed" }), row(7, { userId: "u_other" })]);
  const response = await get();
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body.counts).toEqual({ needs: 2, waiting: 1, answered: 1, closed: 1, all: 5 });
  expect(response.body.asked.map((item) => item.id)).toEqual([5, 4, 3, 2, 1].map((value) => id(value)));
  expect(response.body.asked.find((item) => item.id === id(2))).toMatchObject({ hidden: true, isOwn: true });
  expect(response.body).toMatchObject({ answered: [], askedNextCursor: null, answeredNextCursor: null });
});

test.each([
  ["needs", [2, 1]], ["waiting", [3]], ["answered", [4]], ["closed", [5]], ["all", [5, 4, 3, 2, 1]],
])("asked tab %s uses the actual request status and review count", async (tab, expected) => {
  await h.db.reviewRequests.insertMany([row(1), row(2, { hidden: true }), row(3, { reviewCount: 0 }),
    row(4, { status: "answered" }), row(5, { status: "closed" }), row(6, { status: "removed" })]);
  const response = await get(`?section=asked&tab=${tab}`);
  expect(response.status).toBe(200);
  expect(response.body.items.map((item) => item.id)).toEqual(expected.map((value) => id(value)));
  expect(Object.keys(response.body).sort()).toEqual(["items", "nextCursor"]);
});

test("default pages are capped at twenty and equal-date asked cursors have no duplicates or missing requests", async () => {
  await h.db.reviewRequests.insertMany([...Array.from({ length: 35 }, (_, index) => row(index + 1)), row(1000, { userId: "u_other" })]);
  await h.db.reviewComments.insertMany(Array.from({ length: 35 }, (_, index) => comment(index + 1)));
  const initial = await get();
  expect(initial.body.asked).toHaveLength(20); expect(initial.body.answered).toHaveLength(20);
  expect(initial.body.askedNextCursor).toEqual(expect.any(String)); expect(initial.body.answeredNextCursor).toEqual(expect.any(String));
  const asked = await get(`?section=asked&tab=all&cursor=${initial.body.askedNextCursor}`);
  expect(asked.body.items).toHaveLength(15); expect(asked.body.nextCursor).toBeNull();
  expect([...initial.body.asked, ...asked.body.items].map((item) => item.id)).toEqual(Array.from({ length: 35 }, (_, index) => id(35 - index)));
  const answered = await get(`?section=answered&cursor=${initial.body.answeredNextCursor}`);
  expect(answered.body.items).toHaveLength(15); expect(answered.body.nextCursor).toBeNull();
  expect(new Set([...initial.body.answered, ...answered.body.items].map((item) => item.commentId)).size).toBe(35);
});

test("written Most upvoted pages use votes, creation time and id as a stable three-part cursor", async () => {
  await h.db.reviewRequests.insertOne(row(1000, { userId: "u_other" }));
  const comments = Array.from({ length: 31 }, (_, index) => comment(index + 1, { createdAt: new Date(stamp.getTime() + (index % 3) * 1000) }));
  await h.db.reviewComments.insertMany(comments);
  const expected = [...comments].sort((a, b) => b.upvotes - a.upvotes || b.createdAt - a.createdAt || b._id.localeCompare(a._id)).map((item) => item._id);
  const collected = []; let cursor = null;
  do {
    const response = await get(`?section=answered&sort=top&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
    expect(response.status).toBe(200); collected.push(...response.body.items.map((item) => item.commentId)); cursor = response.body.nextCursor;
  } while (cursor);
  expect(collected).toEqual(expected); expect(new Set(collected).size).toBe(comments.length);
  const plan = await h.db.reviewComments.find({ authorId: "u_owner", parentId: null, isAskerComment: { $ne: true }, status: { $in: ["visible", "hidden"] } })
    .sort({ upvotes: -1, createdAt: -1, _id: -1 }).limit(5).explain("executionStats");
  expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain("IXSCAN");
  expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
  expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(5);
});

test.each([["0", 1], ["-4", 1], ["51", 50], ["bad", 20], ["", 20]])("limits remain bounded for %j", async (limit, expected) => {
  await h.db.reviewRequests.insertMany(Array.from({ length: 60 }, (_, index) => row(index + 1)));
  expect((await get(`?section=asked&limit=${limit}`)).body.items).toHaveLength(expected);
});

test("invalid cursors and cursors from another tab or sort cannot change the requested view", async () => {
  await h.db.reviewRequests.insertMany([row(1), row(2), row(3, { reviewCount: 0 })]);
  const needs = await get("?section=asked&tab=needs&limit=1");
  for (const cursor of ["not-a-cursor", needs.body.nextCursor]) {
    const waiting = await get(`?section=asked&tab=waiting&cursor=${cursor}`);
    expect(waiting.body.items.map((item) => item.id)).toEqual([id(3)]);
  }
  const other = await get(`?section=asked&tab=needs&cursor=${needs.body.nextCursor}`, "other");
  expect(other.body.items).toEqual([]);
});

test("written pagination preserves hidden-parent privacy, excludes replies/removed comments and can advance an empty page", async () => {
  await h.db.reviewRequests.insertMany([row(1000, { userId: "u_other" }), row(1001, { userId: "u_other", hidden: true }), row(1002, { status: "hidden", hidden: true })]);
  await h.db.reviewComments.insertMany([comment(8, { requestId: id(1001) }), comment(7), comment(6, { requestId: id(1002) }),
    comment(5, { parentId: id(7, "C") }), comment(4, { isAskerComment: true }), comment(3, { status: "removed" }),
    comment(2, { authorId: "u_other" })]);
  const first = await get("?section=answered&limit=1");
  expect(first.body.items).toEqual([]); expect(first.body.nextCursor).toEqual(expect.any(String));
  const next = await get(`?section=answered&limit=1&cursor=${first.body.nextCursor}`);
  expect(next.body.items.map((item) => item.commentId)).toEqual([id(7, "C")]);
  const all = await get("?section=answered");
  expect(all.body.items.map((item) => item.commentId)).toEqual([id(7, "C"), id(6, "C")]);
  const json = JSON.stringify(all.body);
  for (const needle of [...SECRET_NEEDLES, "private-game", "userId", "authorId"]) expect(json).not.toContain(needle);
});

test("signed-out readers cannot read the dashboard or section endpoints", async () => {
  for (const path of ["/v1/me/reviews", "/v1/me/reviews?section=asked&tab=needs", "/v1/me/reviews?section=answered&sort=top"]) {
    expect((await request(h.app).get(path)).status).toBe(401);
  }
});

test("reviewer profile explains missing verification and the twenty-game eligibility gate", async () => {
  const response = await request(h.app).get("/v1/me/reviewer").set("authorization", h.bearer("owner"));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ verified: null, verificationReason: "not_enough_ladder_games", syncedGames: 0, requiredGames: 20, canComment: false });
  const indexes = await h.db.reviewComments.indexes();
  expect(indexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ authorId: 1, upvotes: -1, createdAt: -1, _id: -1 }))).toBe(true);
});
