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

  test("dismissed reporters can't re-hide; the community route refuses review targets", async () => {
    const c = (await post("/comments", "troll", { body: "A borderline comment that gets dismissed.", gameTimeSec: 8 })).body.id;
    for (const name of ["r1", "r2", "r3"]) await post(`/comments/${c}/report`, name, { reason: "abuse" });
    expect((await h.db.reviewComments.findOne({ _id: c })).status).toBe("hidden");
    const reportId = (await h.db.communityReports.findOne({ targetId: c, resolvedAt: null })).id;
    await request(h.app).post(`/v1/community/admin/reports/${reportId}`).set("authorization", h.bearer("mod")).send({ action: "dismiss" }).expect(204);
    for (const name of ["r1", "r2", "r3"]) {
      expect((await post(`/comments/${c}/report`, name, { reason: "abuse" })).body).toMatchObject({ alreadyReported: true });
    }
    expect((await h.db.reviewComments.findOne({ _id: c })).status).toBe("visible");
    // Review targets only enter the queue through the review API (rollout,
    // visibility and own-content checks), never the generic route.
    const generic = await request(h.app)
      .post("/v1/community/reports")
      .set("authorization", h.bearer("r1"))
      .send({ targetType: "review_comment", targetId: c, reason: "abuse" });
    expect(generic.status).toBe(400);
  });

  test("a moderator removing a hidden review still drops the author's review count", async () => {
    const before = (await h.db.users.findOne({ userId: h.userId("good") }))?.reviewer?.reviews || 0;
    const c = (await post("/comments", "good", { body: "A review that gets hidden and removed.", gameTimeSec: 13 })).body.id;
    await h.db.reviewComments.updateOne({ _id: c }, { $set: { status: "hidden" } });
    await h.services.reviews.moderationTargets().review_comment.remove(c, h.userId("mod"), "");
    expect((await h.db.users.findOne({ userId: h.userId("good") })).reviewer.reviews).toBe(before);
  });

  test("named request: a block refuses the blocked reviewer; replies to a blocker are refused too", async () => {
    const gameId = await h.seedGame("asker", { gameId: "named-block-game" });
    const named = (await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker"))
      .send({ gameId, question: QUESTION, askerDisplay: "named" })).body.id;
    const onNamed = (path, name, body = {}) =>
      request(h.app).post(`/v1/reviews/${named}${path}`).set("authorization", h.bearer(name)).send(body);
    const c = (await onNamed("/comments", "good", { body: "Solid advice that later annoys the asker.", gameTimeSec: 9 })).body.id;
    await onNamed("/comments", "good", { body: "Replying under my own thread here.", gameTimeSec: 10, parentId: c });
    expect((await onNamed(`/comments/${c}/block`, "asker")).status).toBe(200);
    expect((await onNamed(`/comments/${c}/block`, "asker")).status).toBe(200);
    const blockerView = (await request(h.app).get(`/v1/reviews/${named}`).set("authorization", h.bearer("asker"))).body.comments;
    expect(blockerView.find((x) => x.id === c)).toMatchObject({ state: "blocked", body: "", author: null });
    expect((await request(h.app).get(`/v1/reviews/${named}`)).body.comments.find((x) => x.id === c).state).toBe("visible");
    const denied = await onNamed("/comments", "good", { body: "Trying to comment after being blocked.", gameTimeSec: 11 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("review_blocked");
    expect((await request(h.app).get(`/v1/reviews/${named}`).set("authorization", h.bearer("good"))).body.viewer)
      .toMatchObject({ canComment: false, reason: "blocked" });

    // "troll" blocks "good" from troll's review; good can't reply to it or ping troll.
    const trollReview = (await post("/comments", "troll", { body: "A review that good will want to answer.", gameTimeSec: 14 })).body.id;
    const goodReview = (await post("/comments", "good", { body: "Good's own review on the anonymous request.", gameTimeSec: 15 })).body.id;
    expect((await post(`/comments/${goodReview}/block`, "troll")).status).toBe(200);
    const reply = await post("/comments", "good", { body: "Replying to someone who blocked me.", gameTimeSec: 16, parentId: trollReview });
    expect(reply.status).toBe(403);
    expect(await h.db.notifications.countDocuments({ userId: h.userId("troll"), kind: "review.reply" })).toBe(0);

    const list = await request(h.app).get("/v1/me/review-blocks").set("authorization", h.bearer("asker"));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe("GoodReviewer");
    expect(JSON.stringify(list.body)).not.toContain(h.userId("good"));
    await request(h.app).delete(`/v1/me/review-blocks/${list.body.items[0].id}`).set("authorization", h.bearer("asker")).expect(200);
    expect((await onNamed("/comments", "good", { body: "Unblocked now, commenting again.", gameTimeSec: 12 })).status).toBe(201);
  });

  test("anonymous asker: blocks, upvotes and moderation never tie the asker to their account", async () => {
    await h.seedUser("sleuth", { displayName: "Sleuth" });
    await h.seedLadderHistory("sleuth", { mmr: 4700 });
    // The anonymous asker replies in their own thread.
    const review = (await post("/comments", "sleuth", { body: "A review so the asker can reply to it.", gameTimeSec: 20 })).body.id;
    const askerReply = (await post("/comments", "asker", { body: "Thanks, the asker replying here.", gameTimeSec: 21, parentId: review })).body.id;
    const askerTop = (await post("/comments", "asker", { body: "A top-level note from the asker.", gameTimeSec: 22 })).body.id;

    // Can't block the asker through their own replies…
    const block = await post(`/comments/${askerReply}/block`, "sleuth");
    expect(block.status).toBe(400);
    expect(block.body.error.code).toBe("asker_comment");
    const blocks = await request(h.app).get("/v1/me/review-blocks").set("authorization", h.bearer("sleuth"));
    expect(JSON.stringify(blocks.body)).not.toContain("BlinkMaster");

    // …and blocking the asker's account elsewhere never hides their replies here.
    await h.db.reviewBlocks.insertOne({ _id: "sleuthblocksask1", blockerId: h.userId("sleuth"), blockedId: h.userId("asker"), createdAt: new Date() });
    const sleuthView = (await pageAs("sleuth")).body.comments;
    expect(sleuthView.find((x) => x.id === askerReply)).toMatchObject({ state: "visible" });
    expect(sleuthView.find((x) => x.id === askerTop)).toMatchObject({ state: "visible" });
    // …nor silence the asker's reply notifications (a missing ping would
    // reveal the same thing).
    const replyPings = () => h.db.notifications.find({ userId: h.userId("sleuth"), kind: "review.reply" }).toArray()
      .then((rows) => rows.reduce((n, r) => n + (r.count || 1), 0));
    const pingsBefore = await replyPings();
    expect((await post("/comments", "asker", { body: "Another reply from the anonymous asker.", gameTimeSec: 24, parentId: review })).status).toBe(201);
    expect(await replyPings()).toBe(pingsBefore + 1);

    // Upvotes on the asker's replies are refused (karma is public).
    const karmaBefore = (await h.db.users.findOne({ userId: h.userId("asker") }))?.reviewer?.karma || 0;
    const up = await post(`/comments/${askerReply}/upvote`, "sleuth", { value: true });
    expect(up.status).toBe(400);
    expect(up.body.error.code).toBe("asker_comment");

    // A moderator removing an asker reply applies no karma penalty.
    await h.services.reviews.moderationTargets().review_comment.remove(askerTop, h.userId("mod"), "");
    expect((await h.db.users.findOne({ userId: h.userId("asker") }))?.reviewer?.karma || 0).toBe(karmaBefore);

    // The asker blocks sleuth: on an ANONYMOUS request the block can't be
    // revealed, so sleuth may still comment, but the asker never sees it
    // and never hears about it.
    const forMe = async () => (await request(h.app).get("/v1/reviews/for-me").set("authorization", h.bearer("sleuth"))).body.items.map((x) => x.id);
    expect(await forMe()).toContain(reviewId);
    expect((await post(`/comments/${review}/block`, "asker")).status).toBe(200);
    // Still listed under "Requests you can help with" (dropping it would reveal the block).
    expect(await forMe()).toContain(reviewId);
    const before = await h.db.notifications.countDocuments({ userId: h.userId("asker") });
    const unread = (await request(h.app).get("/v1/me/notifications/unread-count").set("authorization", h.bearer("asker"))).body.count;
    const hidden = await post("/comments", "sleuth", { body: "Posting after the asker blocked me.", gameTimeSec: 23 });
    expect(hidden.status).toBe(201);
    expect((await pageAs("sleuth")).body.viewer).toMatchObject({ canComment: true });
    expect((await pageAs("asker")).body.comments.some((x) => x.id === hidden.body.id)).toBe(false);
    expect(await h.db.notifications.countDocuments({ userId: h.userId("asker") })).toBe(before);
    expect((await request(h.app).get("/v1/me/notifications/unread-count").set("authorization", h.bearer("asker"))).body.count).toBe(unread);
  });

  test("GDPR export never carries the moderator's id", async () => {
    const c = (await post("/comments", "good", { body: "A comment a moderator will remove.", gameTimeSec: 30 })).body.id;
    await h.services.reviews.moderationTargets().review_comment.remove(c, h.userId("mod"), "");
    const exported = await h.services.reviews.exportForUser(h.userId("good"));
    expect(JSON.stringify(exported)).not.toContain(h.userId("mod"));
  });
});
