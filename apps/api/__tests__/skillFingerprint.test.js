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
  ARCHETYPE_CORE_NAMES,
  ARCHETYPE_NAMES,
  MATCHUP_ARCHETYPE_PREFIXES,
  MODERATE_MATCHUP_ANCHOR,
  deriveArchetype,
  matchupBalanceAxis,
  paceAxis,
  repertoireAxis,
  repertoireCategory,
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

function rowsWithBuildCounts(counts) {
  return counts.flatMap((count, index) =>
    repeatedRows(count, { myBuild: `Build ${index + 1}` }),
  );
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
      [1, "one_trick", "Build-Order One-Trick", 0],
      [2, "signature", "Signature Pilot", 6],
      [3, "grinder", "Consistent Grinder", 18],
      [5, "grinder", "Consistent Grinder", 41],
      [6, "adaptive", "Adaptive Strategist", 53],
      [9, "adaptive", "Adaptive Strategist", 88],
      [10, "creative", "Creative Genius", 100],
    ])(
      "%i equally used builds maps to %s",
      (count, category, _categoryLabel, position) => {
        const axis = repertoireAxis(rowsWithBuildCounts(Array(count).fill(10)));
        expect(axis).toMatchObject({
          value: count,
          category,
          position,
          sampleSize: count * 10,
          summary: {
            distinctBuilds: count,
            effectiveBuilds: count,
          },
        });
        expect(axis.builds).toHaveLength(count);
      },
    );

    test.each([
      [1.5, "one_trick"],
      [1.500001, "signature"],
      [2.5, "signature"],
      [2.500001, "grinder"],
      [5, "grinder"],
      [5.000001, "adaptive"],
      [9.999999, "adaptive"],
      [10, "creative"],
    ])("classifies the raw effective-count boundary %s as %s", (value, category) => {
      expect(repertoireCategory(value)).toBe(category);
    });

    test("reports 14 observed builds as 8.347826 effective for a concentrated distribution", () => {
      const counts = [13, 5, 4, 4, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2];
      const axis = repertoireAxis(rowsWithBuildCounts(counts));
      expect(axis).toMatchObject({
        value: 8.347826,
        category: "adaptive",
        sampleSize: 48,
        summary: {
          distinctBuilds: 14,
          effectiveBuilds: 8.347826,
        },
      });
    });

    test("effective diversity stays between one and the distinct build count", () => {
      for (const counts of [[10], [9, 1], [8, 4, 2, 1], [5, 5, 5, 5]]) {
        const axis = repertoireAxis(rowsWithBuildCounts(counts));
        expect(axis.summary.effectiveBuilds).toBeGreaterThanOrEqual(1);
        expect(axis.summary.effectiveBuilds).toBeLessThanOrEqual(
          axis.summary.distinctBuilds,
        );
      }
    });

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
        summary: { distinctBuilds: 3, effectiveBuilds: 3 },
      });
      expect(axis.builds).toEqual([
        { name: "Build 1", games: 3 },
        { name: "Build 2", games: 3 },
        { name: "Build 3", games: 3 },
      ]);
    });
  });

  describe("paceAxis", () => {
    test("uses the exact [5:00, 7:00] timing window and strict outer boundaries", () => {
      const axis = paceAxis([
        ...repeatedRows(4, { durationSec: 299 }),
        ...repeatedRows(8, { durationSec: 300 }),
        ...repeatedRows(8, { durationSec: 420 }),
        ...repeatedRows(4, { durationSec: 421 }),
      ]);
      expect(axis).toMatchObject({
        category: "flexible",
        sampleSize: 24,
        summary: {
          belowFive: { games: 4, percent: 16.67 },
          fiveToSeven: { games: 16, percent: 66.67 },
          aboveSeven: { games: 4, percent: 16.67 },
          sevenToFifteen: { games: 4, percent: 16.67 },
          aboveFifteen: { games: 0, percent: 0 },
        },
      });
      // The mixed boundary probe above is below the 80% timing gate. An exact
      // 80% sample proves the gate without rounding its 8/10 cross-product.
      const exact = paceAxis([
        ...repeatedRows(4, { durationSec: 300 }),
        ...repeatedRows(4, { durationSec: 420 }),
        ...repeatedRows(2, { durationSec: 421 }),
      ]);
      expect(exact.category).toBe("timing_attacker");
    });

    test("Two-Speed wins precedence at the exact 25% + 25% cross-product gates", () => {
      const exact = paceAxis([
        ...repeatedRows(5, { durationSec: 299 }),
        ...repeatedRows(10, { durationSec: 420 }),
        ...repeatedRows(5, { durationSec: 901 }),
      ]);
      const below = paceAxis([
        ...repeatedRows(4, { durationSec: 299 }),
        ...repeatedRows(11, { durationSec: 420 }),
        ...repeatedRows(5, { durationSec: 901 }),
      ]);
      expect(exact).toMatchObject({
        category: "two_speed",
        categoryLabel: "Two-Speed Player",
        summary: {
          belowFive: { games: 5, percent: 25 },
          aboveFifteen: { games: 5, percent: 25 },
        },
      });
      expect(below.category).toBe("flexible");
    });

    test("Late-Game Master wins at exactly 80% strictly above 15:00", () => {
      const exact = paceAxis([
        ...repeatedRows(8, { durationSec: 901 }),
        ...repeatedRows(2, { durationSec: 900 }),
      ]);
      const below = paceAxis([
        ...repeatedRows(7, { durationSec: 901 }),
        ...repeatedRows(3, { durationSec: 900 }),
      ]);
      expect(exact).toMatchObject({
        category: "late_game_master",
        categoryLabel: "Late-Game Master",
        summary: {
          aboveFifteen: { games: 8, percent: 80 },
          sevenToFifteen: { games: 2, percent: 20 },
        },
      });
      expect(below.category).toBe("mid_late_master");
    });

    test("Mid/Late-Game Master wins at exactly 80% strictly above 7:00", () => {
      const exact = paceAxis([
        ...repeatedRows(8, { durationSec: 421 }),
        ...repeatedRows(2, { durationSec: 420 }),
      ]);
      const below = paceAxis([
        ...repeatedRows(7, { durationSec: 421 }),
        ...repeatedRows(3, { durationSec: 420 }),
      ]);
      expect(exact).toMatchObject({
        category: "mid_late_master",
        categoryLabel: "Mid/Late-Game Master",
        summary: { aboveSeven: { games: 8, percent: 80 } },
      });
      expect(below.category).toBe("flexible");
    });

    test("fallback mean categories use <5:00, inclusive 5:00-15:00, and >15:00", () => {
      const cheeser = paceAxis([
        ...repeatedRows(5, { durationSec: 299 }),
        ...repeatedRows(5, { durationSec: 300 }),
      ]);
      const exactlyFive = paceAxis([
        ...repeatedRows(5, { durationSec: 180 }),
        ...repeatedRows(5, { durationSec: 420 }),
      ]);
      const exactlyFifteen = paceAxis([
        ...repeatedRows(5, { durationSec: 420 }),
        ...repeatedRows(5, { durationSec: 1380 }),
      ]);
      const overFifteen = paceAxis([
        ...repeatedRows(5, { durationSec: 420 }),
        ...repeatedRows(5, { durationSec: 1382 }),
      ]);
      expect(cheeser).toMatchObject({ category: "cheeser", value: 299.5 });
      expect(exactlyFive).toMatchObject({ category: "flexible", value: 300 });
      expect(exactlyFifteen).toMatchObject({ category: "flexible", value: 900 });
      expect(overFifteen).toMatchObject({ category: "late_game", value: 901 });
    });

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
        summary: {
          averageSec: 600,
          medianSec: 600,
          belowFive: { games: 0, percent: 0 },
          fiveToSeven: { games: 0, percent: 0 },
          aboveSeven: { games: 9, percent: 100 },
          sevenToFifteen: { games: 9, percent: 100 },
          aboveFifteen: { games: 0, percent: 0 },
        },
      });
    });

    test("keeps an all-invalid duration distribution unavailable instead of inventing zero percentages", () => {
      const axis = paceAxis(repeatedRows(10, { durationSec: 44 }));
      expect(axis).toMatchObject({
        value: null,
        category: null,
        position: null,
        sampleSize: 0,
        summary: {
          averageSec: null,
          medianSec: null,
          belowFive: { games: 0, percent: null },
          fiveToSeven: { games: 0, percent: null },
          aboveSeven: { games: 0, percent: null },
          sevenToFifteen: { games: 0, percent: null },
          aboveFifteen: { games: 0, percent: null },
        },
      });
    });

    test("preserves two-decimal average and median values in the public evidence", () => {
      const axis = paceAxis([
        ...repeatedRows(9, { durationSec: 500 }),
        { durationSec: 501 },
      ]);
      expect(axis).toMatchObject({
        value: 500.1,
        category: "mid_late_master",
        sampleSize: 10,
        summary: { averageSec: 500.1, medianSec: 500 },
      });
    });
  });

  describe("matchupBalanceAxis", () => {
    test("a raw total spread within 5 points is a centered universalist", () => {
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
        signedEdge: -1,
        tierScore: 0,
        strongestMatchup: "PvP",
        weakestMatchup: "PvZ",
      });
    });

    test("a strength-side spread above 5 is Matchup Edge", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(56, 44),
        PvT: outcomeRows(5, 5),
        PvZ: outcomeRows(5, 5),
      });
      expect(axis).toMatchObject({
        value: 6,
        category: "matchup_edge",
        position: 40,
        leaderGap: 6,
        weakGap: 0,
        signedEdge: 6,
        tierScore: 1,
      });
    });

    test("a weakness-side spread above 5 is Matchup Hurdle", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(50, 50),
        PvT: outcomeRows(50, 50),
        PvZ: outcomeRows(44, 56),
      });
      expect(axis).toMatchObject({
        value: 6,
        category: "matchup_hurdle",
        position: 60,
        leaderGap: 0,
        weakGap: 6,
        signedEdge: -6,
        tierScore: -1,
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
        signedEdge: 10,
        tierScore: 2,
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
        signedEdge: -10,
        tierScore: -2,
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
          signedEdge: category === "specialist" ? 10 : -10,
          tierScore: category === "specialist" ? 2 : -2,
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
        category: "matchup_edge",
        position: 1,
        leaderGap: 9.96,
        weakGap: 0,
        signedEdge: 9.96,
        tierScore: 1,
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
        category: "matchup_edge",
        position: 1,
        leaderGap: 9.995,
        weakGap: 0,
        signedEdge: 9.995,
        tierScore: 1,
      });
    });

    test("all three rates within 5 points select the exact universalist tier", () => {
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
        category: "universalist",
        position: 50,
        tierScore: 0,
      });
      expect(blindSpotLean).toMatchObject({
        value: 5,
        category: "universalist",
        position: 50,
        tierScore: 0,
      });
    });

    test("7.5-point moderate gaps land on the 25/75 score anchors", () => {
      expect(MODERATE_MATCHUP_ANCHOR).toBe(7.5);
      const edge = matchupBalanceAxis("P", {
        PvP: outcomeRows(23, 17),
        PvT: outcomeRows(20, 20),
        PvZ: outcomeRows(20, 20),
      });
      const hurdle = matchupBalanceAxis("P", {
        PvP: outcomeRows(20, 20),
        PvT: outcomeRows(20, 20),
        PvZ: outcomeRows(17, 23),
      });
      expect(edge).toMatchObject({
        category: "matchup_edge",
        position: 25,
        signedEdge: 7.5,
        tierScore: 1,
      });
      expect(hurdle).toMatchObject({
        category: "matchup_hurdle",
        position: 75,
        signedEdge: -7.5,
        tierScore: -1,
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
        signedEdge: 10,
        tierScore: 2,
      });
      expect(largerWeakGap).toMatchObject({
        category: "blind_spot",
        position: 100,
        leaderGap: 10,
        weakGap: 11,
        signedEdge: -11,
        tierScore: -2,
      });
    });

    test("moderate shapes choose edge or hurdle and ties favor edge", () => {
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

      expect(specialistLean).toMatchObject({
        category: "matchup_edge",
        position: 40,
        signedEdge: 6,
        tierScore: 1,
      });
      expect(equalGap).toMatchObject({
        category: "matchup_edge",
        position: 49,
        signedEdge: 5,
        tierScore: 1,
      });
      expect(blindSpotLean).toMatchObject({
        category: "matchup_hurdle",
        position: 60,
        signedEdge: -6,
        tierScore: -1,
      });
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
        signedEdge: null,
        tierScore: null,
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

  test("deriveArchetype deterministically names all 175 combinations", () => {
    const names = [];
    for (const repertoire of Object.keys(ARCHETYPE_CORE_NAMES)) {
      for (const pace of Object.keys(ARCHETYPE_CORE_NAMES[repertoire])) {
        for (const matchup of Object.keys(MATCHUP_ARCHETYPE_PREFIXES)) {
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
    expect(names).toHaveLength(175);
    expect(new Set(names).size).toBe(175);
    expect(ARCHETYPE_NAMES).toHaveProperty(
      "creative|two_speed|blind_spot",
      "Fault-Line Chaos Switchboard",
    );
    expect(ARCHETYPE_NAMES).toHaveProperty(
      "one_trick|timing_attacker|specialist",
      "Apex Clockwork Attacker",
    );
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
        "Build 7",
        "Build 8",
        "Build 9",
        "Build 10",
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
      value: 10,
      category: "creative",
      categoryLabel: "Creative Genius",
      sampleSize: 10,
    });
    expect(axes.pace).toEqual({
      key: "pace",
      label: "Game length",
      position: 0,
      value: 300,
      category: "timing_attacker",
      categoryLabel: "Timing Attacker",
      sampleSize: 10,
    });
    expect(axes.matchup_balance).toEqual({
      key: "matchup_balance",
      label: "Matchup shape",
      position: 0,
      value: 10,
      category: "specialist",
      categoryLabel: "Matchup Master",
      sampleSize: 30,
    });

    expect(fingerprint.repertoireSummary).toEqual({
      distinctBuilds: 10,
      effectiveBuilds: 10,
    });
    expect(fingerprint.paceSummary).toEqual({
      averageSec: 300,
      medianSec: 300,
      belowFive: { games: 0, percent: 0 },
      fiveToSeven: { games: 10, percent: 100 },
      aboveSeven: { games: 0, percent: 0 },
      sevenToFifteen: { games: 0, percent: 0 },
      aboveFifteen: { games: 0, percent: 0 },
    });

    expect(fingerprint.buildOrders).toEqual([
      { name: "Build 1", games: 1 },
      { name: "Build 10", games: 1 },
      { name: "Build 2", games: 1 },
      { name: "Build 3", games: 1 },
      { name: "Build 4", games: 1 },
      { name: "Build 5", games: 1 },
      { name: "Build 6", games: 1 },
      { name: "Build 7", games: 1 },
      { name: "Build 8", games: 1 },
      { name: "Build 9", games: 1 },
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
      signedEdge: 10,
      tierScore: 2,
      strongestMatchup: "PvZ",
      weakestMatchup: "PvT",
    });
    expect(fingerprint.archetype).toMatchObject({
      key: "creative|timing_attacker|specialist",
      name: "Apex Timing Inventor",
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
      categoryLabel: "All-Matchup Ace",
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
      durationSec: 900,
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
      category: "one_trick",
      categoryLabel: "Build-Order One-Trick",
      position: 0,
      sampleSize: 50,
    });
    expect(
      fingerprint.axes.find((axis) => axis.key === "pace"),
    ).toMatchObject({
      value: 900,
      category: "mid_late_master",
      categoryLabel: "Mid/Late-Game Master",
      position: 100,
      sampleSize: 50,
    });
    expect(fingerprint.repertoireSummary).toEqual({
      distinctBuilds: 1,
      effectiveBuilds: 1,
    });
    expect(fingerprint.paceSummary).toEqual({
      averageSec: 900,
      medianSec: 900,
      belowFive: { games: 0, percent: 0 },
      fiveToSeven: { games: 0, percent: 0 },
      aboveSeven: { games: 50, percent: 100 },
      sevenToFifteen: { games: 50, percent: 100 },
      aboveFifteen: { games: 0, percent: 0 },
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
      name: "All-Matchup Ace",
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
