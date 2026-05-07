// @ts-nocheck
"use strict";

/**
 * Integration tests for the operational admin surface
 * (``/v1/admin/*`` + AdminService).
 *
 * Covers
 * ------
 *   - 403 gating for non-admin callers.
 *   - Storage stats: returns the expected shape and skips collections
 *     that don't exist yet (NamespaceNotFound).
 *   - Users list: aggregates game counts + first/last activity, joins
 *     in the user identity, paginates by lastActivity cursor.
 *   - User detail: combines games + opponents into one snapshot.
 *   - Rebuild opponents (admin tools "Fix counters" path): deletes
 *     and re-derives the opponents collection from games.
 *   - Wipe games: cascades through GdprService.
 *   - Health: reports ok=true after Mongo ping.
 *
 * Setup
 * -----
 * Real ``mongodb-memory-server`` + the full ``buildApp`` pipeline,
 * same pattern the rest of the integration tests use. No mocks of
 * AdminService internals — we exercise the public HTTP surface.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "admin-token") return { sub: "clerk_admin" };
    if (token === "user-token") return { sub: "clerk_regular_user" };
    throw new Error("invalid");
  }),
}));

const SAMPLE_GAME = (overrides = {}) => ({
  gameId: "2026-05-07T12:00:00|Deroke|Celestial Enclave LE|836",
  date: "2026-05-07T12:00:00.000Z",
  result: "Victory",
  myRace: "Protoss",
  map: "Celestial Enclave LE",
  durationSec: 836,
  buildLog: ["[0:00] Nexus", "[0:17] Pylon"],
  oppBuildLog: ["[0:00] Nexus", "[0:30] Pylon"],
  opponent: {
    pulseId: "1-S2-1-3748829",
    toonHandle: "1-S2-1-3748829",
    pulseCharacterId: "4597144",
    displayName: "Deroke",
    race: "Protoss",
    mmr: 4500,
    leagueId: 6,
    opening: "Protoss DT Rush",
  },
  ...overrides,
});

describe("/v1/admin", () => {
  let mongo;
  let db;
  let app;
  let services;
  let adminUserId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_admin",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 9),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: ["clerk_admin"],
    gameDetailsStore: "mongo",
    r2: null,
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.gameDetails.deleteMany({});
    await db.opponents.deleteMany({});
    await db.users.deleteMany({});
    // Bootstrap the admin's own user row by hitting /v1/me.
    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer admin-token");
    expect(me.status).toBe(200);
    adminUserId = me.body.userId;
  });

  function asAdmin(req) {
    return req.set("authorization", "Bearer admin-token");
  }
  function asUser(req) {
    return req.set("authorization", "Bearer user-token");
  }

  test("non-admins get 403 on every admin endpoint", async () => {
    const meUser = await asUser(request(app).get("/v1/me"));
    expect(meUser.status).toBe(200);
    expect(meUser.body.isAdmin).toBe(false);

    const probes = [
      ["GET", "/v1/admin/storage-stats"],
      ["GET", "/v1/admin/users"],
      ["GET", "/v1/admin/users/u_1"],
      ["GET", "/v1/admin/health"],
      ["POST", "/v1/admin/users/u_1/rebuild-opponents"],
      ["POST", "/v1/admin/me/rebuild-opponents"],
      ["POST", "/v1/admin/users/u_1/wipe-games"],
    ];
    for (const [method, path] of probes) {
      const fn = method === "GET" ? request(app).get(path) : request(app).post(path);
      const res = await asUser(fn);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "admin_only" } });
    }
  });

  test("storage-stats returns per-collection rows + totals", async () => {
    // Seed at least one game so games + game_details exist.
    await services.games.upsert(adminUserId, SAMPLE_GAME());
    const res = await asAdmin(request(app).get("/v1/admin/storage-stats"));
    expect(res.status).toBe(200);
    expect(typeof res.body.totalDocs).toBe("number");
    expect(typeof res.body.totalStorageBytes).toBe("number");
    const games = res.body.collections.find((c) => c.name === "games");
    expect(games).toBeTruthy();
    expect(games.count).toBe(1);
    // Collections that were never touched (e.g. ml_models) come back
    // as zero rows rather than missing — the dashboard still shows
    // the row so an admin can see the cap is unused.
    const mlModels = res.body.collections.find((c) => c.name === "ml_models");
    expect(mlModels).toBeTruthy();
    expect(mlModels.count).toBe(0);
  });

  test("listUsers aggregates game counts and joins user identity", async () => {
    await services.games.upsert(adminUserId, SAMPLE_GAME());
    await services.games.upsert(
      adminUserId,
      SAMPLE_GAME({
        gameId: "2026-05-07T13:00:00|Deroke|Celestial Enclave LE|901",
        date: "2026-05-07T13:00:00.000Z",
        result: "Defeat",
      }),
    );
    const res = await asAdmin(request(app).get("/v1/admin/users"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const u = res.body.items[0];
    expect(u.userId).toBe(adminUserId);
    expect(u.clerkUserId).toBe("clerk_admin");
    expect(u.gameCount).toBe(2);
    expect(typeof u.lastActivity).toBe("string");
    expect(new Date(u.lastActivity).toISOString()).toBe(
      "2026-05-07T13:00:00.000Z",
    );
  });

  test("userDetail returns games totals + top opponents", async () => {
    await services.games.upsert(adminUserId, SAMPLE_GAME());
    // Two games vs Deroke + one win vs a different opponent.
    await services.games.upsert(
      adminUserId,
      SAMPLE_GAME({
        gameId: "2026-05-07T13:00:00|Deroke|Celestial Enclave LE|901",
        date: "2026-05-07T13:00:00.000Z",
      }),
    );
    await services.games.upsert(
      adminUserId,
      SAMPLE_GAME({
        gameId: "2026-05-07T14:00:00|Other|Goldenaura|600",
        date: "2026-05-07T14:00:00.000Z",
        result: "Defeat",
        opponent: {
          pulseId: "1-S2-1-9999999",
          displayName: "Other",
          race: "Zerg",
          mmr: 4200,
        },
      }),
    );
    // Bump the per-opponent counters via the public ingest (the same
    // path the dashboard relies on) so the admin detail snapshot
    // reflects realistic state.
    await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer admin-token")
      .send(SAMPLE_GAME({
        gameId: "2026-05-07T15:00:00|Deroke|Celestial Enclave LE|600",
        date: "2026-05-07T15:00:00.000Z",
      }));

    const res = await asAdmin(
      request(app).get(`/v1/admin/users/${adminUserId}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(adminUserId);
    expect(res.body.games.total).toBeGreaterThanOrEqual(3);
    expect(res.body.opponents.total).toBeGreaterThanOrEqual(1);
    const top = res.body.opponents.top;
    expect(Array.isArray(top)).toBe(true);
    expect(top.length).toBeGreaterThanOrEqual(1);
    // Top entries are projected — no raw HMAC hashes leak through.
    expect(top[0]).not.toHaveProperty("displayNameHash");
  });

  test("rebuild-opponents drops + re-derives from games (counter fix)", async () => {
    // Seed two games vs Deroke through the public ingest so the
    // opponents counter starts at 2.
    await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer admin-token")
      .send(SAMPLE_GAME());
    await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer admin-token")
      .send(SAMPLE_GAME({
        gameId: "2026-05-07T13:00:00|Deroke|Celestial Enclave LE|901",
        date: "2026-05-07T13:00:00.000Z",
        result: "Defeat",
      }));
    // Manually inflate the counters to mimic the bug we're recovering
    // from — historically a re-sync would double-count.
    await db.opponents.updateOne(
      { userId: adminUserId, pulseId: SAMPLE_GAME().opponent.pulseId },
      { $inc: { gameCount: 5, wins: 5 } },
    );
    const inflated = await db.opponents.findOne({ userId: adminUserId });
    expect(inflated.gameCount).toBe(7);

    // Rebuild: counters reset to the source-of-truth (2 games).
    const res = await asAdmin(
      request(app).post(
        `/v1/admin/users/${adminUserId}/rebuild-opponents`,
      ),
    );
    expect(res.status).toBe(202);
    expect(res.body.userId).toBe(adminUserId);
    expect(res.body.droppedRows).toBeGreaterThanOrEqual(1);
    const fixed = await db.opponents.findOne({ userId: adminUserId });
    expect(fixed.gameCount).toBe(2);
    expect(fixed.wins).toBe(1);
    expect(fixed.losses).toBe(1);
  });

  test("rebuild-opponents-me hits the caller's own row", async () => {
    await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer admin-token")
      .send(SAMPLE_GAME());
    const res = await asAdmin(
      request(app).post("/v1/admin/me/rebuild-opponents"),
    );
    expect(res.status).toBe(202);
    expect(res.body.userId).toBe(adminUserId);
  });

  test("wipe-games removes games + game_details + opponents", async () => {
    await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer admin-token")
      .send(SAMPLE_GAME());
    expect(await db.games.countDocuments({ userId: adminUserId })).toBe(1);
    expect(await db.opponents.countDocuments({ userId: adminUserId })).toBe(1);

    const res = await asAdmin(
      request(app).post(`/v1/admin/users/${adminUserId}/wipe-games`),
    );
    expect(res.status).toBe(202);
    expect(res.body.games).toBe(1);
    expect(await db.games.countDocuments({ userId: adminUserId })).toBe(0);
    expect(await db.gameDetails.countDocuments({ userId: adminUserId })).toBe(0);
    expect(await db.opponents.countDocuments({ userId: adminUserId })).toBe(0);
  });

  test("health reports mongo ping success and the configured store kind", async () => {
    const res = await asAdmin(request(app).get("/v1/admin/health"));
    expect(res.status).toBe(200);
    expect(res.body.mongo.ok).toBe(true);
    expect(typeof res.body.mongo.latencyMs).toBe("number");
    expect(res.body.runtime.gameDetailsStore).toBe("mongo");
    expect(typeof res.body.runtime.nodeVersion).toBe("string");
  });
});
