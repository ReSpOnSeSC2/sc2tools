// @ts-nocheck
"use strict";

/**
 * Replay-derived Skill Fingerprint: pure boundaries plus the authenticated
 * route contract through the real app wiring and an in-memory Mongo server.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const {
  ARCHETYPE_NAMES,
  NEAR_BALANCED_MAX_SPREAD,
  deriveArchetype,
  matchupBalanceAxis,
  paceAxis,
  repertoireAxis,
} = require("../src/services/skillFingerprint");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_fingerprint" };
    throw new Error("invalid");
  }),
}));

// ---------------------------------------------------------------------------
// Replay-derived heuristic contract (current implementation)
// ---------------------------------------------------------------------------

const RACE_NAME = { P: "Protoss", T: "Terran", Z: "Zerg" };
const DIAMOND = 4;

function repeatedRows(count, fields) {
  return Array.from({ length: count }, () => ({ ...fields }));
}

function rowsWithDistinctBuilds(count, total = 10) {
  return Array.from({ length: total }, (_, i) => ({
    myBuild: `Build ${(i % count) + 1}`,
  }));
}

function outcomeRows(wins, losses, ties = 0) {
  return [
    ...repeatedRows(wins, { result: "Victory" }),
    ...repeatedRows(losses, { result: "Defeat" }),
    ...repeatedRows(ties, { result: "Tie" }),
  ];
}

describe("skill fingerprint pure replay heuristics", () => {
  describe("repertoireAxis", () => {
    test.each([
      [1, "grinder", "Consistent Grinder", 0],
      [2, "grinder", "Consistent Grinder", 0],
      [3, "adaptive", "Adaptive Strategist", 25],
      [5, "adaptive", "Adaptive Strategist", 75],
      [6, "creative", "Creative Genius", 100],
      [10, "creative", "Creative Genius", 100],
    ])(
      "%i distinct builds maps to %s at the exact boundary",
      (count, category, _categoryLabel, position) => {
        const axis = repertoireAxis(rowsWithDistinctBuilds(count));
        expect(axis).toMatchObject({
          value: count,
          category,
          position,
          sampleSize: 10,
        });
        expect(axis.builds).toHaveLength(count);
      },
    );

    test("needs 10 usable labels and excludes placeholder buckets", () => {
      const axis = repertoireAxis([
        ...rowsWithDistinctBuilds(3, 9),
        { myBuild: "" },
        { myBuild: null },
        { myBuild: "PvZ - Game Too Short" },
        { myBuild: "PvZ - Macro Transition (Unclassified)" },
        { myBuild: "Unclassified - Protoss" },
      ]);

      expect(axis).toMatchObject({
        value: 3,
        category: null,
        position: null,
        sampleSize: 9,
      });
      expect(axis.builds).toEqual([
        { name: "Build 1", games: 3 },
        { name: "Build 2", games: 3 },
        { name: "Build 3", games: 3 },
      ]);
    });
  });

  describe("paceAxis", () => {
    test.each([
      [300, "cheeser", "Cheeser", 0],
      [301, "standard", "Flexible Pacer", 1],
      [510, "standard", "Flexible Pacer", 50],
      [719, "standard", "Flexible Pacer", 99],
      [720, "late_game", "Late-Game Specialist", 100],
    ])(
      "%i-second average maps to %s at the exact boundary",
      (durationSec, category, _categoryLabel, exactPosition) => {
        const axis = paceAxis(repeatedRows(10, { durationSec }));
        expect(axis).toMatchObject({
          value: durationSec,
          category,
          sampleSize: 10,
        });
        expect(axis.position).toBeGreaterThanOrEqual(0);
        expect(axis.position).toBeLessThanOrEqual(100);
        if (exactPosition !== null) expect(axis.position).toBe(exactPosition);
      },
    );

    test("needs 10 valid durations and ignores games shorter than 45 seconds", () => {
      const axis = paceAxis([
        ...repeatedRows(9, { durationSec: 600 }),
        { durationSec: 44 },
        { durationSec: -1 },
        { durationSec: "600" },
        { durationSec: null },
      ]);

      expect(axis).toMatchObject({
        value: 600,
        category: null,
        position: null,
        sampleSize: 9,
      });
    });

    test.each([
      [300.4, 300.4, "standard", 1],
      [719.6, 719.6, "standard", 99],
    ])(
      "classifies the raw %s-second mean and displays it as %s",
      (rawMean, displayedValue, category, position) => {
        const axis = paceAxis(repeatedRows(10, { durationSec: rawMean }));
        expect(axis).toMatchObject({
          value: displayedValue,
          category,
          position,
          sampleSize: 10,
        });
      },
    );

    test.each([
      [300, 301, 300.02, 1],
      [720, 719, 719.98, 99],
    ])(
      "preserves the two-decimal mean of integer-second replay durations",
      (commonDuration, outlierDuration, displayedValue, position) => {
        const axis = paceAxis([
          ...repeatedRows(49, { durationSec: commonDuration }),
          { durationSec: outlierDuration },
        ]);
        expect(axis).toMatchObject({
          value: displayedValue,
          category: "standard",
          position,
          sampleSize: 50,
        });
      },
    );
  });

  describe("matchupBalanceAxis", () => {
    test("a raw total spread within 1 point is a centered universalist", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(50, 50),
        PvT: outcomeRows(50, 50),
        PvZ: outcomeRows(49, 51),
      });
      expect(axis).toMatchObject({
        value: 1,
        category: "universalist",
        position: 50,
        leaderGap: 0,
        weakGap: 1,
        strongestMatchup: "PvP",
        weakestMatchup: "PvZ",
      });
    });

    test("a raw spread above 1 remains visibly 1.02 and is Matchup Flex", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(25, 24), // 51.0204%
        PvT: outcomeRows(5, 5),
        PvZ: outcomeRows(5, 5),
      });
      expect(axis).toMatchObject({
        value: 1.02,
        category: "matchup_flex",
        position: 49,
        leaderGap: 1.02,
        weakGap: 0,
      });
    });

    test("three decimals keep a 1.000625 raw spread visibly above the universalist boundary", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(33, 8), // 80.487805%
        PvT: outcomeRows(31, 8), // 79.487179%
        PvZ: outcomeRows(31, 8),
      });
      expect(axis).toMatchObject({
        value: 1.001,
        category: "matchup_flex",
        position: 49,
        leaderGap: 1.001,
        weakGap: 0,
      });
    });

    test("60/50/49 is a specialist at the exact 10-point leader boundary", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(60, 40),
        PvT: outcomeRows(50, 50),
        PvZ: outcomeRows(49, 51),
      });
      expect(axis).toMatchObject({
        value: 11,
        category: "specialist",
        position: 0,
        leaderGap: 10,
        weakGap: 1,
        strongestMatchup: "PvP",
        weakestMatchup: "PvZ",
      });
    });

    test("60/59/49 is a blind spot at the exact 10-point weak boundary", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(60, 40),
        PvT: outcomeRows(59, 41),
        PvZ: outcomeRows(49, 51),
      });
      expect(axis).toMatchObject({
        value: 11,
        category: "blind_spot",
        position: 100,
        leaderGap: 1,
        weakGap: 10,
        strongestMatchup: "PvP",
        weakestMatchup: "PvZ",
      });
    });

    test.each([
      [
        "specialist",
        {
          PvP: outcomeRows(3, 11), // 21.428571%
          PvT: outcomeRows(4, 31), // 11.428571%
          PvZ: outcomeRows(4, 31),
        },
        0,
        10,
        0,
      ],
      [
        "blind_spot",
        {
          PvP: outcomeRows(3, 11),
          PvT: outcomeRows(3, 11),
          PvZ: outcomeRows(4, 31),
        },
        100,
        0,
        10,
      ],
    ])(
      "recognizes a rationally exact 10-point %s boundary within 50 games",
      (category, rowsByMatchup, position, leaderGap, weakGap) => {
        const axis = matchupBalanceAxis("P", rowsByMatchup);
        expect(axis).toMatchObject({
          value: 10,
          category,
          position,
          leaderGap,
          weakGap,
        });
        expect(axis.matchups.every((matchup) => matchup.games <= 50)).toBe(true);
      },
    );

    test("a raw 9.96-point gap displays as 9.96 without reaching the endpoint", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(4, 9), // 30.7692%
        PvT: outcomeRows(36, 137), // 20.8092%
        PvZ: outcomeRows(36, 137),
      });
      expect(axis).toMatchObject({
        value: 9.96,
        category: "matchup_flex",
        position: 1,
        leaderGap: 9.96,
        weakGap: 0,
      });
      expect(axis.position).not.toBe(0);
    });

    test("three decimals keep a 9.995 raw gap visibly below the endpoint", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(29, 14), // 67.441860%
        PvT: outcomeRows(27, 20), // 57.446809%
        PvZ: outcomeRows(27, 20),
      });
      expect(axis).toMatchObject({
        value: 9.995,
        category: "matchup_flex",
        position: 1,
        leaderGap: 9.995,
        weakGap: 0,
      });
    });

    test("spreads through 5 points remain in the near-center 40-60 band", () => {
      expect(NEAR_BALANCED_MAX_SPREAD).toBe(5);
      const specialistLean = matchupBalanceAxis("P", {
        PvP: outcomeRows(54, 46),
        PvT: outcomeRows(50, 50),
        PvZ: outcomeRows(49, 51),
      });
      const blindSpotLean = matchupBalanceAxis("P", {
        PvP: outcomeRows(51, 49),
        PvT: outcomeRows(50, 50),
        PvZ: outcomeRows(46, 54),
      });
      expect(specialistLean).toMatchObject({
        value: 5,
        category: "matchup_flex",
        position: 40,
      });
      expect(blindSpotLean).toMatchObject({
        value: 5,
        category: "matchup_flex",
        position: 60,
      });
    });

    test("an exact dual-qualified gap tie uses deterministic specialist priority", () => {
      const exactTie = matchupBalanceAxis("P", {
        PvP: outcomeRows(70, 30),
        PvT: outcomeRows(60, 40),
        PvZ: outcomeRows(50, 50),
      });
      const largerWeakGap = matchupBalanceAxis("P", {
        PvP: outcomeRows(70, 30),
        PvT: outcomeRows(60, 40),
        PvZ: outcomeRows(49, 51),
      });
      expect(exactTie).toMatchObject({
        category: "specialist",
        position: 0,
        leaderGap: 10,
        weakGap: 10,
      });
      expect(largerWeakGap).toMatchObject({
        category: "blind_spot",
        position: 100,
        leaderGap: 10,
        weakGap: 11,
      });
    });

    test("other shapes are Matchup Flex and position follows the signed gap", () => {
      const specialistLean = matchupBalanceAxis("P", {
        PvP: outcomeRows(58, 42),
        PvT: outcomeRows(52, 48),
        PvZ: outcomeRows(50, 50),
      });
      const equalGap = matchupBalanceAxis("P", {
        PvP: outcomeRows(60, 40),
        PvT: outcomeRows(55, 45),
        PvZ: outcomeRows(50, 50),
      });
      const blindSpotLean = matchupBalanceAxis("P", {
        PvP: outcomeRows(60, 40),
        PvT: outcomeRows(58, 42),
        PvZ: outcomeRows(52, 48),
      });

      for (const axis of [specialistLean, equalGap, blindSpotLean]) {
        expect(axis.category).toBe("matchup_flex");
      }
      expect(specialistLean.position).toBeLessThan(50);
      expect(equalGap.position).toBe(40);
      expect(blindSpotLean.position).toBeGreaterThan(50);
    });

    test("needs 10 decided games per matchup and excludes ties from win rate", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(5, 5, 8),
        PvT: outcomeRows(5, 5, 3),
        PvZ: outcomeRows(5, 4, 20),
      });
      expect(axis).toMatchObject({
        value: null,
        category: null,
        position: null,
      });
      const rows = Object.fromEntries(axis.matchups.map((row) => [row.matchup, row]));
      expect(rows.PvP).toMatchObject({
        games: 18,
        decidedGames: 10,
        wins: 5,
        losses: 5,
        ties: 8,
        winRate: 50,
      });
      expect(rows.PvZ).toMatchObject({
        games: 29,
        decidedGames: 9,
        wins: 5,
        losses: 4,
        ties: 20,
        winRate: 55.556,
      });
    });
  });

  test("deriveArchetype deterministically names all 36 combinations", () => {
    const names = [];
    for (const repertoire of ["grinder", "adaptive", "creative"]) {
      for (const pace of ["cheeser", "standard", "late_game"]) {
        for (const matchup of [
          "specialist",
          "matchup_flex",
          "universalist",
          "blind_spot",
        ]) {
          const args = { repertoire, pace, matchup };
          const first = deriveArchetype(args);
          expect(deriveArchetype(args)).toEqual(first);
          expect(first).toMatchObject({
            key: `${repertoire}|${pace}|${matchup}`,
            name: expect.any(String),
            description: expect.any(String),
            complete: true,
          });
          names.push(first.name);
        }
      }
    }
    expect(new Set(names).size).toBe(36);
    const catalog = new Set(Object.values(ARCHETYPE_NAMES));
    for (const name of names) expect(catalog.has(name)).toBe(true);
  });
});

describe("GET /v1/me/fingerprint replay-derived contract", () => {
  let mongo;
  let db;
  let app;
  let userId;
  let sequence;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_fingerprint_replay_heuristics",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });
    app = built.app;

    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer test-token");
    expect(me.status).toBe(200);
    userId = me.body.userId;
  });

  beforeEach(async () => {
    sequence = 0;
    await db.games.deleteMany({ userId });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function getFingerprint(matchup = "PvZ") {
    return request(app)
      .get(`/v1/me/fingerprint?matchup=${encodeURIComponent(matchup)}`)
      .set("authorization", "Bearer test-token");
  }

  async function seedRows(matchup, count, options = {}) {
    const ownRace = RACE_NAME[matchup[0]];
    const opponentRace = RACE_NAME[matchup[2]];
    const docs = Array.from({ length: count }, (_, index) => {
      const serial = sequence;
      sequence += 1;
      const result = options.resultAt
        ? options.resultAt(index)
        : options.result || (index % 2 === 0 ? "Victory" : "Defeat");
      const myBuild = options.myBuildAt
        ? options.myBuildAt(index)
        : options.myBuild === undefined
          ? "Standard Build"
          : options.myBuild;
      const durationSec = options.durationAt
        ? options.durationAt(index)
        : options.durationSec === undefined
          ? 600
          : options.durationSec;
      const overrides = options.overridesAt
        ? options.overridesAt(index) || {}
        : options.overrides || {};
      const doc = {
        userId,
        gameId: `fingerprint_replay_${serial}`,
        date: new Date(Date.UTC(2026, 0, 1) + serial * 1000),
        result,
        myRace: ownRace,
        myBuild,
        durationSec,
        map: "Fingerprint Test Map",
        matchFormat: "1v1",
        playerCount: 2,
        opponent: {
          pulseId: `1-S2-1-${100000 + serial}`,
          race: opponentRace,
          leagueId: DIAMOND,
        },
        ...overrides,
      };
      if (options.omitFormatMetadata) {
        delete doc.matchFormat;
        delete doc.playerCount;
      }
      return doc;
    });
    await db.games.insertMany(docs);
  }

  async function seedMatchup(
    matchup,
    { wins = 5, losses = 5, ties = 0, builds, durationSec = 600 } = {},
  ) {
    const results = [
      ...Array(wins).fill("Victory"),
      ...Array(losses).fill("Defeat"),
      ...Array(ties).fill("Tie"),
    ];
    const repertoire = builds || ["Standard Build"];
    await seedRows(matchup, results.length, {
      resultAt: (index) => results[index],
      myBuildAt: (index) => repertoire[index % repertoire.length],
      durationSec,
    });
  }

  test("requires authentication and validates the matchup query", async () => {
    const unauthenticated = await request(app).get(
      "/v1/me/fingerprint?matchup=PvZ",
    );
    expect(unauthenticated.status).toBe(401);

    const missing = await request(app)
      .get("/v1/me/fingerprint")
      .set("authorization", "Bearer test-token");
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("bad_request");

    for (const matchup of ["Pv", "PvZvT", "Protoss", "XvY"]) {
      const response = await getFingerprint(matchup);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("bad_request");
    }
  });

  test("returns 404 until the selected matchup has 10 qualifying games", async () => {
    await seedMatchup("PvP");
    await seedMatchup("PvT");
    await seedRows("PvZ", 9);

    const response = await getFingerprint("PvZ");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_enough_games");
  });

  test("returns the complete public axes, real build counts, matchup rates, and archetype", async () => {
    await seedMatchup("PvP", { wins: 4, losses: 6 });
    await seedMatchup("PvT", { wins: 4, losses: 6 });
    await seedMatchup("PvZ", {
      wins: 5,
      losses: 5,
      builds: [
        "Build 1",
        "Build 2",
        "Build 3",
        "Build 4",
        "Build 5",
        "Build 6",
      ],
      durationSec: 300,
    });

    const response = await getFingerprint("pvz");
    expect(response.status).toBe(200);
    const fingerprint = response.body.fingerprint;

    expect(fingerprint).toMatchObject({
      matchup: "PvZ",
      race: "P",
      games: 10,
      windowGames: 50,
    });
    expect(fingerprint.axes.map((axis) => axis.key)).toEqual([
      "repertoire",
      "pace",
      "matchup_balance",
    ]);
    const axes = Object.fromEntries(
      fingerprint.axes.map((axis) => [axis.key, axis]),
    );
    expect(axes.repertoire).toEqual({
      key: "repertoire",
      label: "Build repertoire",
      position: 100,
      value: 6,
      category: "creative",
      categoryLabel: "Creative Genius",
      sampleSize: 10,
    });
    expect(axes.pace).toEqual({
      key: "pace",
      label: "Game length",
      position: 0,
      value: 300,
      category: "cheeser",
      categoryLabel: "Cheeser",
      sampleSize: 10,
    });
    expect(axes.matchup_balance).toEqual({
      key: "matchup_balance",
      label: "Matchup shape",
      position: 0,
      value: 10,
      category: "specialist",
      categoryLabel: "Matchup Specialist",
      sampleSize: 30,
    });

    expect(fingerprint.buildOrders).toEqual([
      { name: "Build 1", games: 2 },
      { name: "Build 2", games: 2 },
      { name: "Build 3", games: 2 },
      { name: "Build 4", games: 2 },
      { name: "Build 5", games: 1 },
      { name: "Build 6", games: 1 },
    ]);
    expect(fingerprint.matchupWinRates).toEqual([
      {
        matchup: "PvP",
        games: 10,
        decidedGames: 10,
        wins: 4,
        losses: 6,
        ties: 0,
        winRate: 40,
      },
      {
        matchup: "PvT",
        games: 10,
        decidedGames: 10,
        wins: 4,
        losses: 6,
        ties: 0,
        winRate: 40,
      },
      {
        matchup: "PvZ",
        games: 10,
        decidedGames: 10,
        wins: 5,
        losses: 5,
        ties: 0,
        winRate: 50,
      },
    ]);
    expect(fingerprint.matchupSummary).toEqual({
      spread: 10,
      leaderGap: 10,
      weakGap: 0,
      strongestMatchup: "PvZ",
      weakestMatchup: "PvT",
    });
    expect(fingerprint.archetype).toMatchObject({
      key: "creative|cheeser|specialist",
      name: "Lab-Crafted Ambusher",
      description: expect.any(String),
      complete: true,
    });
    expect(fingerprint.playstyle).toBe(fingerprint.archetype.name);
  });

  test("uses decided games for rates while preserving tie and total counts", async () => {
    await seedMatchup("PvP", { wins: 5, losses: 5, ties: 2 });
    await seedMatchup("PvT", { wins: 5, losses: 5, ties: 2 });
    await seedMatchup("PvZ", { wins: 5, losses: 5, ties: 2 });

    const response = await getFingerprint();
    expect(response.status).toBe(200);
    const fingerprint = response.body.fingerprint;
    for (const matchup of fingerprint.matchupWinRates) {
      expect(matchup).toMatchObject({
        games: 12,
        decidedGames: 10,
        wins: 5,
        losses: 5,
        ties: 2,
        winRate: 50,
      });
    }
    expect(
      fingerprint.axes.find((axis) => axis.key === "matchup_balance"),
    ).toMatchObject({
      category: "universalist",
      categoryLabel: "Matchup Universalist",
      position: 50,
      value: 0,
      sampleSize: 30,
    });
  });

  test("uses the latest 50 qualifying 1v1 games and filters resumed, team, wrong-race, and unknown-format rows", async () => {
    await seedRows("PvZ", 5, {
      myBuildAt: (index) => `Old Build ${index + 1}`,
      durationSec: 120,
    });
    await seedRows("PvZ", 50, {
      myBuild: "Current Build",
      durationSec: 720,
    });
    await seedMatchup("PvP");
    await seedMatchup("PvT");
    await seedRows("PvZ", 1, {
      myBuild: "Resumed Build",
      durationSec: 60,
      overrides: { isResumedFromReplay: true },
    });
    await seedRows("PvZ", 1, {
      myBuild: "Team Build",
      durationSec: 60,
      overrides: { matchFormat: "2v2", playerCount: 4 },
    });
    await seedRows("PvZ", 1, {
      myBuild: "Wrong Race Build",
      durationSec: 60,
      overrides: { myRace: "Zerg" },
    });
    await seedRows("PvZ", 1, {
      myBuild: "Unknown Format Build",
      durationSec: 60,
      omitFormatMetadata: true,
    });

    const response = await getFingerprint();
    expect(response.status).toBe(200);
    const fingerprint = response.body.fingerprint;
    expect(fingerprint.games).toBe(50);
    expect(fingerprint.buildOrders).toEqual([
      { name: "Current Build", games: 50 },
    ]);
    expect(
      fingerprint.axes.find((axis) => axis.key === "repertoire"),
    ).toMatchObject({
      value: 1,
      category: "grinder",
      categoryLabel: "Consistent Grinder",
      position: 0,
      sampleSize: 50,
    });
    expect(
      fingerprint.axes.find((axis) => axis.key === "pace"),
    ).toMatchObject({
      value: 720,
      category: "late_game",
      categoryLabel: "Late-Game Specialist",
      position: 100,
      sampleSize: 50,
    });
  });

  test("keeps raw values but withholds build and pace categories below 10 usable samples", async () => {
    await seedMatchup("PvP");
    await seedMatchup("PvT");
    await seedRows("PvZ", 10, {
      myBuildAt: (index) =>
        index === 9 ? "Unclassified" : `Build ${(index % 3) + 1}`,
      durationAt: (index) => (index === 9 ? 44 : 600),
    });

    const response = await getFingerprint();
    expect(response.status).toBe(200);
    const fingerprint = response.body.fingerprint;
    const axes = Object.fromEntries(
      fingerprint.axes.map((axis) => [axis.key, axis]),
    );
    expect(axes.repertoire).toMatchObject({
      position: null,
      value: 3,
      category: null,
      categoryLabel: null,
      sampleSize: 9,
    });
    expect(axes.pace).toMatchObject({
      position: null,
      value: 600,
      category: null,
      categoryLabel: null,
      sampleSize: 9,
    });
    expect(fingerprint.buildOrders).toEqual([
      { name: "Build 1", games: 3 },
      { name: "Build 2", games: 3 },
      { name: "Build 3", games: 3 },
    ]);
    expect(fingerprint.archetype).toMatchObject({
      key: "partial:?|?|universalist",
      name: "Matchup Universalist",
      complete: false,
    });
    expect(fingerprint.playstyle).toBe(fingerprint.archetype.name);
  });

  test("is deterministic across repeated requests", async () => {
    await seedMatchup("PvP");
    await seedMatchup("PvT");
    await seedMatchup("PvZ");

    const first = await getFingerprint();
    const second = await getFingerprint();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.fingerprint).toEqual(first.body.fingerprint);
  });
});
