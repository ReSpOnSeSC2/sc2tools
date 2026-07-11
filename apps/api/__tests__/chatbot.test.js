// @ts-nocheck
"use strict";

/**
 * HTTP-level coverage for the chat-bot endpoints
 * (/v1/chatbot/:token/{opponent,mmr,build}) — the Nightbot /
 * StreamElements / Fossabot custom-API surface.
 *
 * Services come from ``buildApp`` (with a network-disabled
 * PulseMmrService, same idiom as opponentsPulseIntel.test.js) so the
 * ChatbotService under test reads the REAL OverlayTokensService,
 * LiveGameBroker and GamesService. The chatbot router itself mounts
 * on a small standalone Express app: in production it belongs in the
 * PUBLIC router bundle (before any ``router.use(auth)``), and app.js
 * wiring is a separate change — mounting it after buildApp's authed
 * routers here would get intercepted by their auth middleware.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { ChatbotService } = require("../src/services/chatbot");
const {
  buildChatbotRouter,
  CHATBOT_RATE_LIMIT_PER_MIN,
} = require("../src/routes/chatbot");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "chatbot-user") return { sub: "clerk_user_chatbot" };
    throw new Error("invalid");
  }),
}));

describe("GET /v1/chatbot/:token/*", () => {
  let mongo;
  let db;
  let built;
  let chatApp;
  let userId;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_chatbot",
    });
    built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: {
        port: 0,
        nodeEnv: "test",
        logLevel: "silent",
        mongoUri: "",
        mongoDb: "sc2tools_test_chatbot",
        clerkSecretKey: "sk_test",
        clerkJwtIssuer: undefined,
        clerkJwtAudience: undefined,
        serverPepper: Buffer.alloc(32, 9),
        corsAllowedOrigins: [],
        rateLimitPerMinute: 5000,
        agentReleaseAdminToken: "admin",
        pythonExe: null,
        pythonAnalyzerDir: "/tmp/__nonexistent__",
        adminUserIds: [],
      },
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });

    // Warm /me so the user row exists for token minting + sessions.
    const me = await request(built.app)
      .get("/v1/me")
      .set("authorization", "Bearer chatbot-user");
    expect(me.status).toBe(200);
    userId = me.body.userId;

    const chatbot = new ChatbotService(db, {
      overlayTokens: built.services.overlayTokens,
      liveGameBroker: built.services.liveGameBroker,
      games: built.services.games,
      logger: pino({ level: "silent" }),
    });
    chatApp = express();
    chatApp.use(
      "/v1",
      buildChatbotRouter({ chatbot, logger: pino({ level: "silent" }) }),
    );
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    built.services.liveGameBroker.clear();
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function mintToken(label) {
    const res = await request(built.app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer chatbot-user")
      .send({ label })
      .set("content-type", "application/json");
    expect(res.status).toBe(201);
    return res.body.token;
  }

  function expectChatLine(res) {
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.headers["content-type"]).toMatch(/utf-8/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).not.toContain("\n");
    expect(res.text.length).toBeLessThanOrEqual(380);
  }

  async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("waitFor timed out");
  }

  test("unknown token → plain-text 404 on all three endpoints", async () => {
    for (const leaf of ["opponent", "mmr", "build"]) {
      const res = await request(chatApp).get(`/v1/chatbot/not-a-token/${leaf}`);
      expect(res.status).toBe(404);
      expectChatLine(res);
      expect(res.text).toBe("Unknown token.");
    }
  });

  test("revoked token → 404", async () => {
    const token = await mintToken("revoked");
    await request(built.app)
      .delete(`/v1/overlay-tokens/${token}`)
      .set("authorization", "Bearer chatbot-user");
    const res = await request(chatApp).get(`/v1/chatbot/${token}/opponent`);
    expect(res.status).toBe(404);
    expect(res.text).toBe("Unknown token.");
  });

  test("opponent — live snapshot path (broker envelope + enrichment)", async () => {
    const token = await mintToken("live");
    // Prior history with the opponent so the enrichment has H2H +
    // a last-meeting row to surface.
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-777",
      pulseCharacterId: "777",
      displayNameSample: "Foe",
      race: "Zerg",
      wins: 2,
      losses: 1,
      gameCount: 3,
      mmr: 4200,
      lastSeen: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await db.games.insertOne({
      userId,
      gameId: "g-prior-1",
      date: new Date(Date.now() - 24 * 60 * 60 * 1000),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "P - Stargate",
      map: "Goldenaura",
      durationSec: 720,
      opponent: {
        displayName: "Foe",
        race: "Zerg",
        pulseId: "1-S2-1-777",
        pulseCharacterId: "777",
        mmr: 4200,
      },
    });
    // Publish the agent's live envelope the same way POST /v1/agent/live
    // does — broker.publish() — and wait for the async enrichment
    // (streamerHistory) to replace the cached envelope.
    built.services.liveGameBroker.publish(userId, {
      type: "liveGameState",
      phase: "match_in_progress",
      gameKey: "live-1",
      capturedAt: Date.now() / 1000,
      user: { name: "Streamer" },
      players: [
        { name: "Streamer", type: "user", race: "Protoss", result: "Undecided" },
        { name: "Foe", type: "user", race: "Zerg", result: "Undecided" },
      ],
      opponent: {
        name: "Foe",
        race: "Zerg",
        toonHandle: "1-S2-1-777",
        profile: {
          name: "Foe",
          pulse_character_id: 777,
          mmr: 4250,
          league: "Diamond",
          league_tier: 2,
          region: "EU",
        },
      },
    });
    await waitFor(() => {
      const env = built.services.liveGameBroker.latest(userId);
      return Boolean(env && env.streamerHistory && env.streamerHistory.headToHead);
    });

    const res = await request(chatApp).get(`/v1/chatbot/${token}/opponent`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toContain("Now vs Foe");
    expect(res.text).toContain("Zerg");
    expect(res.text).toContain("4250 MMR");
    expect(res.text).toContain("Diamond 2");
    expect(res.text).toContain("H2H 2-1.");
    expect(res.text).toContain("Last meeting: Win on Goldenaura");
  });

  test("opponent — cached post-game payload fallback when no live envelope", async () => {
    const token = await mintToken("postgame");
    // Same cache the games-ingest path stamps via
    // broker.setLatestOverlayLive after buildFromGame.
    built.services.liveGameBroker.setLatestOverlayLive(userId, {
      oppName: "Bar",
      oppRace: "Terran",
      oppMmr: 3900,
      result: "win",
      map: "Goldenaura",
      headToHead: { wins: 3, losses: 2 },
    });
    const res = await request(chatApp).get(`/v1/chatbot/${token}/opponent`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toContain("Last opponent: Bar (Terran, 3900 MMR).");
    expect(res.text).toContain("Win on Goldenaura.");
    expect(res.text).toContain("H2H 3-2.");
  });

  test("opponent — last-game-row fallback when the broker is cold", async () => {
    const token = await mintToken("lastgame");
    await db.games.insertOne({
      userId,
      gameId: "g-last-1",
      date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      result: "Defeat",
      myRace: "Protoss",
      myBuild: "P - Stargate",
      map: "Alcyone",
      durationSec: 600,
      opponent: {
        displayName: "Zergling",
        race: "Zerg",
        mmr: 4100,
        pulseId: "1-S2-1-888",
      },
    });
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-888",
      displayNameSample: "Zergling",
      race: "Zerg",
      wins: 1,
      losses: 4,
      gameCount: 5,
    });
    const res = await request(chatApp).get(`/v1/chatbot/${token}/opponent`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toContain("Last opponent: Zergling (Zerg, 4100 MMR).");
    expect(res.text).toContain("Loss on Alcyone, 2d ago.");
    expect(res.text).toContain("H2H 1-4.");
  });

  test('opponent — "No opponent data yet." when nothing is known', async () => {
    const token = await mintToken("empty-opp");
    const res = await request(chatApp).get(`/v1/chatbot/${token}/opponent`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toBe("No opponent data yet.");
  });

  test("mmr — current MMR, session delta, W-L and streak", async () => {
    const token = await mintToken("mmr");
    const now = Date.now();
    await db.games.insertMany([
      {
        userId,
        gameId: "g-mmr-1",
        date: new Date(now - 2 * 60 * 1000),
        result: "Victory",
        myMmr: 4300,
        myRace: "Protoss",
        opponent: { displayName: "A", race: "Zerg" },
      },
      {
        userId,
        gameId: "g-mmr-2",
        date: new Date(now - 60 * 1000),
        result: "Victory",
        myMmr: 4325,
        myRace: "Protoss",
        opponent: { displayName: "B", race: "Terran" },
      },
    ]);
    const res = await request(chatApp).get(`/v1/chatbot/${token}/mmr`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toContain("MMR 4325");
    expect(res.text).toContain("(+25 today)");
    expect(res.text).toContain("Session 2W-0L");
    expect(res.text).toContain("(W2 streak)");
  });

  test('mmr — "No MMR data yet." for a user with no games at all', async () => {
    const token = await mintToken("mmr-empty");
    const res = await request(chatApp).get(`/v1/chatbot/${token}/mmr`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toBe("No MMR data yet.");
  });

  test("build — last classifier-tagged opener from the game row", async () => {
    const token = await mintToken("build");
    await db.games.insertOne({
      userId,
      gameId: "g-build-1",
      date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      result: "Defeat",
      myRace: "Protoss",
      myBuild: "P - Stargate",
      map: "Alcyone",
      opponent: { displayName: "Zergling", race: "Zerg" },
    });
    const res = await request(chatApp).get(`/v1/chatbot/${token}/build`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toBe("Last opener: P - Stargate (PvZ, Loss on Alcyone, 2d ago)");
  });

  test('build — "No build data yet." when no game carries a tag', async () => {
    const token = await mintToken("build-empty");
    await db.games.insertOne({
      userId,
      gameId: "g-untagged-1",
      date: new Date(),
      result: "Victory",
      myRace: "Protoss",
      opponent: { displayName: "A", race: "Zerg" },
    });
    const res = await request(chatApp).get(`/v1/chatbot/${token}/build`);
    expect(res.status).toBe(200);
    expectChatLine(res);
    expect(res.text).toBe("No build data yet.");
  });

  test("rate limit — 31st request in a minute on one token is a plain-text 429", async () => {
    const token = await mintToken("ratelimit");
    for (let i = 0; i < CHATBOT_RATE_LIMIT_PER_MIN; i += 1) {
      const ok = await request(chatApp).get(`/v1/chatbot/${token}/mmr`);
      expect(ok.status).toBe(200);
    }
    const blocked = await request(chatApp).get(`/v1/chatbot/${token}/mmr`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["content-type"]).toMatch(/text\/plain/);
    expect(blocked.text).toBe("Rate limited. Try again in a minute.");
    // The bucket is per token — a different token is unaffected.
    const other = await mintToken("ratelimit-other");
    const fresh = await request(chatApp).get(`/v1/chatbot/${other}/mmr`);
    expect(fresh.status).toBe(200);
  });
});
