// @ts-nocheck
"use strict";

/**
 * Integration: POST /v1/games on a re-upload that finally carries a
 * resolved pulseCharacterId must persist it on the opponents row,
 * even though counters are NOT bumped on a duplicate gameId.
 *
 * Mirror of the May-2026 stuck-on-TOON-id failure mode: the first
 * ingest happened during a transient SC2Pulse outage so the
 * opponents row was created without ``pulseCharacterId``; a
 * subsequent re-upload of the SAME ``gameId`` then carries the
 * agent's freshly-resolved id, and the ingest path must call
 * ``refreshMetadata`` (which writes the new id) rather than
 * silently skipping the metadata update.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_pulse" };
    throw new Error("invalid");
  }),
}));

describe("/v1/games re-upload upgrades pulseCharacterId on the opponents row", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_pulse_upgrade",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 9),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  const FIRST_UPLOAD = {
    gameId: "2026-05-09T12:00:00|JmaC|Hard Lead LE|620",
    date: "2026-05-09T12:00:00.000Z",
    result: "Defeat",
    myRace: "Protoss",
    map: "Hard Lead LE",
    durationSec: 620,
    opponent: {
      pulseId: "1-S2-1-437579",
      toonHandle: "1-S2-1-437579",
      displayName: "JmaC",
      race: "Terran",
      // No pulseCharacterId — SC2Pulse was unreachable at first
      // ingest. ``pulseLookupAttempted`` reflects the agent's
      // honest "I tried" signal so the cron knows it can re-probe.
      pulseLookupAttempted: true,
    },
  };

  const SECOND_UPLOAD = {
    ...FIRST_UPLOAD,
    opponent: {
      ...FIRST_UPLOAD.opponent,
      pulseCharacterId: "340543107",
    },
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.gameDetails.deleteMany({});
    await db.opponents.deleteMany({});
    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer test-token");
    expect(me.status).toBe(200);
  });

  function postGame(payload) {
    return request(app)
      .post("/v1/games")
      .set("authorization", "Bearer test-token")
      .send(payload);
  }

  test("first ingest leaves pulseCharacterId unset; re-upload upgrades it", async () => {
    const r1 = await postGame(FIRST_UPLOAD);
    expect(r1.status).toBe(202);
    expect(r1.body.accepted[0].created).toBe(true);
    let row = await db.opponents.findOne({
      pulseId: FIRST_UPLOAD.opponent.pulseId,
    });
    expect(row).not.toBeNull();
    expect(row.pulseCharacterId).toBeUndefined();
    expect(row.toonHandle).toBe("1-S2-1-437579");
    expect(row.gameCount).toBe(1);
    expect(row.pulseResolveAttemptedAt).toBeInstanceOf(Date);

    const r2 = await postGame(SECOND_UPLOAD);
    expect(r2.status).toBe(202);
    expect(r2.body.accepted[0].created).toBe(false);
    row = await db.opponents.findOne({
      pulseId: FIRST_UPLOAD.opponent.pulseId,
    });
    // The fix: refreshMetadata fired on the duplicate gameId and
    // landed the pulseCharacterId.
    expect(row.pulseCharacterId).toBe("340543107");
    // Counters did NOT double-count.
    expect(row.gameCount).toBe(1);
    expect(row.losses).toBe(1);
  });

  test("re-upload with a NEW pulseCharacterId replaces the stored value", async () => {
    await postGame(SECOND_UPLOAD); // store 340543107
    const rotated = {
      ...SECOND_UPLOAD,
      opponent: { ...SECOND_UPLOAD.opponent, pulseCharacterId: "999999" },
    };
    const r = await postGame(rotated);
    expect(r.status).toBe(202);
    const row = await db.opponents.findOne({
      pulseId: FIRST_UPLOAD.opponent.pulseId,
    });
    expect(row.pulseCharacterId).toBe("999999");
  });

  test("re-upload that LOSES the resolved id keeps the stored one (sticky)", async () => {
    await postGame(SECOND_UPLOAD); // store 340543107
    await postGame(FIRST_UPLOAD);  // no pulseCharacterId in payload
    const row = await db.opponents.findOne({
      pulseId: FIRST_UPLOAD.opponent.pulseId,
    });
    expect(row.pulseCharacterId).toBe("340543107");
  });
});
