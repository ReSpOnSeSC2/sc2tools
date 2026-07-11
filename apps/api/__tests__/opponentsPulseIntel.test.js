// @ts-nocheck
"use strict";

/**
 * Route contract for GET /v1/opponents/:pulseId/pulse-intel:
 *   - 404 for an opponent the caller doesn't own
 *   - { intel: null } (200) when the opponent exists but their
 *     pulseCharacterId hasn't resolved yet
 *   - { intel } with the service payload once resolved
 *   - never triggers live SC2Pulse traffic in tests (stub injected)
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_intel" };
    throw new Error("invalid");
  }),
}));

describe("GET /v1/opponents/:pulseId/pulse-intel", () => {
  let mongo;
  let db;
  let app;
  let userId;
  const intelCalls = [];

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_pulse_intel",
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

  const FAKE_INTEL = { characterId: "777", league: { label: "Diamond" } };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
      pulseIntel: {
        getIntel: async (characterId) => {
          intelCalls.push(characterId);
          return characterId === "777" ? FAKE_INTEL : null;
        },
      },
    });
    app = built.app;

    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer test-token");
    expect(me.status).toBe(200);
    userId = me.body.userId;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function getIntel(pulseId) {
    return request(app)
      .get(`/v1/opponents/${encodeURIComponent(pulseId)}/pulse-intel`)
      .set("authorization", "Bearer test-token");
  }

  test("404s for an opponent the caller doesn't own", async () => {
    const res = await getIntel("1-S2-1-000000");
    expect(res.status).toBe(404);
  });

  test("returns intel:null while the character id is unresolved", async () => {
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-11111",
      displayNameSample: "Unresolved",
      gameCount: 1,
    });
    const res = await getIntel("1-S2-1-11111");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ intel: null });
    expect(intelCalls).toHaveLength(0);
  });

  test("returns the service payload once the character id is resolved", async () => {
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-22222",
      pulseCharacterId: "777",
      displayNameSample: "Resolved",
      gameCount: 3,
    });
    const res = await getIntel("1-S2-1-22222");
    expect(res.status).toBe(200);
    expect(res.body.intel).toEqual(FAKE_INTEL);
    expect(intelCalls).toEqual(["777"]);
  });

  test("does not leak another user's opponent", async () => {
    await db.opponents.insertOne({
      userId: "someone_else",
      pulseId: "1-S2-1-33333",
      pulseCharacterId: "777",
      gameCount: 5,
    });
    const res = await getIntel("1-S2-1-33333");
    expect(res.status).toBe(404);
  });
});
