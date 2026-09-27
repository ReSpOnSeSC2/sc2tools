// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness, leakedSecrets } = require("./helpers/reviewsHarness");
const { derivedRanking } = require("../src/services/reviews");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: indexability gate, sitemap and OG", () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("reviewer", { displayName: "ReviewFox" });
    await h.seedLadderHistory("reviewer", { mmr: 4800 });
  });
  afterAll(async () => {
    await h.close();
  });

  test("noindex until a helpful or best review exists; link-only is never indexable", async () => {
    const gameId = await h.seedGame("asker");
    const id = (await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker")).send({ gameId, question: QUESTION })).body.id;
    let page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.body.seo).toMatchObject({ indexable: false, answerCount: 0, acceptedAnswerId: null });
    expect(page.headers["cache-control"]).toContain("s-maxage=30");
    const c = (await request(h.app).post(`/v1/reviews/${id}/comments`).set("authorization", h.bearer("reviewer")).send({ body: "Scout at 4:30 and hold the blink.", gameTimeSec: 270 })).body.id;
    page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.body.seo.indexable).toBe(false);
    expect(page.body.seo.answerCount).toBe(1);
    await request(h.app).post(`/v1/reviews/${id}/comments/${c}/helpful`).set("authorization", h.bearer("asker")).expect(200);
    page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.body.seo).toMatchObject({ indexable: true, suggestedAnswerIds: [c], acceptedAnswerId: null });
    await request(h.app).post(`/v1/reviews/${id}/comments/${c}/best`).set("authorization", h.bearer("asker")).expect(200);
    page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.body.seo).toMatchObject({ indexable: true, acceptedAnswerId: c, suggestedAnswerIds: [] });
    const sitemap = await request(h.app).get("/v1/reviews/sitemap");
    expect(sitemap.body.items.map((i) => i.id)).toEqual([id]);

    const og = await request(h.app).get(`/v1/reviews/${id}/og`);
    expect(og.body).toMatchObject({ matchup: "PvZ", map: "Alcyone LE", reviewCount: 1, hasBest: true });
    expect(leakedSecrets(og.body)).toEqual([]);

    expect(derivedRanking({ status: "open", visibility: "link", helpfulCount: 3, hidden: false, createdAt: new Date() }))
      .toMatchObject({ listed: false, indexable: false });
    expect(derivedRanking({ status: "closed", visibility: "public", helpfulCount: 3, createdAt: new Date() }).indexable).toBe(false);
  });

  test("board sorts, filters and paginates without personalisation", async () => {
    await h.db.reviewRequests.deleteMany({});
    const now = Date.now();
    const base = { status: "open", visibility: "public", hidden: false, tags: ["macro"], question: "q".repeat(30), askerDisplay: "anonymous", myRace: "Protoss" };
    const docs = [
      { _id: "AAAAAAAAAAAAAAA1", matchup: "PvZ", askerBand: { id: 4, label: "Diamond" }, reviewCount: 0, helpfulCount: 0, createdAt: new Date(now - 1000) },
      { _id: "AAAAAAAAAAAAAAA2", matchup: "PvT", askerBand: { id: 2, label: "Gold" }, reviewCount: 3, helpfulCount: 2, createdAt: new Date(now - 90_000_000) },
      { _id: "AAAAAAAAAAAAAAA3", matchup: "PvZ", askerBand: { id: 5, label: "Master" }, reviewCount: 1, helpfulCount: 0, tags: ["micro"], createdAt: new Date(now - 5000) },
    ].map((d) => ({ ...base, ...d, lastActivityAt: d.createdAt }));
    for (const d of docs) Object.assign(d, derivedRanking(d));
    await h.db.reviewRequests.insertMany(docs);
    const ids = async (qs) => (await request(h.app).get(`/v1/reviews${qs}`)).body.items.map((i) => i.id);
    expect(await ids("?sort=new")).toEqual(["AAAAAAAAAAAAAAA1", "AAAAAAAAAAAAAAA3", "AAAAAAAAAAAAAAA2"]);
    expect((await ids("?sort=top"))[0]).toBe("AAAAAAAAAAAAAAA2");
    expect(await ids("?matchup=PvZ&sort=new")).toEqual(["AAAAAAAAAAAAAAA1", "AAAAAAAAAAAAAAA3"]);
    expect(await ids("?band=5")).toEqual(["AAAAAAAAAAAAAAA3"]);
    expect(await ids("?tag=micro")).toEqual(["AAAAAAAAAAAAAAA3"]);
    expect(await ids("?unanswered=1")).toEqual(["AAAAAAAAAAAAAAA1"]);
    const page1 = await request(h.app).get("/v1/reviews?sort=new&limit=2");
    expect(page1.headers["cache-control"]).toBe("public, max-age=0, s-maxage=60");
    expect(page1.body.items).toHaveLength(2);
    const page2 = await request(h.app).get(`/v1/reviews?sort=new&limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((i) => i.id)).toEqual(["AAAAAAAAAAAAAAA2"]);
    expect(page2.body.nextCursor).toBeNull();
  });

  test("help-with list and weekly digest target the reviewer's race at or below their band", async () => {
    await h.db.reviewRequests.deleteMany({});
    const gameId = await h.seedGame("asker", { gameId: "digest-game" });
    await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker")).send({ gameId, question: QUESTION }).expect(201);
    const help = await request(h.app).get("/v1/reviews/for-me").set("authorization", h.bearer("reviewer"));
    expect(help.body.verified.race).toBe("Protoss");
    expect(help.body.items).toHaveLength(1);
    const first = await h.services.reviews.sendWeeklyDigest({ weekKey: "2026-09-21" });
    expect(first.notified).toBe(1);
    const again = await h.services.reviews.sendWeeklyDigest({ weekKey: "2026-09-21" });
    expect(again.notified).toBe(0);
    const notes = await request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("reviewer"));
    const digest = notes.body.items.find((n) => n.kind === "review.digest");
    expect(digest.title).toBe("1 open review request in your matchups");
    expect(digest.href).toBe("/reviews?help=1");
  });
});

describe("reviews: GDPR", () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  test("deleting a reviewer anonymises their comments; deleting an asker removes their requests", async () => {
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("reviewer", { displayName: "ReviewFox" });
    await h.seedLadderHistory("reviewer", { mmr: 4800 });
    await h.seedUser("voter");
    const gameId = await h.seedGame("asker");
    const id = (await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker")).send({ gameId, question: QUESTION })).body.id;
    const c = (await request(h.app).post(`/v1/reviews/${id}/comments`).set("authorization", h.bearer("reviewer")).send({ body: "Scout at 4:30 and hold the blink.", gameTimeSec: 270 })).body.id;
    await request(h.app).post(`/v1/reviews/${id}/comments/${c}/upvote`).set("authorization", h.bearer("voter")).expect(200);

    const exported = await h.services.gdpr.export(h.userId("reviewer"));
    expect(exported.data.reviewComments).toHaveLength(1);
    expect(exported.data.reviewKarmaEvents).toHaveLength(1);
    expect(JSON.stringify(exported.data.reviewKarmaEvents)).not.toContain(h.userId("voter"));

    // The voter deletes their account: the reviewer keeps the karma, the
    // ledger row loses its actor.
    await h.services.gdpr.deleteAll(h.userId("voter"));
    const event = await h.db.reviewKarmaEvents.findOne({ commentId: c, kind: "upvote" });
    expect(event.actorId).toBeNull();
    expect((await h.db.users.findOne({ userId: h.userId("reviewer") })).reviewer.karma).toBe(1);

    const counts = await h.services.gdpr.deleteAll(h.userId("reviewer"));
    expect(counts.reviewCommentsAnonymised).toBe(1);
    const page = await request(h.app).get(`/v1/reviews/${id}`);
    const anon = page.body.comments.find((x) => x.id === c);
    expect(anon.author.label).toBe("[deleted user]");
    expect(anon.body).toContain("Scout at 4:30");
    expect(await h.db.reviewKarmaEvents.countDocuments({ userId: h.userId("reviewer") })).toBe(0);

    const askerCounts = await h.services.gdpr.deleteAll(h.userId("asker"));
    expect(askerCounts.reviewRequests).toBe(1);
    expect((await request(h.app).get(`/v1/reviews/${id}`)).status).toBe(404);
    expect(await h.db.reviewComments.countDocuments({ requestId: id })).toBe(0);
    expect(await h.db.notifications.countDocuments({ userId: h.userId("asker") })).toBe(0);
  });
});
