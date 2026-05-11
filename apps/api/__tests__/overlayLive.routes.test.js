// @ts-nocheck
"use strict";

/**
 * HTTP-level coverage for the overlay-live broadcast pipeline:
 *
 *   - ``POST /v1/overlay-events/test`` — Settings → Overlay → "Test" fires
 *     a synthetic payload at one or every widget so streamers can validate
 *     their OBS layout without waiting for a real ladder match.
 *   - ``POST /v1/games`` — the ingest path wires
 *     ``OverlayLiveService.buildFromGame`` into a per-token broadcast that
 *     fans out to every active overlay token belonging to the user.
 *
 * Split out of the main ``overlayLive.test.js`` to keep that file under
 * the project's 800-line ceiling.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { OverlayLiveService } = require("../src/services/overlayLive");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-overlay-live") return { sub: "clerk_user_overlay_live" };
    throw new Error("invalid");
  }),
}));

describe("POST /v1/overlay-events/test", () => {
  let mongo;
  let db;
  let app;
  let captured;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_test_route",
    });
    captured = { liveEmits: [], sessionEmits: [] };
    const fakeIo = {
      to: (room) => ({
        emit: (event, payload) => {
          if (event === "overlay:live") {
            captured.liveEmits.push({ room, payload });
          } else if (event === "overlay:session") {
            captured.sessionEmits.push({ room, payload });
          }
        },
      }),
      in: () => ({ fetchSockets: async () => [] }),
    };
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: {
        port: 0,
        nodeEnv: "test",
        logLevel: "silent",
        mongoUri: "",
        mongoDb: "sc2tools_test_overlay_test_route",
        clerkSecretKey: "sk_test",
        clerkJwtIssuer: undefined,
        clerkJwtAudience: undefined,
        serverPepper: Buffer.alloc(32, 7),
        corsAllowedOrigins: [],
        rateLimitPerMinute: 5000,
        agentReleaseAdminToken: "admin",
        pythonExe: null,
        pythonAnalyzerDir: "/tmp/__nonexistent__",
        adminUserIds: [],
      },
      io: fakeIo,
    });
    app = built.app;
    // Warm /me so the user row exists for the overlay-token POST.
    await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer user-overlay-live");
  });

  afterEach(() => {
    captured.liveEmits.length = 0;
    captured.sessionEmits.length = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function mintToken() {
    const res = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "Test" })
      .set("content-type", "application/json");
    expect(res.status).toBe(201);
    return res.body.token;
  }

  test("400 when token missing", async () => {
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({})
      .set("content-type", "application/json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  test("404 when the token doesn't belong to the caller", async () => {
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token: "definitely-not-a-real-token" })
      .set("content-type", "application/json");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  test("emits a full sample payload to overlay:<token> when no widget is named", async () => {
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(res.body.widget).toBe("all");
    expect(captured.liveEmits).toHaveLength(1);
    expect(captured.liveEmits[0].room).toBe(`overlay:${token}`);
    // Every widget's primary field is in the payload.
    const p = captured.liveEmits[0].payload;
    expect(p.headToHead).toBeDefined();
    expect(p.streak).toBeDefined();
    expect(p.cheeseProbability).toBeGreaterThanOrEqual(0.4);
    expect(p.topBuilds).toBeDefined();
    expect(p.session).toBeDefined();
    // ``session`` widget needs the dedicated overlay:session event too,
    // since that's the channel its renderer listens on.
    expect(captured.sessionEmits).toHaveLength(1);
  });

  test("emits a narrowed payload when a single widget is named", async () => {
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token, widget: "opponent" })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(res.body.widget).toBe("opponent");
    expect(captured.liveEmits).toHaveLength(1);
    const p = captured.liveEmits[0].payload;
    expect(p.oppName).toBeTruthy();
    expect(p.headToHead).toBeDefined();
    // Other widgets stay quiet so neighbouring panels don't strobe.
    expect(p.streak).toBeUndefined();
    expect(p.topBuilds).toBeUndefined();
    // Single-widget probe of a non-session widget shouldn't fire the
    // session event either.
    expect(captured.sessionEmits).toHaveLength(0);
  });

  test("session-widget probe also fires the dedicated overlay:session event", async () => {
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token, widget: "session" })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(captured.liveEmits).toHaveLength(1);
    expect(captured.sessionEmits).toHaveLength(1);
    expect(captured.sessionEmits[0].payload.wins).toBeGreaterThanOrEqual(0);
  });

  test("test-fired payloads carry isTest:true on both events", async () => {
    // The overlay clients use this flag to cap the normally-persistent
    // session/topbuilds widgets at a short visibility timer so a Test
    // click never pins sample data to the streamer's scene.
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(captured.liveEmits[0].payload.isTest).toBe(true);
    expect(captured.sessionEmits[0].payload.isTest).toBe(true);
  });

  test("real overlay:live broadcasts (from /v1/games) do NOT carry isTest", async () => {
    // The ingest path's payload comes from buildFromGame() which never
    // sets the flag, so production widgets keep their natural
    // durations and persistent panels stay persistent.
    const sample = OverlayLiveService.buildSamplePayload();
    expect(sample.isTest).toBeUndefined();
  });
});

describe("POST /v1/games triggers overlay:live broadcast", () => {
  let mongo;
  let db;
  let app;
  let captured;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_games_overlay_live",
    });
    captured = { liveEmits: [], gamesChanged: [] };
    const fakeIo = {
      to: (room) => ({
        emit: (event, payload) => {
          if (event === "overlay:live") {
            captured.liveEmits.push({ room, payload });
          } else if (event === "games:changed") {
            captured.gamesChanged.push({ room, payload });
          }
        },
      }),
      in: () => ({ fetchSockets: async () => [] }),
    };
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: {
        port: 0,
        nodeEnv: "test",
        logLevel: "silent",
        mongoUri: "",
        mongoDb: "sc2tools_test_games_overlay_live",
        clerkSecretKey: "sk_test",
        clerkJwtIssuer: undefined,
        clerkJwtAudience: undefined,
        serverPepper: Buffer.alloc(32, 8),
        corsAllowedOrigins: [],
        rateLimitPerMinute: 5000,
        agentReleaseAdminToken: "admin",
        pythonExe: null,
        pythonAnalyzerDir: "/tmp/__nonexistent__",
        adminUserIds: [],
      },
      io: fakeIo,
    });
    app = built.app;
    await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer user-overlay-live");
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    await db.overlayTokens.deleteMany({});
    captured.liveEmits.length = 0;
    captured.gamesChanged.length = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function waitFor(predicate, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("waitFor timed out");
  }

  test("a successful ingest fans overlay:live out to every active token", async () => {
    // Mint two active tokens + one revoked token. The revoked token
    // must NOT receive a live event.
    const a = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "main" })
      .set("content-type", "application/json");
    const b = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "second" })
      .set("content-type", "application/json");
    const c = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "revoked" })
      .set("content-type", "application/json");
    await request(app)
      .delete(`/v1/overlay-tokens/${c.body.token}`)
      .set("authorization", "Bearer user-overlay-live");

    const game = {
      gameId: "g-overlay-1",
      date: new Date().toISOString(),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "P - Stargate",
      map: "Goldenaura",
      durationSec: 720,
      myMmr: 4310,
      buildLog: ["[1:00] Pylon"],
      oppBuildLog: [],
      opponent: {
        displayName: "Foe",
        race: "Zerg",
        mmr: 4250,
        pulseId: "pulse-1",
        strategy: "Pool first",
      },
    };
    const post = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer user-overlay-live")
      .send(game)
      .set("content-type", "application/json");
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(1);

    await waitFor(() => captured.liveEmits.length >= 2);
    const rooms = captured.liveEmits.map((e) => e.room);
    expect(rooms).toContain(`overlay:${a.body.token}`);
    expect(rooms).toContain(`overlay:${b.body.token}`);
    expect(rooms).not.toContain(`overlay:${c.body.token}`);
    // Each emit carries the derived payload.
    for (const e of captured.liveEmits) {
      expect(e.payload.matchup).toBe("PvZ");
      expect(e.payload.result).toBe("win");
      expect(e.payload.rank).toEqual({ league: "Diamond", tier: 1, mmr: 4310 });
      // Cheese alert because the opponent's strategy is "Pool first".
      expect(e.payload.cheeseProbability).toBeGreaterThanOrEqual(0.4);
    }
  });

  test("a rejected ingest does not broadcast overlay:live", async () => {
    await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "main" })
      .set("content-type", "application/json");
    const post = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer user-overlay-live")
      .send({ gameId: "" }) // missing required fields
      .set("content-type", "application/json");
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(captured.liveEmits).toHaveLength(0);
    expect(captured.gamesChanged).toHaveLength(0);
  });
});
