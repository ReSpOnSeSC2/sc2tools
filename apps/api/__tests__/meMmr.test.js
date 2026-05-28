// @ts-nocheck
"use strict";

/**
 * GET /v1/me/mmr — the dashboard MMR card's data source.
 *
 * Pins the cross-identifier dedupe: a profile that stores BOTH the raw
 * toon handle (``1-S2-1-267727``) and the canonical SC2Pulse character
 * id (``994428``) for the SAME account must report that account ONCE,
 * not twice. Both resolve to the same ``characterId``, so the fan-out
 * collapses them — otherwise the card reads "4 toons" for 2 accounts.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

// Resolve each stored identifier to an MMR row. The two NA identifiers
// (toon handle + character id) share one ``characterId``; likewise EU.
const MMR_BY_ID = {
  "1-S2-1-267727": { mmr: 5433, region: "NA", characterId: "994428" },
  "994428": { mmr: 5433, region: "NA", characterId: "994428" },
  "2-S2-1-8780508": { mmr: 5233, region: "EU", characterId: "8970877" },
  "8970877": { mmr: 5233, region: "EU", characterId: "8970877" },
};

jest.mock("../src/services/pulseMmr", () => ({
  PulseMmrService: class {
    async getCurrentMmr(id) {
      return MMR_BY_ID[String(id)] || null;
    }
  },
}));

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_mmr" };
    throw new Error("invalid");
  }),
}));

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

describe("GET /v1/me/mmr", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_me_mmr",
    clerkSecretKey: "sk_test",
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
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_me_mmr" });
    app = buildApp({ db, logger: pino({ level: "silent" }), config }).app;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer user-a");
  }

  test("dedupes the toon-handle + character-id forms of one account", async () => {
    await withAuth(request(app).get("/v1/me"));
    // Store all four identifiers — two per real account.
    await withAuth(request(app).put("/v1/me/profile")).send({
      pulseIds: ["1-S2-1-267727", "994428", "2-S2-1-8780508", "8970877"],
    });

    const res = await withAuth(request(app).get("/v1/me/mmr"));
    expect(res.status).toBe(200);
    // 4 stored ids → 2 distinct accounts.
    expect(res.body.entries).toHaveLength(2);
    // Sorted desc by MMR: NA (5433) before EU (5233).
    expect(res.body.entries.map((e) => e.region)).toEqual(["NA", "EU"]);
    expect(res.body.entries.map((e) => e.mmr)).toEqual([5433, 5233]);
    expect(res.body.truncated).toBe(false);
  });
});
