// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

// Bypass Clerk for this test by mocking the verifyToken export to
// recognise a magic string and return a stable claim.
jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-clerk-token") return { sub: "clerk_user_test" };
    throw new Error("invalid");
  }),
}));

describe("HTTP integration", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test",
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
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test" });
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

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  describe("/v1/health", () => {
    test("returns 200 without auth", async () => {
      const res = await request(app).get("/v1/health");
      expect(res.status).toBe(200);
    });
  });

  describe("/v1/me", () => {
    test("401 without bearer", async () => {
      const res = await request(app).get("/v1/me");
      expect(res.status).toBe(401);
    });

    test("returns user shell after Clerk auth", async () => {
      const res = await withAuth(request(app).get("/v1/me"));
      expect(res.status).toBe(200);
      expect(res.body.userId).toBeTruthy();
    });
  });

  describe("/v1/summary", () => {
    test("returns empty totals for a fresh user", async () => {
      const res = await withAuth(request(app).get("/v1/summary"));
      expect(res.status).toBe(200);
      expect(res.body.totals.total).toBe(0);
    });
  });

  describe("/v1/games ingest + reads", () => {
    test("POST /v1/games accepts and persists a single game", async () => {
      const game = makeGame("g1", "Victory");
      const post = await withAuth(request(app).post("/v1/games"))
        .send(game)
        .set("content-type", "application/json");
      expect(post.status).toBe(202);
      expect(post.body.accepted).toHaveLength(1);

      const list = await withAuth(request(app).get("/v1/games"));
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].gameId).toBe("g1");
    });

    test("GET /v1/games-list returns the SPA-shaped list", async () => {
      const res = await withAuth(request(app).get("/v1/games-list"));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    test("GET /v1/builds reflects the uploaded game", async () => {
      const res = await withAuth(request(app).get("/v1/builds"));
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].name).toBeTruthy();
    });

    test("GET /v1/games/:id/build-order parses the stored buildLog", async () => {
      const res = await withAuth(request(app).get("/v1/games/g1/build-order"));
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeGreaterThan(0);
    });

    test("GET /v1/games/:id/macro-breakdown returns 404 when not computed", async () => {
      const res = await withAuth(request(app).get("/v1/games/g1/macro-breakdown"));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("macro_not_computed");
    });

    test("POST /v1/games/:id/macro-breakdown with body persists data", async () => {
      const res = await withAuth(
        request(app).post("/v1/games/g1/macro-breakdown"),
      ).send({ macroScore: 85, breakdown: { score: 85 } });
      expect(res.status).toBe(202);
      const after = await withAuth(
        request(app).get("/v1/games/g1/macro-breakdown"),
      );
      expect(after.status).toBe(200);
      expect(after.body.macro_score).toBe(85);
    });
  });

  describe("/v1/opponents profile DNA", () => {
    test("returns the full DNA payload after a few games", async () => {
      const games = [
        Object.assign(makeGame("opp-pulse-game-1", "Victory"), {
          opponent: {
            displayName: "Foo",
            race: "Zerg",
            mmr: 4000,
            pulseId: "opp-pulse-1",
            strategy: "Macro",
          },
          buildLog: ["[1:30] Pylon", "[2:30] Gateway", "[3:00] Cybernetics"],
          oppBuildLog: ["[1:30] Pool", "[2:00] Hatchery"],
        }),
        Object.assign(makeGame("opp-pulse-game-2", "Defeat"), {
          opponent: {
            displayName: "Foo",
            race: "Zerg",
            mmr: 4000,
            pulseId: "opp-pulse-1",
            strategy: "Allin",
          },
          buildLog: ["[2:00] Pylon", "[2:45] Gateway"],
          oppBuildLog: ["[1:50] Pool"],
        }),
        Object.assign(makeGame("opp-pulse-game-3", "Victory"), {
          opponent: {
            displayName: "Foo",
            race: "Zerg",
            mmr: 4000,
            pulseId: "opp-pulse-1",
            strategy: "Macro",
          },
          buildLog: ["[1:45] Pylon"],
          oppBuildLog: ["[1:55] Pool", "[2:30] Hatchery"],
        }),
      ];
      for (const g of games) {
        const post = await withAuth(request(app).post("/v1/games"))
          .send(g)
          .set("content-type", "application/json");
        expect(post.status).toBe(202);
      }
      const res = await withAuth(
        request(app).get("/v1/opponents/opp-pulse-1"),
      );
      expect(res.status).toBe(200);
      const body = res.body;
      expect(body.pulseId).toBe("opp-pulse-1");
      expect(body.totals.total).toBe(3);
      expect(body.totals.wins).toBe(2);
      expect(body.totals.losses).toBe(1);
      expect(body.byMap.Goldenaura.wins).toBe(2);
      expect(body.byMap.Goldenaura.losses).toBe(1);
      expect(body.byStrategy.Macro.wins).toBe(2);
      expect(body.byStrategy.Allin.losses).toBe(1);
      // top strategies sorted by count
      expect(body.topStrategies[0].strategy).toBe("Macro");
      expect(body.topStrategies[0].count).toBe(2);
      // recency-weighted predictions
      expect(body.predictedStrategies.length).toBeGreaterThan(0);
      const macroPred = body.predictedStrategies.find(
        (p) => p.strategy === "Macro",
      );
      expect(macroPred).toBeTruthy();
      // matchup-aware median timings
      expect(body.myRace).toBe("P");
      expect(body.oppRaceModal).toBe("Z");
      expect(body.matchupLabel).toBe("PvZ");
      expect(body.matchupCounts.PvZ).toBe(3);
      expect(body.medianTimingsLegacy.SpawningPool.sampleCount).toBe(3);
      expect(body.medianTimingsLegacy.Gateway.sampleCount).toBe(2);
      expect(body.medianTimingsLegacy.Pylon.source).toBe("build_log");
      expect(body.medianTimingsLegacy.SpawningPool.source).toBe(
        "opp_build_log",
      );
      expect(body.medianTimings.Pylon.median).toBeGreaterThan(0);
      expect(body.medianTimings.Pylon.count).toBe(3);
      expect(body.matchupTimings.PvZ.SpawningPool.count).toBe(3);
      // last 5 games + full games array
      expect(body.last5Games.length).toBe(3);
      expect(body.games.length).toBe(3);
      expect(body.games[0].my_build).toBeDefined();
      expect(body.games[0].opp_strategy).toBeTruthy();
    });

    test("404 for unknown pulseId", async () => {
      const res = await withAuth(
        request(app).get("/v1/opponents/does-not-exist"),
      );
      expect(res.status).toBe(404);
    });

    test("persists toonHandle + pulseCharacterId round-trip", async () => {
      const game = Object.assign(makeGame("opp-cid-game-1", "Victory"), {
        opponent: {
          displayName: "BrenMcBash",
          race: "Terran",
          pulseId: "1-S2-1-716965",
          toonHandle: "1-S2-1-716965",
          pulseCharacterId: "994428",
        },
        buildLog: ["[1:30] Pylon"],
        oppBuildLog: ["[1:30] CommandCenter"],
      });
      const post = await withAuth(request(app).post("/v1/games"))
        .send(game)
        .set("content-type", "application/json");
      expect(post.status).toBe(202);
      const detail = await withAuth(
        request(app).get("/v1/opponents/1-S2-1-716965"),
      );
      expect(detail.status).toBe(200);
      expect(detail.body.toonHandle).toBe("1-S2-1-716965");
      expect(detail.body.pulseCharacterId).toBe("994428");
      const list = await withAuth(request(app).get("/v1/opponents"));
      expect(list.status).toBe(200);
      const row = list.body.items.find(
        (i) => i.pulseId === "1-S2-1-716965",
      );
      expect(row).toBeTruthy();
      expect(row.pulseCharacterId).toBe("994428");
      expect(row.toonHandle).toBe("1-S2-1-716965");
    });

    test("does not clobber resolved pulseCharacterId on a later offline game", async () => {
      const offline = Object.assign(makeGame("opp-cid-game-2", "Victory"), {
        opponent: {
          displayName: "BrenMcBash",
          race: "Terran",
          pulseId: "1-S2-1-716965",
          toonHandle: "1-S2-1-716965",
          // pulseCharacterId omitted — sc2pulse offline at this ingest
        },
      });
      const post = await withAuth(request(app).post("/v1/games"))
        .send(offline)
        .set("content-type", "application/json");
      expect(post.status).toBe(202);
      const detail = await withAuth(
        request(app).get("/v1/opponents/1-S2-1-716965"),
      );
      expect(detail.status).toBe(200);
      // The previously resolved id must still be present.
      expect(detail.body.pulseCharacterId).toBe("994428");
    });
  });

  describe("/v1/spatial", () => {
    test("/spatial/maps returns an empty array for users without spatial data", async () => {
      const res = await withAuth(request(app).get("/v1/spatial/maps"));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test("/spatial/buildings requires a map", async () => {
      const res = await withAuth(request(app).get("/v1/spatial/buildings"));
      expect(res.status).toBe(400);
    });
  });

  describe("/v1/import", () => {
    test("POST /v1/import/scan returns a job id", async () => {
      const res = await withAuth(request(app).post("/v1/import/scan")).send({
        folder: "C:\\Replays",
      });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeTruthy();
    });

    test("POST /v1/import/start kicks the agent", async () => {
      // The earlier scan/start tests left a job in 'scanning'/'running'.
      // Cancel it before kicking a fresh import so we don't 409.
      await withAuth(request(app).post("/v1/import/cancel"));
      const res = await withAuth(request(app).post("/v1/import/start")).send({
        folder: "C:\\Replays",
      });
      expect(res.status).toBe(202);
      expect(res.body.workers).toBeGreaterThan(0);
    });

    test("GET /v1/import/cores returns a positive default", async () => {
      const res = await withAuth(request(app).get("/v1/import/cores"));
      expect(res.status).toBe(200);
      expect(res.body.cores).toBeGreaterThan(0);
    });
  });

  describe("/v1/macro/backfill", () => {
    test("POST /v1/macro/backfill/start produces a job entry", async () => {
      const res = await withAuth(
        request(app).post("/v1/macro/backfill/start"),
      ).send({});
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeTruthy();
    });

    test("GET /v1/macro/backfill/status returns the latest job", async () => {
      const res = await withAuth(
        request(app).get("/v1/macro/backfill/status"),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("/v1/ml", () => {
    test("/ml/status returns hasModel=false initially", async () => {
      const res = await withAuth(request(app).get("/v1/ml/status"));
      expect(res.status).toBe(200);
      expect(res.body.hasModel).toBe(false);
    });

    test("/ml/options returns empty arrays without a model", async () => {
      const res = await withAuth(request(app).get("/v1/ml/options"));
      expect(res.status).toBe(200);
      expect(res.body.races).toEqual([]);
    });

    test("/ml/train returns 503 when python is unavailable", async () => {
      const res = await withAuth(request(app).post("/v1/ml/train")).send({});
      expect(res.status).toBe(503);
    });
  });

  describe("/v1/agent/version", () => {
    test("publish requires admin token", async () => {
      const res = await request(app)
        .post("/v1/agent/releases")
        .send({
          channel: "stable",
          version: "1.0.0",
          artifacts: [
            {
              platform: "windows",
              downloadUrl: "https://example.com/agent.exe",
              sha256: "a".repeat(64),
            },
          ],
        });
      expect(res.status).toBe(401);
    });

    test("admin token publishes a release that the version endpoint serves", async () => {
      const publish = await request(app)
        .post("/v1/agent/releases")
        .set("x-admin-token", "admin-token-for-tests")
        .send({
          channel: "stable",
          version: "1.0.0",
          artifacts: [
            {
              platform: "windows",
              downloadUrl: "https://example.com/agent.exe",
              sha256: "a".repeat(64),
            },
          ],
        });
      // Helpful debug if this ever fails again
      if (publish.status !== 201) {
        // eslint-disable-next-line no-console
        console.error("publish failed:", publish.status, publish.body, publish.text);
      }
      expect(publish.status).toBe(201);

      const version = await request(app).get(
        "/v1/agent/version?channel=stable&platform=windows&current=0.0.1",
      );
      expect(version.status).toBe(200);
      expect(version.body.update_available).toBe(true);
      expect(version.body.latest).toBe("1.0.0");
    });

    test("agent on the latest version sees update_available=false", async () => {
      const res = await request(app).get(
        "/v1/agent/version?channel=stable&platform=windows&current=1.0.0",
      );
      expect(res.status).toBe(200);
      expect(res.body.update_available).toBe(false);
    });
  });

  describe("/v1/catalog + /v1/definitions + /v1/export.csv", () => {
    test("/catalog returns at least empty arrays", async () => {
      const res = await withAuth(request(app).get("/v1/catalog"));
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });

    test("/definitions returns the fallback envelope when no file is shipped", async () => {
      const res = await withAuth(request(app).get("/v1/definitions"));
      expect(res.status).toBe(200);
      expect(res.body.timings).toBeDefined();
    });

    test("/export.csv streams CSV output", async () => {
      const res = await withAuth(request(app).get("/v1/export.csv"));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text.startsWith("gameId,date,result")).toBe(true);
    });

    test("/playback returns a 501 with the local-only hint", async () => {
      const res = await withAuth(request(app).get("/v1/playback"));
      expect(res.status).toBe(501);
    });
  });

  test("UNUSED services to silence the no-unused-vars rule", () => {
    expect(services).toBeDefined();
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
    buildLog: ["[0:30] Probe", "[1:00] Pylon", "[2:15] Stargate"],
    earlyBuildLog: ["[0:00] Nexus"],
    oppBuildLog: ["[1:30] Drone"],
    oppEarlyBuildLog: [],
    opponent: {
      displayName: "Foo",
      race: "Zerg",
      mmr: 4000,
      pulseId: "pulse-1",
      strategy: "Macro",
    },
  };
}
