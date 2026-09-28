// @ts-nocheck
"use strict";

/**
 * Shared setup for the Replay Review Exchange suites. Each suite calls
 * ``jest.mock("@clerk/backend", () => require("./helpers/clerkMock")())``
 * itself (jest hoists mocks per file) and then ``createHarness()``.
 *
 * Bearer tokens are ``u:<name>`` and resolve to Clerk id ``clerk_<name>``;
 * ``seedUser(name)`` creates the matching internal user ``u_<name>`` so
 * tests can address users by name.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../../src/db/connect");
const { buildApp } = require("../../src/app");
const { PulseMmrService } = require("../../src/services/pulseMmr");

const networkDisabled = async () => {
  throw new Error("network_disabled_in_tests");
};

/** Opponent identity seeded into every "secret" game. None may leak. */
const SECRET = Object.freeze({
  name: "SecretOppZed",
  battleTag: "SecretOppZed#4242",
  clan: "ZZCLAN",
  pulseId: "1-S2-1-9876543",
  toonHandle: "1-S2-1-9876543",
  pulseCharacterId: "5550123",
});

const SECRET_NEEDLES = Object.freeze([
  SECRET.name,
  "4242",
  SECRET.clan,
  "9876543",
  SECRET.pulseCharacterId,
]);

/**
 * ``pulseMmr`` stands in for SC2Pulse (reviewer leagues); by default it
 * is a PulseMmrService whose fetch always fails, so no suite reaches the
 * live API.
 *
 * @param {{rollout?: "off"|"admins"|"on", admins?: string[], pulseMmr?: object}} [opts]
 */
async function createHarness(opts = {}) {
  const mongo = await MongoMemoryServer.create();
  const dbName = `reviews_${Math.random().toString(36).slice(2, 10)}`;
  const db = await connect({ uri: mongo.getUri(), dbName });
  const config = {
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
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: (opts.admins || ["admin"]).map((name) => `clerk_${name}`),
    reviewsEnabled: opts.rollout || "on",
  };
  const built = buildApp({
    db,
    logger: pino({ level: "silent" }),
    config,
    reviewSeasonWindowStart: async () => new Date(0),
    pulseMmr: opts.pulseMmr || new PulseMmrService({ fetchImpl: networkDisabled }),
  });
  const harness = {
    mongo,
    db,
    app: built.app,
    services: built.services,
    config,
    /** @param {string} name */
    userId: (name) => `u_${name}`,
    /** @param {string} name */
    bearer: (name) => `Bearer u:${name}`,
    /**
     * @param {string} name
     * @param {Record<string, any>} [extra]
     */
    async seedUser(name, extra = {}) {
      await db.users.updateOne(
        { userId: `u_${name}` },
        {
          $setOnInsert: {
            userId: `u_${name}`,
            clerkUserId: `clerk_${name}`,
            createdAt: new Date(),
            lastSeenAt: new Date(),
          },
          $set: extra,
        },
        { upsert: true },
      );
      return `u_${name}`;
    },
    /**
     * Ladder 1v1 history so a reviewer passes the synced-games gate and
     * verifies at the band implied by ``mmr``.
     *
     * @param {string} name
     * @param {{count?: number, mmr?: number, race?: string}} [o]
     */
    async seedLadderHistory(name, o = {}) {
      const userId = `u_${name}`;
      const count = o.count ?? 25;
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        rows.push({
          userId,
          gameId: `${name}-ladder-${i}`,
          date: new Date(Date.now() - (i + 1) * 3600_000),
          result: i % 2 ? "Victory" : "Defeat",
          myRace: o.race || "Protoss",
          map: "Alcyone LE",
          matchFormat: "1v1",
          playerCount: 2,
          isLadderGame: true,
          myMmr: (o.mmr ?? 4700) - (i % 3) * 10,
          myMmrSource: "replay",
          durationSec: 600,
          opponent: { displayName: `Ladder${i}`, race: "Zerg", mmr: 4500 },
        });
      }
      if (rows.length) await db.games.insertMany(rows);
    },
    /**
     * A reviewable 1v1 game for ``name`` whose opponent carries the full
     * SECRET identity, with macro breakdown, build logs, APM curve and an
     * inline map playback that all name the opponent somewhere.
     *
     * @param {string} name
     * @param {{gameId?: string, playback?: boolean, macro?: boolean, matchFormat?: string, myBuild?: string, buildLog?: string[]}} [o]
     */
    async seedGame(name, o = {}) {
      const userId = `u_${name}`;
      const gameId = o.gameId || `2026-09-01T10:00:00|${SECRET.name}|Alcyone LE|640`;
      const date = new Date("2026-09-01T10:10:40Z");
      await db.games.insertOne({
        userId,
        gameId,
        date,
        result: "Defeat",
        myRace: "Protoss",
        myBuild: o.myBuild || "PvZ - Blink All-in",
        map: "Alcyone LE",
        matchFormat: o.matchFormat || "1v1",
        playerCount: o.matchFormat && o.matchFormat !== "1v1" ? 4 : 2,
        isLadderGame: true,
        durationSec: 640,
        macroScore: 61,
        myMmr: 4130,
        myMmrSource: "replay",
        myToonHandle: "1-S2-1-111111",
        opponent: {
          displayName: SECRET.name,
          battleTag: SECRET.battleTag,
          clan: SECRET.clan,
          pulseId: SECRET.pulseId,
          toonHandle: SECRET.toonHandle,
          pulseCharacterId: SECRET.pulseCharacterId,
          race: "Zerg",
          mmr: 4088,
          leagueId: 4,
          strategy: "Zerg - Roach Ravager",
        },
      });
      /** @type {Record<string, any>} */
      const heavy = {
        buildLog: o.buildLog || ["[0:18] Pylon", "[0:45] Gateway", "[1:30] Cybernetics Core"],
        oppBuildLog: ["[0:20] Hatchery", `[0:50] Spawning Pool`],
        apmCurve: {
          players: [
            { pid: 1, name: "Asker", race: "Protoss", is_me: true, samples: [] },
            { pid: 2, name: SECRET.name, race: "Zerg", is_me: false, samples: [] },
          ],
        },
      };
      if (o.macro !== false) {
        heavy.macroBreakdown = {
          macro_score: 61,
          raw: { sq: 70, supply_blocked_seconds: 12 },
          all_leaks: [{ name: "Supply block", detail: "Blocked at 3:10", penalty: 4, time: 190 }],
          top_3_leaks: [{ name: "Supply block", detail: "Blocked at 3:10", penalty: 4, time: 190 }],
          stats_events: [{ time: 60, food_used: 20, army_value: 100 }],
          opp_stats_events: [{ time: 60, food_used: 22, army_value: 150 }],
          player_stats: {
            me: { name: "Asker" },
            opponent: { name: SECRET.name, battleTag: SECRET.battleTag, pid: 2 },
          },
        };
      }
      if (o.playback !== false) {
        heavy.mapPlayback = {
          v: 5,
          mapName: "Alcyone LE",
          gameLength: 640,
          bounds: { minX: 0, minY: 0, maxX: 150, maxY: 150 },
          spawns: [{ owner: "me", x: 20, y: 20 }, { owner: "opp", x: 130, y: 130 }],
          units: [{ owner: "opp", name: "Zergling", born: 100, died: null, wp: [100, 50, 50], playerName: SECRET.name }],
          buildings: [],
          battles: [],
          stats: { me: [], opp: [] },
          players: [{ name: SECRET.name, toon: SECRET.toonHandle }],
          replaySha256: "a".repeat(64),
        };
      }
      await built.services.gameDetails.upsert(userId, gameId, date, heavy);
      return gameId;
    },
    async close() {
      await db.close();
      await mongo.stop();
    },
  };
  return harness;
}

/**
 * Serialise any number of response bodies and return every secret that
 * appears in them (empty = no leak).
 *
 * @param {...unknown} bodies
 */
function leakedSecrets(...bodies) {
  const text = JSON.stringify(bodies);
  return SECRET_NEEDLES.filter((needle) => text.includes(needle));
}

module.exports = { createHarness, SECRET, SECRET_NEEDLES, leakedSecrets };
