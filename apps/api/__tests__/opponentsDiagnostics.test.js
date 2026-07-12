// @ts-nocheck
"use strict";

/**
 * OpponentsService — admin identity / MMR diagnostics + single-opponent
 * retry.
 *
 * ``diagnoseIdentity`` turns the stored identity/MMR state of one
 * opponent into a human-readable explanation of why the Pulse ID shows
 * "TOON" or the MMR shows "—". It's read-only and makes no SC2Pulse
 * calls — everything is inferred from fields already persisted at
 * ingest / backfill time, which is why the admin debug panel needs no
 * agent update.
 *
 * ``retryPulseResolution`` forces a fresh resolve + MMR refetch for one
 * opponent (bypassing the cron throttle windows), back-stamping games
 * that lack an in-replay MMR.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService.diagnoseIdentity", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_diag_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
  });

  test("returns null for an unknown opponent", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    expect(await opponents.diagnoseIdentity("u1", "nope")).toBeNull();
  });

  test("resolved id + MMR present → ok findings", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-1",
      toonHandle: "1-S2-1-1",
      pulseCharacterId: "452727",
      displayNameSample: "ReSpOnSe",
      region: "NA",
      mmr: 4500,
      mmrFetchedAt: new Date("2026-05-20T00:00:00Z"),
      gameCount: 3,
    });
    const d = await opponents.diagnoseIdentity("u1", "1-S2-1-1");
    expect(d.pulseIdStatus).toBe("resolved");
    expect(d.mmrStatus).toBe("present");
    expect(d.pulseCharacterId).toBe("452727");
    expect(d.findings.some((f) => f.code === "pulse_id_resolved")).toBe(true);
    expect(d.findings.some((f) => f.code === "mmr_present")).toBe(true);
  });

  test("toon-only barcode, attempted, no MMR → explains both gaps", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-2",
      toonHandle: "1-S2-1-2",
      displayNameSample: "IIIIIIIII",
      region: "NA",
      pulseResolveAttemptedAt: new Date("2026-05-20T00:00:00Z"),
      gameCount: 5,
    });
    const d = await opponents.diagnoseIdentity("u1", "1-S2-1-2");
    expect(d.pulseIdStatus).toBe("unresolved");
    expect(d.mmrStatus).toBe("missing");
    const codes = d.findings.map((f) => f.code);
    expect(codes).toContain("pulse_id_unresolved");
    expect(codes).toContain("pulse_resolve_attempted");
    expect(codes).toContain("pulse_resolve_barcode");
    // No id was ever resolved and no fetch stamped → "not fetched yet".
    expect(codes).toContain("mmr_pulse_not_fetched");
  });

  test("counts in-replay MMR games and reports pulse-empty when fetched but blank", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-3",
      toonHandle: "1-S2-1-3",
      pulseCharacterId: "999",
      displayNameSample: "Truth",
      // A fetch happened (timestamp set) but no mmr landed.
      mmrFetchedAt: new Date("2026-05-20T00:00:00Z"),
      gameCount: 2,
    });
    await db.games.insertMany([
      {
        userId: "u1",
        gameId: "g1",
        date: new Date(),
        opponent: { pulseId: "1-S2-1-3", mmr: 4100 },
      },
      {
        userId: "u1",
        gameId: "g2",
        date: new Date(),
        opponent: { pulseId: "1-S2-1-3" },
      },
    ]);
    const d = await opponents.diagnoseIdentity("u1", "1-S2-1-3");
    expect(d.inReplayMmrCount).toBe(1);
    expect(d.findings.map((f) => f.code)).toContain("mmr_pulse_empty");
  });
});

describe("OpponentsService.retryPulseResolution", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_retry_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
  });

  test("returns null for an unknown opponent", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    expect(await opponents.retryPulseResolution("u1", "nope")).toBeNull();
  });

  test("resolves an id and fetches row MMR without back-stamping game MMR", async () => {
    const pulseResolver = {
      resolve: jest.fn(async () => "452727"),
    };
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => ({ mmr: 4800, region: "NA" })),
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 4800, region: "NA" })),
      getCurrentMmrByToon: jest.fn(async () => null),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver,
      pulseMmr,
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-4",
      toonHandle: "1-S2-1-4",
      displayNameSample: "Koht",
      gameCount: 2,
    });
    await db.games.insertMany([
      { userId: "u1", gameId: "g1", opponent: { pulseId: "1-S2-1-4" } },
      {
        userId: "u1",
        gameId: "g2",
        opponent: { pulseId: "1-S2-1-4", mmr: 4000 },
      },
    ]);

    const res = await opponents.retryPulseResolution("u1", "1-S2-1-4");
    expect(res.resolvedPulseCharacterId).toBe(true);
    expect(res.pulseCharacterId).toBe("452727");
    expect(res.mmr).toBe(4800);
    expect(res.gamesRestamped).toBe(1); // metadata updated on the missing-MMR game

    const row = await db.opponents.findOne({ userId: "u1", pulseId: "1-S2-1-4" });
    expect(row.pulseCharacterId).toBe("452727");
    expect(row.mmr).toBe(4800);
    expect(row.pulseResolveAttemptedAt).toBeInstanceOf(Date);

    const g1 = await db.games.findOne({ userId: "u1", gameId: "g1" });
    const g2 = await db.games.findOne({ userId: "u1", gameId: "g2" });
    expect(g1.opponent.mmr).toBeUndefined(); // enrichment job owns this write
    expect(g1.opponent.pulseCharacterId).toBe("452727");
    expect(g1.opponent.region).toBe("NA");
    expect(g2.opponent.mmr).toBe(4000); // in-replay value preserved
  });

  test("already-resolved id only refetches MMR (no resolver call)", async () => {
    const pulseResolver = { resolve: jest.fn(async () => "should-not-run") };
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => ({ mmr: 5100, region: "EU" })),
      getCurrentMmrForAny: jest.fn(async () => ({ mmr: 5100, region: "EU" })),
      getCurrentMmrByToon: jest.fn(async () => null),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver,
      pulseMmr,
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "2-S2-1-5",
      toonHandle: "2-S2-1-5",
      pulseCharacterId: "777",
      displayNameSample: "EON",
      gameCount: 1,
    });

    const res = await opponents.retryPulseResolution("u1", "2-S2-1-5");
    expect(pulseResolver.resolve).not.toHaveBeenCalled();
    expect(res.resolvedPulseCharacterId).toBe(false);
    expect(res.pulseCharacterId).toBe("777");
    expect(res.mmr).toBe(5100);
    expect(res.region).toBe("EU");
  });

  test("falls back to toon-handle MMR when no id can be resolved", async () => {
    const pulseResolver = { resolve: jest.fn(async () => null) };
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => null),
      getCurrentMmrForAny: jest.fn(async () => null),
      getCurrentMmrByToon: jest.fn(async () => ({ mmr: 4300, region: "NA" })),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseResolver,
      pulseMmr,
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-6",
      toonHandle: "1-S2-1-6",
      displayNameSample: "nickname",
      gameCount: 1,
    });

    const res = await opponents.retryPulseResolution("u1", "1-S2-1-6");
    expect(res.resolvedPulseCharacterId).toBe(false);
    expect(res.pulseCharacterId).toBeNull();
    expect(pulseMmr.getCurrentMmrByToon).toHaveBeenCalledWith("1-S2-1-6");
    expect(res.mmr).toBe(4300);
  });
});

describe("OpponentsService.getPulseRaceBreakdown", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_races_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
  });

  test("returns null for an unknown opponent", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: { getRaceBreakdown: jest.fn() },
    });
    expect(await opponents.getPulseRaceBreakdown("u1", "nope")).toBeNull();
  });

  test("returns per-race rows + top-race headline", async () => {
    const pulseMmr = {
      getRaceBreakdown: jest.fn(async () => [
        { race: "Protoss", mmr: 5584, games: 7387, league: "Master", region: "NA" },
        { race: "Zerg", mmr: 5081, games: 1163, league: "Master", region: "NA" },
        { race: "Terran", mmr: 4667, games: 509, league: "Diamond", region: "NA" },
      ]),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), { pulseMmr });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-77",
      pulseCharacterId: "107665",
      toonHandle: "1-S2-1-77",
      gameCount: 12,
    });

    const out = await opponents.getPulseRaceBreakdown("u1", "1-S2-1-77");
    expect(out.resolved).toBe(true);
    expect(out.races).toHaveLength(3);
    expect(out.topRace).toBe("Protoss");
    expect(out.topMmr).toBe(5584);
    // The id list prefers the resolved character id, and the region
    // hint is derived from the toon handle ("1-..." → NA) so the
    // breakdown queries only that region's current season.
    expect(pulseMmr.getRaceBreakdown).toHaveBeenCalledWith(
      expect.arrayContaining(["107665"]),
      { preferredRegion: "NA" },
    );
  });

  test("degrades to resolved:false when SC2Pulse returns nothing", async () => {
    const pulseMmr = { getRaceBreakdown: jest.fn(async () => []) };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), { pulseMmr });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-88",
      toonHandle: "1-S2-1-88",
    });
    const out = await opponents.getPulseRaceBreakdown("u1", "1-S2-1-88");
    expect(out.resolved).toBe(false);
    expect(out.races).toEqual([]);
    expect(out.topRace).toBeNull();
  });
});
