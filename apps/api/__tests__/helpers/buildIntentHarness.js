// @ts-nocheck
"use strict";

/**
 * Shared harness for the build check-in suites (buildIntents*.test.js,
 * buildIntentLive*.test.js, buildIntentSocket*.test.js).
 *
 * ``startFullApp`` boots MongoMemoryServer + the real ``buildApp`` with a
 * fake Socket.io that records every emit. Each suite declares its own
 * ``jest.mock("@clerk/backend", () => require("./helpers/clerkMock")())``
 * so ``Bearer u:<name>`` signs in as Clerk user ``clerk_<name>``.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const request = require("supertest");
const { connect } = require("../../src/db/connect");
const { buildApp } = require("../../src/app");
const { PulseMmrService } = require("../../src/services/pulseMmr");
const { randomToken, sha256 } = require("../../src/util/hash");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A Socket.io stand-in that records ``to(room).emit(event, payload)``. */
function makeFakeIo() {
  const emitted = [];
  return {
    emitted,
    to: (room) => ({
      emit: (event, payload) => {
        emitted.push({ room, event, payload });
      },
    }),
    in: () => ({ fetchSockets: async () => [] }),
    /** @param {string} event */
    events(event) {
      return emitted.filter((e) => e.event === event);
    },
    clear() {
      emitted.length = 0;
    },
  };
}

/** @param {string} dbName */
function testConfig(dbName) {
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
    rateLimitPerMinute: 100000,
    replayIngestMaxActive: 1,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };
}

/** @param {string} dbName */
async function startFullApp(dbName) {
  const mongo = await MongoMemoryServer.create();
  const db = await connect({ uri: mongo.getUri(), dbName });
  const io = makeFakeIo();
  const { app, services } = buildApp({
    db,
    logger: pino({ level: "silent" }),
    config: testConfig(dbName),
    io,
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
  return { mongo, db, app, services, io, stop };
}

/**
 * Create the Clerk user ``clerk_<name>`` and pair a device token to it.
 * @returns {Promise<{ userId: string, web: string, device: string }>} auth headers
 */
async function signIn(app, db, name) {
  const web = `Bearer u:${name}`;
  await request(app).get("/v1/me").set("authorization", web).expect(200);
  const row = await db.users.findOne({ clerkUserId: `clerk_${name}` });
  const raw = randomToken(32);
  const now = new Date();
  await db.deviceTokens.insertOne({
    tokenHash: sha256(raw),
    userId: row.userId,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  return { userId: row.userId, web, device: `Bearer ${raw}` };
}

/**
 * A randomizer config with one matchup enabled.
 * @param {string} matchup
 * @param {string[]} ids build ids (catalog slugs or custom:<slug>)
 * @param {{ enabled?: boolean }} [opts]
 */
function randomizerPrefs(matchup, ids, opts = {}) {
  return {
    version: 2,
    matchups: {
      [matchup]: {
        enabled: opts.enabled !== false,
        useCustomWeights: false,
        unitRandomizerEnabled: false,
        builds: ids.map((id) => ({
          id,
          name: `name of ${id}`,
          race: "Protoss",
          source: id.startsWith("custom:") ? "custom" : "catalog",
          weight: 1,
        })),
      },
    },
  };
}

/**
 * @param {object} db
 * @param {string} userId
 * @param {Record<string, unknown>} prefs merged under ``preferences``
 */
async function setPrefs(db, userId, prefs) {
  const set = {};
  for (const [key, value] of Object.entries(prefs)) set[`preferences.${key}`] = value;
  await db.users.updateOne({ userId }, { $set: set });
}

/** An overlay token with the given widgets. */
async function addOverlayToken(db, userId, token, enabledWidgets, extra = {}) {
  await db.overlayTokens.insertOne({
    token,
    userId,
    label: token,
    createdAt: new Date(),
    lastSeenAt: null,
    revokedAt: null,
    enabledWidgets,
    ...extra,
  });
}

/** A custom build document. */
async function addCustomBuild(db, userId, slug, fields = {}) {
  await db.customBuilds.insertOne({
    userId,
    slug,
    name: fields.name || `Custom ${slug}`,
    race: "Protoss",
    vsRace: "Zerg",
    perspective: "you",
    rules: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    _schemaVersion: 2,
    ...fields,
  });
}

/**
 * A stored games row (inserted directly, bypassing ingest).
 * @param {object} db
 * @param {string} userId
 * @param {string} gameId
 * @param {Record<string, unknown>} [fields]
 */
async function addGame(db, userId, gameId, fields = {}) {
  await db.games.insertOne({
    userId,
    gameId,
    date: new Date(Date.now() - HOUR_MS),
    result: "Victory",
    myRace: "Protoss",
    map: "Site Delta LE",
    durationSec: 600,
    myBuild: "PvZ - Macro Transition (Unclassified)",
    matchFormat: "1v1",
    opponent: { displayName: "Opp", race: "Zerg", pulseId: "p-1" },
    _schemaVersion: 8,
    ...fields,
  });
}

/**
 * An ingest payload: a 1v1 PvZ ladder game that ended ``endedAgoMs`` ago
 * after ``durationSec`` seconds.
 */
function ingestGame(n, over = {}) {
  const durationSec = over.durationSec ?? 620;
  const endMs = over.endMs ?? Date.now() - 5 * 60 * 1000;
  return {
    gameId: `bind-${n}|Opp|Site Delta LE|${durationSec}`,
    date: new Date(endMs).toISOString(),
    startedAt: new Date(endMs - durationSec * 1000).toISOString(),
    result: "Victory",
    myRace: "Protoss",
    map: "Site Delta LE",
    durationSec,
    myBuild: "PvZ - Macro Transition (Unclassified)",
    matchFormat: "1v1",
    isLadderGame: true,
    myMmrSource: "unavailable",
    buildLog: ["[0:12] Pylon", "[0:40] Gateway"],
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
  HOUR_MS,
  DAY_MS,
  makeFakeIo,
  startFullApp,
  signIn,
  randomizerPrefs,
  setPrefs,
  addOverlayToken,
  addCustomBuild,
  addGame,
  ingestGame,
};
