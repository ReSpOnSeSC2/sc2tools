// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");

describe("services/trendsInsights.mmrProgression", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "mmr_progression_test" });
    svc = new AggregationsService(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
  });

  function makeGame(gameId, overrides = {}) {
    return {
      userId: "u1",
      gameId,
      date: new Date("2026-05-01T12:00:00Z"),
      result: "Victory",
      myRace: "Zerg",
      myMmr: 4100,
      myMmrSource: "replay",
      myToonHandle: "1-S2-1-12345",
      isLadderGame: true,
      playerCount: 2,
      opponent: { race: "Protoss" },
      ...overrides,
    };
  }

  test("quarantines untrusted/non-1v1 rows and splits account race ladders", async () => {
    await db.games.insertMany([
      makeGame("z1"),
      makeGame("z2", {
        date: new Date("2026-05-02T12:00:00Z"),
        myMmr: 4125,
      }),
      makeGame("t1", {
        date: new Date("2026-05-01T13:00:00Z"),
        myRace: "Terran",
        myLadderRace: "Terran",
        myMmr: 3950,
      }),
      // Random may spawn as any race; the selected ladder race owns MMR.
      makeGame("r1", {
        date: new Date("2026-05-03T12:00:00Z"),
        myRace: "Protoss",
        myLadderRace: "Random",
        myMmr: 4050,
      }),
      // Numeric legacy values are visible in coverage but never charted.
      makeGame("legacy", { myMmr: 5400, myMmrSource: undefined }),
      makeGame("custom", { isLadderGame: false, myMmr: 5000 }),
      makeGame("team", { playerCount: 4, myMmr: 4300 }),
      makeGame("missing-handle", { myToonHandle: "   ", myMmr: 4200 }),
      makeGame("missing-race", {
        myRace: "Unknown",
        myLadderRace: "",
        myMmr: 4250,
      }),
      makeGame("unavailable", {
        myMmr: undefined,
        myMmrSource: "unavailable",
      }),
    ]);

    const out = await svc.mmrProgression(
      "u1",
      { interval: "day", tz: "UTC" },
      {},
    );

    expect(out.series.map((s) => s.seriesKey)).toEqual([
      "1-S2-1-12345|Z",
      "1-S2-1-12345|T",
      "1-S2-1-12345|R",
    ]);
    expect(out.series.map((s) => s.label)).toEqual([
      "NA 12345 · Zerg",
      "NA 12345 · Terran",
      "NA 12345 · Random",
    ]);
    expect(out.series[0].points).toHaveLength(2);
    expect(out.series[0].latest.mmr).toBe(4125);
    expect(out.series[1].latest.mmr).toBe(3950);
    expect(out.series[2].latest.mmr).toBe(4050);

    // A top-level blended line would jump among three separate ratings.
    expect(out.mixedSeries).toBe(true);
    expect(out.points).toEqual([]);
    expect(out.latest).toBeNull();

    expect(out.coverage).toEqual({
      filteredGames: 10,
      numericMmrGames: 9,
      verifiedReplayMmrGames: 8,
      untrustedNumericMmrGames: 1,
      unavailableMmrGames: 1,
      missingMmrGames: 1,
      excludedNonRanked1v1Games: 2,
      missingAccountGames: 1,
      missingLadderRaceGames: 1,
      eligibleGames: 4,
    });
  });

  test("keeps top-level compatibility fields for one verified series", async () => {
    await db.games.insertMany([
      makeGame("z1", { myMmr: 4100 }),
      makeGame("z2", {
        date: new Date("2026-05-02T12:00:00Z"),
        result: "Defeat",
        myMmr: 4125,
      }),
      makeGame("legacy", { myMmr: 5400, myMmrSource: undefined }),
    ]);

    const out = await svc.mmrProgression(
      "u1",
      { interval: "day", tz: "UTC" },
      {},
    );

    expect(out.series).toHaveLength(1);
    expect(out.points).toHaveLength(2);
    expect(out.latest.mmr).toBe(4125);
    expect(out.peak.mmr).toBe(4125);
    expect(out.trough.mmr).toBe(4100);
    expect(out.coverage.untrustedNumericMmrGames).toBe(1);
  });
});
