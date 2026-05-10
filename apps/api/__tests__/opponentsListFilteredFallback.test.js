// @ts-nocheck
"use strict";

/**
 * Regression: when the opponents list runs through the
 * ``_listFiltered`` aggregation path (any filter set —
 * ``since``/``until``/``race``/``oppRace``/``map``/``mmr*``/etc.),
 * it must return the canonical ``pulseCharacterId`` / ``toonHandle``
 * even when historical games rows don't carry those fields embedded.
 *
 * The bug: the May-2026 backfill cron heals stuck-on-TOON opponents
 * by writing ``pulseCharacterId`` to the OPPONENTS row only. Games
 * rows are immutable; existing rows uploaded before the heal still
 * have ``opponent.pulseCharacterId === undefined``. The aggregation's
 * ``$last: $opponent.pulseCharacterId`` therefore returns null and
 * the SPA's filtered Opponents tab keeps rendering the toon-handle
 * "TOON" badge for an opponent whose unfiltered profile correctly
 * shows the resolved Pulse-id link.
 *
 * Fix: ``_listFiltered`` falls back to a single batched
 * ``find({ userId, pulseId: { $in: [...] } })`` against the
 * opponents collection and patches any null identity field with
 * the canonical value from the row.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService._listFiltered identity fallback", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "opp_list_filtered_fallback",
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  test("filtered list patches missing pulseCharacterId from opponents row", async () => {
    const userId = "u_jmac";
    // Opponents row has the healed canonical character id.
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-437579",
      toonHandle: "1-S2-1-437579",
      pulseCharacterId: "84828",
      displayNameSample: "JmaC",
      race: "T",
      gameCount: 6,
      wins: 5,
      losses: 1,
      firstSeen: new Date("2026-01-01"),
      lastSeen: new Date("2026-05-09"),
    });
    // Games rows pre-date the heal — they carry pulseId / toonHandle
    // but NO pulseCharacterId on the embedded opponent sub-doc.
    await db.games.insertMany([
      {
        userId,
        gameId: "g_1",
        date: new Date("2026-05-01"),
        result: "Victory",
        myRace: "Protoss",
        map: "Goldenaura",
        durationSec: 600,
        opponent: {
          pulseId: "1-S2-1-437579",
          toonHandle: "1-S2-1-437579",
          displayName: "JmaC",
          race: "Terran",
        },
      },
      {
        userId,
        gameId: "g_2",
        date: new Date("2026-05-09"),
        result: "Victory",
        myRace: "Protoss",
        map: "Hard Lead LE",
        durationSec: 720,
        opponent: {
          pulseId: "1-S2-1-437579",
          toonHandle: "1-S2-1-437579",
          displayName: "JmaC",
          race: "Terran",
        },
      },
    ]);

    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    // Force the filtered path: ``since`` / ``until`` are real date
    // filters that flip ``hasFilters`` to true.
    const out = await opponents.list(userId, {
      filters: {
        since: new Date("2026-01-01"),
        until: new Date("2026-12-31"),
      },
    });
    expect(out.items.length).toBe(1);
    const row = out.items[0];
    expect(row.pulseId).toBe("1-S2-1-437579");
    // The fix: pulseCharacterId is filled from the opponents row
    // even though no games row carries it.
    expect(row.pulseCharacterId).toBe("84828");
    expect(row.toonHandle).toBe("1-S2-1-437579");
  });

  test("filtered list keeps the games-row pulseCharacterId when it IS present", async () => {
    // Sanity check the sticky semantics: when the games rows DO carry
    // a pulseCharacterId (newer ingests), the aggregation's value
    // wins. We never overwrite a non-null aggregation value with the
    // opponents-row value — games rows remain the authority on the
    // most-recent observed identity.
    const userId = "u_x";
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-1",
      toonHandle: "1-S2-1-1",
      pulseCharacterId: "OLD_VALUE",
      displayNameSample: "X",
      race: "T",
      gameCount: 1,
      wins: 1,
      losses: 0,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
    await db.games.insertOne({
      userId,
      gameId: "g_recent",
      date: new Date(),
      result: "Victory",
      myRace: "Protoss",
      map: "M",
      durationSec: 600,
      opponent: {
        pulseId: "1-S2-1-1",
        toonHandle: "1-S2-1-1",
        pulseCharacterId: "NEW_VALUE",
        displayName: "X",
        race: "Terran",
      },
    });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const out = await opponents.list(userId, {
      filters: {
        since: new Date("2020-01-01"),
        until: new Date("2030-01-01"),
      },
    });
    expect(out.items[0].pulseCharacterId).toBe("NEW_VALUE");
  });

  test("filtered list leaves rows alone when neither source has the id", async () => {
    // Truly stuck row: opponents row has no pulseCharacterId, games
    // rows don't either. Filtered list returns null/undefined for
    // pulseCharacterId; the SPA falls back to the toon-handle TOON
    // badge — same as before the fix.
    const userId = "u_stuck";
    await db.opponents.insertOne({
      userId,
      pulseId: "1-S2-1-9",
      toonHandle: "1-S2-1-9",
      displayNameSample: "Ghost",
      race: "T",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
    await db.games.insertOne({
      userId,
      gameId: "g_stuck",
      date: new Date(),
      result: "Defeat",
      myRace: "Protoss",
      map: "M",
      durationSec: 800,
      opponent: {
        pulseId: "1-S2-1-9",
        toonHandle: "1-S2-1-9",
        displayName: "Ghost",
        race: "Terran",
      },
    });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const out = await opponents.list(userId, {
      filters: {
        since: new Date("2020-01-01"),
        until: new Date("2030-01-01"),
      },
    });
    expect(out.items[0].pulseId).toBe("1-S2-1-9");
    expect(out.items[0].pulseCharacterId).toBeFalsy();
    expect(out.items[0].toonHandle).toBe("1-S2-1-9");
  });
});
