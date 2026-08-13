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
    await db.games.deleteMany({});
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

  test("on hit, fetches opponent-row MMR without back-stamping game MMR", async () => {
    // The "barcode finally got a pulseCharacterId" case. After the
    // backfill resolves the id, the freshly-fetched SC2Pulse MMR
    // lands on the opponents row. Game-level MMR belongs to replay
    // data or the dedicated enrichment job, so neither a missing MMR
    // nor an in-replay value is changed here.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-1",
      toonHandle: "1-S2-1-1",
      displayNameSample: "Barcode",
    });
    await db.games.insertMany([
      {
        userId: "u1",
        gameId: "g1",
        date: new Date("2026-05-01T12:00:00Z"),
        opponent: { pulseId: "1-S2-1-1", toonHandle: "1-S2-1-1", race: "Protoss" },
      },
      {
        userId: "u1",
        gameId: "g2",
        date: new Date("2026-05-02T12:00:00Z"),
        // Pre-existing in-replay agent MMR — must NOT be overwritten.
        opponent: { pulseId: "1-S2-1-1", toonHandle: "1-S2-1-1", race: "Protoss", mmr: 3000 },
      },
      {
        // Different opponent — must NOT be touched by this backfill.
        userId: "u1",
        gameId: "g3",
        date: new Date("2026-05-03T12:00:00Z"),
        opponent: { pulseId: "2-S2-1-9", toonHandle: "2-S2-1-9", mmr: 4000 },
      },
    ]);
    const resolver = fakeResolver({ "1-S2-1-1": "452727" });
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => ({ mmr: 4800, region: "NA" })),
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 4800, region: "NA" })),
      // Available, but this pulse-id backfill must not use it to write
      // game-level MMR; the dedicated enrichment job owns that write.
      getRaceBreakdown: jest.fn(async () => [
        { race: "Protoss", mmr: 4800, region: "NA" },
      ]),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver: resolver,
      pulseMmr,
    });
    const out = await opponents.backfillPulseCharacterId("u1", { limit: 10 });
    expect(out.resolved).toBe(1);
    // Region-aware path used because pulseMmr has getCurrentMmrForAny.
    expect(pulseMmr.getCurrentMmrForAny).toHaveBeenCalledTimes(1);
    const oppRow = await db.opponents.findOne({ userId: "u1", pulseId: "1-S2-1-1" });
    expect(oppRow.pulseCharacterId).toBe("452727");
    expect(oppRow.mmr).toBe(4800);
    expect(oppRow.region).toBe("NA");
    expect(oppRow.mmrFetchedAt).toBeInstanceOf(Date);
    expect(pulseMmr.getRaceBreakdown).not.toHaveBeenCalled();
    // Stable identity metadata is healed on every matching game, but
    // SC2Pulse MMR is not written here.
    const g1 = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(g1.opponent.mmr).toBeUndefined();
    expect(g1.opponent.region).toBe("NA");
    expect(g1.opponent.pulseCharacterId).toBe("452727");
    // g2 already had the agent's in-replay MMR (3000), so it survives while
    // the newly resolved stable identity and region are still attached.
    const g2 = await db.games.findOne({ userId: "u1", gameId: "g2" });
    expect(g2.opponent.mmr).toBe(3000);
    expect(g2.opponent.region).toBe("NA");
    expect(g2.opponent.pulseCharacterId).toBe("452727");
    // Untouched opponent's game keeps its own values.
    const g3 = await db.games.findOne({ userId: "u1", gameId: "g3" });
    expect(g3.opponent.mmr).toBe(4000);
    expect(g3.opponent.region).toBeUndefined();
  });

  test("on hit, still stamps region from toon_handle when pulse MMR fetch returns null", async () => {
    // SC2Pulse can return null (no team in any region, rate-limit,
    // network blip). We still resolved the pulseCharacterId, and
    // the toon_handle gives us a reliable region — stamp that onto
    // games that lack an MMR so the per-region filter starts working
    // even before the next MMR fetch succeeds.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "2-S2-1-1",
      toonHandle: "2-S2-1-1",
      displayNameSample: "Barcode",
    });
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      date: new Date("2026-05-01T12:00:00Z"),
      opponent: { pulseId: "2-S2-1-1", toonHandle: "2-S2-1-1" },
    });
    const resolver = fakeResolver({ "2-S2-1-1": "452727" });
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => null),
      getCurrentMmrForAny: jest.fn(async () => null),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver: resolver,
      pulseMmr,
    });
    await opponents.backfillPulseCharacterId("u1", { limit: 10 });
    const oppRow = await db.opponents.findOne({ userId: "u1", pulseId: "2-S2-1-1" });
    expect(oppRow.pulseCharacterId).toBe("452727");
    expect(oppRow.mmr).toBeUndefined();
    expect(oppRow.region).toBe("EU"); // toon_handle leading byte 2
    const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(game.opponent.mmr).toBeUndefined();
    expect(game.opponent.region).toBe("EU");
    expect(game.opponent.pulseCharacterId).toBe("452727");
  });

  test("works without a pulseMmr dep (MMR fetch silently skipped)", async () => {
    // Backfill tick that ran before pulseMmr was injected: still
    // useful for healing pulseCharacterId + region. The dedicated
    // enrichment job may later fill game-level MMR.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-1",
      toonHandle: "1-S2-1-1",
      displayNameSample: "Barcode",
    });
    await db.games.insertOne({
      userId: "u1",
      gameId: "g1",
      date: new Date("2026-05-01T12:00:00Z"),
      opponent: { pulseId: "1-S2-1-1", toonHandle: "1-S2-1-1" },
    });
    const resolver = fakeResolver({ "1-S2-1-1": "452727" });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver: resolver,
      // no pulseMmr
    });
    const out = await opponents.backfillPulseCharacterId("u1", { limit: 10 });
    expect(out.resolved).toBe(1);
    const oppRow = await db.opponents.findOne({ userId: "u1", pulseId: "1-S2-1-1" });
    expect(oppRow.pulseCharacterId).toBe("452727");
    expect(oppRow.region).toBe("NA");
    expect(oppRow.mmr).toBeUndefined();
    const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(game.opponent.region).toBe("NA");
    expect(game.opponent.pulseCharacterId).toBe("452727");
    expect(game.opponent.mmr).toBeUndefined();
  });
});
