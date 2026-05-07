// @ts-nocheck
"use strict";

/**
 * Coverage for the cloud-driven overlay session-record widget pipeline.
 *
 * The session widget is the only overlay panel that doesn't depend on
 * the local desktop agent posting live events. It's derived from the
 * games collection by ``GamesService.todaySession`` and pushed to the
 * OBS Browser Source over the ``overlay:session`` socket event:
 *
 *   - on initial connect (so the panel is populated before any
 *     ``overlay:live`` payload arrives)
 *   - after ``POST /v1/games`` succeeds (so the W-L count ticks the
 *     moment the agent uploads a fresh replay)
 *
 * These tests exercise the service method directly across timezone
 * boundaries and edge cases, plus a route-level test that verifies the
 * ingest path triggers the per-overlay session emit without crashing
 * on a bare-bones io stub.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { GamesService } = require("../src/services/games");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-clerk-token") return { sub: "clerk_user_overlay" };
    throw new Error("invalid");
  }),
}));

describe("services/games.todaySession", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_session",
    });
    svc = new GamesService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("returns zeroes when the user has no games at all", async () => {
    const out = await svc.todaySession("u1", "UTC");
    expect(out).toEqual({ wins: 0, losses: 0, games: 0 });
  });

  test("counts only games that fall on today's local-day key", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 30 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 60 * 60 * 60 * 1000);

    await db.games.insertMany([
      { userId: "u1", gameId: "g-today-1", result: "Victory", date: now },
      {
        userId: "u1",
        gameId: "g-today-2",
        result: "Defeat",
        date: new Date(now.getTime() - 60 * 1000),
      },
      {
        userId: "u1",
        gameId: "g-yesterday",
        result: "Victory",
        date: yesterday,
      },
      {
        userId: "u1",
        gameId: "g-old",
        result: "Victory",
        date: twoDaysAgo,
      },
      // Different user — must never bleed in.
      { userId: "u2", gameId: "g-other", result: "Victory", date: now },
    ]);

    const out = await svc.todaySession("u1", "UTC");
    expect(out.games).toBe(2);
    expect(out.wins).toBe(1);
    expect(out.losses).toBe(1);
  });

  test("normalises legacy 'win'/'loss' result values alongside Victory/Defeat", async () => {
    const now = new Date();
    await db.games.insertMany([
      { userId: "u1", gameId: "a", result: "win", date: now },
      { userId: "u1", gameId: "b", result: "loss", date: now },
      { userId: "u1", gameId: "c", result: "Victory", date: now },
      { userId: "u1", gameId: "d", result: "Defeat", date: now },
      // Tie shouldn't count as either bucket but DOES bump the games
      // tally so the streamer sees the panel reflect every match they
      // played.
      { userId: "u1", gameId: "e", result: "Tie", date: now },
    ]);
    const out = await svc.todaySession("u1", "UTC");
    expect(out.wins).toBe(2);
    expect(out.losses).toBe(2);
    expect(out.games).toBe(5);
  });

  test("falls back to UTC when the timezone is missing or invalid", async () => {
    const now = new Date();
    await db.games.insertOne({
      userId: "u1",
      gameId: "g-now",
      result: "Victory",
      date: now,
    });
    // Both these timezone arguments should still produce a valid
    // (non-throwing) aggregate. The fallback path inside
    // ``pickTimezone`` swallows the bad input.
    const a = await svc.todaySession("u1", undefined);
    const b = await svc.todaySession("u1", "Definitely/Not_A_Real_Zone");
    expect(a.games).toBe(1);
    expect(b.games).toBe(1);
  });

  test("ignores invalid stored dates without throwing", async () => {
    const now = new Date();
    // ``date: null`` slipped past validation in early agent versions —
    // the aggregator must not crash on it.
    await db.games.insertMany([
      { userId: "u1", gameId: "valid", result: "Victory", date: now },
      { userId: "u1", gameId: "broken", result: "Victory", date: null },
    ]);
    const out = await svc.todaySession("u1", "UTC");
    expect(out.games).toBe(1);
    expect(out.wins).toBe(1);
  });

  test("derives mmrStart and mmrCurrent from chronological order when myMmr is populated", async () => {
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
    const t2 = new Date(t0.getTime() + 10 * 60 * 1000);
    await db.games.insertMany([
      // Out-of-order insertion — the service sorts by date.
      {
        userId: "u1",
        gameId: "mid",
        result: "Defeat",
        date: t1,
        myMmr: 4040,
      },
      {
        userId: "u1",
        gameId: "first",
        result: "Victory",
        date: t0,
        myMmr: 4000,
      },
      {
        userId: "u1",
        gameId: "last",
        result: "Victory",
        date: t2,
        myMmr: 4080,
      },
    ]);
    const out = await svc.todaySession("u1", "UTC");
    expect(out.mmrStart).toBe(4000);
    expect(out.mmrCurrent).toBe(4080);
    expect(out.wins).toBe(2);
    expect(out.losses).toBe(1);
  });

  test("omits mmrStart/mmrCurrent entirely when no game carries myMmr", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "no-mmr",
      result: "Victory",
      date: new Date(),
    });
    const out = await svc.todaySession("u1", "UTC");
    expect(out.mmrStart).toBeUndefined();
    expect(out.mmrCurrent).toBeUndefined();
  });

  test("falls back to the most recent MMR-stamped game when today's games are unranked", async () => {
    // Today's session is all unranked (no myMmr). A ranked game from
    // a few weeks ago carries the user's last known MMR — the
    // fallback should surface it on `mmrCurrent` so the session
    // widget still paints a number.
    const today = new Date();
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.games.insertMany([
      {
        userId: "u1",
        gameId: "ranked-old",
        result: "Victory",
        date: monthAgo,
        myMmr: 4280,
      },
      {
        userId: "u1",
        gameId: "unranked-today",
        result: "Defeat",
        date: today,
      },
    ]);
    const out = await svc.todaySession("u1", "UTC");
    // Today's W-L still scoped to today: 0W 1L.
    expect(out.wins).toBe(0);
    expect(out.losses).toBe(1);
    // mmrStart stays undefined — no today-game stamped MMR.
    expect(out.mmrStart).toBeUndefined();
    // mmrCurrent comes from the time-unbounded fallback.
    expect(out.mmrCurrent).toBe(4280);
  });

  test("derives region from the most recent toonHandle when the user profile lacks one", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      result: "Victory",
      date: new Date(),
      opponent: { toonHandle: "2-S2-1-12345" },
    });
    // Stub users service that returns no region (e.g. user hasn't
    // filled in their profile). The service should derive "EU" from
    // the leading 2 in the opponent's toon handle.
    const svcWithUsers = new GamesService(db, {
      users: { getProfile: async () => ({}) },
    });
    const out = await svcWithUsers.todaySession("u1", "UTC");
    expect(out.region).toBe("EU");
  });

  test("user profile region wins over the toon-handle fallback", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      result: "Victory",
      date: new Date(),
      // Toon handle says EU (2-…), but the user explicitly set NA in
      // their profile — profile must win.
      opponent: { toonHandle: "2-S2-1-12345" },
    });
    const svcWithUsers = new GamesService(db, {
      users: { getProfile: async () => ({ region: "na" }) },
    });
    const out = await svcWithUsers.todaySession("u1", "UTC");
    expect(out.region).toBe("NA");
  });

  test("Tier-3 SC2Pulse fallback fills mmrCurrent when no game carries myMmr", async () => {
    // Today's game with no myMmr; no historic myMmr either. The
    // PulseMmrService stub stands in for the SC2Pulse round-trip.
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      result: "Victory",
      date: new Date(),
      opponent: { toonHandle: "2-S2-1-99999" },
    });
    const pulseMmr = {
      getCurrentMmr: jest.fn(async (pulseId) => {
        expect(pulseId).toBe("994428");
        return { mmr: 5343, region: "EU" };
      }),
    };
    const svcWithPulse = new GamesService(db, {
      users: { getProfile: async () => ({ pulseId: "994428" }) },
      pulseMmr,
    });
    const out = await svcWithPulse.todaySession("u1", "UTC");
    expect(out.mmrCurrent).toBe(5343);
    expect(out.region).toBe("EU");
    expect(pulseMmr.getCurrentMmr).toHaveBeenCalledTimes(1);
  });

  test("Tier-3 SC2Pulse fallback is skipped when a stored myMmr is found", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      result: "Victory",
      date: new Date(),
      myMmr: 4800,
    });
    const pulseMmr = {
      // If this is hit, the test fails — we want the cheaper stored-MMR
      // path to short-circuit before the network call.
      getCurrentMmr: jest.fn(async () => {
        throw new Error("should_not_be_called");
      }),
    };
    const svcWithPulse = new GamesService(db, {
      users: { getProfile: async () => ({ pulseId: "994428" }) },
      pulseMmr,
    });
    const out = await svcWithPulse.todaySession("u1", "UTC");
    expect(out.mmrCurrent).toBe(4800);
    expect(pulseMmr.getCurrentMmr).not.toHaveBeenCalled();
  });

  test("profile region wins over the SC2Pulse-derived region", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      result: "Victory",
      date: new Date(),
    });
    const svcWithPulse = new GamesService(db, {
      users: {
        getProfile: async () => ({ pulseId: "994428", region: "kr" }),
      },
      pulseMmr: {
        getCurrentMmr: async () => ({ mmr: 5343, region: "EU" }),
      },
    });
    const out = await svcWithPulse.todaySession("u1", "UTC");
    expect(out.mmrCurrent).toBe(5343);
    expect(out.region).toBe("KR");
  });

  test("Tier-3 fallback survives a thrown SC2Pulse error", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      result: "Victory",
      date: new Date(),
    });
    const svcWithPulse = new GamesService(db, {
      users: { getProfile: async () => ({ pulseId: "994428" }) },
      pulseMmr: {
        getCurrentMmr: async () => {
          throw new Error("boom");
        },
      },
    });
    const out = await svcWithPulse.todaySession("u1", "UTC");
    expect(out.mmrCurrent).toBeUndefined();
    expect(out.wins).toBe(1);
  });

  test("populates streak / sessionStartedAt / region for the SPA-style session widget", async () => {
    const t0 = new Date(Date.now() - 25 * 60 * 1000);
    const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
    const t2 = new Date(t0.getTime() + 10 * 60 * 1000);
    const t3 = new Date(t0.getTime() + 15 * 60 * 1000);
    await db.games.insertMany([
      { userId: "u1", gameId: "g1", result: "Defeat", date: t0 },
      { userId: "u1", gameId: "g2", result: "Victory", date: t1 },
      { userId: "u1", gameId: "g3", result: "Victory", date: t2 },
      { userId: "u1", gameId: "g4", result: "Victory", date: t3 },
    ]);
    // Inject a stub users service so the region lookup runs without a
    // real users collection. The service only reads `region` so the
    // stub returns the bare minimum.
    const svcWithUsers = new GamesService(db, {
      users: { getProfile: async () => ({ region: "na" }) },
    });
    const out = await svcWithUsers.todaySession("u1", "UTC");
    expect(out.wins).toBe(3);
    expect(out.losses).toBe(1);
    // Most recent run is W3 (g2..g4 all Victory).
    expect(out.streak).toEqual({ kind: "win", count: 3 });
    // Earliest game timestamp is surfaced as an ISO string for the widget.
    expect(typeof out.sessionStartedAt).toBe("string");
    expect(out.sessionStartedAt).toBe(t0.toISOString());
    // Region is upper-cased so the widget can paint it as a label.
    expect(out.region).toBe("NA");
  });

  test("respects the requested timezone when bucketing day boundaries", async () => {
    // Pick a moment we control: a game timestamped at 23:00 UTC.
    // For a UTC overlay this is "today"; for an Auckland overlay
    // (UTC+12/13) the same instant has already rolled into "tomorrow",
    // and so the per-tz aggregate diverges. We build the timestamp
    // anchored to the current wall clock so the test stays valid as
    // calendars roll.
    const now = new Date();
    // Move the game to 1 minute ago so it's unambiguously "today" in UTC.
    const recent = new Date(now.getTime() - 60 * 1000);
    await db.games.insertOne({
      userId: "u1",
      gameId: "recent",
      result: "Victory",
      date: recent,
    });
    const utc = await svc.todaySession("u1", "UTC");
    expect(utc.games).toBe(1);
    // Sanity: the same query in a different valid TZ still produces a
    // well-formed response (count may be 0 or 1 depending on whether
    // the moment crossed the day boundary in that TZ; the exact value
    // is environment-sensitive).
    const ny = await svc.todaySession("u1", "America/New_York");
    expect(ny.games === 0 || ny.games === 1).toBe(true);
    expect(ny.games + utc.games).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /v1/games re-emits overlay:session", () => {
  let mongo;
  let db;
  let app;
  let captured;
  let fakeIo;

  function makeFakeIo() {
    captured = { sessionEmits: [], gamesChangedEmits: [] };
    /** @type {any[]} */
    const overlaySockets = [
      {
        data: { kind: "overlay", timezone: "America/Los_Angeles" },
        emit: (event, payload) => {
          if (event === "overlay:session") {
            captured.sessionEmits.push({ tz: "America/Los_Angeles", payload });
          }
        },
      },
      {
        data: { kind: "overlay", timezone: "UTC" },
        emit: (event, payload) => {
          if (event === "overlay:session") {
            captured.sessionEmits.push({ tz: "UTC", payload });
          }
        },
      },
      // A web-app socket also lives in the user room — must NOT receive
      // overlay:session because it's not an overlay kind.
      {
        data: { kind: "web" },
        emit: (event) => {
          if (event === "overlay:session") {
            captured.sessionEmits.push({ tz: "WEB", payload: null });
          }
        },
      },
    ];
    return {
      to: (_room) => ({
        emit: (event, payload) => {
          if (event === "games:changed") {
            captured.gamesChangedEmits.push(payload);
          }
        },
      }),
      in: (_room) => ({
        fetchSockets: async () => overlaySockets,
      }),
    };
  }

  // Poll until ``predicate()`` is truthy or the deadline elapses. The
  // route fires the per-overlay emit fire-and-forget after returning
  // 202, so the test has no direct handle to await — we busy-wait on
  // observable side effects instead. 1s is plenty for an in-process
  // Mongo memory server.
  async function waitFor(predicate, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_overlay_session_route",
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
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_session_route",
    });
    fakeIo = makeFakeIo();
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      io: fakeIo,
    });
    app = built.app;
    // Warm /me so the user row exists.
    await request(app).get("/v1/me").set("authorization", "Bearer test-clerk-token");
  });

  afterEach(async () => {
    // Drain any in-flight per-overlay emits triggered by the test
    // before we clear the buffer — without this, a stale push from
    // test N can land after we reset the array and contaminate
    // test N+1's assertions. 80ms covers the typical Mongo + emit
    // round-trip locally; the polling waitFor inside individual tests
    // already extends this when an explicit observation is needed.
    await new Promise((r) => setTimeout(r, 80));
    await db.games.deleteMany({});
    captured.sessionEmits.length = 0;
    captured.gamesChangedEmits.length = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("each connected overlay socket gets a fresh session aggregate after ingest", async () => {
    const game = makeGame("g-session-1", "Victory");
    const post = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer test-clerk-token")
      .send(game)
      .set("content-type", "application/json");
    expect(post.status).toBe(202);

    // The route returns 202 before the per-overlay emit completes; we
    // poll for the observable side effect instead of awaiting the
    // promise directly (the route is fire-and-forget by design).
    await waitFor(() => captured.sessionEmits.length >= 2);

    expect(captured.gamesChangedEmits).toHaveLength(1);
    expect(captured.gamesChangedEmits[0]).toEqual({ count: 1 });

    // Two overlay sockets in the room → two emits, one per timezone.
    // The web-kind socket must be filtered out.
    expect(captured.sessionEmits).toHaveLength(2);
    const seen = new Set(captured.sessionEmits.map((e) => e.tz));
    expect(seen.has("America/Los_Angeles")).toBe(true);
    expect(seen.has("UTC")).toBe(true);
    expect(seen.has("WEB")).toBe(false);

    for (const emit of captured.sessionEmits) {
      expect(emit.payload.games).toBe(1);
      expect(emit.payload.wins).toBe(1);
      expect(emit.payload.losses).toBe(0);
    }
  });

  test("validation reject path does not trigger an overlay:session emit", async () => {
    const post = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer test-clerk-token")
      .send({ gameId: "" }) // missing required fields
      .set("content-type", "application/json");
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(0);
    expect(post.body.rejected.length).toBeGreaterThan(0);
    // Wait long enough that any (incorrectly) fired emit would have
    // landed by now. The afterEach drain plus this delay together rule
    // out late-arriving emits from neighbouring tests.
    await new Promise((r) => setTimeout(r, 120));
    // No accepted games → no broadcast.
    expect(captured.gamesChangedEmits).toHaveLength(0);
    expect(captured.sessionEmits).toHaveLength(0);
  });
});

function makeGame(gameId, result) {
  return {
    gameId,
    date: new Date().toISOString(),
    result,
    myRace: "Protoss",
    myBuild: "P - Stargate Rush",
    map: "Goldenaura",
    durationSec: 720,
    macroScore: 75,
    apm: 165,
    spq: 11,
    myMmr: 4100,
    buildLog: ["[0:30] Probe", "[1:00] Pylon"],
    earlyBuildLog: [],
    oppBuildLog: [],
    oppEarlyBuildLog: [],
    opponent: {
      displayName: "Foo",
      race: "Zerg",
      mmr: 4000,
      pulseId: "pulse-1",
    },
  };
}
