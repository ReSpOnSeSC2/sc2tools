// @ts-nocheck
"use strict";

/**
 * Shared fixtures for the guide_stats suites (guideStats*.test.js).
 * Test-only data: slim games rows and guide_samples rows shaped exactly
 * like the ones ingest writes, built from a counter so every
 * (userId, gameId) is unique.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../../src/db/connect");

/** A fixed "now" after the 5.0.16 release. */
const NOW_MS = Date.parse("2026-08-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A replay build of the current era ("after": the 12-worker game, here
 * 5.0.15) and one of the previous era ("before": the 8-worker patch
 * 5.0.16, ≥ 97364). util/patchEra.js has the rule.
 */
const AFTER_BUILD = 96883;
const BEFORE_BUILD = 97425;
const GLAIVES = "PvZ - Stargate into Glaives";
const PHOENIX = "PvZ - 2 Stargate Phoenix";

/**
 * Start a memory server and connect (indexes included — also the
 * background-built guide games index, so plans and hints are deterministic).
 *
 * @param {string} dbName
 */
async function startDb(dbName) {
  const mongo = await MongoMemoryServer.create();
  const db = await connect({ uri: mongo.getUri(), dbName, awaitBackgroundIndexes: true });
  return { mongo, db };
}

/** Empty every collection the guide_stats suites touch. */
async function resetDb(db) {
  await Promise.all([
    db.games.deleteMany({}),
    db.guideSamples.deleteMany({}),
    db.guideStats.deleteMany({}),
    db.users.deleteMany({}),
    db.db.collection("jobLocks").deleteMany({}),
  ]);
}

function makeSeq() {
  let n = 0;
  return () => {
    n += 1;
    return n;
  };
}

const nextId = makeSeq();

/**
 * One slim PvZ ladder game (overridable, deep-merged for ``opponent``).
 *
 * @param {object} [overrides]
 */
function slimGame(overrides = {}) {
  const n = nextId();
  const { opponent, ...rest } = overrides;
  return {
    userId: `user-${n % 7}`,
    gameId: `game-${n}`,
    date: new Date(NOW_MS - (n % 20) * DAY_MS - n * 1000),
    result: "Victory",
    myRace: "Protoss",
    myBuild: GLAIVES,
    map: "Site Delta LE",
    durationSec: 640,
    playerCount: 2,
    isLadderGame: true,
    gameBuild: AFTER_BUILD,
    opponent: { displayName: `Foe${n}`, race: "Zerg", leagueId: 4, mmr: 4120, ...(opponent || {}) },
    _schemaVersion: 7,
    ...rest,
  };
}

/**
 * ``users × perUser`` games of one cell: the first ``winsPerUser`` games of
 * each user are wins, the rest losses (unless ``overrides.result``).
 *
 * @param {{ users: number, perUser: number, winsPerUser?: number, userPrefix?: string, overrides?: object }} spec
 */
function cellGames(spec) {
  const out = [];
  const prefix = spec.userPrefix || "cell";
  for (let u = 0; u < spec.users; u += 1) {
    for (let g = 0; g < spec.perUser; g += 1) {
      out.push(slimGame({
        userId: `${prefix}-${u}`,
        result: g < (spec.winsPerUser ?? 0) ? "Victory" : "Defeat",
        ...(spec.overrides || {}),
      }));
    }
  }
  return out;
}

/**
 * One guide_samples row (PvZ Glaives, current era by default).
 *
 * @param {object} [overrides]
 */
function sampleRow(overrides = {}) {
  const n = nextId();
  return {
    buildKey: GLAIVES,
    matchup: "PvZ",
    era: "after",
    eraRule: 2,
    leagueBand: 4,
    mmrBand: 4000,
    result: "Victory",
    map: "Site Delta LE",
    durationSec: 640,
    userHash: `uh-${n % 7}`,
    gameHash: `gh-${n}`,
    milestones: {},
    army: {},
    createdAt: new Date(NOW_MS - n * 1000),
    updatedAt: new Date(NOW_MS - n * 1000),
    _schemaVersion: 1,
    ...overrides,
  };
}

/** Every guide_stats doc, keyed by ``key``. */
async function statsByKey(db) {
  const docs = await db.guideStats.find({}, { projection: { _id: 0 } }).toArray();
  return new Map(docs.map((d) => [d.key, d]));
}

module.exports = {
  NOW_MS,
  DAY_MS,
  AFTER_BUILD,
  BEFORE_BUILD,
  GLAIVES,
  PHOENIX,
  startDb,
  resetDb,
  slimGame,
  cellGames,
  sampleRow,
  statsByKey,
};
