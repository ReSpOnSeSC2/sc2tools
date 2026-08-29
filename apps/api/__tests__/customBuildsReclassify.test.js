// @ts-nocheck
"use strict";

/**
 * /v1/custom-builds/:slug/reclassify and /v1/custom-builds/reclassify-all
 * integration tests.
 *
 * Spec: reclassification writes each saved build to the axis its persisted
 * perspective describes: `myBuild` for the user's opener and
 * `opponent.strategy` for the opponent's opener. Each axis has independent
 * slug provenance so one replay can match one custom build on both sides.
 * Cleared tags are scoped to builds the user owns; tags from other sources
 * (community builds, agent classifier) are never disturbed.
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

async function waitForJob(db, userId, generation, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await db.customBuildJobs.findOne({ userId, generation });
    if (job && job.status === "complete") return job;
    if (job && job.status === "failed") {
      throw new Error(`reclassification failed: ${job.error}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for reclassification ${generation}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    if (services?.customBuilds) {
      await services.customBuilds.stopReclassifications();
    }
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

    // PUT durably queues cloud-side reclassification without holding the
    // request open for a full replay-library scan.
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
      status: "queued",
      generation: expect.any(String),
    });

    // An explicit request uses the same durable queue contract.
    const res = await withAuth(
      request(app).post("/v1/custom-builds/pvp-oracle/reclassify").send({}),
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.name).toBe("PvP Oracle Opener");
    await waitForJob(db, userId, res.body.generation);

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
    await db.games.updateOne(
      { userId, gameId: "g-stale-tag" },
      { $set: { _customBuildSlug: "pvp-oracle" } },
    );

    const res = await withAuth(
      request(app).post("/v1/custom-builds/pvp-oracle/reclassify").send({}),
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    await waitForJob(db, userId, res.body.generation);

    const stale = await db.games.findOne({ userId, gameId: "g-stale-tag" });
    expect(stale.myBuild).toBeUndefined();
  });

  test("opponent-perspective reclassify updates only the opponent strategy axis", async () => {
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-opponent-ghost",
      date: new Date("2026-05-03T12:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvT - Blink Pressure",
      buildLog: PROTOSS_OPENER,
      oppBuildLog: [...TERRAN_OPP_OPENER, "[4:00] GhostAcademy"],
      result: "Victory",
      map: "Equilibrium LE",
      opponent: {
        displayName: "ghostTerran",
        race: "Terran",
        strategy: "TvP - Reaper Expand",
      },
    });

    const put = await withAuth(
      request(app).put("/v1/custom-builds/tvp-ghost-opener").send({
        slug: "tvp-ghost-opener",
        name: "TvP Ghost Opener",
        race: "Terran",
        vsRace: "Protoss",
        perspective: "opponent",
        rules: [{ type: "before", name: "BuildGhostAcademy", time_lt: 300 }],
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body.reclassify).toMatchObject({
      status: "queued",
      generation: expect.any(String),
    });
    await waitForJob(db, userId, put.body.reclassify.generation);

    const row = await db.games.findOne({
      userId,
      gameId: "g-opponent-ghost",
    });
    expect(row.myBuild).toBe("PvT - Blink Pressure");
    expect(row._customBuildSlug).toBeUndefined();
    expect(row.opponent.strategy).toBe("TvP Ghost Opener");
    expect(row._customOpponentStrategySlug).toBe("tvp-ghost-opener");

    // The Build Order view reads these labels through the per-game API. Keep
    // this contract perspective-specific too: a captured opponent opener must
    // not replace the Protoss build shown for the user.
    const buildOrder = await withAuth(
      request(app).get("/v1/games/g-opponent-ghost/build-order"),
    );
    expect(buildOrder.status).toBe(200);
    expect(buildOrder.body).toEqual(expect.objectContaining({
      my_build: "PvT - Blink Pressure",
      opp_strategy: "TvP Ghost Opener",
    }));
  });

  test("opponent reclassify repairs a legacy opponent tag written onto my build", async () => {
    const userId = await bootstrap();
    const slug = "tvp-three-rax-legacy-repair";

    await services.games.upsert(userId, {
      gameId: "g-opponent-legacy-three-rax",
      date: new Date("2026-05-03T13:00:00Z"),
      myRace: "Protoss",
      myBuild: "3 Rax",
      buildLog: PROTOSS_OPENER,
      oppBuildLog: [...TERRAN_OPP_OPENER, "[3:00] EngineeringBay"],
      result: "Victory",
      map: "Equilibrium LE",
      opponent: {
        displayName: "legacyTerran",
        race: "Terran",
        strategy: "TvP - Reaper Expand",
      },
    });
    // This reproduces the legacy corruption exactly. Provenance is normally
    // server-owned, so seed it directly rather than through replay ingest.
    await db.games.updateOne(
      { userId, gameId: "g-opponent-legacy-three-rax" },
      { $set: { _customBuildSlug: slug } },
    );

    const put = await withAuth(
      request(app).put(`/v1/custom-builds/${slug}`).send({
        slug,
        name: "3 Rax",
        race: "Terran",
        vsRace: "Protoss",
        perspective: "opponent",
        rules: [{
          type: "before",
          name: "BuildEngineeringBay",
          time_lt: 240,
        }],
      }),
    );
    expect(put.status).toBe(200);
    await waitForJob(db, userId, put.body.reclassify.generation);

    const repaired = await db.games.findOne({
      userId,
      gameId: "g-opponent-legacy-three-rax",
    });
    expect(repaired.myBuild).toBeUndefined();
    expect(repaired._customBuildSlug).toBeUndefined();
    expect(repaired.opponent.strategy).toBe("3 Rax");
    expect(repaired._customOpponentStrategySlug).toBe(slug);
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
      status: "queued",
      generation: expect.any(String),
    });
    await waitForJob(db, userId, initial.body.reclassify.generation);

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
    expect(renamed.body.reclassify.status).toBe("queued");
    await waitForJob(db, userId, renamed.body.reclassify.generation);

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
    if (services?.customBuilds) {
      await services.customBuilds.stopReclassifications();
    }
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
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.builds).toBe(2);
    expect(res.body.perBuild).toBeUndefined();
    await waitForJob(db, userId, res.body.job.generation);

    const a = await db.games.findOne({ userId, gameId: "g-a" });
    const b = await db.games.findOne({ userId, gameId: "g-b" });
    // g-a matches both rules, so the more recently updated build (cyber)
    // should claim it; g-b only matches the cyber rule.
    expect([a.myBuild, b.myBuild].every((n) => typeof n === "string")).toBe(true);
  });

  test("closest-match wins: more rules trumps recency", async () => {
    // Regression for the user-reported "it still shows the old build"
    // bug after first PR landed: when two builds match a game, the more
    // specific build (more rules) should claim it — not just the more
    // recently edited one. We save the most-specific build FIRST so
    // recency would put it second; the closest-match logic must still
    // route the game to it.
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-closest",
      date: new Date("2026-05-04T00:00:00Z"),
      myRace: "Protoss",
      buildLog: PROTOSS_OPENER,
      oppBuildLog: PROTOSS_OPP_OPENER,
      result: "Victory",
      map: "Mclosest",
      opponent: { race: "Protoss", displayName: "p3" },
    });

    // 3-rule build saved FIRST → updatedAt is older than the 1-rule
    // build below.
    await withAuth(
      request(app).put("/v1/custom-builds/specific-build").send({
        slug: "specific-build",
        name: "Specific build (3 rules)",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [
          { type: "before", name: "BuildGateway", time_lt: 90 },
          { type: "before", name: "BuildCyberneticsCore", time_lt: 130 },
          { type: "before", name: "BuildOracle", time_lt: 418 },
        ],
      }),
    );
    // Wait one ms so updatedAt strictly differs (Mongo timestamps).
    await new Promise((r) => setTimeout(r, 5));
    await withAuth(
      request(app).put("/v1/custom-builds/loose-build").send({
        slug: "loose-build",
        name: "Loose build (1 rule)",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );

    const res = await withAuth(
      request(app).post("/v1/custom-builds/reclassify-all").send({}),
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    await waitForJob(db, userId, res.body.job.generation);

    const row = await db.games.findOne({ userId, gameId: "g-closest" });
    expect(row.myBuild).toBe("Specific build (3 rules)");
  });

  test("classifies the user's build and opponent strategy independently on one replay", async () => {
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-dual-axis-history",
      date: new Date("2026-05-04T12:00:00Z"),
      myRace: "Zerg",
      myBuild: "ZvT - Agent Macro",
      buildLog: [
        "[0:00] Drone",
        "[0:13] Overlord",
        "[0:45] SpawningPool",
      ],
      oppBuildLog: [
        "[0:00] SCV",
        "[0:17] SupplyDepot",
        "[1:00] Barracks",
      ],
      result: "Victory",
      map: "Dual Axis LE",
      opponent: {
        race: "Terran",
        displayName: "dualTerran",
        strategy: "TvZ - Agent Reaper",
      },
    });

    const own = await withAuth(
      request(app).put("/v1/custom-builds/zvt-pool-first").send({
        slug: "zvt-pool-first",
        name: "ZvT Pool First",
        race: "Zerg",
        vsRace: "Terran",
        perspective: "you",
        rules: [{ type: "before", name: "BuildSpawningPool", time_lt: 60 }],
        reclassify: false,
      }),
    );
    expect(own.status).toBe(200);
    const opponent = await withAuth(
      request(app).put("/v1/custom-builds/tvz-one-rax").send({
        slug: "tvz-one-rax",
        name: "TvZ One Rax",
        race: "Terran",
        vsRace: "Zerg",
        perspective: "opponent",
        rules: [{ type: "before", name: "BuildBarracks", time_lt: 90 }],
        reclassify: false,
      }),
    );
    expect(opponent.status).toBe(200);

    const res = await withAuth(
      request(app).post("/v1/custom-builds/reclassify-all").send({}),
    );
    expect(res.status).toBe(202);
    await waitForJob(db, userId, res.body.job.generation);

    const row = await db.games.findOne({
      userId,
      gameId: "g-dual-axis-history",
    });
    expect(row.myBuild).toBe("ZvT Pool First");
    expect(row._customBuildSlug).toBe("zvt-pool-first");
    expect(row.opponent.strategy).toBe("TvZ One Rax");
    expect(row._customOpponentStrategySlug).toBe("tvz-one-rax");

    // The analytics axes consumed by the Builds and Strategies sections must
    // expose the same independent classifications. An opponent capture must
    // never leak into `/v1/builds`, and both labels must meet in the cross-tab.
    const [builds, strategies, crossTab, customStats, opponentDossier] =
      await Promise.all([
        withAuth(request(app).get("/v1/builds")),
        withAuth(request(app).get("/v1/opp-strategies")),
        withAuth(request(app).get("/v1/build-vs-strategy")),
        withAuth(request(app).get("/v1/custom-builds/stats")),
        withAuth(request(app).get("/v1/custom-builds/tvz-one-rax/matches")),
      ]);
    for (const response of [
      builds,
      strategies,
      crossTab,
      customStats,
      opponentDossier,
    ]) {
      expect(response.status).toBe(200);
    }
    expect(builds.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ZvT Pool First", total: 1 }),
    ]));
    expect(builds.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "TvZ One Rax" }),
    ]));
    expect(strategies.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "TvZ One Rax", total: 1 }),
    ]));
    expect(strategies.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ZvT Pool First" }),
    ]));
    expect(crossTab.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        my_build: "ZvT Pool First",
        opp_strat: "TvZ One Rax",
        total: 1,
      }),
    ]));
    expect(customStats.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "zvt-pool-first", total: 1 }),
      expect.objectContaining({ slug: "tvz-one-rax", total: 1 }),
    ]));
    expect(opponentDossier.body).toEqual(expect.objectContaining({
      slug: "tvz-one-rax",
      totals: expect.objectContaining({ total: 1 }),
    }));
  });

  test("ingest auto-tags a freshly-uploaded replay against saved builds", async () => {
    // The lived-in case the user complained about: post a fresh
    // replay via POST /v1/games and the agent's auto-classifier
    // ("PvZ - 2 Stargate Void Ray") should be overridden by the
    // user's saved custom build name when the rules match.
    //
    // We use vsRace=Random + Random-race opponent so the matchup gate
    // isolates this test from prior PvP fixtures saved in the same
    // describe block.
    const userId = await bootstrap();

    await withAuth(
      request(app).put("/v1/custom-builds/pvr-ingest").send({
        slug: "pvr-ingest",
        name: "PvR Ingest Oracle",
        race: "Protoss",
        vsRace: "Random",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );

    const post = await withAuth(
      request(app)
        .post("/v1/games")
        .set("content-type", "application/json")
        .send({
          gameId: "g-ingest-1",
          date: "2026-05-05T00:00:00Z",
          result: "Victory",
          map: "Equilibrium LE",
          myRace: "Protoss",
          // The agent shipped its built-in classifier label:
          myBuild: "PvR - 2 Stargate Void Ray",
          buildLog: PROTOSS_OPENER,
          oppBuildLog: PROTOSS_OPP_OPENER,
          opponent: {
            displayName: "ingestOpp",
            race: "Random",
            pulseId: "1-S2-9-99999",
          },
        }),
    );
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(1);

    const row = await db.games.findOne({ userId, gameId: "g-ingest-1" });
    // myBuild was overwritten from the agent's auto label to the
    // user's saved build name as part of the ingest pipeline.
    expect(row.myBuild).toBe("PvR Ingest Oracle");
  });

  test("ingest tagSingleGame classifies both axes without one overwriting the other", async () => {
    const userId = await bootstrap();

    const own = await withAuth(
      request(app).put("/v1/custom-builds/zvr-ingest-extractor").send({
        slug: "zvr-ingest-extractor",
        name: "ZvR Ingest Extractor",
        race: "Zerg",
        vsRace: "Random",
        perspective: "you",
        rules: [{ type: "before", name: "BuildExtractor", time_lt: 60 }],
        reclassify: false,
      }),
    );
    expect(own.status).toBe(200);
    const opponent = await withAuth(
      request(app).put("/v1/custom-builds/rvz-ingest-bunker").send({
        slug: "rvz-ingest-bunker",
        name: "RvZ Ingest Bunker",
        race: "Random",
        vsRace: "Zerg",
        perspective: "opponent",
        rules: [{ type: "before", name: "BuildBunker", time_lt: 180 }],
        reclassify: false,
      }),
    );
    expect(opponent.status).toBe(200);

    const post = await withAuth(
      request(app)
        .post("/v1/games")
        .set("content-type", "application/json")
        .send({
          gameId: "g-ingest-dual-axis",
          date: "2026-05-06T00:00:00Z",
          result: "Victory",
          map: "Dual Ingest LE",
          myRace: "Zerg",
          myBuild: "ZvR - Agent Pool",
          buildLog: [
            "[0:00] Drone",
            "[0:40] Extractor",
          ],
          oppBuildLog: [
            "[0:00] SCV",
            "[2:30] Bunker",
          ],
          opponent: {
            displayName: "ingestDualOpp",
            race: "Random",
            strategy: "RvZ - Agent Mystery",
            pulseId: "1-S2-9-99998",
          },
        }),
    );
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(1);

    const row = await db.games.findOne({
      userId,
      gameId: "g-ingest-dual-axis",
    });
    expect(row.myBuild).toBe("ZvR Ingest Extractor");
    expect(row._customBuildSlug).toBe("zvr-ingest-extractor");
    expect(row.opponent.strategy).toBe("RvZ Ingest Bunker");
    expect(row._customOpponentStrategySlug).toBe("rvz-ingest-bunker");
  });

  test("fresh ingest classifies proxy-required builds on both perspectives", async () => {
    const userId = await bootstrap();
    expect((await withAuth(
      request(app).put("/v1/custom-builds/tvp-proxy-rax").send({
        slug: "tvp-proxy-rax",
        name: "TvP Proxy Rax",
        race: "Terran",
        vsRace: "Protoss",
        perspective: "you",
        rules: [{
          type: "before", name: "BuildBarracks", time_lt: 180, proxy: true,
        }],
        reclassify: false,
      }),
    )).status).toBe(200);
    expect((await withAuth(
      request(app).put("/v1/custom-builds/pvt-proxy-gate").send({
        slug: "pvt-proxy-gate",
        name: "PvT Proxy Gate",
        race: "Protoss",
        vsRace: "Terran",
        perspective: "opponent",
        rules: [{
          type: "before", name: "BuildGateway", time_lt: 180, proxy: true,
        }],
        reclassify: false,
      }),
    )).status).toBe(200);

    const post = await withAuth(
      request(app).post("/v1/games").send({
        gameId: "g-ingest-dual-proxy",
        date: "2026-05-07T00:00:00Z",
        result: "Victory",
        map: "Proxy Ingest LE",
        myRace: "Terran",
        myBuild: "TvP - Agent Mystery",
        buildLog: ["[1:30] Barracks"],
        oppBuildLog: ["[1:40] Gateway"],
        spatial: {
          my_proxy_classification_v: 1,
          opp_proxy_classification_v: 1,
          my_proxies: [{ name: "Barracks", time: 90, x: 80, y: 80 }],
          opp_proxies: [{ name: "Gateway", time: 100, x: 20, y: 20 }],
        },
        opponent: {
          displayName: "proxyDualOpp",
          race: "Protoss",
          strategy: "PvT - Agent Mystery",
        },
      }),
    );
    expect(post.status).toBe(202);

    const row = await db.games.findOne({
      userId,
      gameId: "g-ingest-dual-proxy",
    });
    expect(row.spatial).toEqual(expect.objectContaining({
      my_proxy_classification_v: 1,
      opp_proxy_classification_v: 1,
      my_proxies: [expect.objectContaining({
        name: "Barracks", time: 90, x: 80, y: 80,
      })],
      opp_proxies: [expect.objectContaining({
        name: "Gateway", time: 100, x: 20, y: 20,
      })],
    }));
    expect(row.myBuild).toBe("TvP Proxy Rax");
    expect(row.opponent.strategy).toBe("PvT Proxy Gate");
  });

  test("durable reclassify retains stored proxy evidence on both axes", async () => {
    const userId = await bootstrap();
    await services.games.upsert(userId, {
      gameId: "g-history-dual-proxy",
      date: new Date("2026-05-08T00:00:00Z"),
      result: "Defeat",
      map: "Proxy History LE",
      myRace: "Zerg",
      myBuild: "ZvT - Agent Mystery",
      buildLog: ["[2:00] NydusNetwork"],
      oppBuildLog: ["[3:00] FusionCore"],
      spatial: {
        my_proxy_classification_v: 1,
        opp_proxy_classification_v: 1,
        my_proxies: [{ name: "NydusNetwork", time: 120, x: 90, y: 90 }],
        opp_proxies: [{ name: "FusionCore", time: 180, x: 20, y: 20 }],
      },
      opponent: {
        displayName: "historyProxyOpp",
        race: "Terran",
        strategy: "TvZ - Agent Mystery",
      },
    });
    expect((await db.games.findOne({
      userId, gameId: "g-history-dual-proxy",
    })).spatial).toEqual(expect.objectContaining({
      my_proxy_classification_v: 1,
      opp_proxy_classification_v: 1,
      my_proxies: [expect.objectContaining({ name: "NydusNetwork" })],
      opp_proxies: [expect.objectContaining({ name: "FusionCore" })],
    }));
    const ownSaved = await withAuth(
      request(app).put("/v1/custom-builds/zvt-proxy-nydus").send({
        slug: "zvt-proxy-nydus",
        name: "ZvT Proxy Nydus",
        race: "Zerg",
        vsRace: "Terran",
        perspective: "you",
        rules: [{
          type: "before", name: "BuildNydusNetwork", time_lt: 240, proxy: true,
        }],
        reclassify: false,
      }),
    );
    expect(ownSaved.status).toBe(200);
    const opponentSaved = await withAuth(
      request(app).put("/v1/custom-builds/tvz-proxy-fusion").send({
        slug: "tvz-proxy-fusion",
        name: "TvZ Proxy Fusion",
        race: "Terran",
        vsRace: "Zerg",
        perspective: "opponent",
        rules: [{
          type: "before", name: "BuildFusionCore", time_lt: 240, proxy: true,
        }],
        reclassify: false,
      }),
    );
    expect(opponentSaved.status).toBe(200);

    const queued = await withAuth(
      request(app).post("/v1/custom-builds/reclassify-all").send({}),
    );
    expect(queued.status).toBe(202);
    await waitForJob(db, userId, queued.body.job.generation);

    const row = await db.games.findOne({
      userId,
      gameId: "g-history-dual-proxy",
    });
    expect(row.myBuild).toBe("ZvT Proxy Nydus");
    expect(row._customBuildSlug).toBe("zvt-proxy-nydus");
    expect(row.opponent.strategy).toBe("TvZ Proxy Fusion");
    expect(row._customOpponentStrategySlug).toBe("tvz-proxy-fusion");
  });

  test("negative proxy rules defer legacy rows without coverage evidence", async () => {
    const userId = await bootstrap();
    const base = {
      date: new Date("2026-05-09T00:00:00Z"),
      result: "Victory",
      map: "Proxy Coverage LE",
      myRace: "Terran",
      myBuild: "TvP - Agent Macro",
      buildLog: ["[1:30] Barracks"],
      oppBuildLog: [],
      opponent: { displayName: "coverageOpp", race: "Protoss" },
    };
    await services.games.upsert(userId, {
      ...base,
      gameId: "g-proxy-coverage-legacy",
      // Old spatial rows carried coordinates only. They cannot prove that a
      // same-name structure was home, so negative rules must not claim it.
      spatial: { my_proxies: [{ x: 80, y: 80 }] },
    });
    await services.games.upsert(userId, {
      ...base,
      gameId: "g-proxy-coverage-known-home",
      spatial: { my_proxy_classification_v: 1 },
    });
    const saved = await withAuth(
      request(app).put("/v1/custom-builds/tvp-no-early-proxy-rax").send({
        slug: "tvp-no-early-proxy-rax",
        name: "TvP No Early Proxy Rax",
        race: "Terran",
        vsRace: "Protoss",
        perspective: "you",
        rules: [{
          type: "not_before",
          name: "BuildBarracks",
          time_lt: 180,
          proxy: true,
        }],
        reclassify: false,
      }),
    );
    expect(saved.status).toBe(200);
    const queued = await withAuth(
      request(app).post(
        "/v1/custom-builds/tvp-no-early-proxy-rax/reclassify",
      ).send({}),
    );
    expect(queued.status).toBe(202);
    await waitForJob(db, userId, queued.body.generation);

    const [legacy, knownHome] = await Promise.all([
      db.games.findOne({ userId, gameId: "g-proxy-coverage-legacy" }),
      db.games.findOne({ userId, gameId: "g-proxy-coverage-known-home" }),
    ]);
    expect(legacy.myBuild).toBe("TvP - Agent Macro");
    expect(legacy._customBuildSlug).toBeUndefined();
    expect(knownHome.myBuild).toBe("TvP No Early Proxy Rax");
    expect(knownHome._customBuildSlug).toBe("tvp-no-early-proxy-rax");
  });

  test("ingest sanitization and reclassify preserve provenance on unknown proxy evidence", async () => {
    const userId = await bootstrap();
    for (const build of [
      {
        slug: "tvp-specific-proxy-rax",
        name: "TvP Specific Proxy Rax",
        race: "Terran",
        vsRace: "Protoss",
        perspective: "you",
        rules: [
          { type: "before", name: "BuildBarracks", time_lt: 180, proxy: true },
          { type: "before", name: "BuildBarracks", time_lt: 180 },
        ],
      },
      {
        slug: "tvp-generic-rax",
        name: "TvP Generic Rax",
        race: "Terran",
        vsRace: "Protoss",
        perspective: "you",
        rules: [
          { type: "before", name: "BuildBarracks", time_lt: 180 },
        ],
      },
      {
        slug: "pvt-specific-proxy-gate",
        name: "PvT Specific Proxy Gate",
        race: "Protoss",
        vsRace: "Terran",
        perspective: "opponent",
        rules: [
          { type: "before", name: "BuildGateway", time_lt: 180, proxy: true },
          { type: "before", name: "BuildGateway", time_lt: 180 },
        ],
      },
      {
        slug: "pvt-generic-gate",
        name: "PvT Generic Gate",
        race: "Protoss",
        vsRace: "Terran",
        perspective: "opponent",
        rules: [
          { type: "before", name: "BuildGateway", time_lt: 180 },
        ],
      },
    ]) {
      const saved = await withAuth(
        request(app).put(`/v1/custom-builds/${build.slug}`).send({
          ...build,
          reclassify: false,
        }),
      );
      expect(saved.status).toBe(200);
    }

    await db.games.insertOne({
      userId,
      gameId: "g-proxy-ingest-unknown",
      date: new Date("2026-05-10T00:00:00Z"),
      result: "Victory",
      map: "Proxy Integrity LE",
      myRace: "Terran",
      myBuild: "TvP Specific Proxy Rax",
      _customBuildSlug: "tvp-specific-proxy-rax",
      opponent: {
        displayName: "integrityOpp",
        race: "Protoss",
        strategy: "PvT Specific Proxy Gate",
      },
      _customOpponentStrategySlug: "pvt-specific-proxy-gate",
    });

    const post = await withAuth(
      request(app).post("/v1/games").send({
        gameId: "g-proxy-ingest-unknown",
        date: "2026-05-10T00:00:00Z",
        result: "Victory",
        map: "Proxy Integrity LE",
        myRace: "Terran",
        myBuild: "TvP - Agent Mystery",
        buildLog: ["[1:30] Barracks"],
        oppBuildLog: [],
        spatial: {
          my_proxy_classification_v: 1,
          // Raw annotation could correlate this finite row, but GamesService
          // rejects its out-of-contract geometry and must strip the stamp
          // before immediate tagging sees it.
          my_proxies: [{
            name: "Barracks", time: 90, x: 20_001, y: 80,
          }],
        },
        opponent: {
          displayName: "integrityOpp",
          race: "Protoss",
          strategy: "PvT - Agent Mystery",
        },
      }),
    );
    expect(post.status).toBe(202);

    let row = await db.games.findOne({
      userId, gameId: "g-proxy-ingest-unknown",
    });
    expect(row.spatial.my_proxy_classification_v).toBeUndefined();
    expect(row.spatial.my_proxies).toEqual([]);
    expect(row.myBuild).toBe("TvP Specific Proxy Rax");
    expect(row._customBuildSlug).toBe("tvp-specific-proxy-rax");
    expect(row.opponent.strategy).toBe("PvT Specific Proxy Gate");
    expect(row._customOpponentStrategySlug).toBe(
      "pvt-specific-proxy-gate",
    );

    const queued = await withAuth(
      request(app).post("/v1/custom-builds/reclassify-all").send({}),
    );
    expect(queued.status).toBe(202);
    await waitForJob(db, userId, queued.body.job.generation);
    row = await db.games.findOne({
      userId, gameId: "g-proxy-ingest-unknown",
    });
    expect(row.myBuild).toBe("TvP Specific Proxy Rax");
    expect(row._customBuildSlug).toBe("tvp-specific-proxy-rax");
    expect(row.opponent.strategy).toBe("PvT Specific Proxy Gate");
    expect(row._customOpponentStrategySlug).toBe(
      "pvt-specific-proxy-gate",
    );

    // Both empty logs are unavailable, not a definitive nonmatch. A re-upload
    // must restore both prior custom labels after GamesService patches the raw
    // agent labels, while a first ingest with no prior tag invents nothing.
    const emptyReupload = await withAuth(
      request(app).post("/v1/games").send({
        gameId: "g-proxy-ingest-unknown",
        date: "2026-05-10T00:00:00Z",
        result: "Victory",
        map: "Proxy Integrity LE",
        myRace: "Terran",
        myBuild: "TvP - Empty Agent Label",
        buildLog: [],
        oppBuildLog: [],
        opponent: {
          displayName: "integrityOpp",
          race: "Protoss",
          strategy: "PvT - Empty Agent Label",
        },
      }),
    );
    expect(emptyReupload.status).toBe(202);
    row = await db.games.findOne({
      userId, gameId: "g-proxy-ingest-unknown",
    });
    expect(row.myBuild).toBe("TvP Specific Proxy Rax");
    expect(row._customBuildSlug).toBe("tvp-specific-proxy-rax");
    expect(row.opponent.strategy).toBe("PvT Specific Proxy Gate");
    expect(row._customOpponentStrategySlug).toBe(
      "pvt-specific-proxy-gate",
    );

    const firstEmpty = await withAuth(
      request(app).post("/v1/games").send({
        gameId: "g-proxy-first-empty",
        date: "2026-05-11T00:00:00Z",
        result: "Defeat",
        map: "Proxy Integrity LE",
        myRace: "Terran",
        myBuild: "TvP - First Empty Agent",
        buildLog: [],
        oppBuildLog: [],
        opponent: {
          displayName: "firstEmptyOpp",
          race: "Protoss",
          strategy: "PvT - First Empty Agent",
        },
      }),
    );
    expect(firstEmpty.status).toBe(202);
    const firstRow = await db.games.findOne({
      userId, gameId: "g-proxy-first-empty",
    });
    expect(firstRow.myBuild).toBe("TvP - First Empty Agent");
    expect(firstRow._customBuildSlug).toBeUndefined();
    expect(firstRow.opponent.strategy).toBe("PvT - First Empty Agent");
    expect(firstRow._customOpponentStrategySlug).toBeUndefined();

    await db.games.insertOne({
      userId,
      gameId: "g-proxy-stale-axes",
      date: new Date("2026-05-12T00:00:00Z"),
      result: "Victory",
      map: "Proxy Integrity LE",
      myRace: "Terran",
      myBuild: "Wrong Axis Label",
      // Opponent definition incorrectly attached to the user's axis.
      _customBuildSlug: "pvt-specific-proxy-gate",
      opponent: {
        displayName: "staleAxesOpp",
        race: "Protoss",
        strategy: "Deleted Opponent Label",
      },
      _customOpponentStrategySlug: "deleted-opponent-slug",
    });
    const staleAxes = await withAuth(
      request(app).post("/v1/games").send({
        gameId: "g-proxy-stale-axes",
        date: "2026-05-12T00:00:00Z",
        result: "Victory",
        map: "Proxy Integrity LE",
        myRace: "Terran",
        myBuild: "TvP - Stale Agent",
        buildLog: [],
        oppBuildLog: [],
        opponent: {
          displayName: "staleAxesOpp",
          race: "Protoss",
          strategy: "PvT - Stale Agent",
        },
      }),
    );
    expect(staleAxes.status).toBe(202);
    const staleAxesRow = await db.games.findOne({
      userId, gameId: "g-proxy-stale-axes",
    });
    expect(staleAxesRow.myBuild).toBe("TvP - Stale Agent");
    expect(staleAxesRow._customBuildSlug).toBeUndefined();
    expect(staleAxesRow.opponent.strategy).toBe("PvT - Stale Agent");
    expect(staleAxesRow._customOpponentStrategySlug).toBeUndefined();

    await db.customBuilds.deleteMany({ userId });
    await db.games.insertOne({
      userId,
      gameId: "g-proxy-no-active-builds",
      date: new Date("2026-05-13T00:00:00Z"),
      result: "Victory",
      map: "Proxy Integrity LE",
      myRace: "Terran",
      myBuild: "Old Custom User",
      _customBuildSlug: "deleted-user-build",
      opponent: {
        displayName: "noBuildsOpp",
        race: "Protoss",
        strategy: "Old Custom Opponent",
      },
      _customOpponentStrategySlug: "deleted-opponent-build",
    });
    const noActive = await withAuth(
      request(app).post("/v1/games").send({
        gameId: "g-proxy-no-active-builds",
        date: "2026-05-13T00:00:00Z",
        result: "Victory",
        map: "Proxy Integrity LE",
        myRace: "Terran",
        myBuild: "TvP - No Active Agent",
        buildLog: [],
        oppBuildLog: [],
        opponent: {
          displayName: "noBuildsOpp",
          race: "Protoss",
          strategy: "PvT - No Active Agent",
        },
      }),
    );
    expect(noActive.status).toBe(202);
    const noActiveRow = await db.games.findOne({
      userId, gameId: "g-proxy-no-active-builds",
    });
    expect(noActiveRow.myBuild).toBe("TvP - No Active Agent");
    expect(noActiveRow._customBuildSlug).toBeUndefined();
    expect(noActiveRow.opponent.strategy).toBe("PvT - No Active Agent");
    expect(noActiveRow._customOpponentStrategySlug).toBeUndefined();
  });
});
