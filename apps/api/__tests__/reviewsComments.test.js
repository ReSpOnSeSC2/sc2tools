// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");

const QUESTION = "Why did my blink all-in fail against the roach defence?";
const BODY = "Your blink timing at 5:12 was too late — scout first.";

describe("reviews: comment rules", () => {
  let h;
  let reviewId;

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("master", { displayName: "MasterFox" });
    await h.seedUser("diamond", { displayName: "DiamondDog" });
    await h.seedUser("newbie", { displayName: "FreshAccount" });
    await h.seedLadderHistory("master", { mmr: 4800 });
    await h.seedLadderHistory("diamond", { mmr: 3800 });
    await h.seedLadderHistory("newbie", { count: 5, mmr: 4800 });
    const gameId = await h.seedGame("asker");
    const res = await request(h.app)
      .post("/v1/reviews")
      .set("authorization", h.bearer("asker"))
      .send({ gameId, question: QUESTION, desiredLevel: "masters_plus" });
    reviewId = res.body.id;
  });
  afterAll(async () => {
    await h.close();
  });

  const comment = (name, body) =>
    request(h.app).post(`/v1/reviews/${reviewId}/comments`).set("authorization", h.bearer(name)).send(body);

  test("commenting needs sign-in and >= 20 synced games", async () => {
    expect((await request(h.app).post(`/v1/reviews/${reviewId}/comments`).send({ body: BODY, gameTimeSec: 10 })).status).toBe(401);
    const res = await comment("newbie", { body: BODY, gameTimeSec: 10 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("review_min_games");
    expect(res.body.error.meta).toEqual({ syncedGames: 5, requiredGames: 20 });
    const page = await request(h.app).get(`/v1/reviews/${reviewId}`).set("authorization", h.bearer("newbie"));
    expect(page.body.viewer).toMatchObject({ canComment: false, reason: "min_games" });
  });

  test("desired reviewer level gates top-level reviews but not replies", async () => {
    const diamond = await comment("diamond", { body: BODY, gameTimeSec: 312 });
    expect(diamond.status).toBe(403);
    expect(diamond.body.error.code).toBe("review_level_required");
    const master = await comment("master", { body: BODY, gameTimeSec: 312, endTimeSec: 340, mapPoint: { x: 40, y: 61.25 } });
    expect(master.status).toBe(201);
    const reply = await comment("diamond", { body: "Agreed, a probe scout at 4:30 shows it.", gameTimeSec: 270, parentId: master.body.id });
    expect(reply.status).toBe(201);
    const nested = await comment("master", { body: "Replies only go one level deep here.", gameTimeSec: 1, parentId: reply.body.id });
    expect(nested.status).toBe(400);
    expect(nested.body.error.code).toBe("invalid_parent");
    const page = await request(h.app).get(`/v1/reviews/${reviewId}`);
    const top = page.body.comments.find((c) => c.id === master.body.id);
    expect(top).toMatchObject({ gameTimeSec: 312, endTimeSec: 340, mapPoint: { x: 40, y: 61.3 } });
    expect(top.author.label).toBe("MasterFox");
    expect(top.author.verified).toEqual({ band: { id: 5, label: "Master" }, race: "Protoss", mmr: 4800 });
    expect(page.body.request.stats.reviewCount).toBe(1);
    expect(page.body.request.stats.commentCount).toBe(2);
  });

  test("validates body, time and range and runs the content filter", async () => {
    expect((await comment("master", { body: "too short", gameTimeSec: 1 })).body.error.code).toBe("invalid_comment");
    expect((await comment("master", { body: "x".repeat(2001), gameTimeSec: 1 })).status).toBe(400);
    expect((await comment("master", { body: BODY, gameTimeSec: 9999 })).body.error.code).toBe("invalid_time");
    expect((await comment("master", { body: BODY, gameTimeSec: 100, endTimeSec: 90 })).body.error.code).toBe("invalid_range");
    expect((await comment("master", { body: BODY, gameTimeSec: 100, endTimeSec: 500 })).body.error.code).toBe("invalid_range");
    expect((await comment("master", { body: "you played like a n1gg3r honestly", gameTimeSec: 1 })).body.error.code).toBe("content_rejected");
    const links = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(" ");
    expect((await comment("master", { body: links, gameTimeSec: 1 })).body.error.code).toBe("too_many_links");
    expect((await comment("master", { body: BODY, gameTimeSec: 1, html: "<b>" })).status).toBe(400);
  });

  test("the asker can reply to their own request without the reviewer gates", async () => {
    const res = await comment("asker", { body: "Thanks — I did scout, see 4:05.", gameTimeSec: 245 });
    expect(res.status).toBe(201);
    const page = await request(h.app).get(`/v1/reviews/${reviewId}`);
    const mine = page.body.comments.find((c) => c.id === res.body.id);
    expect(mine.author).toMatchObject({ label: "Anonymous Protoss", isAsker: true, profileHref: null });
  });

  test("rate limits: 30 comments per hour and 200 per day", async () => {
    await h.seedUser("spammer", { displayName: "Spammer" });
    await h.seedLadderHistory("spammer", { mmr: 4900 });
    const now = Date.now();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      _id: `spam${String(i).padStart(12, "0")}`,
      requestId: "elsewhere00000000",
      authorId: h.userId("spammer"),
      parentId: null,
      status: "visible",
      createdAt: new Date(now - 60_000 - i),
    }));
    await h.db.reviewComments.insertMany(rows);
    const hourly = await comment("spammer", { body: BODY, gameTimeSec: 1 });
    expect(hourly.status).toBe(429);
    expect(hourly.body.error.message).toMatch(/per hour/);
    await h.db.reviewComments.updateMany({ authorId: h.userId("spammer") }, { $set: { createdAt: new Date(now - 2 * 3600_000) } });
    const more = Array.from({ length: 170 }, (_, i) => ({ ...rows[0], _id: `mspm${String(i).padStart(12, "0")}`, createdAt: new Date(now - 3 * 3600_000) }));
    await h.db.reviewComments.insertMany(more);
    const daily = await comment("spammer", { body: BODY, gameTimeSec: 1 });
    expect(daily.status).toBe(429);
    expect(daily.body.error.message).toMatch(/per day/);
  });

  test("edit window: 15 minutes, own comments only", async () => {
    const created = await comment("master", { body: BODY, gameTimeSec: 100 });
    const id = created.body.id;
    const edit = (name, body) =>
      request(h.app).patch(`/v1/reviews/${reviewId}/comments/${id}`).set("authorization", h.bearer(name)).send(body);
    expect((await edit("diamond", { body: "Hijacked edit attempt here." })).status).toBe(403);
    const ok = await edit("master", { body: "Edited: scout at 4:30 and hold the blink.", mapPoint: { x: 10, y: 10 } });
    expect(ok.status).toBe(200);
    const fresh = await h.db.reviewComments.findOne({ _id: id });
    expect(fresh.body).toBe("Edited: scout at 4:30 and hold the blink.");
    expect(fresh.gameTimeSec).toBe(100);
    expect(fresh.editedAt).toBeInstanceOf(Date);
    const realNow = h.services.reviews.now;
    h.services.reviews.now = () => Date.now() + 16 * 60 * 1000;
    try {
      const late = await edit("master", { body: "Too late to edit this one now." });
      expect(late.status).toBe(403);
      expect(late.body.error.code).toBe("edit_window_closed");
    } finally {
      h.services.reviews.now = realNow;
    }
  });

  test("delete: [deleted] placeholder with replies, hard delete without", async () => {
    const parent = await comment("master", { body: "Top-level thought about the macro.", gameTimeSec: 50 });
    await comment("diamond", { body: "A reply that keeps the parent alive.", gameTimeSec: 60, parentId: parent.body.id });
    const lone = await comment("master", { body: "A lonely comment with no replies.", gameTimeSec: 70 });
    const del = (id) => request(h.app).delete(`/v1/reviews/${reviewId}/comments/${id}`).set("authorization", h.bearer("master"));
    expect((await request(h.app).delete(`/v1/reviews/${reviewId}/comments/${parent.body.id}`).set("authorization", h.bearer("diamond"))).status).toBe(403);
    expect((await del(parent.body.id)).body).toEqual({ deleted: "soft" });
    expect((await del(lone.body.id)).body).toEqual({ deleted: "hard" });
    expect(await h.db.reviewComments.findOne({ _id: lone.body.id })).toBeNull();
    const page = await request(h.app).get(`/v1/reviews/${reviewId}`);
    const placeholder = page.body.comments.find((c) => c.id === parent.body.id);
    expect(placeholder).toMatchObject({ state: "deleted", body: "", author: null, gameTimeSec: null });
    expect(page.body.comments.some((c) => c.parentId === parent.body.id)).toBe(true);
  });

  test("device tokens cannot comment and closed requests refuse comments", async () => {
    await request(h.app).post(`/v1/reviews/${reviewId}/close`).set("authorization", h.bearer("asker")).expect(200);
    const closed = await comment("master", { body: BODY, gameTimeSec: 1 });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("review_closed");
  });
});
