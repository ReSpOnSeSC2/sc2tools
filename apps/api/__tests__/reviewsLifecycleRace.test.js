// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

let h;
let reviewId;
let a;
let b;
const viewer = (name) => ({ userId: h.userId(name), source: "clerk", isAdmin: false });

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  if (h) await h.close();
});
afterEach(() => jest.restoreAllMocks());

beforeEach(async () => {
  await Promise.all([
    h.db.reviewRequests.deleteMany({}), h.db.reviewComments.deleteMany({}),
    h.db.reviewKarmaEvents.deleteMany({}), h.db.notifications.deleteMany({}),
    h.db.users.deleteMany({}), h.db.games.deleteMany({}), h.db.gameDetails.deleteMany({}),
  ]);
  await h.seedUser("asker", { displayName: "BlinkMaster" });
  await h.seedUser("ra", { displayName: "ReviewerA" });
  await h.seedUser("rb", { displayName: "ReviewerB" });
  await h.seedUser("voter");
  await h.seedLadderHistory("ra", { mmr: 4800 });
  await h.seedLadderHistory("rb", { mmr: 4000 });
  const gameId = await h.seedGame("asker");
  reviewId = (await h.services.reviews.create(h.userId("asker"), { gameId, question: QUESTION })).id;
  a = (await h.services.reviews.addComment(reviewId, viewer("ra"), {
    body: "Scout at 4:30 and hold the blink.", gameTimeSec: 270,
  })).id;
  b = (await h.services.reviews.addComment(reviewId, viewer("rb"), {
    body: "Your probe count stalled at 5:00.", gameTimeSec: 300,
  })).id;
  await h.services.reviews.setBest(reviewId, a, viewer("asker"), true);
});

// Interleave at the actual Mongo write boundary, after the service has read
// the old request. There are no timers, scheduler assumptions, or mock DBs.
function stopBeforeWrite(matches, terminal) {
  let stopped = false;
  const original = h.db.reviewRequests.updateOne.bind(h.db.reviewRequests);
  jest.spyOn(h.db.reviewRequests, "updateOne").mockImplementation(async (...args) => {
    const [filter, update] = args;
    const set = Array.isArray(update) ? update[0]?.$set : update?.$set;
    if (!stopped && filter._id === reviewId && matches(set)) {
      stopped = true;
      if (terminal === "closed") await h.services.reviews.close(reviewId, viewer("asker"));
      else if (terminal === "removed") await h.services.reviews.moderationTargets().review_request.remove(reviewId);
      else await h.services.reviews.moderationTargets().review_request.onReported(reviewId, 3);
    }
    return original(...args);
  });
  return () => expect(stopped).toBe(true);
}

async function assertTerminal(terminal, bestCommentId) {
  const doc = await h.db.reviewRequests.findOne({ _id: reviewId });
  expect(doc).toMatchObject({ status: terminal, bestCommentId, listed: false, indexable: false });
  expect(doc.activeKey).toBeUndefined();
  const analysis = await request(h.app).get(`/v1/reviews/${reviewId}/analysis`);
  expect(analysis.status).toBe(terminal === "closed" ? 410 : 404);
  expect(analysis.headers["cache-control"]).toContain("no-store");
}

test.each([
  ["selecting another best answer", true, "closed"],
  ["clearing the best answer", false, "closed"],
  ["selecting another best answer", true, "removed"],
  ["clearing the best answer", false, "removed"],
])("%s (value=%s) cannot undo a concurrent %s transition", async (_label, value, terminal) => {
  const assertStopped = stopBeforeWrite((set) => set?.status === (value ? "answered" : "open"), terminal);
  await expect(h.services.reviews.setBest(reviewId, value ? b : a, viewer("asker"), value))
    .rejects.toMatchObject({ status: 409, code: "conflict" });
  assertStopped();
  await assertTerminal(terminal, a);
  expect(await h.db.reviewKarmaEvents.countDocuments({ requestId: reviewId, kind: "best" })).toBe(1);
  expect(await h.db.reviewComments.findOne({ _id: a })).toMatchObject({ best: true });
  expect(await h.db.reviewComments.findOne({ _id: b })).toMatchObject({ best: false });
  expect((await h.db.users.findOne({ userId: h.userId("ra") })).reviewer).toMatchObject({ karma: 15, best: 1 });
  expect((await h.db.users.findOne({ userId: h.userId("rb") })).reviewer.karma || 0).toBe(0);
});

test.each([
  ["deleting", "closed"], ["moderating", "closed"],
  ["deleting", "removed"], ["moderating", "removed"],
])("%s the best comment preserves a concurrent %s transition and revokes its karma", async (action, terminal) => {
  await h.services.reviews.setHelpful(reviewId, a, viewer("asker"), true);
  await h.services.reviews.setUpvote(reviewId, a, viewer("voter"), true);
  const assertStopped = stopBeforeWrite((set) => set?.bestCommentId === null, terminal);
  if (action === "deleting") await h.services.reviews.deleteComment(reviewId, a, viewer("ra"));
  else await h.services.reviews.moderationTargets().review_comment.remove(a, "u_admin");
  assertStopped();
  await assertTerminal(terminal, null);
  expect(await h.db.reviewKarmaEvents.countDocuments({ commentId: a, kind: { $in: ["helpful", "best", "upvote"] } })).toBe(0);
  expect(await h.db.reviewComments.findOne({ _id: a })).toMatchObject({
    status: action === "deleting" ? "deleted" : "removed", best: false, helpful: false, upvoteKarma: 0,
  });
  const stats = (await h.db.users.findOne({ userId: h.userId("ra") })).reviewer;
  expect(stats).toMatchObject({ karma: action === "deleting" ? 0 : -20, best: 0, helpful: 0, upvotes: 0, reviews: 0 });
});

test("removing an active best comment still clears its pointer and returns an answered request to open", async () => {
  await h.services.reviews.deleteComment(reviewId, a, viewer("ra"));
  const doc = await h.db.reviewRequests.findOne({ _id: reviewId });
  expect(doc).toMatchObject({ status: "open", bestCommentId: null, listed: true });
  expect(doc.activeKey).toEqual(expect.any(String));
  expect(await h.db.reviewKarmaEvents.countDocuments({ commentId: a, kind: "best" })).toBe(0);
  await request(h.app).get(`/v1/reviews/${reviewId}/analysis`).expect(200);
});

test.each(["closed", "removed", "hidden"])("a pending ranking refresh cannot relist or reindex a newly %s request", async (terminal) => {
  expect(await h.db.reviewRequests.findOne({ _id: reviewId })).toMatchObject({ listed: true, indexable: true });
  const assertStopped = stopBeforeWrite((set) => set?.listed === true, terminal);
  await h.services.reviews._refresh(reviewId, { activity: true });
  assertStopped();
  const doc = await h.db.reviewRequests.findOne({ _id: reviewId });
  expect(doc).toMatchObject({ listed: false, indexable: false, bestCommentId: a });
  if (terminal === "hidden") {
    expect(doc).toMatchObject({ status: "answered", hidden: true });
    expect(doc.activeKey).toEqual(expect.any(String));
  } else {
    expect(doc.status).toBe(terminal);
    expect(doc.activeKey).toBeUndefined();
  }
  const board = await request(h.app).get("/v1/reviews?sort=new").expect(200);
  expect(board.body.items.map((item) => item.id)).not.toContain(reviewId);
  const sitemap = await request(h.app).get("/v1/reviews/sitemap").expect(200);
  expect(sitemap.body.items.map((item) => item.id)).not.toContain(reviewId);
  const page = await request(h.app).get(`/v1/reviews/${reviewId}`);
  expect(page.status).toBe(terminal === "closed" ? 200 : 404);
  if (terminal === "closed") expect(page.body.seo.indexable).toBe(false);
  const analysis = await request(h.app).get(`/v1/reviews/${reviewId}/analysis`);
  expect(analysis.status).toBe(terminal === "closed" ? 410 : 404);
});
