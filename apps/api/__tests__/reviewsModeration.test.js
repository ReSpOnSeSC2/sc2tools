// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: report → moderation queue → auto-hide, and blocks", () => {
  let h;
  let reviewId;

  const post = (path, name, body = {}) =>
    request(h.app).post(`/v1/reviews/${reviewId}${path}`).set("authorization", h.bearer(name)).send(body);
  const pageAs = (name) => {
    const req = request(h.app).get(`/v1/reviews/${reviewId}`);
    return name ? req.set("authorization", h.bearer(name)) : req;
  };

  beforeAll(async () => {
    h = await createHarness({ admins: ["mod"] });
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("troll", { displayName: "TrollFace" });
    await h.seedUser("good", { displayName: "GoodReviewer" });
    await h.seedUser("mod");
    await h.seedLadderHistory("troll", { mmr: 4700 });
    await h.seedLadderHistory("good", { mmr: 4700 });
    for (const name of ["r1", "r2", "r3"]) await h.seedUser(name);
    const gameId = await h.seedGame("asker");
    reviewId = (await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker")).send({ gameId, question: QUESTION })).body.id;
  });
  afterAll(async () => {
    await h.close();
  });

  test("reports land in the shared community queue with a target summary", async () => {
    const c = (await post("/comments", "troll", { body: "This is spammy nonsense content.", gameTimeSec: 5 })).body.id;
    const first = await post(`/comments/${c}/report`, "r1", { reason: "spam" });
    expect(first.status).toBe(202);
    expect(first.body.alreadyReported).toBe(false);
    const again = await post(`/comments/${c}/report`, "r1", { reason: "spam" });
    expect(again.body.alreadyReported).toBe(true);
    expect((await post(`/comments/${c}/report`, "troll", { reason: "spam" })).status).toBe(400);
    const queue = await request(h.app).get("/v1/community/admin/reports").set("authorization", h.bearer("mod"));
    expect(queue.status).toBe(200);
    const item = queue.body.items.find((r) => r.targetId === c);
    expect(item.targetType).toBe("review_comment");
    expect(item.target).toMatchObject({ href: `/reviews/${reviewId}#comment-${c}`, hidden: false });
    expect(item.target.snippet).toContain("spammy");
  });

  test("auto-hide after 3 distinct reporters; dismiss restores and settles every report", async () => {
    const c = (await post("/comments", "troll", { body: "Another low-effort troll comment.", gameTimeSec: 6 })).body.id;
    await post(`/comments/${c}/report`, "r1", { reason: "abuse" });
    await post(`/comments/${c}/report`, "r2", { reason: "abuse" });
    expect((await h.db.reviewComments.findOne({ _id: c })).status).toBe("visible");
    await post(`/comments/${c}/report`, "r3", { reason: "abuse" });
    expect((await h.db.reviewComments.findOne({ _id: c })).status).toBe("hidden");
    expect((await pageAs(null)).body.comments.some((x) => x.id === c)).toBe(false);
    const authorView = (await pageAs("troll")).body.comments.find((x) => x.id === c);
    expect(authorView.state).toBe("hidden");
    expect(authorView.body).toContain("troll comment");
    const adminView = (await pageAs("mod")).body.comments.find((x) => x.id === c);
    expect(adminView.state).toBe("hidden");

    const queue = await request(h.app).get("/v1/community/admin/reports").set("authorization", h.bearer("mod"));
    const reportId = queue.body.items.find((r) => r.targetId === c).id;
    await request(h.app).post(`/v1/community/admin/reports/${reportId}`).set("authorization", h.bearer("mod")).send({ action: "dismiss" }).expect(204);
    expect((await h.db.reviewComments.findOne({ _id: c })).status).toBe("visible");
    expect(await h.db.communityReports.countDocuments({ targetId: c, resolvedAt: null })).toBe(0);
  });

  test("moderator removal: gone from the page, earned karma revoked, −20 once", async () => {
    const c = (await post("/comments", "troll", { body: "A comment that earns karma first.", gameTimeSec: 7 })).body.id;
    await post(`/comments/${c}/helpful`, "asker");
    expect((await h.db.users.findOne({ userId: h.userId("troll") })).reviewer.karma).toBe(5);
    await post(`/comments/${c}/report`, "r1", { reason: "abuse" });
    const reportId = (await h.db.communityReports.findOne({ targetId: c })).id;
    await request(h.app).post(`/v1/community/admin/reports/${reportId}`).set("authorization", h.bearer("mod")).send({ action: "remove" }).expect(204);
    // A second removal attempt must not stack the penalty.
    await h.services.reviews.moderationTargets().review_comment.remove(c, h.userId("mod"), "");
    const troll = (await h.db.users.findOne({ userId: h.userId("troll") })).reviewer;
    expect(troll.karma).toBe(-20);
    expect(troll.removed).toBe(1);
    expect((await h.db.reviewComments.findOne({ _id: c })).status).toBe("removed");
    expect((await pageAs(null)).body.comments.some((x) => x.id === c)).toBe(false);
    expect((await h.db.reviewRequests.findOne({ _id: reviewId })).helpfulCount).toBe(0);
  });

  test("reporting a request auto-hides it from everyone but the asker and admins", async () => {
    for (const name of ["r1", "r2", "r3"]) {
      expect((await post("/report", name, { reason: "inappropriate question" })).status).toBe(202);
    }
    expect((await pageAs(null)).status).toBe(404);
    expect((await pageAs("asker")).body.request.hidden).toBe(true);
    expect((await pageAs("mod")).status).toBe(200);
    expect((await request(h.app).get(`/v1/reviews/${reviewId}/analysis`)).status).toBe(404);
    const board = await request(h.app).get("/v1/reviews");
    expect(board.body.items.some((x) => x.id === reviewId)).toBe(false);
    const reportId = (await h.db.communityReports.findOne({ targetId: reviewId, resolvedAt: null })).id;
    await request(h.app).post(`/v1/community/admin/reports/${reportId}`).set("authorization", h.bearer("mod")).send({ action: "dismiss" }).expect(204);
    expect((await pageAs(null)).status).toBe(200);
  });

  test("block: the blocker stops seeing them and they can't comment on the blocker's requests", async () => {
    const c = (await post("/comments", "good", { body: "Solid advice that later annoys the asker.", gameTimeSec: 9 })).body.id;
    await post("/comments", "good", { body: "Replying under my own thread here.", gameTimeSec: 10, parentId: c });
    expect((await post(`/comments/${c}/block`, "asker")).status).toBe(200);
    expect((await post(`/comments/${c}/block`, "asker")).status).toBe(200);
    const blockerView = (await pageAs("asker")).body.comments;
    expect(blockerView.find((x) => x.id === c)).toMatchObject({ state: "blocked", body: "", author: null });
    expect((await pageAs(null)).body.comments.find((x) => x.id === c).state).toBe("visible");
    const denied = await post("/comments", "good", { body: "Trying to comment after being blocked.", gameTimeSec: 11 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("review_blocked");
    expect((await pageAs("good")).body.viewer).toMatchObject({ canComment: false, reason: "blocked" });

    const list = await request(h.app).get("/v1/me/review-blocks").set("authorization", h.bearer("asker"));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe("GoodReviewer");
    expect(JSON.stringify(list.body)).not.toContain(h.userId("good"));
    await request(h.app).delete(`/v1/me/review-blocks/${list.body.items[0].id}`).set("authorization", h.bearer("asker")).expect(200);
    expect((await post("/comments", "good", { body: "Unblocked now, commenting again.", gameTimeSec: 12 })).status).toBe(201);
  });
});
