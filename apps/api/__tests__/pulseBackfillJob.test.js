// @ts-nocheck
"use strict";

/**
 * Integration: pulseBackfillJob single-cycle run.
 *
 * Spins up a localhost HTTP server that emulates the SC2Pulse
 * endpoints the cloud resolver hits, seeds a stuck opponents row,
 * runs one backfill cycle, and asserts the row got healed.
 *
 * No mock objects of internal code — the resolver, the service,
 * and the job all run against real implementations. The only
 * stand-in is the external SC2Pulse service itself, which we
 * substitute with an in-process fake bound to the resolver via
 * its ``baseUrl`` constructor option (the same pattern used by
 * pulseMmr.test.js for its outbound HTTP calls).
 */

const http = require("http");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { buildPulseResolver } = require("../src/services/pulseResolver");
const { buildPulseBackfillJob } = require("../src/jobs/pulseBackfillJob");

function startFakeSc2Pulse(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reply = handler(req.url || "");
      if (reply === undefined) {
        res.statusCode = 404;
        res.end("");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {any} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("pulseBackfillJob — heals a stuck row in one cycle", () => {
  let mongo;
  let db;
  let fake;
  let opponents;
  let job;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "pulse_backfill_test" });
    fake = await startFakeSc2Pulse((url) => {
      // Mirror the SC2Pulse JSON shapes the resolver consumes.
      if (url.includes("/season/list/all")) {
        return [{ region: "US", battlenetId: 60 }];
      }
      if (url.includes("/character/search/advanced")) {
        if (url.includes("name=JmaC")) return [340543107];
        return [];
      }
      if (url.includes("/character/340543107/teams")) {
        return [
          { members: [{ character: { region: "US", battlenetId: 437579 } }] },
        ];
      }
      return undefined;
    });
    const resolver = buildPulseResolver({
      baseUrl: `${fake.url}`,
      logger: pino({ level: "silent" }),
    });
    opponents = new OpponentsService(db, Buffer.alloc(32, 4), {
      pulseResolver: resolver,
      logger: pino({ level: "silent" }),
    });
    job = buildPulseBackfillJob({
      db,
      opponents,
      logger: pino({ level: "silent" }),
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
    if (fake) await fake.close();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.db.collection("jobLocks").deleteMany({});
  });

  test("seeded stuck row gets pulseCharacterId after one cycle", async () => {
    await db.opponents.insertOne({
      userId: "u_jmac",
      pulseId: "1-S2-1-437579",
      toonHandle: "1-S2-1-437579",
      displayNameSample: "JmaC",
      race: "T",
      gameCount: 5,
      wins: 5,
      losses: 0,
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-05-09"),
    });

    const summary = await job.runOnce();
    expect(summary).not.toBeNull();
    expect(summary.ranAsLeader).toBe(true);
    expect(summary.users).toBe(1);
    expect(summary.scanned).toBe(1);
    expect(summary.resolved).toBe(1);
    expect(summary.updated).toBe(1);

    const row = await db.opponents.findOne({ userId: "u_jmac" });
    expect(row.pulseCharacterId).toBe("340543107");
    expect(row.pulseResolveAttemptedAt).toBeInstanceOf(Date);
  });

  test("a second concurrent run does not double-acquire the lock", async () => {
    await db.opponents.insertOne({
      userId: "u_other",
      pulseId: "1-S2-1-9",
      toonHandle: "1-S2-1-9",
      displayNameSample: "Ghost",
      race: "T",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-05-09"),
    });
    // Simulate a co-leader holding the lock by inserting a fresh
    // (unexpired) lock doc before the run.
    const future = new Date(Date.now() + 60_000);
    await db.db.collection("jobLocks").insertOne({
      key: "pulseBackfill",
      expiresAt: future,
      acquiredAt: new Date(),
    });
    const summary = await job.runOnce();
    expect(summary.ranAsLeader).toBe(false);
    // The simulated lock is still there — we did NOT release someone
    // else's claim.
    const lock = await db.db.collection("jobLocks").findOne({
      key: "pulseBackfill",
    });
    expect(lock).not.toBeNull();
  });
});
