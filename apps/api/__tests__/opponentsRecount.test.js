// @ts-nocheck
"use strict";

/**
 * Regression: opponent counters must not double-count when the same
 * ``gameId`` is uploaded twice.
 *
 * Reproducer for the May-2026 bug where users who clicked "Re-sync
 * from scratch" (which clears the agent's local ``state.uploaded``
 * dedupe and re-walks every replay) saw their per-opponent
 * ``gameCount`` / ``wins`` / ``losses`` / ``openings.<X>`` numbers
 * inflate by one on every re-upload — the slim ``games`` row dedupes
 * on ``(userId, gameId)``, but the ingest route used to call
 * ``opponents.recordGame`` unconditionally, and that does a $inc.
 *
 * Fix in apps/api/src/routes/games.js: gate ``recordGame`` on the
 * ``created`` flag returned by ``games.upsert``. Re-uploads now
 * route through ``opponents.refreshMetadata`` (which $sets the
 * legitimately-drifting fields like ``mmr`` and ``lastSeen`` without
 * touching counters).
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_recount" };
    throw new Error("invalid");
  }),
}));

const SAMPLE_GAME = {
  gameId: "2026-05-07T12:00:00|Deroke|Celestial Enclave LE|836",
  date: "2026-05-07T12:00:00.000Z",
  result: "Victory",
  myRace: "Protoss",
  map: "Celestial Enclave LE",
  durationSec: 836,
  myBuild: "PvP - 1 Gate Expand",
  buildLog: ["[0:00] Nexus", "[0:17] Pylon", "[0:49] Gateway"],
  oppBuildLog: ["[0:00] Nexus", "[0:30] Pylon", "[3:30] DarkShrine"],
  opponent: {
    pulseId: "1-S2-1-3748829",
    toonHandle: "1-S2-1-3748829",
    pulseCharacterId: "4597144",
    displayName: "Deroke",
    race: "Protoss",
    mmr: 4500,
    leagueId: 6,
    opening: "Protoss - DT Rush",
  },
};

describe("/v1/games ingest does not double-count opponent counters on re-upload", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_recount",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 5),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
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
    // Bootstrap user row by hitting /v1/me — same path the SPA uses.
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

  test("first upload bumps counters, second upload of the same gameId does not", async () => {
    // First upload — fresh insert.
    const r1 = await postGame(SAMPLE_GAME);
    expect(r1.status).toBe(202);
    expect(r1.body.accepted).toHaveLength(1);
    expect(r1.body.accepted[0].created).toBe(true);

    const opp1 = await db.opponents.findOne({
      pulseId: SAMPLE_GAME.opponent.pulseId,
    });
    expect(opp1).not.toBeNull();
    expect(opp1.gameCount).toBe(1);
    expect(opp1.wins).toBe(1);
    expect(opp1.losses).toBe(0);
    // Whatever the sanitized opening key is, it should be exactly
    // one entry with value 1 — locking the format to a literal would
    // be fragile across sanitizer revisions.
    expect(Object.keys(opp1.openings || {})).toHaveLength(1);
    expect(Object.values(opp1.openings || {})[0]).toBe(1);

    // Second upload — same gameId, agent re-sync.
    const r2 = await postGame(SAMPLE_GAME);
    expect(r2.status).toBe(202);
    expect(r2.body.accepted).toHaveLength(1);
    expect(r2.body.accepted[0].created).toBe(false);

    const opp2 = await db.opponents.findOne({
      pulseId: SAMPLE_GAME.opponent.pulseId,
    });
    // The whole point of the fix: counters DID NOT move.
    expect(opp2.gameCount).toBe(1);
    expect(opp2.wins).toBe(1);
    expect(opp2.losses).toBe(0);
    // Same opening key, same value — i.e. the $inc was NOT fired.
    expect(Object.keys(opp2.openings || {})).toHaveLength(1);
    expect(Object.values(opp2.openings || {})[0]).toBe(1);
    // games row count: also still 1 (dedupes on gameId).
    expect(await db.games.countDocuments({ gameId: SAMPLE_GAME.gameId })).toBe(1);
  });

  test("re-upload still refreshes mutable metadata (mmr, lastSeen)", async () => {
    await postGame(SAMPLE_GAME);
    const before = await db.opponents.findOne({
      pulseId: SAMPLE_GAME.opponent.pulseId,
    });

    // Same game, but the opponent's MMR has shifted between
    // encounters — the agent picks up the new value when it
    // re-uploads. ``refreshMetadata`` must take effect even though
    // ``recordGame`` is skipped.
    const updated = {
      ...SAMPLE_GAME,
      opponent: { ...SAMPLE_GAME.opponent, mmr: 4600 },
    };
    await postGame(updated);

    const after = await db.opponents.findOne({
      pulseId: SAMPLE_GAME.opponent.pulseId,
    });
    expect(after.mmr).toBe(4600);
    // Counters still untouched.
    expect(after.gameCount).toBe(before.gameCount);
    expect(after.wins).toBe(before.wins);
  });

  test("a second DISTINCT game vs the same opponent does increment counters", async () => {
    await postGame(SAMPLE_GAME);
    // Different gameId (different date/duration), same opponent.
    const second = {
      ...SAMPLE_GAME,
      gameId: "2026-05-07T13:00:00|Deroke|Celestial Enclave LE|901",
      date: "2026-05-07T13:00:00.000Z",
      durationSec: 901,
      result: "Defeat",
    };
    await postGame(second);

    const opp = await db.opponents.findOne({
      pulseId: SAMPLE_GAME.opponent.pulseId,
    });
    expect(opp.gameCount).toBe(2);
    expect(opp.wins).toBe(1);
    expect(opp.losses).toBe(1);
  });
});
