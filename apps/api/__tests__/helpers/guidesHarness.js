// @ts-nocheck
"use strict";

/**
 * Shared full-app setup for the SC2 Tools Guides API suites
 * (guidesRoutes*.test.js, guidesAdmin.test.js, guidesNoPii.test.js,
 * guideNotes.test.js). TEST FIXTURES ONLY.
 *
 * Each suite declares the Clerk mock itself (jest hoists mocks per file):
 *   jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
 * Bearer ``u:<name>`` → Clerk id ``clerk_<name>``; ``seedUser(name)``
 * creates the internal user ``u_<name>`` first so ids are predictable.
 * ``u:admin`` is the platform admin.
 *
 * The guides video service is injected with the real channel id (so the
 * committed snapshot seeds) and a fetch that never reaches the network
 * unless a suite passes its own ``fetchImpl``.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../../src/db/connect");
const { buildApp } = require("../../src/app");
const { PulseMmrService } = require("../../src/services/pulseMmr");
const { GuideVideosService } = require("../../src/services/guideVideos");
const { cellGames, slimGame, sampleRow, GLAIVES } = require("./guideStatsSeed");

const CHANNEL_ID = "UCZS3YP1mvpqyuU5vPvHVG7g";
const CHANNEL_URL = "https://www.youtube.com/@ReSpOnSeSC2";
const ROBO = "PvZ - Robo Opener";
const EIGHT_POOL = "Zerg - 8 Pool";
const SHARER_SLUG = "sharer-one-a1b2c3d4e5";

const networkDisabled = async () => {
  throw new Error("network_disabled_in_tests");
};

/**
 * @param {{ enabled?: boolean, fetchImpl?: Function, admins?: string[] }} [opts]
 */
async function createGuidesHarness(opts = {}) {
  const mongo = await MongoMemoryServer.create();
  const dbName = `guides_${Math.random().toString(36).slice(2, 10)}`;
  const db = await connect({ uri: mongo.getUri(), dbName });
  const config = {
    port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: dbName,
    clerkSecretKey: "sk_test", clerkJwtIssuer: undefined, clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: [], rateLimitPerMinute: 100000,
    agentReleaseAdminToken: "admin", pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: (opts.admins || ["admin"]).map((name) => `clerk_${name}`),
    guidesEnabled: opts.enabled !== false,
    guidesYoutubeChannelId: CHANNEL_ID,
    guidesYoutubeChannelUrl: CHANNEL_URL,
  };
  const logger = pino({ level: "silent" });
  const guideVideos = new GuideVideosService(db, {
    channelId: CHANNEL_ID, channelUrl: CHANNEL_URL, logger, fetchImpl: opts.fetchImpl || networkDisabled,
  });
  const built = buildApp({
    db, logger, config, guideVideos,
    pulseMmr: new PulseMmrService({ fetchImpl: networkDisabled }),
  });
  return {
    mongo,
    db,
    app: built.app,
    services: built.services,
    config,
    guideVideos,
    /** @param {string} name */
    bearer: (name) => `Bearer u:${name}`,
    /** @param {string} name @param {object} [extra] */
    async seedUser(name, extra = {}) {
      const userId = `u_${name}`;
      await db.users.updateOne(
        { userId },
        {
          $setOnInsert: { userId, clerkUserId: `clerk_${name}`, createdAt: new Date(), lastSeenAt: new Date() },
          $set: extra,
        },
        { upsert: true },
      );
      return userId;
    },
    async close() {
      if (built.services.customBuilds) await built.services.customBuilds.stopReclassifications();
      await db.close();
      await mongo.stop();
    },
  };
}

/**
 * A PvZ corpus that publishes one build ("Stargate into Glaives": 6
 * users × 20 games vs 8 Pool on Site Delta LE, all Diamond, one sharing
 * user with a stored replay) and leaves "Robo Opener" as a
 * floor-clearing but unpublished cell (5 users × 8 games), plus 36
 * Glaives samples. Runs the real recompute.
 *
 * @param {Awaited<ReturnType<typeof createGuidesHarness>>} h
 */
async function seedGuideCorpus(h) {
  const { db } = h;
  await db.users.insertOne({
    userId: "gl-0", clerkUserId: "clerk_gl_0", displayName: "Sharer One",
    replaySharing: { enabled: true, slug: SHARER_SLUG, updatedAt: new Date() },
  });
  await db.games.insertMany([
    ...cellGames({ users: 6, perUser: 20, winsPerUser: 11, userPrefix: "gl", overrides: { opponent: { strategy: EIGHT_POOL } } }),
    ...cellGames({ users: 5, perUser: 8, winsPerUser: 4, userPrefix: "ro", overrides: { myBuild: ROBO } }),
    slimGame({
      userId: "gl-0", date: new Date(), result: "Victory", durationSec: 612,
      replayFile: { storedAt: new Date(), sizeBytes: 1000 }, opponent: { strategy: EIGHT_POOL },
    }),
  ]);
  await db.guideSamples.insertMany(Array.from({ length: 36 }, (_, i) => sampleRow({
    userHash: `uh-${i % 6}`,
    milestones: { Pylon: 18 + (i % 4), Gateway: 40 + (i % 5), Stargate: 180 + (i % 7) },
    army: { 360: { Adept: 4 + (i % 2), Oracle: 1 } },
  })));
  await h.guideVideos.ensureSnapshot();
  return h.services.guideStats.recompute();
}

module.exports = {
  CHANNEL_ID,
  CHANNEL_URL,
  GLAIVES,
  ROBO,
  EIGHT_POOL,
  SHARER_SLUG,
  createGuidesHarness,
  seedGuideCorpus,
};
