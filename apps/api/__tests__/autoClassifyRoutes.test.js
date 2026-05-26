// @ts-nocheck
"use strict";

/**
 * /v1/auto-classify integration tests.
 *
 * Spec: the discovery-engine HTTP surface must
 *   - 401 on unauthenticated requests,
 *   - return a candidates payload sorted/shaped the way
 *     AutoClassifyService.discover documents,
 *   - and on POST /apply, persist the candidate as a real custom build
 *     and re-tag the games it claims (verified by reading the games
 *     collection directly + the reclassify summary in the response).
 *
 * Seeded against a real MongoMemoryServer through buildApp so the
 * route + service + cloud reclassify pipeline are exercised end-to-end.
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

/**
 * Five Stargate-opening PvZ build logs with a few seconds of wobble
 * each so the cluster engine sees them as the same opening. Identical
 * tech path: Gateway → Cyber → Stargate → Phoenix → FleetBeacon →
 * Tempest by 8:00.
 */
function stargateBuildLog(w = 0) {
  return [
    `[0:00] Probe`,
    `[0:12] Probe`,
    `[0:17] Pylon`,
    `[0:${pad(45 + w)}] Gateway`,
    `[1:20] Assimilator`,
    `[1:${pad(43 + w)}] CyberneticsCore`,
    `[3:${pad(20 + w)}] Stargate`,
    `[4:${pad(40 + w)}] Phoenix`,
    `[5:${pad(10 + w)}] FleetBeacon`,
    `[6:${pad(40 + w)}] Tempest`,
  ];
}

/**
 * Distinct Robo opening — used for the multi-cluster check + as a
 * second matchup the candidate list can sort.
 */
function roboBuildLog(w = 0) {
  return [
    `[0:00] Probe`,
    `[0:12] Probe`,
    `[0:17] Pylon`,
    `[0:${pad(48 + w)}] Gateway`,
    `[1:20] Assimilator`,
    `[1:${pad(58 + w)}] CyberneticsCore`,
    `[3:${pad(20 + w)}] RoboticsFacility`,
    `[4:${pad(45 + w)}] Immortal`,
    `[5:${pad(10 + w)}] Observer`,
    `[5:${pad(30 + w)}] RoboticsBay`,
    `[6:${pad(50 + w)}] Colossus`,
  ];
}

function pad(n) {
  const s = String(Math.max(0, Math.min(59, n)));
  return s.length === 1 ? `0${s}` : s;
}

const ZERG_BUILD_LOG = [
  "[0:00] Drone",
  "[0:14] Drone",
  "[0:18] Overlord",
  "[0:48] Hatchery",
  "[1:10] SpawningPool",
  "[2:30] Lair",
];

describe("/v1/auto-classify", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_auto_classify_routes",
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

  async function seedStargateCluster(userId, opts = {}) {
    const myBuild = opts.myBuild === undefined ? null : opts.myBuild;
    const startMs = opts.startMs || Date.parse("2026-05-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      await services.games.upsert(userId, {
        gameId: opts.prefix
          ? `${opts.prefix}-${i + 1}`
          : `g-pvz-stargate-${i + 1}`,
        date: new Date(startMs + i * 60_000),
        myRace: "Protoss",
        oppRace: "Zerg",
        myBuild,
        buildLog: stargateBuildLog(i * 2),
        oppBuildLog: ZERG_BUILD_LOG,
        result: i % 2 === 0 ? "Victory" : "Defeat",
        map: "Equilibrium LE",
        opponent: { displayName: `zergBro${i}`, race: "Zerg" },
      });
    }
  }

  describe("auth", () => {
    test("GET /candidates without a bearer returns 401", async () => {
      const res = await request(app).get("/v1/auto-classify/candidates");
      expect(res.status).toBe(401);
    });

    test("POST /apply without a bearer returns 401", async () => {
      const res = await request(app)
        .post("/v1/auto-classify/apply")
        .send({ candidates: [] });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /candidates", () => {
    test("returns the discovered candidate shape for a 5-game cluster", async () => {
      const userId = await bootstrap();
      await seedStargateCluster(userId, { prefix: "g-discover" });

      const res = await withAuth(
        request(app).get("/v1/auto-classify/candidates"),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          perspective: "you",
          candidates: expect.any(Array),
        }),
      );
      // At least one PvZ candidate sourced from the seeded cluster.
      const pvz = res.body.candidates.find((c) => c.matchup === "PvZ");
      expect(pvz).toBeTruthy();
      expect(pvz).toEqual(
        expect.objectContaining({
          matchup: "PvZ",
          perspective: "you",
          race: "Protoss",
          vsRace: "Zerg",
          proposedName: expect.any(String),
          proposedSlug: expect.any(String),
          rules: expect.any(Array),
          gameCount: expect.any(Number),
          winRate: expect.any(Number),
          cohesion: expect.any(Number),
          selfMatchRate: expect.any(Number),
          sampleGames: expect.any(Array),
        }),
      );
      expect(pvz.gameCount).toBeGreaterThanOrEqual(5);
      expect(pvz.rules.length).toBeGreaterThan(0);
      expect(pvz.proposedSlug).toMatch(/^[a-zA-Z0-9._-]+$/);
      expect(pvz.sampleGames.length).toBeGreaterThan(0);
      for (const s of pvz.sampleGames) {
        expect(typeof s.gameId).toBe("string");
      }
    });

    test("perspective=opponent flips race/vsRace assignment", async () => {
      const userId = await bootstrap();
      // perspective=opponent reads oppEvents; we put the Robo opening
      // on the opp side so the discovered build is Protoss vs Zerg's
      // mirror — race=Protoss, vsRace=Zerg from the opponent's POV
      // (the cloud's matchup string stays myRace-first regardless).
      for (let i = 0; i < 5; i++) {
        await services.games.upsert(userId, {
          gameId: `g-opp-robo-${i + 1}`,
          date: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 60_000),
          myRace: "Zerg",
          oppRace: "Protoss",
          myBuild: null,
          buildLog: ZERG_BUILD_LOG,
          oppBuildLog: roboBuildLog(i * 2),
          result: "Victory",
          map: "Equilibrium LE",
          opponent: { displayName: `tossBro${i}`, race: "Protoss" },
        });
      }

      const res = await withAuth(
        request(app).get("/v1/auto-classify/candidates?perspective=opponent"),
      );
      expect(res.status).toBe(200);
      expect(res.body.perspective).toBe("opponent");
      const oppCandidate = res.body.candidates.find(
        (c) =>
          c.perspective === "opponent" &&
          c.race === "Protoss" &&
          c.vsRace === "Zerg",
      );
      expect(oppCandidate).toBeTruthy();
      // Matchup string is still myRace-first (Z vs P from user's
      // perspective).
      expect(oppCandidate.matchup).toBe("ZvP");
    });
  });

  describe("POST /apply", () => {
    test("creates a build and reclassifies tagged games", async () => {
      const userId = await bootstrap();
      await seedStargateCluster(userId, { prefix: "g-apply" });

      const discover = await withAuth(
        request(app).get("/v1/auto-classify/candidates"),
      );
      expect(discover.status).toBe(200);
      const candidate = discover.body.candidates.find(
        (c) => c.matchup === "PvZ" && c.race === "Protoss",
      );
      expect(candidate).toBeTruthy();

      const apply = await withAuth(
        request(app)
          .post("/v1/auto-classify/apply")
          .send({ candidates: [candidate] }),
      );
      expect(apply.status).toBe(200);
      expect(apply.body).toEqual(
        expect.objectContaining({
          ok: true,
          created: [candidate.proposedSlug],
          builds: expect.any(Number),
          scanned: expect.any(Number),
          tagged: expect.any(Number),
          cleared: expect.any(Number),
          perBuild: expect.any(Array),
        }),
      );
      expect(apply.body.tagged).toBeGreaterThanOrEqual(5);

      // The build now exists in the user's custom-builds library.
      const stored = await db.customBuilds.findOne({
        userId,
        slug: candidate.proposedSlug,
      });
      expect(stored).toBeTruthy();
      expect(stored.name).toBe(candidate.proposedName);
      expect(stored.race).toBe("Protoss");
      expect(stored.vsRace).toBe("Zerg");
      expect(stored.source).toBe("auto-classify");
      expect(Array.isArray(stored.rules)).toBe(true);
      expect(stored.rules.length).toBeGreaterThan(0);

      // Every seeded cluster game carries the new build's name.
      const tagged = await db.games
        .find({ userId, gameId: { $regex: /^g-apply-/ } })
        .toArray();
      expect(tagged.length).toBe(5);
      for (const g of tagged) {
        expect(g.myBuild).toBe(candidate.proposedName);
      }
    });

    test("400 when body.candidates is missing", async () => {
      await bootstrap();
      const res = await withAuth(
        request(app).post("/v1/auto-classify/apply").send({}),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    });

    test("400 when body.candidates is empty", async () => {
      await bootstrap();
      const res = await withAuth(
        request(app)
          .post("/v1/auto-classify/apply")
          .send({ candidates: [] }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    });

    test("400 when body.candidates exceeds the per-call cap", async () => {
      await bootstrap();
      const tooMany = Array.from({ length: 51 }, (_, i) => ({
        proposedSlug: `dummy-${i}`,
        proposedName: `Dummy ${i}`,
        race: "Protoss",
        vsRace: "Zerg",
        perspective: "you",
        rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
      }));
      const res = await withAuth(
        request(app)
          .post("/v1/auto-classify/apply")
          .send({ candidates: tooMany }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    });

    test("400 with structured details when any candidate fails validation", async () => {
      await bootstrap();
      const res = await withAuth(
        request(app)
          .post("/v1/auto-classify/apply")
          .send({
            candidates: [
              {
                // empty slug fails the slug pattern in validateCustomBuild
                proposedSlug: "",
                proposedName: "",
                race: "Protoss",
                vsRace: "Zerg",
                perspective: "you",
                rules: [
                  { type: "before", name: "BuildStargate", time_lt: 240 },
                ],
              },
            ],
          }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_candidates");
      expect(Array.isArray(res.body.error.details)).toBe(true);
      // Each detail is a flat human-readable string so the cloud UI
      // can surface them verbatim in a toast (per-candidate field
      // errors are prefixed with their slug when one is available).
      expect(res.body.error.details.length).toBeGreaterThan(0);
      for (const d of res.body.error.details) {
        expect(typeof d).toBe("string");
        expect(d.length).toBeGreaterThan(0);
      }
    });
  });
});
