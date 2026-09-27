// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: create eligibility and caps", () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("other");
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.db.reviewRequests.deleteMany({});
    await h.db.games.deleteMany({});
    await h.db.gameDetails.deleteMany({});
  });

  const post = (name, body) =>
    request(h.app).post("/v1/reviews").set("authorization", h.bearer(name)).send(body);

  test("creates a request from your own 1v1 game with a macro breakdown", async () => {
    const gameId = await h.seedGame("asker");
    const res = await post("asker", {
      gameId,
      question: QUESTION,
      tags: ["build_order", "army_control"],
      desiredLevel: "masters_plus",
      visibility: "public",
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(res.body.url).toBe(`/reviews/${res.body.id}`);
    const doc = await h.db.reviewRequests.findOne({ _id: res.body.id });
    expect(doc.status).toBe("open");
    expect(doc.matchup).toBe("PvZ");
    expect(doc.result).toBe("Loss");
    expect(doc.askerDisplay).toBe("anonymous");
    expect(doc.askerBand).toEqual({ id: 4, label: "Diamond" });
    expect(doc.opponentLabel).toBe("Opponent (Zerg, ~4,100 MMR)");
    expect(doc.hasPlayback).toBe(true);
    expect(doc.playbackMode).toBe("inline");
    expect(doc.listed).toBe(true);
    expect(doc.indexable).toBe(false);
    expect(doc._schemaVersion).toBe(1);
  });

  test("rejects someone else's game, non-1v1 games and games with no macro breakdown", async () => {
    const theirs = await h.seedGame("other", { gameId: "other-game" });
    expect((await post("asker", { gameId: theirs, question: QUESTION })).status).toBe(404);

    const team = await h.seedGame("asker", { gameId: "team-game", matchFormat: "team" });
    const teamRes = await post("asker", { gameId: team, question: QUESTION });
    expect(teamRes.status).toBe(400);
    expect(teamRes.body.error.code).toBe("review_not_1v1");

    const noMacro = await h.seedGame("asker", { gameId: "no-macro", macro: false });
    const noMacroRes = await post("asker", { gameId: noMacro, question: QUESTION });
    expect(noMacroRes.status).toBe(400);
    expect(noMacroRes.body.error.code).toBe("review_needs_macro");
  });

  test("validates the question and runs the content filter", async () => {
    const gameId = await h.seedGame("asker");
    const short = await post("asker", { gameId, question: "too short" });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe("invalid_question");
    const long = await post("asker", { gameId, question: "x".repeat(501) });
    expect(long.status).toBe(400);
    const slur = await post("asker", { gameId, question: "why did this f a g g o t zerg beat my blink push" });
    expect(slur.status).toBe(400);
    expect(slur.body.error.code).toBe("content_rejected");
    const unknownField = await post("asker", { gameId, question: QUESTION, squad: "abc" });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe("invalid_review_input");
  });

  test("one live request per game, at most 3 open, at most 3 new per day", async () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await h.seedGame("asker", { gameId: `cap-${i}` }));
    const first = await post("asker", { gameId: ids[0], question: QUESTION });
    expect(first.status).toBe(201);
    const dup = await post("asker", { gameId: ids[0], question: QUESTION });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("review_exists");
    expect(dup.body.error.meta.id).toBe(first.body.id);
    expect((await post("asker", { gameId: ids[1], question: QUESTION })).status).toBe(201);
    expect((await post("asker", { gameId: ids[2], question: QUESTION })).status).toBe(201);
    const fourth = await post("asker", { gameId: ids[3], question: QUESTION });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe("review_open_limit");

    // Closing frees an open slot, but the daily cap still holds.
    await request(h.app)
      .post(`/v1/reviews/${first.body.id}/close`)
      .set("authorization", h.bearer("asker"))
      .expect(200);
    const daily = await post("asker", { gameId: ids[3], question: QUESTION });
    expect(daily.status).toBe(429);
    expect(daily.body.error.code).toBe("review_daily_limit");
  });

  test("named posting requires a display name and never falls back to the BattleTag", async () => {
    await h.seedUser("tagonly", { battleTag: "InGameName#1234" });
    const gameId = await h.seedGame("tagonly");
    const res = await post("tagonly", { gameId, question: QUESTION, askerDisplay: "named" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("display_name_required");
    const named = await h.seedGame("asker", { gameId: "named-game" });
    const ok = await post("asker", { gameId: named, question: QUESTION, askerDisplay: "named" });
    expect(ok.status).toBe(201);
    const page = await request(h.app).get(`/v1/reviews/${ok.body.id}`);
    expect(page.body.request.asker.label).toBe("BlinkMaster");
  });

  test("requires a browser session: signed-out 401", async () => {
    const res = await request(h.app).post("/v1/reviews").send({ gameId: "x", question: QUESTION });
    expect(res.status).toBe(401);
  });
});

describe("reviews: rollout flag", () => {
  test("off hides every route; admins-only exposes them to admins alone", async () => {
    const off = await createHarness({ rollout: "off" });
    try {
      expect((await request(off.app).get("/v1/reviews")).status).toBe(404);
    } finally {
      await off.close();
    }
    const admins = await createHarness({ rollout: "admins", admins: ["boss"] });
    try {
      await admins.seedUser("boss");
      await admins.seedUser("pleb");
      expect((await request(admins.app).get("/v1/reviews")).status).toBe(404);
      expect((await request(admins.app).get("/v1/reviews").set("authorization", admins.bearer("pleb"))).status).toBe(404);
      const boss = await request(admins.app).get("/v1/reviews").set("authorization", admins.bearer("boss"));
      expect(boss.status).toBe(200);
      expect(boss.body.items).toEqual([]);
    } finally {
      await admins.close();
    }
  });
});
