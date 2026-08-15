// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { VERSION_KEY } = require("../src/db/schemaVersioning");
const {
  FingerprintPopulationCalibrationService,
  COLLECTION_NAME,
  MIN_POPULATION_SAMPLE,
  PLAYER_WINDOW_GAMES,
  SCHEMA_VERSION,
  midrankPercentile,
  scoreAxis,
  twoSidedPercentileScore,
} = require("../src/services/fingerprintPopulationCalibration");
const {
  buildFingerprintPopulationCalibrationRecomputeJob,
} = require("../src/jobs/fingerprintPopulationCalibrationRecomputeJob");

describe("fingerprint population calibration pure scoring", () => {
  test("exact tied values use the empirical midrank CDF", () => {
    const histogram = [
      { value: 10, count: 2 },
      { value: 20, count: 4 },
      { value: 30, count: 2 },
    ];

    expect(midrankPercentile(histogram, 5)).toBe(0);
    expect(midrankPercentile(histogram, 10)).toBe(0.125);
    expect(midrankPercentile(histogram, 15)).toBe(0.25);
    expect(midrankPercentile(histogram, 20)).toBe(0.5);
    expect(midrankPercentile(histogram, 30)).toBe(0.875);
    expect(midrankPercentile(histogram, 35)).toBe(1);

    expect(twoSidedPercentileScore(histogram, 20)).toBe(0);
    expect(twoSidedPercentileScore(histogram, 10)).toBe(0.75);
    expect(twoSidedPercentileScore(histogram, 30)).toBe(0.75);
  });

  test("histograms are sorted and duplicate exact values are combined", () => {
    const unsorted = [
      { value: 20, count: 1 },
      { value: 10, count: 2 },
      { value: 20, count: 3 },
      { value: 30, count: 2 },
    ];
    expect(midrankPercentile(unsorted, 20)).toBe(0.5);
  });

  test.each([
    [[], 1],
    [[{ value: 1, count: 0 }], 1],
    [[{ value: Number.NaN, count: 1 }], 1],
    [[{ value: 1, count: 1.5 }], 1],
    [[{ value: 1, count: 1 }], Number.NaN],
  ])("malformed histogram/value returns null", (histogram, value) => {
    expect(midrankPercentile(histogram, value)).toBeNull();
    expect(twoSidedPercentileScore(histogram, value)).toBeNull();
  });

  function calibrationTable() {
    return {
      axes: {
        repertoire: {
          n: 100,
          valueN: 100,
          histogram: [
            { value: 1, count: 20 },
            { value: 2, count: 60 },
            { value: 3, count: 20 },
          ],
          categoryCounts: {
            one_trick: 20,
            signature: 60,
            grinder: 20,
          },
        },
        pace: {
          n: 100,
          valueN: 100,
          histogram: [
            { value: 250, count: 10 },
            { value: 275, count: 10 },
            { value: 290, count: 10 },
            { value: 600, count: 70 },
          ],
          categoryCounts: {
            cheeser: 40,
            flexible: 20,
            late_game: 10,
            late_game_master: 5,
            mid_late_master: 10,
            timing_attacker: 10,
            two_speed: 5,
          },
        },
        matchup_edge: {
          n: 100,
          valueN: 100,
          histogram: [
            { value: -20, count: 20 },
            { value: 0, count: 60 },
            { value: 20, count: 20 },
          ],
          categoryCounts: {
            blind_spot: 5,
            matchup_edge: 20,
            matchup_hurdle: 15,
            specialist: 10,
            universalist: 50,
          },
        },
      },
    };
  }

  test("repertoire always uses effective-build two-sided percentile", () => {
    const table = calibrationTable();
    expect(
      scoreAxis(table, "repertoire", {
        category: "signature",
        detail: { effectiveBuilds: 2 },
      }),
    ).toBe(0);
    expect(
      scoreAxis(table, "repertoire", {
        category: "one_trick",
        detail: { effectiveBuilds: 1 },
      }),
    ).toBe(0.8);
  });

  test("pace uses percentiles for continuous tiers and rarity for signatures", () => {
    const table = calibrationTable();
    expect(
      scoreAxis(table, "pace", {
        category: "flexible",
        value: 600,
        detail: { averageSec: 600 },
      }),
    ).toBeCloseTo(0.3, 12);
    expect(
      scoreAxis(table, "pace", {
        category: "late_game",
        value: 1200,
        detail: { averageSec: 1200 },
      }),
    ).toBe(1);
    expect(
      scoreAxis(table, "pace", {
        category: "timing_attacker",
        value: 360,
        detail: { averageSec: 360 },
      }),
    ).toBe(0.9);
    expect(
      scoreAxis(table, "pace", {
        category: "two_speed",
        value: 600,
        detail: { averageSec: 600 },
      }),
    ).toBe(0.95);
  });

  test("only dominant-under-five cheeser uses rarity", () => {
    const table = calibrationTable();
    const dominant = scoreAxis(table, "pace", {
      category: "cheeser",
      value: 290,
      detail: {
        averageSec: 290,
        classificationMethod: "dominant_under_five",
      },
    });
    const meanFallback = scoreAxis(table, "pace", {
      category: "cheeser",
      value: 290,
      detail: {
        averageSec: 290,
        classificationMethod: "mean_under_five",
      },
    });
    const legacyWithoutMethod = scoreAxis(table, "pace", {
      category: "cheeser",
      value: 290,
      detail: { averageSec: 290 },
    });

    expect(dominant).toBe(0.6); // 1 - 40/100 cheeser tier frequency
    expect(meanFallback).toBe(0.5); // midrank of the 290-second tie
    expect(legacyWithoutMethod).toBe(meanFallback);
  });

  test("matchup moderate tiers use signed-edge percentiles; endpoint tiers use rarity", () => {
    const table = calibrationTable();
    expect(
      scoreAxis(table, "matchup_edge", {
        category: "matchup_edge",
        value: 0,
        detail: { signedEdge: 0 },
      }),
    ).toBe(0);
    expect(
      scoreAxis(table, "matchup_edge", {
        category: "matchup_hurdle",
        value: -20,
        detail: { signedEdge: -20 },
      }),
    ).toBe(0.8);
    expect(
      scoreAxis(table, "matchup_edge", {
        category: "specialist",
        value: 30,
        detail: { signedEdge: 30 },
      }),
    ).toBe(0.9);
    expect(
      scoreAxis(table, "matchup_edge", {
        category: "universalist",
        value: 0,
        detail: { signedEdge: 0 },
      }),
    ).toBe(0.5);
  });

  test("missing or undersampled calibration returns null without fallback", () => {
    const table = calibrationTable();
    table.axes.repertoire.valueN = MIN_POPULATION_SAMPLE - 1;
    expect(
      scoreAxis(table, "repertoire", {
        category: "creative",
        position: 100,
        detail: { effectiveBuilds: 12 },
      }),
    ).toBeNull();
    expect(
      scoreAxis(null, "pace", {
        category: "cheeser",
        position: 0,
        detail: { averageSec: 250 },
      }),
    ).toBeNull();
    expect(
      scoreAxis(table, "pace", { category: null, position: 0 }),
    ).toBeNull();
  });
});

describe("FingerprintPopulationCalibrationService", () => {
  let mongo;
  let db;
  let service;
  let calibration;
  let serial = 0;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_fingerprint_population_calibration",
    });
    service = new FingerprintPopulationCalibrationService(db, {
      logger: null,
      now: () => Date.UTC(2026, 7, 14, 12),
    });
    calibration = db.db.collection(COLLECTION_NAME);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await calibration.deleteMany({});
    serial = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  const OPPONENT_RACE = {
    P: "Protoss",
    T: "Terran",
    Z: "Zerg",
  };
  const DURATIONS_A = [240, 240, 240, 360, 360, 360, 360, 600, 600, 600];
  const DURATIONS_B = [240, 240, 240, 360, 360, 360, 600, 600, 600, 600];

  function game(userId, matchup, index, options = {}) {
    serial += 1;
    const pattern = options.durationPattern || DURATIONS_A;
    const build = options.twoBuilds
      ? `Build ${(index % 2) + 1}`
      : options.build || "Build 1";
    return {
      userId,
      gameId: `fingerprint-calibration-${serial}`,
      date:
        options.date ||
        new Date(Date.UTC(2026, 0, 2) + serial * 1000),
      result: index % 2 === 0 ? "Victory" : "Defeat",
      myRace: "Protoss",
      myBuild: build,
      durationSec: pattern[index % pattern.length],
      matchFormat: "1v1",
      playerCount: 2,
      opponent: { race: OPPONENT_RACE[matchup[2]] },
      ...options.overrides,
    };
  }

  async function seedPopulation() {
    const docs = [];

    // These ten rows would materially change player-0's PvZ repertoire and
    // pace if the population window took more than the latest 50.
    for (let i = 0; i < 10; i += 1) {
      docs.push(
        game("player-0", "PvZ", i, {
          build: `Old Experimental Build ${i}`,
          durationPattern: [1200],
          date: new Date(Date.UTC(2025, 0, 1) + i * 1000),
        }),
      );
    }

    for (let player = 0; player < MIN_POPULATION_SAMPLE; player += 1) {
      const userId = `player-${player}`;
      const twoBuilds = player >= MIN_POPULATION_SAMPLE / 2;
      const durationPattern = twoBuilds ? DURATIONS_B : DURATIONS_A;
      for (const matchup of ["PvP", "PvT", "PvZ"]) {
        const count = player === 0 && matchup === "PvZ"
          ? PLAYER_WINDOW_GAMES
          : 10;
        for (let i = 0; i < count; i += 1) {
          docs.push(
            game(userId, matchup, i, {
              twoBuilds,
              durationPattern,
            }),
          );
        }
      }
    }

    // Each excluded row would create another persisted matchup/player window
    // if the 1v1/race/resumed qualification diverged from the live service.
    docs.push(
      game("excluded-team", "PvZ", 0, {
        overrides: { matchFormat: "team", playerCount: 4 },
      }),
      game("excluded-resumed", "PvZ", 0, {
        overrides: { isResumedFromReplay: true },
      }),
      game("excluded-random", "PvZ", 0, {
        overrides: { myRace: "Random" },
      }),
    );

    await db.games.insertMany(docs);
  }

  test("recompute persists exact aggregate-only latest-50 tables", async () => {
    await seedPopulation();
    const result = await service.recompute();

    expect(result).toMatchObject({
      matchups: 3,
      playerMatchupWindows: 3 * MIN_POPULATION_SAMPLE,
      updatedAt: new Date(Date.UTC(2026, 7, 14, 12)),
    });

    const docs = await calibration.find({}, { projection: { _id: 0 } })
      .sort({ matchup: 1 })
      .toArray();
    expect(docs.map((row) => row.matchup)).toEqual(["PvP", "PvT", "PvZ"]);

    const pvz = docs.find((row) => row.matchup === "PvZ");
    expect(pvz).toMatchObject({
      version: SCHEMA_VERSION,
      n: MIN_POPULATION_SAMPLE,
      axes: {
        repertoire: {
          metric: "effectiveBuilds",
          n: MIN_POPULATION_SAMPLE,
          valueN: MIN_POPULATION_SAMPLE,
          histogram: [
            { value: 1, count: 25 },
            { value: 2, count: 25 },
          ],
          categoryCounts: { one_trick: 25, signature: 25 },
        },
        pace: {
          metric: "averageSec",
          n: MIN_POPULATION_SAMPLE,
          valueN: MIN_POPULATION_SAMPLE,
          histogram: [
            { value: 396, count: 25 },
            { value: 420, count: 25 },
          ],
          categoryCounts: { flexible: MIN_POPULATION_SAMPLE },
        },
        matchup_edge: {
          metric: "signedEdge",
          n: MIN_POPULATION_SAMPLE,
          valueN: MIN_POPULATION_SAMPLE,
          histogram: [{ value: 0, count: MIN_POPULATION_SAMPLE }],
          categoryCounts: { universalist: MIN_POPULATION_SAMPLE },
        },
      },
      reference: {
        version: SCHEMA_VERSION,
        population: "global",
        unit: "player_matchup_window",
        windowGames: PLAYER_WINDOW_GAMES,
        windowMode: "latest",
        filters: "non_resumed_1v1_ptz_matchups",
        window: {
          mode: "latest_qualifying_1v1",
          games: PLAYER_WINDOW_GAMES,
        },
        histogram: "exact_values",
        percentile: "empirical_midrank_cdf",
        minPopulationSample: MIN_POPULATION_SAMPLE,
      },
      [VERSION_KEY]: SCHEMA_VERSION,
    });

    // Old experimental rows were outside player-0's latest 50. If they leaked
    // in, effective-build and duration histograms above would gain extra bins.
    expect(pvz.axes.repertoire.histogram).toHaveLength(2);
    expect(pvz.axes.pace.histogram).toHaveLength(2);

    const persisted = JSON.stringify(docs);
    expect(persisted).not.toMatch(/player-\d|excluded-/);
    expect(allKeys(docs)).not.toContain("userId");
  });

  test("lookup/scoring use the persisted reference and suppress small populations", async () => {
    await seedPopulation();
    await service.recompute();

    const table = await service.lookup("p v z");
    expect(table).not.toBeNull();
    expect(
      service.scoreAxis(table, "repertoire", {
        category: "one_trick",
        detail: { effectiveBuilds: 1 },
      }),
    ).toEqual({
      distinctiveness: 0.5,
      method: "two_sided_percentile",
      populationSize: MIN_POPULATION_SAMPLE,
      percentile: 0.25,
    });
    expect(
      await service.scoreForMatchup({
        matchup: "PvZ",
        axisKey: "pace",
        result: {
          category: "flexible",
          value: 396,
          detail: { averageSec: 396 },
        },
      }),
    ).toEqual({
      distinctiveness: 0.5,
      method: "two_sided_percentile",
      populationSize: MIN_POPULATION_SAMPLE,
      percentile: 0.25,
    });
    expect(
      service.scoreAxis(table, "matchup_edge", {
        category: "universalist",
        value: 0,
        detail: { signedEdge: 0 },
      }),
    ).toEqual({
      distinctiveness: 0,
      method: "tier_rarity",
      populationSize: MIN_POPULATION_SAMPLE,
      tierFrequency: 1,
    });

    await calibration.insertOne({
      matchup: "TvZ",
      n: MIN_POPULATION_SAMPLE - 1,
      axes: {},
      reference: { version: SCHEMA_VERSION },
      updatedAt: new Date(),
      [VERSION_KEY]: SCHEMA_VERSION,
    });
    expect(await service.lookup({ matchup: "TvZ" })).toBeNull();
    expect(await service.lookup({ matchup: "not-a-matchup" })).toBeNull();
  });

  test("recompute is idempotent and removes aggregate bands no longer present", async () => {
    await seedPopulation();
    await service.recompute();
    const first = await calibration.find({}, { projection: { _id: 0 } })
      .sort({ matchup: 1 })
      .toArray();

    await service.recompute();
    const second = await calibration.find({}, { projection: { _id: 0 } })
      .sort({ matchup: 1 })
      .toArray();
    expect(second).toEqual(first);

    await db.games.deleteMany({});
    await service.recompute();
    expect(await calibration.countDocuments()).toBe(0);
  });
});

describe("fingerprint population calibration recompute job", () => {
  test("manual ticks are single-flight and report aggregate counts", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const recompute = jest.fn(async () => {
      await gate;
      return { matchups: 9, playerMatchupWindows: 450 };
    });
    const childLogger = { info: jest.fn(), warn: jest.fn() };
    const logger = { child: jest.fn(() => childLogger) };
    const job = buildFingerprintPopulationCalibrationRecomputeJob({
      calibration: { recompute },
      logger,
      runOnStart: false,
    });

    const first = job.tick();
    const second = job.tick();
    expect(recompute).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    expect(childLogger.info).toHaveBeenCalledWith(
      { matchups: 9, playerMatchupWindows: 450 },
      "fingerprint_population_calibration_recomputed",
    );
    await job.stop();
  });
});

function allKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, nested] of Object.entries(value)) {
    out.push(key);
    allKeys(nested, out);
  }
  return out;
}
