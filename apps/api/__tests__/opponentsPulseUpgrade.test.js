// @ts-nocheck
"use strict";

/**
 * OpponentsService — pulseCharacterId upgrade + backfill.
 *
 * Pins the May-2026 "stuck on TOON id" fix:
 *   * recordGame upgrades pulseCharacterId from missing → set
 *   * recordGame replaces a stale pulseCharacterId with a new one
 *   * refreshMetadata follows the same rules without bumping
 *     counters and without upserting
 *   * backfillPulseCharacterId walks stuck rows, persists hits,
 *     bumps pulseResolveAttemptedAt on misses, and skips rows
 *     attempted within the freshness window
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService pulseCharacterId upgrade", () => {
  let mongo;
  let db;
  let opponents;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_pulse_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
  });

  const baseGame = {
    pulseId: "1-S2-1-267727",
    toonHandle: "1-S2-1-267727",
    displayName: "ReSpOnSe",
    race: "P",
    result: "Victory",
    playedAt: new Date("2026-05-09T12:00:00Z"),
  };

  test("recordGame upgrades pulseCharacterId from missing → set", async () => {
    // First game — no pulseCharacterId resolved yet.
    const r1 = await opponents.recordGame("u1", { ...baseGame });
    expect(r1.upgraded).toBe(false);
    let row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(row.pulseCharacterId).toBeUndefined();

    // Second game — agent finally resolved the id.
    const r2 = await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(r2.upgraded).toBe(true);
    expect(r2.from).toBeNull();
    expect(r2.to).toBe("452727");
    row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(row.pulseCharacterId).toBe("452727");
  });

  test("recordGame REPLACES stale pulseCharacterId when a new value arrives", async () => {
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "111111",
    });
    const r = await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(r.upgraded).toBe(true);
    expect(r.from).toBe("111111");
    expect(r.to).toBe("452727");
    const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(row.pulseCharacterId).toBe("452727");
  });

  test("recordGame keeps pulseCharacterId sticky against an empty incoming", async () => {
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    await opponents.recordGame("u1", { ...baseGame }); // no pulseCharacterId
    const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(row.pulseCharacterId).toBe("452727");
  });

  test("refreshMetadata follows the same rules WITHOUT bumping counters", async () => {
    // Seed via recordGame so the row exists with counters at 1.
    await opponents.recordGame("u1", { ...baseGame });
    const before = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(before.gameCount).toBe(1);

    const r = await opponents.refreshMetadata("u1", {
      pulseId: baseGame.pulseId,
      toonHandle: baseGame.toonHandle,
      pulseCharacterId: "452727",
      displayName: baseGame.displayName,
      race: baseGame.race,
      playedAt: baseGame.playedAt,
    });
    expect(r.matched).toBe(1);
    expect(r.upgraded).toBe(true);
    const after = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(after.pulseCharacterId).toBe("452727");
    expect(after.gameCount).toBe(1); // counters untouched
    expect(after.wins).toBe(1);
  });

  test("refreshMetadata does NOT upsert a missing row", async () => {
    const r = await opponents.refreshMetadata("u_no_row", {
      pulseId: "1-S2-1-9",
      toonHandle: "1-S2-1-9",
      pulseCharacterId: "452727",
      displayName: "x",
      race: "T",
      playedAt: new Date(),
    });
    expect(r.matched).toBe(0);
    const row = await db.opponents.findOne({ userId: "u_no_row" });
    expect(row).toBeNull();
  });

  test("pulseLookupAttempted stamps pulseResolveAttemptedAt", async () => {
    const before = Date.now();
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseLookupAttempted: true,
    });
    const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
    expect(row.pulseResolveAttemptedAt).toBeInstanceOf(Date);
    expect(row.pulseResolveAttemptedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("OpponentsService.backfillPulseCharacterId", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_backfill_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
  });

  function fakeResolver(map) {
    // map: { toonHandle: pulseCharacterId | null }
    return {
      calls: [],
      async resolve({ toonHandle, displayName, forceRefresh }) {
        this.calls.push({ toonHandle, displayName, forceRefresh });
        return Object.prototype.hasOwnProperty.call(map, toonHandle)
          ? map[toonHandle]
          : null;
      },
    };
  }

  test("processes stuck rows, persists hits, bumps timestamp on misses", async () => {
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: "1-S2-1-1",
        toonHandle: "1-S2-1-1",
        displayNameSample: "JmaC",
      },
      {
        userId: "u1",
        pulseId: "1-S2-1-2",
        toonHandle: "1-S2-1-2",
        displayNameSample: "Ghost",
      },
      {
        userId: "u1",
        pulseId: "1-S2-1-3",
        toonHandle: "1-S2-1-3",
        displayNameSample: "Already",
        pulseCharacterId: "999999", // NOT stuck — should be ignored
      },
    ]);
    const resolver = fakeResolver({
      "1-S2-1-1": "452727",
      "1-S2-1-2": null, // miss
    });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver: resolver,
    });
    const out = await opponents.backfillPulseCharacterId("u1", { limit: 10 });
    expect(out.scanned).toBe(2);
    expect(out.resolved).toBe(1);
    expect(out.updated).toBe(2); // both rows got pulseResolveAttemptedAt
    const hit = await db.opponents.findOne({ userId: "u1", pulseId: "1-S2-1-1" });
    expect(hit.pulseCharacterId).toBe("452727");
    expect(hit.pulseResolveAttemptedAt).toBeInstanceOf(Date);
    const miss = await db.opponents.findOne({ userId: "u1", pulseId: "1-S2-1-2" });
    expect(miss.pulseCharacterId).toBeUndefined();
    expect(miss.pulseResolveAttemptedAt).toBeInstanceOf(Date);
    const skipped = await db.opponents.findOne({ userId: "u1", pulseId: "1-S2-1-3" });
    expect(skipped.pulseCharacterId).toBe("999999");
    expect(skipped.pulseResolveAttemptedAt).toBeUndefined();
    // Backfill must always force_refresh so it bypasses the
    // resolver's negative cache from a previous miss.
    expect(resolver.calls.every((c) => c.forceRefresh === true)).toBe(true);
  });

  test("skips rows attempted within the freshness window", async () => {
    const fresh = new Date();
    const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: "1-S2-1-1",
        toonHandle: "1-S2-1-1",
        displayNameSample: "Recent",
        pulseResolveAttemptedAt: fresh,
      },
      {
        userId: "u1",
        pulseId: "1-S2-1-2",
        toonHandle: "1-S2-1-2",
        displayNameSample: "Stale",
        pulseResolveAttemptedAt: ancient,
      },
    ]);
    const resolver = fakeResolver({ "1-S2-1-2": "12345" });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver: resolver,
    });
    const out = await opponents.backfillPulseCharacterId("u1", { limit: 10 });
    expect(out.scanned).toBe(1);
    expect(out.resolved).toBe(1);
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0].toonHandle).toBe("1-S2-1-2");
  });

  test("force=true overrides the freshness-window skip", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-1",
      toonHandle: "1-S2-1-1",
      displayNameSample: "Recent",
      pulseResolveAttemptedAt: new Date(),
    });
    const resolver = fakeResolver({ "1-S2-1-1": "452727" });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver: resolver,
    });
    const out = await opponents.backfillPulseCharacterId("u1", {
      limit: 10, force: true,
    });
    expect(out.scanned).toBe(1);
    expect(out.resolved).toBe(1);
  });

  test("requires a pulseResolver dep", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await expect(
      opponents.backfillPulseCharacterId("u1"),
    ).rejects.toThrow(/pulseResolver/);
  });
});
