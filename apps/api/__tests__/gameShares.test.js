// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness, leakedSecrets, SECRET } = require("./helpers/reviewsHarness");
const { buildGameSharesRouter } = require("../src/routes/gameShares");
const { GameSharesService, GAME_SHARES } = require("../src/services/gameShares");
const { sanitiseRequestUrl } = require("../src/middleware/requestLogging");
const { sanitiseReportPagePath } = require("../src/services/reportContext");
const { privateSearchHttpOptions } = require("../src/middleware/privateSearchTelemetry");
const { _internals: publicReplays } = require("../src/routes/publicReplays");
const { reviewMacroBreakdown } = require("../src/services/reviewRedaction");

describe("game share links (HTTP + Mongo)", () => {
  let h;
  let gameId;

  const create = (name, id = gameId) => request(h.app)
    .post(`/v1/games/${encodeURIComponent(id)}/shares`)
    .set("authorization", h.bearer(name));

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("owner", { displayName: "ShareOwner" });
    await h.seedUser("other", { displayName: "SomeoneElse" });
    gameId = await h.seedGame("owner");
    // A confirmed build check-in rewrites the row's label; neither it nor a
    // private note may reach a viewer, who sees the classifier's label.
    await h.db.games.updateOne({ userId: h.userId("owner"), gameId }, {
      $set: {
        myBuild: "My Secret Plan",
        buildIntent: {
          status: "confirmed", applied: true, build: { name: "My Secret Plan", slug: "my-secret-plan" },
          detected: { name: "PvZ - Blink All-in" }, note: "private note",
        },
        notes: "my private game notes",
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  test("the owner creates one live link per game and lists it; repeated asks reuse it", async () => {
    const first = await create("owner");
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const { token, url, active, viewCount } = first.body.share;
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(url).toBe(`/g/${token}`);
    expect(active).toBe(true);
    expect(viewCount).toBe(0);

    const again = await create("owner");
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.share.token).toBe(token);

    const list = await request(h.app).get(`/v1/games/${encodeURIComponent(gameId)}/shares`).set("authorization", h.bearer("owner"));
    expect(list.status).toBe(200);
    expect(list.body.shares.map((s) => s.token)).toEqual([token]);
    expect(list.body.activeCount).toBe(1);
    expect(list.body.limit).toBe(200);

    // Signed out, another account, or someone else's game.
    expect((await request(h.app).post(`/v1/games/${encodeURIComponent(gameId)}/shares`)).status).toBe(401);
    expect((await create("other")).status).toBe(404);
  });

  test("the public analysis is anonymous, redacted and parity-shaped with the public allow-lists", async () => {
    const { body: { share } } = await create("owner");
    const res = await request(h.app).get(`/v1/shares/${share.token}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    const text = JSON.stringify(res.body);
    expect(leakedSecrets(res.body)).toEqual([]);
    expect(text).not.toContain(gameId);
    for (const secret of ["My Secret Plan", "private note", "my private game notes", "ShareOwner", "1-S2-1-111111", "4130", "4088", "10:10"]) {
      expect(text).not.toContain(secret);
    }
    const { game } = res.body;
    expect(game).toMatchObject({
      matchup: "PvZ", map: "Alcyone LE", result: "Loss", playedOn: "2026-09-01",
      playerLabel: "Protoss player", playerMmr: 4100, opponentMmr: 4100,
      opponentLabel: "Opponent (Zerg, ~4,100 MMR)", myBuild: "PvZ - Blink All-in", oppStrategy: "Zerg - Roach Ravager",
    });
    // Same allow-list as public replays and reviews: no player_stats, names or ids.
    const macro = await h.services.perGame.macroBreakdown(h.userId("owner"), gameId);
    expect(res.body.macroBreakdown).toEqual(reviewMacroBreakdown(macro));
    expect(Object.keys(res.body.macroBreakdown).sort()).toEqual(Object.keys(publicReplays.publicMacroBreakdown(macro)).sort());
    expect(res.body.macroBreakdown.player_stats).toBeUndefined();
    expect(res.body.buildOrder.game_id).toBeUndefined();
    expect(res.body.buildOrder.opponent).toBe("Opponent (Zerg, ~4,100 MMR)");
    expect(res.body.buildOrder.my_build).toBe("PvZ - Blink All-in");
    expect(res.body.playback.mode).toBe("inline");

    // Inline playback keeps units but drops identity keys and the replay hash.
    const playback = await request(h.app).get(`/v1/shares/${share.token}/map-playback`);
    expect(playback.status).toBe(200);
    expect(leakedSecrets(playback.body)).toEqual([]);
    expect(playback.body.players).toBeUndefined();
    expect(playback.body.replaySha256).toBeUndefined();
    expect(playback.body.units[0].playerName).toBeUndefined();
  });

  test("views are counted from the browser beacon only", async () => {
    const { body: { share } } = await create("owner");
    await request(h.app).get(`/v1/shares/${share.token}`);
    expect((await request(h.app).post(`/v1/shares/${share.token}/views`)).status).toBe(204);
    expect((await request(h.app).post(`/v1/shares/${share.token}/views`)).status).toBe(204);
    const list = await request(h.app).get(`/v1/games/${encodeURIComponent(gameId)}/shares`).set("authorization", h.bearer("owner"));
    expect(list.body.shares[0].viewCount).toBe(2);
    expect(list.body.shares[0].lastViewedAt).toBeTruthy();
  });

  test("a revoked token returns 404 everywhere, and only its owner can revoke it", async () => {
    const otherGame = await h.seedGame("owner", { gameId: "revoke-me" });
    const { body: { share } } = await create("owner", otherGame);
    expect((await request(h.app).get(`/v1/shares/${share.token}`)).status).toBe(200);
    expect((await request(h.app).delete(`/v1/shares/${share.token}`).set("authorization", h.bearer("other"))).status).toBe(404);
    expect((await request(h.app).delete(`/v1/shares/${share.token}`)).status).toBe(401);

    const revoked = await request(h.app).delete(`/v1/shares/${share.token}`).set("authorization", h.bearer("owner"));
    expect(revoked.status).toBe(200);
    expect(revoked.body.share.active).toBe(false);
    const segment = `/map-playback/artifacts/${"c".repeat(64)}/segments/0`;
    for (const path of ["", "/map-playback", "/map-playback/manifest", segment, segment + "/link"]) {
      const res = await request(h.app).get(`/v1/shares/${share.token}${path}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toMatch(/not_found/);
    }
    expect((await request(h.app).post(`/v1/shares/${share.token}/views`)).status).toBe(404);
    // Revoking again is idempotent; a new ask mints a different token.
    expect((await request(h.app).delete(`/v1/shares/${share.token}`).set("authorization", h.bearer("owner"))).status).toBe(200);
    const fresh = await create("owner", otherGame);
    expect(fresh.status).toBe(201);
    expect(fresh.body.share.token).not.toBe(share.token);
    // Malformed and unknown tokens look exactly like revoked ones.
    expect((await request(h.app).get("/v1/shares/short")).status).toBe(404);
    expect((await request(h.app).get("/v1/shares/AAAAAAAAAAAAAAAA")).status).toBe(404);
  });

  test("deleting the game retires its link", async () => {
    const doomed = await h.seedGame("owner", { gameId: "doomed-game" });
    const { body: { share } } = await create("owner", doomed);
    await h.db.games.updateOne({ userId: h.userId("owner"), gameId: doomed }, { $set: { _deleted: true } });
    expect((await request(h.app).get(`/v1/shares/${share.token}`)).status).toBe(404);
    const row = await h.db.gameShares.findOne({ _id: share.token });
    expect(row.revokedAt).toBeTruthy();
    expect(row.revokedReason).toBe("game_unavailable");
    expect(row.activeKey).toBeUndefined();
  });

  test("resumed-from-replay games cannot be shared", async () => {
    const resumed = await h.seedGame("owner", { gameId: "resumed-game" });
    await h.db.games.updateOne({ userId: h.userId("owner"), gameId: resumed }, { $set: { isResumedFromReplay: true } });
    expect((await create("owner", resumed)).status).toBe(404);
  });

  test("at most 200 links can be live per user", async () => {
    await h.seedUser("busy");
    const capped = await h.seedGame("busy", { gameId: "busy-new-game" });
    const now = new Date();
    await h.db.gameShares.insertMany(Array.from({ length: GAME_SHARES.MAX_ACTIVE }, (_, i) => ({
      _id: `busy${String(i).padStart(12, "0")}`, userId: h.userId("busy"), gameId: `busy-${i}`,
      activeKey: `${h.userId("busy")}\u0000busy-${i}`, createdAt: now, revokedAt: null, viewCount: 0,
    })));
    const res = await create("busy", capped);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("share_limit");
    await request(h.app).delete("/v1/shares/busy000000000000").set("authorization", h.bearer("busy"));
    expect((await create("busy", capped)).status).toBe(201);
  });

  test("account export lists shares without tokens; account deletion removes them", async () => {
    await h.seedUser("leaver");
    const leaverGame = await h.seedGame("leaver", { gameId: "leaver-game" });
    const { body: { share } } = await create("leaver", leaverGame);
    const exported = await h.services.gdpr.export(h.userId("leaver"));
    expect(exported.data.gameShares).toHaveLength(1);
    expect(exported.data.gameShares[0].gameId).toBe(leaverGame);
    expect(JSON.stringify(exported.data.gameShares)).not.toContain(share.token);
    expect(exported.data.gameShares[0].activeKey).toBeUndefined();

    const inventory = await h.services.gdpr.inventory(h.userId("leaver"));
    expect(inventory.removed.gameShares).toBe(1);
    const counts = await h.services.gdpr.deleteAll(h.userId("leaver"));
    expect(counts.gameShares).toBe(1);
    expect(await h.db.gameShares.countDocuments({ userId: h.userId("leaver") })).toBe(0);
    expect((await request(h.app).get(`/v1/shares/${share.token}`)).status).toBe(404);
  });

  test("request logs and problem reports never carry a share token", () => {
    expect(sanitiseRequestUrl("/v1/shares/AbCdEfGhIjKlMnOp/map-playback/manifest")).toBe("/v1/shares/[redacted]/map-playback/manifest");
    expect(sanitiseRequestUrl("/v1/shares/AbCdEfGhIjKlMnOp")).toBe("/v1/shares/[redacted]");
    expect(sanitiseRequestUrl("/v1/games/g1/shares")).toBe("/v1/games/g1/shares");
    expect(sanitiseReportPagePath("/g/AbCdEfGhIjKlMnOp?t=5#battle-report")).toBe("/g/[redacted]");
    // No tracing span carries a share URL either.
    const { ignoreIncomingRequests } = privateSearchHttpOptions();
    expect(ignoreIncomingRequests("/v1/shares/AbCdEfGhIjKlMnOp/views")).toBe(true);
    expect(ignoreIncomingRequests("/v1/games/g1/shares")).toBe(false);
  });
});

describe("game share rate limits", () => {
  function app(max) {
    const shares = { analysis: jest.fn(async () => ({ ok: true })), recordView: jest.fn(async () => undefined) };
    const router = buildGameSharesRouter({ gameShares: shares, auth: (_req, _res, next) => next(), heavyLimitPerMinute: max, viewLimitPerMinute: max });
    return { shares, app: express().use("/v1", router) };
  }

  test("each token has its own budget", async () => {
    const { app: server, shares } = app(2);
    const a = "AAAAAAAAAAAAAAAA", b = "BBBBBBBBBBBBBBBB";
    expect((await request(server).get(`/v1/shares/${a}`)).status).toBe(200);
    expect((await request(server).get(`/v1/shares/${a}`)).status).toBe(200);
    const limited = await request(server).get(`/v1/shares/${a}`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect((await request(server).get(`/v1/shares/${b}`)).status).toBe(200);
    expect(shares.analysis).toHaveBeenCalledTimes(3);
  });

  test("malformed tokens never reach the service", async () => {
    const { app: server, shares } = app(10);
    expect((await request(server).get("/v1/shares/not-a-token")).status).toBe(404);
    expect((await request(server).post("/v1/shares/not-a-token/views")).status).toBe(404);
    expect(shares.analysis).not.toHaveBeenCalled();
    expect(shares.recordView).not.toHaveBeenCalled();
  });
});

describe("presigned segment links", () => {
  const ARTIFACT = "c".repeat(64);
  function service({ segment = Buffer.from(JSON.stringify({ playback: { units: [{ owner: "me", name: "Marine" }] } })) } = {}) {
    const playbackArtifacts = {
      getSegment: jest.fn(async () => segment),
      signSegment: jest.fn(async (_u, _g, artifactId, index, expiresIn) => ({ url: `https://storage.example/${artifactId}/${index}.json?sig=x`, expiresIn })),
      getManifest: jest.fn(),
    };
    const shares = new GameSharesService({ gameShares: {}, games: {} }, {
      replayLibrary: { getDetail: jest.fn() }, perGame: {}, playbackArtifacts,
    });
    shares.resolve = jest.fn(async () => ({ ownerId: "u_owner", gameId: "game-1", inlinePlayback: false }));
    return { shares, playbackArtifacts };
  }

  test("the public link declines legacy presigning and the verified proxy still serves the bytes", async () => {
    const { shares, playbackArtifacts } = service();
    const server = express();
    server.use("/v1", buildGameSharesRouter({ gameShares: shares, auth: (_req, _res, next) => next() }));
    server.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code } }));
    const path = `/v1/shares/AAAAAAAAAAAAAAAA/map-playback/artifacts/${ARTIFACT}/segments/3`;
    const link = await request(server).get(path + "/link").expect(404);
    expect(link.headers["cache-control"]).toContain("no-store");
    expect(link.headers.location).toBeUndefined();
    expect(link.body).toEqual({ error: { code: "playback_direct_unavailable", message: "Use the replay playback endpoint." } });
    expect(playbackArtifacts.signSegment).not.toHaveBeenCalled();
    expect(playbackArtifacts.getSegment).not.toHaveBeenCalled();

    const proxied = await request(server).get(path).expect(200);
    expect(proxied.body).toEqual({ playback: { units: [{ owner: "me", name: "Marine" }] } });
    expect(playbackArtifacts.getSegment).toHaveBeenCalledWith("u_owner", "game-1", ARTIFACT, 3);
  });

  test("a segment carrying identity keys gets no link and no bytes", async () => {
    const dirty = Buffer.from(JSON.stringify({ playback: { units: [{ owner: "opp", name: "Zergling", playerName: SECRET.name }] } }));
    const { shares, playbackArtifacts } = service({ segment: dirty });
    await expect(shares.segmentLink("AAAAAAAAAAAAAAAA", ARTIFACT, 0)).rejects.toMatchObject({ status: 404 });
    await expect(shares.playbackSegment("AAAAAAAAAAAAAAAA", ARTIFACT, 0)).rejects.toMatchObject({ status: 404 });
    expect(playbackArtifacts.signSegment).not.toHaveBeenCalled();
  });
});
