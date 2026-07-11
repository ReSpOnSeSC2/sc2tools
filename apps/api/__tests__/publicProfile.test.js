// @ts-nocheck
"use strict";

/**
 * Route + service contract for the opt-in public player page:
 *   GET /v1/public/profile/:handle
 *     - 404 for an unknown handle
 *     - 404 for a user who has NOT opted in (no published named build)
 *     - 200 with correct headline aggregates once opted in
 *     - NEVER leaks opponent identities / raw rows (no-PII assertion)
 *     - per-IP rate limit fires
 *
 * The public profile route is intentionally NOT wired into buildApp yet
 * (app.js is off-limits for this change — see the PR's wiring report), so
 * we build the app via buildApp to get network-disabled services + seed
 * helpers, then mount the router on a small standalone express app here.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { PublicProfileService } = require("../src/services/publicProfile");
const { buildPublicProfileRouter } = require("../src/routes/publicProfile");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_a" };
    throw new Error("invalid");
  }),
}));

const OPP_TAG = "SecretOpponentTag#1234";

describe("GET /v1/public/profile/:handle", () => {
  let mongo;
  let db;
  let services;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_public_profile",
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

  /** Mount the public-profile router on its own express app so the test
   *  can pass a tiny rate-limit ceiling for the smoke test. */
  function mountApp(rateLimitPerMinute) {
    const publicProfile = new PublicProfileService(db, {
      community: services.community,
      aggregations: services.aggregations,
      builds: services.builds,
    });
    const a = express();
    a.use(express.json());
    a.use("/v1", buildPublicProfileRouter({ publicProfile, rateLimitPerMinute }));
    return a;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });

    // Two internal users: u_a opts in (publishes a named build); u_priv
    // has games but never publishes → stays private.
    await db.users.insertOne({
      userId: "u_a",
      clerkUserId: "clerk_user_a",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    await db.users.insertOne({
      userId: "u_priv",
      clerkUserId: "clerk_user_priv",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });

    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      // Network-disabled Pulse client — ingest must never hit live
      // SC2Pulse in tests.
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });
    services = built.services;

    // Seed u_a's games. Two builds, mixed results, an opponent whose
    // battle tag MUST NOT surface anywhere in the public payload.
    const seed = async (userId, gameId, result, myRace, myBuild, oppRace) => {
      await services.games.upsert(userId, {
        gameId,
        date: new Date().toISOString(),
        result,
        myRace,
        myBuild,
        map: "Goldenaura",
        durationSec: 620,
        opponent: { displayName: OPP_TAG, race: oppRace, pulseId: "1-S2-1-999" },
      });
    };
    // "Glaive Adept Timing": 3 games, 2W-1L vs Terran.
    await seed("u_a", "ga1", "Victory", "Protoss", "PvT - Glaive Adept Timing", "Terran");
    await seed("u_a", "ga2", "Victory", "Protoss", "PvT - Glaive Adept Timing", "Terran");
    await seed("u_a", "ga3", "Defeat", "Protoss", "PvT - Glaive Adept Timing", "Terran");
    // "Cannon Rush": only 2 games → below the signature threshold, dropped.
    await seed("u_a", "cr1", "Victory", "Protoss", "PvZ - Cannon Rush", "Zerg");
    await seed("u_a", "cr2", "Defeat", "Protoss", "PvZ - Cannon Rush", "Zerg");

    // u_priv has games but never publishes.
    await seed("u_priv", "pv1", "Victory", "Zerg", "ZvP - Ling Flood", "Protoss");

    // u_a opts in: publish a private custom build under a public name.
    await services.customBuilds.upsert("u_a", {
      slug: "glaive-timing",
      name: "Glaive Adept Timing",
      race: "Protoss",
      matchup: "PvT",
      steps: [{ supply: 14, time: "0:18", action: "Pylon" }],
    });
    const pub = await services.community.publish("u_a", "glaive-timing", {
      title: "Glaive Adept Timing",
      description: "Punish 1-1-1.",
      authorName: "Reaver",
    });
    expect(pub.slug).toBeTruthy();

    app = mountApp();
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("404 for an unknown handle", async () => {
    const res = await request(app).get("/v1/public/profile/u_does_not_exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("profile_not_found");
  });

  test("404 for a malformed handle", async () => {
    const res = await request(app).get(
      "/v1/public/profile/" + encodeURIComponent("../etc/passwd"),
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("profile_not_found");
  });

  test("404 for a user who has NOT opted in (private by default)", async () => {
    const res = await request(app).get("/v1/public/profile/u_priv");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("profile_not_found");
  });

  test("200 with correct headline aggregates once opted in", async () => {
    const res = await request(app).get("/v1/public/profile/u_a");
    expect(res.status).toBe(200);
    const p = res.body.profile;
    expect(p).toBeTruthy();
    expect(p.handle).toBe("u_a");
    expect(p.displayName).toBe("Reaver");
    expect(p.mainRace).toBe("Protoss");

    // Totals: 5 games, 3 wins, 2 losses.
    expect(p.totals.games).toBe(5);
    expect(p.totals.wins).toBe(3);
    expect(p.totals.losses).toBe(2);
    expect(p.totals.winRate).toBeCloseTo(3 / 5, 5);

    // Matchup splits are race letters, not identities.
    const vsT = p.matchups.find((m) => m.matchup === "vs T");
    expect(vsT).toBeTruthy();
    expect(vsT.games).toBe(3);
    expect(vsT.wins).toBe(2);
    expect(vsT.losses).toBe(1);

    // Signature build: the 3-game build survives; the 2-game one is
    // dropped below the min-sample threshold.
    const names = p.signatureBuilds.map((b) => b.name);
    expect(names).toContain("PvT - Glaive Adept Timing");
    expect(names).not.toContain("PvZ - Cannon Rush");
    const sig = p.signatureBuilds.find(
      (b) => b.name === "PvT - Glaive Adept Timing",
    );
    expect(sig.games).toBe(3);
    expect(sig.winRate).toBeCloseTo(2 / 3, 5);

    // Featured community build links the share loop.
    expect(p.featuredBuild).toBeTruthy();
    expect(typeof p.featuredBuild.slug).toBe("string");
    expect(p.publishedBuildCount).toBeGreaterThanOrEqual(1);
  });

  test("response contains NO opponent identities or raw rows (no-PII)", async () => {
    const res = await request(app).get("/v1/public/profile/u_a");
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    // The seeded opponent battle tag and pulse id must never appear.
    expect(raw).not.toContain("SecretOpponentTag");
    expect(raw).not.toContain("1-S2-1-999");
    expect(raw.toLowerCase()).not.toContain("pulseid");
    // No per-game drill-down / raw rows.
    expect(res.body.profile.recent).toBeUndefined();
    expect(res.body.profile.games).toBeUndefined();
  });

  test("per-IP rate limit fires", async () => {
    const limited = mountApp(3); // 3 requests / minute ceiling
    await request(limited).get("/v1/public/profile/u_a").expect(200);
    await request(limited).get("/v1/public/profile/u_a").expect(200);
    await request(limited).get("/v1/public/profile/u_a").expect(200);
    const fourth = await request(limited).get("/v1/public/profile/u_a");
    expect(fourth.status).toBe(429);
  });
});
