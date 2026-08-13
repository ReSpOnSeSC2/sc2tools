// @ts-nocheck
"use strict";

/**
 * OpponentsService — SC2Pulse MMR + region fill on opponent rows.
 *
 * sc2reader almost never carries an opponent's MMR for ranked 1v1
 * ladder replays, so the analyzer's Opponents tab and per-opponent
 * profile would otherwise show "—" forever.
 *
 * recordGame / refreshMetadata fix this by:
 *   * Deriving the opponent's region from the toon_handle leading
 *     byte (1=NA, 2=EU, 3=KR, 5=CN, 6=SEA) — cheap, no network.
 *   * Attempting one rate-limited SC2Pulse fetch per ingest
 *     (preferring the derived region for multi-region opponents),
 *     persisting mmr + region on the opponents row.
 *   * Leaving game-level opponent.mmr to replay data or the dedicated,
 *     race-aware opponent-MMR enrichment job. A current, race-agnostic
 *     opponent-row rating must never be back-stamped by this service.
 *
 * What this suite pins:
 *   * Region derivation works for every Blizzard region byte.
 *   * Pulse fetch populates mmr + region on first ingest.
 *   * Pulse failure / rate-limit leaves prior values intact.
 *   * Freshness window suppresses re-fetches on bulk re-upload.
 *   * Toon-only rows use the toon-handle fallback when supported.
 *   * Pulse exceptions are swallowed.
 *   * refreshMetadata follows the same contract as recordGame.
 *   * recordGame / refreshMetadata may fill game metadata such as
 *     region, but never back-stamp SC2Pulse MMR; replay MMR survives.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService MMR + region from SC2Pulse", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_mmr_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
  });

  const baseGame = {
    pulseId: "1-S2-1-267727",
    toonHandle: "1-S2-1-267727",
    displayName: "ReSpOnSe",
    race: "P",
    result: "Victory",
    playedAt: new Date("2026-05-09T12:00:00Z"),
  };

  function makePulseStub(impl) {
    const calls = [];
    return {
      calls,
      getCurrentMmr: jest.fn(async (id) => {
        calls.push({ kind: "single", id });
        return impl(id, undefined);
      }),
      getCurrentMmrForAny: jest.fn(async (ids, opts) => {
        calls.push({ kind: "any", ids, preferredRegion: opts?.preferredRegion });
        return impl(ids[0], opts?.preferredRegion);
      }),
      getCurrentMmrByToon: jest.fn(async (toon) => {
        calls.push({ kind: "toon", toon });
        return impl(toon, undefined);
      }),
      // Keep a race breakdown available so the ownership-boundary
      // tests prove recordGame / refreshMetadata do not consume it to
      // back-stamp game-level MMR.
      getRaceBreakdown: jest.fn(async (ids) => {
        calls.push({ kind: "races", ids });
        const r = await impl(ids[0], undefined);
        if (!r) return [];
        return [{ race: "Protoss", mmr: r.mmr, region: r.region }];
      }),
    };
  }

  test("derives region from toonHandle even when the toon MMR fallback misses", async () => {
    const pulseMmr = makePulseStub(async () => null);
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", { ...baseGame });
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.region).toBe("NA");
    // No pulseCharacterId → the toon-handle fallback is attempted, but
    // it returned null so no mmr lands. Region is still derived cheaply.
    expect(pulseMmr.calls).toEqual([
      { kind: "toon", toon: baseGame.toonHandle },
    ]);
    expect(row.mmr).toBeUndefined();
  });

  test("region derivation maps every Blizzard region byte", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const cases = [
      ["1-S2-1-1", "NA"],
      ["2-S2-1-1", "EU"],
      ["3-S2-1-1", "KR"],
      ["5-S2-1-1", "CN"],
      ["6-S2-1-1", "SEA"],
    ];
    for (const [toon, region] of cases) {
      await db.opponents.deleteMany({});
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseId: toon,
        toonHandle: toon,
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: toon });
      expect(row.region).toBe(region);
    }
  });

  test("Pulse fetch populates mmr + region on first ingest, region-aware", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "EU" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    // Region-aware path used because pulseMmr has getCurrentMmrForAny
    // and we pass the derived region as preferredRegion.
    expect(pulseMmr.calls.length).toBe(1);
    expect(pulseMmr.calls[0].kind).toBe("any");
    expect(pulseMmr.calls[0].preferredRegion).toBe("NA");
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBe(4321);
    expect(row.region).toBe("EU"); // Pulse region overrides toon-derived NA
    expect(row.mmrFetchedAt).toBeInstanceOf(Date);
  });

  test("Pulse failure (returns null) leaves prior mmr untouched", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: makePulseStub(async () => ({ mmr: 4000, region: "NA" })),
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    // Force a refetch by backdating mmrFetchedAt past the freshness
    // window, then run a second ingest with a Pulse that returns null.
    await db.opponents.updateOne(
      { userId: "u1", pulseId: baseGame.pulseId },
      { $set: { mmrFetchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    );
    const failingPulse = makePulseStub(async () => null);
    const opponents2 = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: failingPulse,
    });
    await opponents2.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(failingPulse.calls.length).toBe(1);
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBe(4000); // Prior value preserved.
  });

  test("freshness window suppresses re-fetches on bulk re-upload", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(pulseMmr.calls.length).toBe(1);
    // Second ingest within the freshness window — Pulse must not be
    // called again.
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(pulseMmr.calls.length).toBe(1);
  });

  test("toon-only rows (no pulseCharacterId) fetch MMR via the toon-handle fallback", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", { ...baseGame });
    // No pulseCharacterId → resolves MMR straight from the toon handle
    // so a toon-only opponent isn't stuck on "—" until the cron resolves
    // a character id.
    expect(pulseMmr.calls).toEqual([
      { kind: "toon", toon: baseGame.toonHandle },
    ]);
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBe(4321);
    expect(row.region).toBe("NA");
  });

  test("historical backfill explicitly defers Pulse network work to the cron", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "EU" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseLookupAttempted: false,
    });
    expect(pulseMmr.calls).toEqual([]);
    let row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    // Cheap replay identity/region still land immediately. The existing
    // bounded Pulse backfill job owns the deferred character/MMR lookup.
    expect(row.toonHandle).toBe(baseGame.toonHandle);
    expect(row.region).toBe("NA");
    expect(row.mmr).toBeUndefined();

    await opponents.refreshMetadata("u1", {
      ...baseGame,
      gameId: "history-1",
      pulseLookupAttempted: false,
    });
    expect(pulseMmr.calls).toEqual([]);
    row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.toonHandle).toBe(baseGame.toonHandle);
  });

  test("toon-only fallback is skipped when the client lacks getCurrentMmrByToon", async () => {
    // An older / partial pulseMmr without toon support must still be
    // safe: no character id and no toon method → no fetch, no throw.
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => ({ mmr: 4321, region: "NA" })),
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 4321, region: "NA" })),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", { ...baseGame });
    expect(pulseMmr.getCurrentMmr).not.toHaveBeenCalled();
    expect(pulseMmr.getCurrentMmrForAny).not.toHaveBeenCalled();
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBeUndefined();
    expect(row.region).toBe("NA");
  });

  test("Pulse exception is swallowed; ingest still succeeds", async () => {
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => {
        throw new Error("rate_limited");
      }),
      getCurrentMmrForAny: jest.fn(async () => {
        throw new Error("rate_limited");
      }),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await expect(
      opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
      }),
    ).resolves.toMatchObject({ upgraded: true });
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBeUndefined();
    expect(row.region).toBe("NA");
  });

  test("refreshMetadata follows the same MMR + region rules", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });

    const pulseMmr = makePulseStub(async () => ({ mmr: 4500, region: "EU" }));
    const opponents2 = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents2.refreshMetadata("u1", {
      pulseId: baseGame.pulseId,
      toonHandle: baseGame.toonHandle,
      pulseCharacterId: "452727",
      displayName: baseGame.displayName,
      race: baseGame.race,
      playedAt: baseGame.playedAt,
    });
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(pulseMmr.calls.length).toBe(1);
    expect(row.mmr).toBe(4500);
    expect(row.region).toBe("EU");
  });

  describe("game-level MMR ownership boundary", () => {
    beforeEach(async () => {
      // Insert a slim games row that recordGame can update metadata on.
      await db.games.insertOne({
        userId: "u1",
        gameId: "g1",
        date: new Date("2026-05-09T12:00:00Z"),
        opponent: {
          pulseId: baseGame.pulseId,
          toonHandle: baseGame.toonHandle,
          displayName: baseGame.displayName,
          race: baseGame.race,
        },
      });
    });

    test("recordGame never back-stamps SC2Pulse MMR", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
        gameId: "g1",
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBeUndefined();
      expect(game.opponent.region).toBe("NA");
      expect(pulseMmr.getRaceBreakdown).not.toHaveBeenCalled();
    });

    test("recordGame preserves replay-provided opponent.mmr", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 9999, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await db.games.updateOne(
        { userId: "u1", gameId: "g1" },
        { $set: { "opponent.mmr": 4321 } },
      );
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
        gameId: "g1",
        mmr: 4321, // agent already had a value
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBe(4321);
      expect(pulseMmr.getRaceBreakdown).not.toHaveBeenCalled();
    });

    test("no-op when gameId is omitted (defensive)", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
        // no gameId
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBeUndefined();
      expect(game.opponent.region).toBeUndefined();
    });

    test("refreshMetadata never back-stamps SC2Pulse MMR", async () => {
      // Pre-fill opponents row from a prior ingest.
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
      });

      const pulseMmr = makePulseStub(async () => ({ mmr: 4500, region: "EU" }));
      const opponents2 = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents2.refreshMetadata("u1", {
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        pulseCharacterId: "452727",
        displayName: baseGame.displayName,
        race: baseGame.race,
        playedAt: baseGame.playedAt,
        gameId: "g1",
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBeUndefined();
      expect(game.opponent.region).toBe("EU");
      expect(pulseMmr.getRaceBreakdown).not.toHaveBeenCalled();
    });
  });
});
