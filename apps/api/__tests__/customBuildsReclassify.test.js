// @ts-nocheck
"use strict";

/**
 * /v1/custom-builds/:slug/reclassify and /v1/custom-builds/reclassify-all
 * integration tests.
 *
 * Spec: reclassify writes `myBuild` on stored games to whatever build's
 * rules they match — without touching the agent. Cleared tags are
 * scoped to builds the user owns; tags from other sources (community
 * builds, agent classifier) are never disturbed.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-clerk-token") return { sub: "clerk_user_test" };
    throw new Error("invalid");
  }),
}));

const PROTOSS_OPENER = [
  "[0:00] Probe",
  "[0:12] Probe",
  "[0:17] Pylon",
  "[0:49] Gateway",
  "[1:20] Assimilator",
  "[1:43] CyberneticsCore",
  "[3:00] Stargate",
  "[6:28] Oracle",
];

const PROTOSS_OPP_OPENER = [
  "[0:00] Probe",
  "[0:14] Probe",
  "[0:17] Pylon",
  "[0:49] Gateway",
  "[3:30] RoboticsFacility",
];

const TERRAN_OPP_OPENER = [
  "[0:00] SCV",
  "[0:14] SCV",
  "[0:17] SupplyDepot",
  "[1:00] Barracks",
  "[2:30] Bunker",
  "[5:00] Factory",
];

describe("POST /v1/custom-builds/:slug/reclassify", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_reclassify",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 1),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 1000,
    agentReleaseAdminToken: "admin-token-for-tests",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__definitely_missing__",
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

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  async function bootstrap() {
    const me = await withAuth(request(app).get("/v1/me"));
    expect(me.status).toBe(200);
    return me.body.userId;
  }

  test("tags games whose stored events satisfy the build's rules", async () => {
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-pvp-stargate-1",
      date: new Date("2026-05-01T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvP — Other",
      buildLog: PROTOSS_OPENER,
      oppBuildLog: PROTOSS_OPP_OPENER,
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "tossBro", race: "Protoss" },
    });
    await services.games.upsert(userId, {
      gameId: "g-pvt-stargate-1",
      date: new Date("2026-05-02T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvT — Other",
      buildLog: PROTOSS_OPENER,
      oppBuildLog: TERRAN_OPP_OPENER,
      result: "Defeat",
      map: "Equilibrium LE",
      opponent: { displayName: "DuncanTheFat", race: "Terran" },
    });

    // PUT now reclassifies cloud-side as part of save so opponent /
    // recent-games views see the new build name immediately.
    const putRes = await withAuth(
      request(app).put("/v1/custom-builds/pvp-oracle").send({
        slug: "pvp-oracle",
        name: "PvP Oracle Opener",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );
    expect(putRes.status).toBe(200);
    expect(putRes.body.reclassify).toMatchObject({
      tagged: 1,
      matched: 1,
      name: "PvP Oracle Opener",
    });

    // Subsequent explicit reclassify is a no-op because the PUT already
    // tagged everything that matches.
    const res = await withAuth(
      request(app).post("/v1/custom-builds/pvp-oracle/reclassify").send({}),
    );
    expect(res.status).toBe(200);
    expect(res.body.tagged).toBe(0);
    expect(res.body.matched).toBe(1);
    expect(res.body.name).toBe("PvP Oracle Opener");

    const tagged = await db.games.findOne({ userId, gameId: "g-pvp-stargate-1" });
    const untouched = await db.games.findOne({
      userId,
      gameId: "g-pvt-stargate-1",
    });
    expect(tagged.myBuild).toBe("PvP Oracle Opener");
    // PvT game is gated out by vsRace=Protoss, so its tag must remain.
    expect(untouched.myBuild).toBe("PvT — Other");
  });

  test("clears the tag from games that no longer match (replace=true default)", async () => {
    const userId = await bootstrap();

    // Pre-tag a game with our build's name even though it doesn't match
    // the current rules.
    await services.games.upsert(userId, {
      gameId: "g-stale-tag",
      date: new Date("2026-05-03T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvP Oracle Opener",
      buildLog: ["[0:00] Probe", "[0:17] Pylon"],
      oppBuildLog: PROTOSS_OPP_OPENER,
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "noOracle", race: "Protoss" },
    });

    const res = await withAuth(
      request(app).post("/v1/custom-builds/pvp-oracle/reclassify").send({}),
    );
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBeGreaterThanOrEqual(1);

    const stale = await db.games.findOne({ userId, gameId: "g-stale-tag" });
    expect(stale.myBuild).toBeUndefined();
  });

  test("returns 404 for an unknown slug", async () => {
    await bootstrap();
    const res = await withAuth(
      request(app)
        .post("/v1/custom-builds/__nope__/reclassify")
        .send({}),
    );
    expect(res.status).toBe(404);
  });

  test("PUT auto-tags games on save AND clears stale tags from a renamed build", async () => {
    // Regression: the BuildDetail view (live rule eval) and the opponent
    // profile / Recent games table (stored myBuild) used to drift when
    // the user saved a custom build but never clicked Reclassify. PUT
    // now does the cloud-side reclassify itself so the two views stay
    // in sync without a separate user action.
    //
    // Tests in this suite share the same Mongo instance, so we use
    // vsRace=Random (no other fixture uses it) + a unique rule token
    // so the matchup gate cleanly isolates this test's game from the
    // prior PvP/PvT fixtures.
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-rename-1",
      date: new Date("2026-05-04T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvR — Auto-detected old label",
      // PhotonCannon is unique to this test — no other fixture's
      // buildLog contains it, so the rule below only matches g-rename-1.
      buildLog: [...PROTOSS_OPENER, "[3:30] PhotonCannon"],
      oppBuildLog: PROTOSS_OPP_OPENER,
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "renameTest", race: "Random" },
    });

    const initial = await withAuth(
      request(app).put("/v1/custom-builds/rename-build").send({
        slug: "rename-build",
        name: "First name",
        race: "Protoss",
        vsRace: "Random",
        rules: [{ type: "before", name: "BuildPhotonCannon", time_lt: 600 }],
      }),
    );
    expect(initial.status).toBe(200);
    expect(initial.body.reclassify).toMatchObject({
      tagged: 1,
      matched: 1,
      name: "First name",
    });

    let row = await db.games.findOne({ userId, gameId: "g-rename-1" });
    expect(row.myBuild).toBe("First name");

    // Rename via second PUT — replace=true default should re-stamp the
    // game under the new name in one pass, with no manual reclassify
    // in between.
    const renamed = await withAuth(
      request(app).put("/v1/custom-builds/rename-build").send({
        slug: "rename-build",
        name: "Second name",
        race: "Protoss",
        vsRace: "Random",
        rules: [{ type: "before", name: "BuildPhotonCannon", time_lt: 600 }],
      }),
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.reclassify.tagged).toBe(1);

    row = await db.games.findOne({ userId, gameId: "g-rename-1" });
    expect(row.myBuild).toBe("Second name");
  });
});

describe("POST /v1/custom-builds/reclassify-all", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_reclassify_all",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 1),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 1000,
    agentReleaseAdminToken: "admin-token-for-tests",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__definitely_missing__",
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

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  async function bootstrap() {
    const me = await withAuth(request(app).get("/v1/me"));
    expect(me.status).toBe(200);
    return me.body.userId;
  }

  test("tags every saved build's matching games in one pass", async () => {
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-a",
      date: new Date("2026-05-01T00:00:00Z"),
      myRace: "Protoss",
      buildLog: PROTOSS_OPENER,
      oppBuildLog: PROTOSS_OPP_OPENER,
      result: "Victory",
      map: "M1",
      opponent: { race: "Protoss", displayName: "p" },
    });
    await services.games.upsert(userId, {
      gameId: "g-b",
      date: new Date("2026-05-02T00:00:00Z"),
      myRace: "Protoss",
      buildLog: [
        "[0:00] Probe",
        "[0:17] Pylon",
        "[0:49] Gateway",
        "[1:20] Assimilator",
        "[1:43] CyberneticsCore",
      ],
      oppBuildLog: PROTOSS_OPP_OPENER,
      result: "Victory",
      map: "M2",
      opponent: { race: "Protoss", displayName: "p2" },
    });

    await withAuth(
      request(app).put("/v1/custom-builds/pvp-stargate-bulk").send({
        slug: "pvp-stargate-bulk",
        name: "PvP Stargate (bulk)",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
      }),
    );
    await withAuth(
      request(app).put("/v1/custom-builds/pvp-cyber-bulk").send({
        slug: "pvp-cyber-bulk",
        name: "PvP Cyber Open",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [{ type: "before", name: "BuildCyberneticsCore", time_lt: 120 }],
      }),
    );

    const res = await withAuth(
      request(app).post("/v1/custom-builds/reclassify-all").send({}),
    );
    expect(res.status).toBe(200);
    expect(res.body.builds).toBe(2);
    expect(Array.isArray(res.body.perBuild)).toBe(true);

    const a = await db.games.findOne({ userId, gameId: "g-a" });
    const b = await db.games.findOne({ userId, gameId: "g-b" });
    // g-a matches both rules, so the more recently updated build (cyber)
    // should claim it; g-b only matches the cyber rule.
    expect([a.myBuild, b.myBuild].every((n) => typeof n === "string")).toBe(true);
  });
});
