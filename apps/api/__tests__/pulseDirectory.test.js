// @ts-nocheck
"use strict";

/**
 * PulseDirectoryService — the global, cross-user SC2Pulse cache.
 *
 * Pins the sharing contract:
 *   * a resolution / MMR pull written by one path is readable by any
 *     other (no userId scoping);
 *   * fresh entries are served, stale ones (past TTL) are not;
 *   * negative resolutions are never served as positive hits;
 *   * write-through is keyed on the toon handle so resolution + MMR
 *     collapse onto a single row.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { PulseDirectoryService } = require("../src/services/pulseDirectory");

describe("PulseDirectoryService", () => {
  let mongo;
  let db;
  let now;
  let directory;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "pulse_dir_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.pulseAccounts.deleteMany({});
    now = 1_700_000_000_000;
    directory = new PulseDirectoryService(db, { now: () => now });
  });

  const TOON = "1-S2-1-267727";

  test("recordResolution then getFreshResolution returns the id", async () => {
    const wrote = await directory.recordResolution({
      toonHandle: TOON,
      pulseCharacterId: "267727",
      displayName: "ReSpOnSe",
      region: "NA",
    });
    expect(wrote).toBe(true);
    expect(await directory.getFreshResolution(TOON)).toBe("267727");

    const row = await db.pulseAccounts.findOne({ toonHandle: TOON });
    expect(row.pulseCharacterId).toBe("267727");
    expect(row.displayNameSample).toBe("ReSpOnSe");
    expect(row.region).toBe("NA");
    expect(row._schemaVersion).toBe(1);
  });

  test("getFreshResolution misses once the resolution TTL elapses", async () => {
    await directory.recordResolution({
      toonHandle: TOON,
      pulseCharacterId: "267727",
    });
    expect(await directory.getFreshResolution(TOON)).toBe("267727");
    // Advance just past the 24h positive TTL.
    now += 24 * 60 * 60 * 1000 + 1;
    expect(await directory.getFreshResolution(TOON)).toBeNull();
  });

  test("getFreshResolution returns null for an unknown toon", async () => {
    expect(await directory.getFreshResolution("9-S2-9-9")).toBeNull();
  });

  test("recordResolution ignores empty ids (no false positive)", async () => {
    expect(
      await directory.recordResolution({ toonHandle: TOON, pulseCharacterId: "" }),
    ).toBe(false);
    expect(await directory.getFreshResolution(TOON)).toBeNull();
  });

  test("recordMmr then getFreshMmr round-trips collapsed MMR + races", async () => {
    const races = [
      { race: "Protoss", mmr: 5200, games: 120, league: "Diamond", region: "NA" },
      { race: "Zerg", mmr: 4800, games: 30, league: "Diamond", region: "NA" },
    ];
    const wrote = await directory.recordMmr({
      toonHandle: TOON,
      pulseCharacterId: "267727",
      mmr: 5200,
      region: "NA",
      races,
    });
    expect(wrote).toBe(true);

    const byToon = await directory.getFreshMmr({ toonHandle: TOON });
    expect(byToon.mmr).toBe(5200);
    expect(byToon.region).toBe("NA");
    expect(byToon.races).toHaveLength(2);

    // Lookup by character id resolves the same row via the sparse index.
    const byId = await directory.getFreshMmr({ pulseCharacterId: "267727" });
    expect(byId.mmr).toBe(5200);
  });

  test("resolution + MMR collapse onto one row keyed by toon", async () => {
    await directory.recordResolution({
      toonHandle: TOON,
      pulseCharacterId: "267727",
    });
    await directory.recordMmr({ toonHandle: TOON, mmr: 5000, region: "EU" });
    const count = await db.pulseAccounts.countDocuments({ toonHandle: TOON });
    expect(count).toBe(1);
    const row = await db.pulseAccounts.findOne({ toonHandle: TOON });
    expect(row.pulseCharacterId).toBe("267727");
    expect(row.mmr).toBe(5000);
  });

  test("getFreshMmr misses once the MMR TTL elapses", async () => {
    await directory.recordMmr({ toonHandle: TOON, mmr: 5000 });
    expect((await directory.getFreshMmr({ toonHandle: TOON })).mmr).toBe(5000);
    now += 60 * 60 * 1000 + 1; // past the 1h MMR TTL
    expect(await directory.getFreshMmr({ toonHandle: TOON })).toBeNull();
  });

  test("recordMmr drops malformed race rows and rejects empty payloads", async () => {
    const wrote = await directory.recordMmr({
      toonHandle: TOON,
      races: [
        { race: "Protoss", mmr: 5200, games: 5 },
        { race: "", mmr: 4000 }, // no race
        { race: "Zerg", mmr: 0 }, // non-positive mmr
        { race: "Terran", mmr: "nan" }, // non-numeric
      ],
    });
    expect(wrote).toBe(true);
    const row = await directory.getFreshMmr({ toonHandle: TOON });
    expect(row.races).toHaveLength(1);
    expect(row.races[0].race).toBe("Protoss");

    // Nothing worth caching → no write.
    expect(await directory.recordMmr({ toonHandle: "2-S2-1-1", races: [] })).toBe(
      false,
    );
  });

  test("stats counts total / resolved / mmrCached", async () => {
    await directory.recordResolution({ toonHandle: TOON, pulseCharacterId: "1" });
    await directory.recordMmr({ toonHandle: TOON, mmr: 5000 });
    await directory.recordMmr({ toonHandle: "2-S2-1-2", mmr: 4000 }); // mmr only
    const stats = await directory.stats();
    expect(stats.total).toBe(2);
    expect(stats.resolved).toBe(1);
    expect(stats.mmrCached).toBe(2);
  });
});
