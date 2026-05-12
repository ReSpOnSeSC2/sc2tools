// @ts-nocheck
"use strict";

/**
 * Migration: 2026-05-12-heal-opponent-current-name.
 *
 * Heals existing opponents rows whose displayNameSample / lastSeen
 * drifted away from the canonical "latest game by date" before the
 * write guard landed. Pinned here because the migration runs against
 * production data once; if it ever needs a re-run (or a follow-up
 * fix to its heuristic), the test catches semantic regressions.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  healUser,
} = require("../src/db/migrations/2026-05-12-heal-opponent-current-name");

describe("heal-opponent-current-name migration", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "heal_current_name" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  test("heals stale displayNameSample to the latest-by-date game's displayName", async () => {
    const userId = "u_heal";
    const pulseId = "1-S2-1-8636008";
    // Row stamped with the OLD name (the bug state — a re-uploaded
    // old replay overwrote what the agent had already stored).
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      displayNameSample: "foruGeoff",
      race: "P",
      gameCount: 2,
      wins: 1,
      losses: 1,
      firstSeen: new Date("2024-11-01"),
      lastSeen: new Date("2024-11-01"),
    });
    await db.games.insertMany([
      {
        userId,
        gameId: "g1",
        date: new Date("2024-11-01"),
        result: "Victory",
        myRace: "Protoss",
        map: "M1",
        durationSec: 600,
        opponent: { pulseId, toonHandle: pulseId, displayName: "foruGeoff", race: "Protoss" },
      },
      {
        userId,
        gameId: "g2",
        date: new Date("2026-04-18"),
        result: "Defeat",
        myRace: "Protoss",
        map: "M2",
        durationSec: 700,
        opponent: { pulseId, toonHandle: pulseId, displayName: "RekcOr", race: "Protoss" },
      },
    ]);

    const summary = await healUser(db.db, userId, { dryRun: false, batch: 500 });
    expect(summary.scanned).toBe(1);
    expect(summary.planned).toBe(1);
    expect(summary.written).toBe(1);
    const row = await db.opponents.findOne({ userId, pulseId });
    expect(row.displayNameSample).toBe("RekcOr");
    expect(row.lastSeen).toEqual(new Date("2026-04-18"));
  });

  test("idempotent: re-running on an already-healed row plans zero writes", async () => {
    const userId = "u_clean";
    const pulseId = "1-S2-1-1";
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      displayNameSample: "Current",
      race: "T",
      gameCount: 1,
      wins: 1,
      losses: 0,
      firstSeen: new Date("2026-04-01"),
      lastSeen: new Date("2026-04-18"),
    });
    await db.games.insertOne({
      userId,
      gameId: "g",
      date: new Date("2026-04-18"),
      result: "Victory",
      myRace: "Protoss",
      map: "M",
      durationSec: 600,
      opponent: { pulseId, toonHandle: pulseId, displayName: "Current", race: "Terran" },
    });

    const first = await healUser(db.db, userId, { dryRun: false, batch: 500 });
    expect(first.planned).toBe(0);
    expect(first.written).toBe(0);
    const second = await healUser(db.db, userId, { dryRun: false, batch: 500 });
    expect(second.planned).toBe(0);
    expect(second.written).toBe(0);
  });

  test("dry-run plans changes without writing", async () => {
    const userId = "u_dry";
    const pulseId = "1-S2-1-2";
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      displayNameSample: "Stale",
      race: "Z",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2024-01-01"),
      lastSeen: new Date("2024-01-01"),
    });
    await db.games.insertOne({
      userId,
      gameId: "g",
      date: new Date("2026-04-18"),
      result: "Defeat",
      myRace: "Protoss",
      map: "M",
      durationSec: 700,
      opponent: { pulseId, toonHandle: pulseId, displayName: "Fresh", race: "Zerg" },
    });

    const summary = await healUser(db.db, userId, { dryRun: true, batch: 500 });
    expect(summary.planned).toBe(1);
    expect(summary.written).toBe(0);
    const row = await db.opponents.findOne({ userId, pulseId });
    expect(row.displayNameSample).toBe("Stale");
  });
});
