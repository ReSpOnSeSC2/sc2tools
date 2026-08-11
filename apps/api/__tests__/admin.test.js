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
const { PulseMmrService } = require("../src/services/pulseMmr");

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
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      // Network-disabled pulse service: the fixtures carry REAL pulse
      // ids, so every ingest did a live SC2Pulse fetch — the
      // listOpponents test seeds 6 games and its ~6 × 8s network
      // budget rode right up to (and under load past) the 30s test
      // timeout. Failures are swallowed as "SC2Pulse unavailable",
      // same pattern as opponentsRecount.test.js.
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });
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
      ["GET", "/v1/admin/infrastructure"],
      ["GET", "/v1/admin/users"],
      ["GET", "/v1/admin/users/u_1"],
      ["GET", "/v1/admin/users/u_1/opponents"],
      ["GET", "/v1/admin/users/u_1/opponents/p_1/games"],
      ["GET", "/v1/admin/users/u_1/games/g_1/build-order"],
      ["GET", "/v1/admin/users/u_1/games/g_1/apm-curve"],
      ["GET", "/v1/admin/users/u_1/games/g_1/macro-breakdown"],
      ["GET", "/v1/admin/health"],
      ["GET", "/v1/admin/events"],
      ["GET", "/v1/admin/events/counts"],
      ["POST", "/v1/admin/events/mark-read"],
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
    expect(res.body.database.available).toBe(true);
    expect(res.body.database.appData.scope).toBe("sc2tools_database_only");
    expect(typeof res.body.database.appData.allocatedTotalBytes).toBe("number");
    expect(res.body.database.pricing).toMatchObject({
      monthlyPlanningEstimateUsd: 56.94,
      estimate: true,
    });
    expect(res.body.database.atlas).toMatchObject({
      configured: false,
      available: false,
      errorCode: "not_configured",
    });
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

  test("infrastructure returns private setup advisories without identifiers", async () => {
    const res = await asAdmin(
      request(app).get("/v1/admin/infrastructure"),
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      overallStatus: "watch",
      providers: {
        cloudflare: { configured: false, status: "watch" },
        mongo: {
          available: true,
          monitoringAvailable: false,
          status: "watch",
        },
        render: { configured: false, status: "watch" },
      },
    });
    expect(res.body.advisories.map((row) => row.code)).toEqual([
      "cloudflare_monitoring_not_configured",
      "atlas_monitoring_not_configured",
      "render_monitoring_not_configured",
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /mongodb:\/\/|srv-|rnd_|accountId|projectId|clusterName/,
    );
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

  test("listOpponents paginates, filters, and sorts the full history", async () => {
    // pulseId, name, race, result, date
    const seed = [
      ["1-S2-1-265393", "GoMeZ", "Zerg", "Victory", "2026-05-01T10:00:00.000Z"],
      ["1-S2-1-265393", "GoMeZ", "Zerg", "Victory", "2026-05-01T11:00:00.000Z"],
      ["1-S2-1-265393", "GoMeZ", "Zerg", "Defeat", "2026-05-01T12:00:00.000Z"],
      ["1-S2-1-3740123", "Salt", "Protoss", "Victory", "2026-05-02T10:00:00.000Z"],
      ["1-S2-1-3740123", "Salt", "Protoss", "Defeat", "2026-05-02T11:00:00.000Z"],
      ["1-S2-1-4262731", "Captain", "Zerg", "Victory", "2026-05-03T10:00:00.000Z"],
    ];
    for (const [pulseId, name, race, result, date] of seed) {
      const res = await request(app)
        .post("/v1/games")
        .set("authorization", "Bearer admin-token")
        .send(
          SAMPLE_GAME({
            gameId: `${date}|${name}|Map|600`,
            date,
            result,
            opponent: { pulseId, toonHandle: pulseId, displayName: name, race },
          }),
        );
      expect(res.status).toBeLessThan(300);
    }

    const base = `/v1/admin/users/${adminUserId}/opponents`;

    // Default: gameCount desc → GoMeZ(3), Salt(2), Captain(1).
    const all = await asAdmin(request(app).get(base));
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((o) => o.displayNameSample)).toEqual([
      "GoMeZ",
      "Salt",
      "Captain",
    ]);
    expect(all.body.items[0].wins).toBe(2);
    expect(all.body.items[0].losses).toBe(1);
    expect(all.body.items[0].winRate).toBeCloseTo(2 / 3);
    expect([...all.body.races].sort()).toEqual(["Protoss", "Zerg"]);
    expect(all.body.hasMore).toBe(false);

    // Race filter.
    const zerg = await asAdmin(request(app).get(`${base}?race=Zerg`));
    expect(zerg.body.total).toBe(2);
    expect(zerg.body.items.every((o) => o.race === "Zerg")).toBe(true);

    // Search by pulse-id fragment.
    const search = await asAdmin(request(app).get(`${base}?search=3740123`));
    expect(search.body.total).toBe(1);
    expect(search.body.items[0].displayNameSample).toBe("Salt");

    // minGames filter.
    const min2 = await asAdmin(request(app).get(`${base}?minGames=2`));
    expect(min2.body.total).toBe(2);

    // Offset pagination — limit 2 → page 0 (2 rows, more) then page 1 (1 row).
    const p0 = await asAdmin(request(app).get(`${base}?limit=2&page=0`));
    expect(p0.body.items).toHaveLength(2);
    expect(p0.body.hasMore).toBe(true);
    const p1 = await asAdmin(request(app).get(`${base}?limit=2&page=1`));
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.hasMore).toBe(false);

    // Sort by winRate asc → Salt(0.5), GoMeZ(0.667), Captain(1.0).
    const byWr = await asAdmin(
      request(app).get(`${base}?sort=winRate&order=asc`),
    );
    expect(byWr.body.items.map((o) => o.displayNameSample)).toEqual([
      "Salt",
      "GoMeZ",
      "Captain",
    ]);
    // Explicit timeout: this is the heaviest test in the suite — six
    // sequential full ingests through the HTTP + Mongo path, then nine
    // admin aggregations over the result. Network is already out of the
    // picture (see the pulseMmr stub in beforeAll; the resolver's own
    // fetch runs only in the admin-triggered backfill routes, not on
    // ingest), so what is left is genuinely compute-bound, and `npm
    // test` runs it --runInBand under coverage instrumentation. That
    // lands near enough to the 30 s default that a slower-than-usual CI
    // runner tips it over and fails main on an unrelated commit. Raising
    // it here rather than in jest.config.js keeps the 30 s ceiling
    // enforced for the other 1,466 tests, where a 30 s test really would
    // mean something hung.
  }, 90_000);

  test("opponent drill-down lists games and serves per-game build order", async () => {
    const pulseId = "1-S2-1-265393";
    const g1 = SAMPLE_GAME({
      gameId: "2026-05-08T10:00:00|GoMeZ|Map|600",
      date: "2026-05-08T10:00:00.000Z",
      result: "Victory",
      buildLog: ["[0:00] Nexus", "[0:17] Pylon", "[0:34] Gateway"],
      oppBuildLog: ["[0:00] Hatchery", "[0:12] Drone", "[0:40] Spawning Pool"],
      opponent: { pulseId, toonHandle: pulseId, displayName: "GoMeZ", race: "Zerg" },
    });
    const g2 = SAMPLE_GAME({
      gameId: "2026-05-08T11:00:00|GoMeZ|Map|700",
      date: "2026-05-08T11:00:00.000Z",
      result: "Defeat",
      opponent: { pulseId, toonHandle: pulseId, displayName: "GoMeZ", race: "Zerg" },
    });
    for (const g of [g1, g2]) {
      const res = await request(app)
        .post("/v1/games")
        .set("authorization", "Bearer admin-token")
        .send(g);
      expect(res.status).toBeLessThan(300);
    }

    // Games vs opponent — matched on the nested opponent.pulseId (no
    // top-level oppPulseId in this payload), newest first.
    const list = await asAdmin(
      request(app).get(
        `/v1/admin/users/${adminUserId}/opponents/${pulseId}/games`,
      ),
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0].gameId).toBe(g2.gameId); // newest first
    expect(list.body.items[0].opponent.displayName).toBe("GoMeZ");
    expect(list.body.items[1].result).toBe("Victory");

    // Per-game build order for an arbitrary user's game.
    const bo = await asAdmin(
      request(app).get(
        `/v1/admin/users/${adminUserId}/games/${encodeURIComponent(
          g1.gameId,
        )}/build-order`,
      ),
    );
    expect(bo.status).toBe(200);
    expect(bo.body.ok).toBe(true);
    expect(Array.isArray(bo.body.events)).toBe(true);
    expect(bo.body.events.length).toBeGreaterThan(0);
    expect(Array.isArray(bo.body.opp_events)).toBe(true);

    // Unknown game → 404.
    const missing = await asAdmin(
      request(app).get(
        `/v1/admin/users/${adminUserId}/games/${encodeURIComponent(
          "nope|x|y|1",
        )}/build-order`,
      ),
    );
    expect(missing.status).toBe(404);

    // APM + macro routes are wired and surface the not-computed state
    // (this seed game carries no apmCurve / macroBreakdown blob).
    const apm = await asAdmin(
      request(app).get(
        `/v1/admin/users/${adminUserId}/games/${encodeURIComponent(
          g1.gameId,
        )}/apm-curve`,
      ),
    );
    expect(apm.status).toBe(404);
    expect(apm.body.error.code).toBe("apm_not_computed");

    const macro = await asAdmin(
      request(app).get(
        `/v1/admin/users/${adminUserId}/games/${encodeURIComponent(
          g1.gameId,
        )}/macro-breakdown`,
      ),
    );
    expect(macro.status).toBe(404);
    expect(macro.body.error.code).toBe("macro_not_computed");
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
    expect(res.body.runtime.replayFilesStore).toBe("disabled");
    expect(res.body.runtime.infrastructureCostsConfigured).toBe(false);
    expect(res.body.runtime.capacityMonitoringConfigured).toBe(false);
    expect(typeof res.body.runtime.nodeVersion).toBe("string");
    expect(res.body.cloudflareAnalytics).toEqual({
      configured: false,
      available: false,
      stale: false,
      asOf: null,
      errorCode: "not_configured",
    });
    expect(res.body.mongo.storage.scope).toBe("sc2tools_database_only");
    expect(res.body.mongo.pricing.monthlyPlanningEstimateUsd).toBe(56.94);
    expect(res.body.mongo.atlas).toMatchObject({
      configured: false,
      available: false,
      credential: {
        expiresAt: null,
        daysRemaining: null,
        expiringSoon: false,
      },
      errorCode: "not_configured",
    });
    expect(res.body.render).toMatchObject({
      configured: false,
      available: false,
      errorCode: "not_configured",
    });
  });
});
