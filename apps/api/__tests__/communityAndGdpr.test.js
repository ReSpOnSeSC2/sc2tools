// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_a" };
    if (token === "user-b") return { sub: "clerk_user_b" };
    if (token === "admin-x") return { sub: "clerk_admin" };
    throw new Error("invalid");
  }),
}));

describe("community + gdpr integration", () => {
  let mongo;
  let db;
  let app;
  let services;
  let userAId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_comm",
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
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_comm" });
    // Resolve the internal user ids.
    const aRes = await db.users.insertOne({
      userId: "u_a",
      clerkUserId: "clerk_user_a",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    userAId = "u_a";
    await db.users.insertOne({
      userId: "u_admin",
      clerkUserId: "clerk_admin",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });

    // SC2TOOLS_ADMIN_USER_IDS holds *Clerk* user IDs (the `user_xxx`
    // strings from the Clerk dashboard), not internal UUIDs — match
    // the verifyToken mock above which returns sub: "clerk_admin"
    // for the "admin-x" bearer.
    config.adminUserIds = ["clerk_admin"];
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  describe("publishes a custom build then surfaces it publicly", () => {
    test("publish + list + detail", async () => {
      // Seed a private custom build for user A.
      await services.customBuilds.upsert("u_a", {
        slug: "my-build",
        name: "My PvT Macro",
        matchup: "PvT",
        steps: [{ supply: 14, time: "0:18", action: "Pylon" }],
      });

      const pub = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({ slug: "my-build", title: "Macro PvT", description: "Test" });
      expect(pub.status).toBe(201);
      expect(pub.body.slug).toBeTruthy();
      const slug = pub.body.slug;

      const list = await request(app).get("/v1/community/builds");
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBe(1);
      expect(list.body.items[0].title).toBe("Macro PvT");
      // Phase 9: ownerUserId is the internal UUID (not the Clerk id) and
      // is exposed publicly so the frontend can link to the author
      // profile page.
      expect(list.body.items[0].ownerUserId).toBe("u_a");
      expect(typeof list.body.total).toBe("number");
      expect(list.body.hasMore).toBe(false);

      const detail = await request(app).get(
        `/v1/community/builds/${slug}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.build).toBeTruthy();
      expect(detail.body.build.slug).toBe("my-build");
      expect(detail.body.ownerUserId).toBe("u_a");
      // Per-user vote arrays must NOT be returned publicly.
      expect(detail.body.upvotes).toBeUndefined();
      expect(detail.body.downvotes).toBeUndefined();
    });

    test("list supports sort=new and q= search", async () => {
      // Newest-first sort: the previously published build is the only
      // one in the collection, so it must appear regardless of sort.
      const newest = await request(app).get(
        "/v1/community/builds?sort=new",
      );
      expect(newest.status).toBe(200);
      expect(newest.body.items.length).toBeGreaterThan(0);

      const found = await request(app).get(
        "/v1/community/builds?q=macro",
      );
      expect(found.status).toBe(200);
      expect(found.body.items.length).toBeGreaterThan(0);

      const missed = await request(app).get(
        "/v1/community/builds?q=zzznonexistent",
      );
      expect(missed.status).toBe(200);
      expect(missed.body.items.length).toBe(0);
    });
  });

  describe("public author profile (Phase 10)", () => {
    test("404 when the author has no public name on any build", async () => {
      // u_a's only published build above carries no authorName, so the
      // implicit anonymization rule yields a 404.
      const res = await request(app).get("/v1/community/authors/u_a");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("author_not_found");
    });

    test("returns aggregate after the author publishes with a name", async () => {
      await services.customBuilds.upsert("u_a", {
        slug: "named-build",
        name: "Glaive Adept Timing",
        race: "Protoss",
        matchup: "PvT",
      });
      const pub = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({
          slug: "named-build",
          title: "Glaive Adept Timing",
          description: "Punish 1-1-1.",
          authorName: "Reaver",
        });
      expect(pub.status).toBe(201);

      const res = await request(app).get("/v1/community/authors/u_a");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("u_a");
      expect(res.body.displayName).toBe("Reaver");
      expect(Array.isArray(res.body.builds)).toBe(true);
      expect(res.body.builds.length).toBeGreaterThan(0);
      expect(typeof res.body.totalBuilds).toBe("number");
      expect(typeof res.body.totalVotes).toBe("number");
    });

    test("404 for unknown user id", async () => {
      const res = await request(app).get(
        "/v1/community/authors/u_does_not_exist",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("k-anonymous opponent profile", () => {
    test("returns 404 when fewer than 5 contributors", async () => {
      // Seed games from 3 users vs the same opponent.
      const opp = "1-S2-2-99999";
      for (let i = 0; i < 3; i++) {
        const u = `user_${i}`;
        await services.games.upsert(u, {
          gameId: `g_${i}`,
          date: new Date().toISOString(),
          result: "Victory",
          myRace: "Protoss",
          map: "Goldenaura",
          durationSec: 600,
          opponent: { pulseId: opp, displayName: "x", race: "Terran" },
        });
      }
      const res = await request(app).get(
        `/v1/community/opponents/${encodeURIComponent(opp)}`,
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("k_anon_threshold_not_met");
    });

    test("returns aggregate when ≥ 5 contributors", async () => {
      const opp = "1-S2-2-77777";
      for (let i = 0; i < 6; i++) {
        const u = `user_kx_${i}`;
        await services.games.upsert(u, {
          gameId: `gkx_${i}`,
          date: new Date().toISOString(),
          result: i % 2 === 0 ? "Victory" : "Defeat",
          myRace: "Zerg",
          map: "Inside and Out",
          durationSec: 600,
          opponent: {
            pulseId: opp,
            displayName: "x",
            race: "Protoss",
            opening: "Phoenix",
          },
        });
      }
      const res = await request(app).get(
        `/v1/community/opponents/${encodeURIComponent(opp)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.contributors).toBeGreaterThanOrEqual(5);
      expect(res.body.openings.Phoenix).toBeGreaterThan(0);
    });
  });

  describe("GDPR export + delete", () => {
    test("export bundles per-user collections", async () => {
      await services.games.upsert("u_a", {
        gameId: "ga_export_test",
        date: new Date().toISOString(),
        result: "Victory",
        myRace: "Protoss",
        map: "Test Map",
      });

      const res = await request(app)
        .get("/v1/me/export")
        .set("authorization", "Bearer user-a");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("u_a");
      expect(Array.isArray(res.body.data.games)).toBe(true);
      const myGame = res.body.data.games.find(
        (g) => g.gameId === "ga_export_test",
      );
      expect(myGame).toBeTruthy();
    });

    test("delete wipes per-user records", async () => {
      // Use a fresh user so we don't break the export test ordering.
      await db.users.insertOne({
        userId: "u_del",
        clerkUserId: "clerk_del",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      await services.games.upsert("u_del", {
        gameId: "g_to_be_deleted",
        date: new Date().toISOString(),
        result: "Defeat",
        myRace: "Terran",
        map: "M",
      });
      // Bypass the auth verify mock by calling the service directly,
      // since the integration test only knows clerk_user_a.
      const counts = await services.gdpr.deleteAll("u_del");
      expect(counts.games).toBeGreaterThanOrEqual(1);
      expect(counts.users).toBe(1);
      const after = await db.games.countDocuments({ userId: "u_del" });
      expect(after).toBe(0);
    });

    test("wipeGames clears games + rebuilds opponents from the survivors", async () => {
      const userId = "u_wipe";
      await db.users.insertOne({
        userId,
        clerkUserId: "clerk_wipe",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      // Two games against the same opponent. recordGame is called once
      // per upload via the route layer; here we mirror that so the
      // opponents counter starts at 2 (the state we expect after a
      // normal upload flow).
      const oldDate = new Date("2024-01-01T00:00:00Z");
      const newDate = new Date("2026-04-01T00:00:00Z");
      const opponent = {
        pulseId: "p_wipe_1",
        displayName: "WipeFoe",
        race: "Zerg",
      };
      await services.games.upsert(userId, {
        gameId: "g_wipe_old",
        date: oldDate.toISOString(),
        result: "Victory",
        myRace: "Protoss",
        map: "M1",
        opponent,
      });
      await services.opponents.recordGame(userId, {
        ...opponent,
        result: "Victory",
        playedAt: oldDate,
      });
      await services.games.upsert(userId, {
        gameId: "g_wipe_new",
        date: newDate.toISOString(),
        result: "Defeat",
        myRace: "Protoss",
        map: "M2",
        opponent,
      });
      await services.opponents.recordGame(userId, {
        ...opponent,
        result: "Defeat",
        playedAt: newDate,
      });

      expect(await db.games.countDocuments({ userId })).toBe(2);
      const before = await db.opponents.findOne({ userId, pulseId: "p_wipe_1" });
      expect(before.gameCount).toBe(2);

      // Wipe just the OLD game (date < 2025-01-01).
      const partial = await services.gdpr.wipeGames(userId, {
        until: new Date("2025-01-01T00:00:00Z"),
      });
      expect(partial.games).toBe(1);
      expect(await db.games.countDocuments({ userId })).toBe(1);
      const afterPartial = await db.opponents.findOne({
        userId,
        pulseId: "p_wipe_1",
      });
      // Opponents got rebuilt from the surviving game — counters reset
      // to 1 (one defeat, zero wins) instead of being half-decremented.
      expect(afterPartial.gameCount).toBe(1);
      expect(afterPartial.losses).toBe(1);
      expect(afterPartial.wins).toBe(0);

      // Now wipe everything — opponents collection should empty out.
      const full = await services.gdpr.wipeGames(userId);
      expect(full.games).toBe(1);
      expect(await db.games.countDocuments({ userId })).toBe(0);
      expect(await db.opponents.countDocuments({ userId })).toBe(0);

      // User row stays intact — wipeGames is scoped, unlike deleteAll.
      const userRow = await db.users.findOne({ userId });
      expect(userRow).not.toBeNull();
    });
  });

  describe("admin gating", () => {
    test("non-admin → 403 on admin endpoints", async () => {
      const res = await request(app)
        .get("/v1/community/admin/reports")
        .set("authorization", "Bearer user-a");
      expect(res.status).toBe(403);
    });

    test("admin → 200 on admin endpoints", async () => {
      const res = await request(app)
        .get("/v1/community/admin/reports")
        .set("authorization", "Bearer admin-x");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    test("/v1/me reports isAdmin per the admin list", async () => {
      const nonAdmin = await request(app)
        .get("/v1/me")
        .set("authorization", "Bearer user-a");
      expect(nonAdmin.status).toBe(200);
      expect(nonAdmin.body.isAdmin).toBe(false);

      const admin = await request(app)
        .get("/v1/me")
        .set("authorization", "Bearer admin-x");
      expect(admin.status).toBe(200);
      expect(admin.body.isAdmin).toBe(true);
    });
  });
});
