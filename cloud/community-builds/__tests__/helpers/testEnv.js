"use strict";

const crypto = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const pino = require("pino");
const { ensureIndexes } = require("../../src/db");
const { COLLECTIONS } = require("../../src/constants");
const { buildApp } = require("../../src/app");
const { signHmac } = require("../../src/util/hmac");

const PEPPER = crypto.randomBytes(32);
const SILENT_LOGGER = pino({ level: "silent" });

/**
 * Boot a real in-memory MongoDB and wired-up Express app for tests.
 * Returns helpers for signing requests and tearing down.
 */
async function bootTestEnv({ clock } = {}) {
  const mongo = await MongoMemoryServer.create();
  const client = new MongoClient(mongo.getUri());
  await client.connect();
  const db = client.db("sc2_test");
  const ctx = {
    builds: db.collection(COLLECTIONS.BUILDS),
    votes: db.collection(COLLECTIONS.VOTES),
    flags: db.collection(COLLECTIONS.FLAGS),
  };
  await ensureIndexes(ctx);
  const app = buildApp({
    db: ctx,
    logger: SILENT_LOGGER,
    pepper: PEPPER,
    trustProxy: 0,
    corsAllowedOrigins: [],
    clock: clock || (() => Date.now()),
  });
  return {
    app,
    db: ctx,
    pepper: PEPPER,
    sign: (body) => signHmac(PEPPER, body ?? Buffer.alloc(0)),
    clientId: () => crypto.randomBytes(16).toString("hex"),
    teardown: async () => {
      await client.close();
      await mongo.stop();
    },
  };
}

/**
 * Serialise a JS value to the exact JSON string that will be sent on the
 * wire and signed for HMAC verification.
 *
 * @param {unknown} body
 * @returns {string}
 */
function jsonBody(body) {
  return JSON.stringify(body);
}

function sampleBuild(overrides = {}) {
  return {
    id: "proto-1-gate-expand",
    name: "1 Gate Expand",
    race: "Protoss",
    vsRace: "Terran",
    tier: "A",
    description: "Standard 1 gate expand opener.",
    winConditions: ["secure third", "scout for cloak"],
    losesTo: ["proxy 2 rax"],
    transitionsInto: ["blink stalker"],
    signature: [
      { t: 17, what: "Pylon", weight: 0.6 },
      { t: 38, what: "Gateway", weight: 0.8 },
      { t: 60, what: "Assimilator", weight: 0.5 },
      { t: 90, what: "Cybernetics Core", weight: 0.7 },
    ],
    toleranceSec: 15,
    minMatchScore: 0.6,
    authorDisplay: "TestAuthor#1234",
    ...overrides,
  };
}

module.exports = { bootTestEnv, sampleBuild, jsonBody, PEPPER };
