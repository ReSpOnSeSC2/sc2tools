// @ts-nocheck
"use strict";

/**
 * Shared full-app harness for the browser-ingest suites
 * (gamesBrowserIngest, gamesExists, browserIngestQuota).
 *
 * Boots a real MongoMemoryServer + ``connect`` (so indexes exist) and the
 * real ``buildApp`` with a hand-built config, like the other full-app
 * suites. Each test file declares its own ``jest.mock("@clerk/backend")``
 * (jest hoists mocks per file) mapping "browser-token" to
 * "clerk_user_browser" and "other-browser-token" to "clerk_user_other".
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../../src/db/connect");
const { buildApp } = require("../../src/app");
const { PulseMmrService } = require("../../src/services/pulseMmr");
const { randomToken, sha256 } = require("../../src/util/hash");

/**
 * @param {string} dbName
 * @param {Record<string, unknown>} [overrides] config fields
 */
function testConfig(dbName, overrides = {}) {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: dbName,
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    replayIngestMaxActive: 1,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
    ...overrides,
  };
}

/**
 * Start Mongo + the app. Call ``stop`` in afterAll.
 * @param {string} dbName
 * @param {Record<string, unknown>} [overrides]
 */
async function startHarness(dbName, overrides = {}) {
  const mongo = await MongoMemoryServer.create();
  const db = await connect({ uri: mongo.getUri(), dbName });
  const { app, services } = buildApp({
    db,
    logger: pino({ level: "silent" }),
    config: testConfig(dbName, overrides),
    pulseMmr: new PulseMmrService({
      fetchImpl: async () => {
        throw new Error("network_disabled_in_tests");
      },
    }),
  });
  const stop = async () => {
    await db.close();
    await mongo.stop();
  };
  return { mongo, db, app, services, stop };
}

/** Wipe every collection the browser-ingest suites write. */
async function resetCollections(db) {
  await Promise.all([
    db.games.deleteMany({}),
    db.gameDetails.deleteMany({}),
    db.opponents.deleteMany({}),
    db.deviceTokens.deleteMany({}),
    db.browserIngestDaily.deleteMany({}),
  ]);
}

/**
 * Pair a device token to ``userId``; returns the raw bearer token.
 * @param {object} db
 * @param {string} userId
 */
async function insertDeviceToken(db, userId) {
  const raw = randomToken(32);
  const now = new Date();
  await db.deviceTokens.insertOne({
    tokenHash: sha256(raw),
    userId,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  return raw;
}

/** Resolve the internal userId for a Clerk id (created on first request). */
async function userIdForClerk(db, clerkUserId) {
  const row = await db.users.findOne({ clerkUserId });
  return row ? row.userId : null;
}

/**
 * A small but complete game record in the pipeline's upload shape.
 * @param {number} n distinguishes gameIds
 * @param {Record<string, unknown>} [over]
 */
function sampleGame(n = 1, over = {}) {
  return {
    gameId: `2026-09-20T12:10:${String(n).padStart(2, "0")}|Opp|Site Delta LE|620`,
    date: "2026-09-20T12:10:20.000Z",
    result: "Victory",
    myRace: "Protoss",
    map: "Site Delta LE",
    durationSec: 620,
    myMmrSource: "unavailable",
    myToonHandle: "1-S2-1-111",
    isLadderGame: true,
    buildLog: ["[0:12] Pylon"],
    oppBuildLog: ["[0:17] SpawningPool"],
    opponent: {
      pulseId: "1-S2-1-222",
      toonHandle: "1-S2-1-222",
      displayName: "Opp",
      race: "Zerg",
      pulseLookupAttempted: false,
    },
    ...over,
  };
}

module.exports = {
  startHarness,
  resetCollections,
  insertDeviceToken,
  userIdForClerk,
  sampleGame,
};
