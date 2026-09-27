// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness, leakedSecrets, SECRET } = require("./helpers/reviewsHarness");
const { segmentCarriesIdentity } = require("../src/services/reviews");
const { reviewPlaybackManifest, stripIdentityKeys } = require("../src/services/reviewRedaction");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: opponent redaction and the scoped grant", () => {
  let h;
  let reviewId;
  let gameId;

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("reviewer", { displayName: "ReviewFox" });
    await h.seedLadderHistory("reviewer", { mmr: 4700 });
    gameId = await h.seedGame("asker");
    // A second game of the owner with a DIFFERENT build — the grant must
    // never serve it.
    await h.seedGame("asker", {
      gameId: "private-other-game",
      myBuild: "PvT - Secret Proxy Gates",
      buildLog: ["[0:10] PrivateProxyPylon", "[0:30] Gateway"],
    });
    const res = await request(h.app)
      .post("/v1/reviews")
      .set("authorization", h.bearer("asker"))
      .send({ gameId, question: QUESTION, tags: ["build_order"] });
    expect(res.status).toBe(201);
    reviewId = res.body.id;
    const comment = await request(h.app)
      .post(`/v1/reviews/${reviewId}/comments`)
      .set("authorization", h.bearer("reviewer"))
      .send({ body: "Your blink timing at 5:12 was too late — scout first.", gameTimeSec: 312, mapPoint: { x: 40.5, y: 60 } });
    expect(comment.status).toBe(201);
  });
  afterAll(async () => {
    await h.close();
  });

  test("no public response or OG payload carries the opponent's identity or the game id", async () => {
    const responses = await Promise.all([
      request(h.app).get("/v1/reviews"),
      request(h.app).get(`/v1/reviews/${reviewId}`),
      request(h.app).get(`/v1/reviews/${reviewId}`).set("authorization", h.bearer("reviewer")),
      request(h.app).get(`/v1/reviews/${reviewId}`).set("authorization", h.bearer("asker")),
      request(h.app).get(`/v1/reviews/${reviewId}/analysis`),
      request(h.app).get(`/v1/reviews/${reviewId}/analysis/map-playback`),
      request(h.app).get(`/v1/reviews/${reviewId}/og`),
      request(h.app).get("/v1/reviews/sitemap"),
      request(h.app).get("/v1/reviews/leaderboard"),
      request(h.app).get("/v1/reviews/for-me").set("authorization", h.bearer("reviewer")),
      request(h.app).get("/v1/me/reviews").set("authorization", h.bearer("reviewer")),
      request(h.app).get("/v1/me/reviews").set("authorization", h.bearer("asker")),
      request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("asker")),
    ]);
    for (const res of responses) expect(res.status).toBe(200);
    const bodies = responses.map((r) => r.body);
    expect(leakedSecrets(...bodies)).toEqual([]);
    expect(JSON.stringify(bodies)).not.toContain(gameId);
    expect(JSON.stringify(bodies)).not.toContain("private-other-game");
    // The page names the opponent only by the redacted label.
    const page = responses[1].body;
    expect(page.request.opponent.label).toBe("Opponent (Zerg, ~4,100 MMR)");
    expect(page.request.opponent.mmr).toBe(4100);
    expect(page.request.asker.label).toBe("Anonymous Protoss");
    // Map playback keeps units but drops identity keys and the replay hash.
    const playback = responses[5].body;
    expect(playback.units).toHaveLength(1);
    expect(playback.units[0].playerName).toBeUndefined();
    expect(playback.players).toBeUndefined();
    expect(playback.replaySha256).toBeUndefined();
    // The analysis has the asker's build and a redacted opponent label.
    const analysis = responses[4].body;
    expect(analysis.buildOrder.opponent).toBe("Opponent (Zerg, ~4,100 MMR)");
    expect(analysis.buildOrder.game_id).toBeUndefined();
    expect(analysis.macroBreakdown.player_stats).toBeUndefined();
    expect(analysis.playback.mode).toBe("inline");
  });

  test("the grant serves THIS game's analysis and nothing else of the owner's", async () => {
    const analysis = await request(h.app).get(`/v1/reviews/${reviewId}/analysis?gameId=private-other-game`);
    expect(analysis.status).toBe(200);
    const names = analysis.body.buildOrder.events.map((e) => e.name);
    expect(names).toContain("Pylon");
    expect(names).not.toContain("PrivateProxyPylon");
    expect(JSON.stringify(analysis.body)).not.toContain("Secret Proxy Gates");
    // The owner's private per-game routes stay private.
    expect((await request(h.app).get(`/v1/games/${encodeURIComponent(gameId)}/build-order`)).status).toBe(401);
    expect((await request(h.app).get(`/v1/games/private-other-game/build-order`).set("authorization", h.bearer("reviewer"))).status).toBe(404);
  });

  test("closing the request revokes the grant but keeps the thread", async () => {
    const other = await h.seedGame("asker", { gameId: "closing-game" });
    const created = await request(h.app)
      .post("/v1/reviews")
      .set("authorization", h.bearer("asker"))
      .send({ gameId: other, question: QUESTION });
    const id = created.body.id;
    expect((await request(h.app).get(`/v1/reviews/${id}/analysis`)).status).toBe(200);
    expect((await request(h.app).post(`/v1/reviews/${id}/close`).set("authorization", h.bearer("reviewer"))).status).toBe(403);
    expect((await request(h.app).post(`/v1/reviews/${id}/close`).set("authorization", h.bearer("asker"))).status).toBe(200);
    const revoked = await request(h.app).get(`/v1/reviews/${id}/analysis`);
    expect(revoked.status).toBe(410);
    expect(revoked.body.error.code).toBe("review_closed");
    expect((await request(h.app).get(`/v1/reviews/${id}/analysis/map-playback`)).status).toBe(410);
    const page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.status).toBe(200);
    expect(page.body.request.status).toBe("closed");
    expect(page.body.seo.indexable).toBe(false);
  });

  test("deleting the game closes the request", async () => {
    const doomed = await h.seedGame("asker", { gameId: "doomed-game" });
    const created = await request(h.app)
      .post("/v1/reviews")
      .set("authorization", h.bearer("asker"))
      .send({ gameId: doomed, question: QUESTION });
    await h.db.games.deleteOne({ userId: h.userId("asker"), gameId: doomed });
    const res = await request(h.app).get(`/v1/reviews/${created.body.id}/analysis`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("review_game_unavailable");
    const doc = await h.db.reviewRequests.findOne({ _id: created.body.id });
    expect(doc.status).toBe("closed");
    expect(doc.closedReason).toBe("game_unavailable");
    expect(doc.activeKey).toBeUndefined();
  });

  test("a history wipe closes requests whose games are gone", async () => {
    // Earlier tests in this suite used today's 3-per-day allowance.
    await h.db.reviewRequests.updateMany({}, { $set: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    const wiped = await h.seedGame("asker", { gameId: "wiped-game" });
    const created = await request(h.app)
      .post("/v1/reviews")
      .set("authorization", h.bearer("asker"))
      .send({ gameId: wiped, question: QUESTION });
    expect(created.status).toBe(201);
    await h.services.gdpr.wipeGames(h.userId("asker"));
    const doc = await h.db.reviewRequests.findOne({ _id: created.body.id });
    expect(doc.status).toBe("closed");
  });

  test("segment scan fails closed on identity keys; manifests are allow-listed", () => {
    const clean = Buffer.from(JSON.stringify({ schema: "sc2tools-playback-segment-v1", playback: { units: [{ owner: "me", name: "Probe" }] } }));
    const dirty = Buffer.from(JSON.stringify({ schema: "sc2tools-playback-segment-v1", playback: { units: [{ owner: "opp", playerName: SECRET.name }] } }));
    expect(segmentCarriesIdentity(clean)).toBe(false);
    expect(segmentCarriesIdentity(dirty)).toBe(true);
    expect(segmentCarriesIdentity(Buffer.from("not json"))).toBe(true);
    const manifest = reviewPlaybackManifest({
      ok: true,
      artifactId: "b".repeat(64),
      extra: SECRET.name,
      manifest: {
        schema: "sc2tools-playback-manifest-v1",
        replaySha256: "c".repeat(64),
        sourceArtifactSha256: "d".repeat(64),
        mapName: "Alcyone LE",
        gameLength: 640,
        fidelity: { positions: "engine", player: SECRET.name },
        players: [SECRET.name],
        segments: [{ index: 0, start: 0, end: 640, sizeBytes: 10, points: 1, sha256: "e".repeat(64), owner: SECRET.name }],
      },
    });
    expect(leakedSecrets(manifest)).toEqual([]);
    expect(stripIdentityKeys({ a: [{ battleTag: "x", keep: 1 }] })).toEqual({ a: [{ keep: 1 }] });
  });
});
