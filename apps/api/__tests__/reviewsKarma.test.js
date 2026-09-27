// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: helpful / best / upvote and karma", () => {
  let h;
  let reviewId;
  let a; // reviewer A's comment
  let b; // reviewer B's comment

  const post = (path, name, body = {}) =>
    request(h.app).post(`/v1/reviews/${reviewId}${path}`).set("authorization", h.bearer(name)).send(body);
  const stats = async (name) => (await h.db.users.findOne({ userId: h.userId(name) })).reviewer;

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("ra", { displayName: "ReviewerA" });
    await h.seedUser("rb", { displayName: "ReviewerB" });
    await h.seedLadderHistory("ra", { mmr: 4800 });
    await h.seedLadderHistory("rb", { mmr: 4000 });
    for (let i = 0; i < 12; i += 1) await h.seedUser(`voter${i}`);
    const gameId = await h.seedGame("asker");
    reviewId = (await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker")).send({ gameId, question: QUESTION })).body.id;
    a = (await post("/comments", "ra", { body: "Scout at 4:30 and hold the blink.", gameTimeSec: 270 })).body.id;
    b = (await post("/comments", "rb", { body: "Your probe count stalled at 5:00.", gameTimeSec: 300 })).body.id;
  });
  afterAll(async () => {
    await h.close();
  });

  test("first review earns the First Review badge", async () => {
    const me = await request(h.app).get("/v1/me/reviewer").set("authorization", h.bearer("ra"));
    expect(me.body.stats.reviews).toBe(1);
    expect(me.body.badges.map((x) => x.key)).toContain("first_review");
    expect(me.body.verified.band.label).toBe("Master");
  });

  test("helpful is asker-only, idempotent, +5, and reversible", async () => {
    expect((await post(`/comments/${a}/helpful`, "rb")).status).toBe(403);
    expect((await post(`/comments/${a}/helpful`, "asker")).status).toBe(200);
    expect((await post(`/comments/${a}/helpful`, "asker")).status).toBe(200);
    expect((await stats("ra")).karma).toBe(5);
    expect((await stats("ra")).helpful).toBe(1);
    expect(await h.db.reviewKarmaEvents.countDocuments({ commentId: a, kind: "helpful" })).toBe(1);
    await post(`/comments/${a}/helpful`, "asker", { value: false });
    expect((await stats("ra")).karma).toBe(0);
    await post(`/comments/${a}/helpful`, "asker");
    expect((await stats("ra")).karma).toBe(5);
    const notes = await request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("ra"));
    expect(notes.body.items.some((n) => n.kind === "review.helpful")).toBe(true);
  });

  test("best is one per request: +15, moving it transfers the karma and sets answered", async () => {
    expect((await post(`/comments/${a}/best`, "asker")).status).toBe(200);
    expect((await post(`/comments/${a}/best`, "asker")).status).toBe(200);
    expect((await stats("ra")).karma).toBe(20);
    let doc = await h.db.reviewRequests.findOne({ _id: reviewId });
    expect(doc.status).toBe("answered");
    expect(doc.bestCommentId).toBe(a);
    await post(`/comments/${b}/best`, "asker");
    expect((await stats("ra")).karma).toBe(5);
    expect((await stats("rb")).karma).toBe(15);
    expect((await stats("rb")).best).toBe(1);
    doc = await h.db.reviewRequests.findOne({ _id: reviewId });
    expect(doc.bestCommentId).toBe(b);
    const page = await request(h.app).get(`/v1/reviews/${reviewId}`);
    expect(page.body.comments.find((c) => c.id === a).best).toBe(false);
    expect(page.body.comments.find((c) => c.id === b).best).toBe(true);
  });

  test("upvotes: idempotent, no self-votes, +1 each but at most +10 per comment", async () => {
    expect((await post(`/comments/${a}/upvote`, "ra")).status).toBe(400);
    const before = (await stats("ra")).karma;
    for (let i = 0; i < 12; i += 1) {
      await post(`/comments/${a}/upvote`, `voter${i}`);
      await post(`/comments/${a}/upvote`, `voter${i}`);
    }
    const comment = await h.db.reviewComments.findOne({ _id: a });
    expect(comment.upvotes).toBe(12);
    expect(comment.upvoteKarma).toBe(10);
    expect((await stats("ra")).karma).toBe(before + 10);
    // Withdrawing a karma-bearing vote frees a slot for a later voter.
    await post(`/comments/${a}/upvote`, "voter0", { value: false });
    expect((await stats("ra")).karma).toBe(before + 9);
    await post(`/comments/${a}/upvote`, "voter0");
    expect((await stats("ra")).karma).toBe(before + 10);
    const page = await request(h.app).get(`/v1/reviews/${reviewId}`).set("authorization", h.bearer("voter3"));
    expect(page.body.comments.find((c) => c.id === a)).toMatchObject({ upvotes: 12, upvoted: true });
  });

  test("materialised totals match a full ledger recompute", async () => {
    const live = await stats("ra");
    const recomputed = await h.services.reviewerReputation.recomputeStats(h.userId("ra"));
    expect(recomputed.karma).toBe(live.karma);
    expect(recomputed.helpful).toBe(live.helpful);
    expect(recomputed.best).toBe(live.best);
    expect(recomputed.upvotes).toBe(live.upvotes);
    expect(recomputed.reviews).toBe(live.reviews);
  });

  test("weekly leaderboard lists opted-in reviewers only", async () => {
    let board = await request(h.app).get("/v1/reviews/leaderboard");
    expect(board.body.items).toEqual([]);
    await request(h.app).patch("/v1/me/reviewer").set("authorization", h.bearer("rb")).send({ leaderboardOptIn: true }).expect(200);
    board = await request(h.app).get("/v1/reviews/leaderboard");
    expect(board.body.items.map((i) => i.name)).toEqual(["ReviewerB"]);
    expect(board.body.items[0].points).toBe(15);
    expect(board.headers["cache-control"]).toContain("s-maxage=60");
  });

  test("badge thresholds and verified flair", () => {
    const { badgesFor, flairFor } = require("../src/services/reviewerReputation");
    const stats50 = { karma: 300, helpful: 50, best: 10, upvotes: 0, reviews: 60, removed: 0 };
    expect(badgesFor(stats50).map((x) => x.key)).toEqual(["first_review", "helpful_10", "mentor", "best_10"]);
    expect(flairFor(stats50, { band: { id: 5, label: "Master" } })).toBe("Masters Mentor");
    expect(flairFor(stats50, null)).toBe("Mentor");
    expect(flairFor({ ...stats50, helpful: 3 }, { band: { id: 4, label: "Diamond" } })).toBe("Diamond Top Reviewer");
  });
});
