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
const { PulseMmrService } = require("../src/services/pulseMmr");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_mmr" };
    throw new Error("invalid");
  }),
}));

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

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

const CHARACTER_IDS = new Map([
  ["1-S2-1-267727", 994428],
  ["2-S2-1-8780508", 8970877],
  ["1-S2-1-11", 1001],
  ["2-S2-1-22", 1002],
  ["1-S2-1-44", 1004],
  ["2-S2-1-55", 1005],
]);
const TEAMS = new Map([
  ["994428", [{ region: "US", rating: 5433 }]],
  ["8970877", [{ region: "EU", rating: 5233 }]],
  ["1004", [{ region: "US", rating: 5433 }]],
  ["1005", [{ region: "EU", rating: 5233 }]],
  ["2001", [
    { region: "US", rating: 5800, members: [{ terranGamesPlayed: 30 }] },
    { region: "US", rating: 4200, members: [{ protossGamesPlayed: 30 }] },
    { region: "US", rating: 4000, members: [{ randomGamesPlayed: 30 }] },
    { region: "US", rating: 6200, members: [{ protossGamesPlayed: 0 }] },
  ]],
  ["2002", [{ region: "EU", rating: 3900, members: [{ protossGamesPlayed: 30 }] }]],
]);

async function fetchPulseFixture(url) {
  const { pathname, searchParams } = new URL(url);
  let data = [];
  if (pathname.endsWith("/character/search")) {
    const id = CHARACTER_IDS.get(searchParams.get("term"));
    if (id) data = [{ members: { character: { id } } }];
  } else if (pathname.endsWith("/season/list/all")) {
    data = [{ battlenetId: 68, region: "US" }, { battlenetId: 68, region: "EU" }];
  } else if (pathname.endsWith("/group/team")) {
    data = searchParams.getAll("characterId").flatMap((id) => TEAMS.get(id) || []);
  }
  return { ok: true, json: async () => data };
}

let mongo;
let db;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_me_mmr" });
  const pulseMmr = new PulseMmrService({ fetchImpl: fetchPulseFixture });
  app = buildApp({ db, logger: pino({ level: "silent" }), config, pulseMmr }).app;
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

function withAuth(req) {
  return req.set("authorization", "Bearer user-a");
}

describe("GET /v1/me/mmr", () => {
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
    expect(res.body.hasSavedIds).toBe(true);
    expect(res.body.truncated).toBe(false);
  });

  test("looks up later ladder handles when earlier saved handles have no rating", async () => {
    await withAuth(request(app).get("/v1/me"));
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: ["1-S2-1-11", "2-S2-1-22", "98-S2-1-33", "1-S2-1-44", "2-S2-1-55"] })
      .expect(200);

    const res = await withAuth(request(app).get("/v1/me/mmr")).expect(200);
    expect(res.body).toEqual({
      entries: [
        { pulseId: "1-S2-1-44", region: "NA", mmr: 5433 },
        { pulseId: "2-S2-1-55", region: "EU", mmr: 5233 },
      ],
      hasSavedIds: true,
      truncated: false,
    });
  });

  test("returns a private, race-scoped MMR from the owner's saved ladders", async () => {
    await request(app).get("/v1/me/mmr?race=R").expect(401);
    await withAuth(request(app).get("/v1/me"));
    await withAuth(request(app).put("/v1/me/profile")).send({ pulseIds: ["2001", "2002"] }).expect(200);
    const protoss = await withAuth(request(app).get("/v1/me/mmr?race=P")).expect(200);
    expect(protoss.headers["cache-control"]).toBe("private, no-store");
    expect(protoss.body).toEqual({ race: "P", mmr: 4200 });
    expect((await withAuth(request(app).get("/v1/me/mmr?race=R")).expect(200)).body).toEqual({ race: "R", mmr: 4000 });
    expect((await withAuth(request(app).get("/v1/me/mmr?race=Z")).expect(200)).body).toEqual({ race: "Z", mmr: null });
    await withAuth(request(app).get("/v1/me/mmr?race=P&race=T")).expect(400);
    await withAuth(request(app).get("/v1/me/mmr?race=unknown")).expect(400);
  });

  test("distinguishes saved identities with no rating from missing setup", async () => {
    await withAuth(request(app).get("/v1/me"));
    await withAuth(request(app).put("/v1/me/profile")).send({ pulseIds: ["98-S2-1-33"] }).expect(200);
    const unrated = await withAuth(request(app).get("/v1/me/mmr")).expect(200);
    expect(unrated.body).toEqual({ entries: [], hasSavedIds: true, truncated: false });

    await withAuth(request(app).put("/v1/me/profile")).send({ pulseIds: [] }).expect(200);
    const unconfigured = await withAuth(request(app).get("/v1/me/mmr")).expect(200);
    expect(unconfigured.body).toEqual({ entries: [], hasSavedIds: false, truncated: false });
  });
});
