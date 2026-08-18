// @ts-nocheck
"use strict";

/**
 * Replay-derived Skill Fingerprint: pure boundaries plus the authenticated
 * route contract through the real app wiring and an in-memory Mongo server.
 *
 * Two regressions have dedicated route tests and should not be deleted without
 * a replacement: the date range must change the result, and the three matchups
 * of one race must be able to produce different archetypes.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const {
  COLLECTION_NAME: FINGERPRINT_CALIBRATION_COLLECTION,
  MIN_POPULATION_SAMPLE,
  SCHEMA_VERSION: FINGERPRINT_CALIBRATION_VERSION,
} = require("../src/services/fingerprintPopulationCalibration");
const {
  AXIS_ORDER,
  AXIS_VOCABULARY,
  ARCHETYPE_OVERRIDES,
  CREATIVE_MIN_EFFECTIVE_BUILDS,
  GRINDER_MAX_EFFECTIVE_BUILDS,
  MIN_MATCHUP_GAMES,
  MODERATE_MATCHUP_ANCHOR,
  NEUTRAL_ARCHETYPE_NAME,
  ONE_TRICK_MAX_EFFECTIVE_BUILDS,
  RANGE_ROW_CAP,
  SIGNATURE_MAX_EFFECTIVE_BUILDS,
  TAXONOMY_FALLBACK_METHOD,
  WINDOW_GAMES,
  axisDistinctiveness,
  buildTaxonomy,
  calibrateAxisResult,
  deriveArchetype,
  fingerprintFilters,
  matchupBalanceAxis,
  matchupEdgeAxis,
  paceAxis,
  perplexity,
  repertoireAxis,
  repertoireCategory,
} = require("../src/services/skillFingerprint");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_fingerprint" };
    throw new Error("invalid");
  }),
}));

const RACE_NAME = { P: "Protoss", T: "Terran", Z: "Zerg" };
const DIAMOND = 4;

function repeatedRows(count, fields) {
  return Array.from({ length: count }, () => ({ ...fields }));
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

/** Rows spread evenly over `distinct` build names. */
function uniformBuildRows(distinct, total) {
  return Array.from({ length: total }, (_, i) => ({
    myBuild: `Build ${(i % distinct) + 1}`,
  }));
}

function durationRows(durations) {
  return durations.map((durationSec) => ({ durationSec }));
}

/** Matchup rows shaped the way `matchupBalanceAxis` returns them. */
function edgeRows(spec) {
  return Object.entries(spec).map(([matchup, [wins, losses]]) => ({
    matchup,
    wins,
    losses,
    decidedGames: wins + losses,
    games: wins + losses,
    ties: 0,
    winRate: wins + losses ? (100 * wins) / (wins + losses) : null,
  }));
}

// ---------------------------------------------------------------------------
// Filter narrowing
// ---------------------------------------------------------------------------

describe("fingerprintFilters", () => {
  const since = new Date("2026-01-01T00:00:00.000Z");
  const until = new Date("2026-06-01T00:00:00.000Z");

  test("keeps cohort filters, forces the matchup, and drops axis-breaking ones", () => {
    const { filters, strippedFilters } = fingerprintFilters(
      {
        since,
        until,
        race: "Z",
        oppRace: "T",
        map: "ley lines",
        mapPool: "nonladder",
        regions: ["EU"],
        excludeTooShort: true,
        build: "4-Gate",
        mmrMin: 3000,
        mmrMax: 5000,
        oppStrategy: "Proxy Rax",
        leak: "Supply Blocked",
        macroMin: 60,
        macroMax: 80,
        minMinutes: 20,
        maxMinutes: 40,
        groupByRacePlayed: true,
        gameSize: "team",
      },
      "PvZ",
    );

    // Kept verbatim.
    expect(filters).toMatchObject({
      since,
      until,
      map: "ley lines",
      mapPool: "nonladder",
      regions: ["EU"],
      excludeTooShort: true,
    });
    // Owned by the card, not the filter bar.
    expect(filters.race).toBe("P");
    expect(filters.oppRace).toBe("Z");
    expect(filters.gameSize).toBe("1v1");
    // Dropped entirely.
    for (const key of [
      "build",
      "mmrMin",
      "mmrMax",
      "oppStrategy",
      "leak",
      "macroMin",
      "macroMax",
      // Game length is stripped for the sharpest circularity reason of
      // the lot: an axis of this fingerprint is computed FROM replay
      // duration, so a 20-40 minute cohort would report "Late Game
      // Master" for every player alive.
      "minMinutes",
      "maxMinutes",
      "groupByRacePlayed",
    ]) {
      expect(filters[key]).toBeUndefined();
    }
    expect(strippedFilters).toEqual(
      expect.arrayContaining([
        "build",
        "mmr_min",
        "mmr_max",
        "opp_strategy",
        "leak",
        "macro_min",
        "macro_max",
        "min_minutes",
        "max_minutes",
        "race",
        "opp_race",
      ]),
    );
  });

  test("with no filters yields only the matchup constraints tickerFacts relies on", () => {
    const { filters, strippedFilters } = fingerprintFilters(undefined, "PvZ");
    expect(filters).toEqual({ race: "P", oppRace: "Z", gameSize: "1v1" });
    expect(strippedFilters).toEqual([]);
  });

  test("a race filter matching the selected matchup is not reported as dropped", () => {
    const { strippedFilters } = fingerprintFilters(
      { race: "P", oppRace: "Z" },
      "PvZ",
    );
    expect(strippedFilters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure replay heuristics
// ---------------------------------------------------------------------------

describe("skill fingerprint pure replay heuristics", () => {
  describe("perplexity", () => {
    test.each([1, 2, 3, 5, 10])(
      "a uniform %i-build distribution has exactly that effective count",
      (k) => {
        expect(perplexity(Array(k).fill(4))).toBeCloseTo(k, 9);
      },
    );

    test("concentration collapses the effective count regardless of tail length", () => {
      // 88 games of one build plus nine one-offs: ten distinct names, but the
      // player is not playing ten builds.
      expect(perplexity([88, ...Array(9).fill(1.33)])).toBeLessThan(2);
    });
  });

  describe("repertoireAxis", () => {
    test.each([
      [1, "one_trick"],
      [2, "signature"],
      [3, "grinder"],
      [5, "grinder"],
      [6, "adaptive"],
      [10, "creative"],
    ])("%i evenly played builds classify as %s", (distinct, category) => {
      // Always clear MIN_BUILD_SAMPLE, and keep the count a multiple of
      // `distinct` so the distribution stays exactly uniform.
      const axis = repertoireAxis(uniformBuildRows(distinct, distinct * 10));
      expect(axis.category).toBe(category);
      expect(axis.detail.effectiveBuilds).toBeCloseTo(distinct, 1);
    });

    test.each([
      [ONE_TRICK_MAX_EFFECTIVE_BUILDS, "one_trick"],
      [ONE_TRICK_MAX_EFFECTIVE_BUILDS + 0.000001, "signature"],
      [SIGNATURE_MAX_EFFECTIVE_BUILDS, "signature"],
      [SIGNATURE_MAX_EFFECTIVE_BUILDS + 0.000001, "grinder"],
      [GRINDER_MAX_EFFECTIVE_BUILDS, "grinder"],
      [GRINDER_MAX_EFFECTIVE_BUILDS + 0.000001, "adaptive"],
      [CREATIVE_MIN_EFFECTIVE_BUILDS - 0.000001, "adaptive"],
      [CREATIVE_MIN_EFFECTIVE_BUILDS, "creative"],
    ])("classifies unrounded Shannon diversity %s as %s", (value, category) => {
      expect(repertoireCategory(value)).toBe(category);
    });

    test("reports distinct count separately from Shannon effective diversity", () => {
      const counts = [18, 9, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1];
      const axis = repertoireAxis(rowsWithBuildCounts(counts));
      expect(axis).toMatchObject({
        value: 14,
        category: "adaptive",
        sampleSize: 50,
        summary: {
          method: "shannon_perplexity",
          formula: "exp(-sum(p_i * ln(p_i)))",
          distinctBuilds: 14,
          effectiveBuilds: 8.350723,
        },
      });
    });

    test("ten builds with one dominant is signature, not creative", () => {
      const rows = [
        ...repeatedRows(88, { myBuild: "Bread and Butter" }),
        ...Array.from({ length: 9 }, (_, i) => ({ myBuild: `One Off ${i}` })),
      ];
      const axis = repertoireAxis(rows);
      expect(axis.value).toBe(10);
      expect(axis.category).toBe("signature");
      expect(axis.detail.effectiveBuilds).toBeLessThan(2);
      expect(axis.detail.topBuildShare).toBeGreaterThan(0.85);
    });

    test("value stays the raw distinct count that tickerFacts renders", () => {
      const axis = repertoireAxis(uniformBuildRows(4, 20));
      expect(axis.value).toBe(4);
      expect(Number.isInteger(axis.value)).toBe(true);
    });

    test("build identity is case-folded and unusable names are dropped", () => {
      const rows = [
        ...repeatedRows(6, { myBuild: "Standard Build" }),
        ...repeatedRows(6, { myBuild: "standard build" }),
        ...repeatedRows(4, { myBuild: "PvZ - Game Too Short" }),
        ...repeatedRows(2, { myBuild: "Unclassified" }),
        ...repeatedRows(2, { myBuild: "unknown" }),
      ];
      const axis = repertoireAxis(rows);
      expect(axis.value).toBe(1);
      expect(axis.sampleSize).toBe(12);
      expect(axis.builds).toEqual([{ name: "Standard Build", games: 12 }]);
    });

    test("below the build sample floor it reports a reason instead of a category", () => {
      const axis = repertoireAxis(uniformBuildRows(2, 9));
      expect(axis).toMatchObject({
        category: null,
        position: null,
        reason: "needs_more_classified_builds",
        needed: 10,
        sampleSize: 9,
        summary: { distinctBuilds: 2 },
      });
    });
  });

  describe("paceAxis", () => {
    test("uses the exact [5:00, 10:00] timing window and strict outer boundaries", () => {
      const axis = paceAxis([
        ...repeatedRows(6, { durationSec: 299 }),
        ...repeatedRows(8, { durationSec: 300 }),
        ...repeatedRows(6, { durationSec: 600 }),
        ...repeatedRows(4, { durationSec: 601 }),
      ]);
      expect(axis).toMatchObject({
        category: "flexible",
        sampleSize: 24,
        summary: {
          belowFive: { games: 6, percent: 25 },
          fiveToTen: { games: 14, percent: 58.33 },
          aboveTen: { games: 4, percent: 16.67 },
          tenToFifteen: { games: 4, percent: 16.67 },
          aboveFifteen: { games: 0, percent: 0 },
        },
      });
      // The mixed boundary probe above is below the 80% timing gate. An exact
      // 80% sample proves the gate without rounding its 8/10 cross-product.
      const exact = paceAxis([
        ...repeatedRows(4, { durationSec: 300 }),
        ...repeatedRows(4, { durationSec: 600 }),
        ...repeatedRows(2, { durationSec: 601 }),
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
          tenToFifteen: { games: 2, percent: 20 },
        },
      });
      expect(below.category).toBe("mid_late_master");
    });

    test("Mid-Game Maestro wins at exactly 80% strictly above 10:00", () => {
      const exact = paceAxis([
        ...repeatedRows(8, { durationSec: 601 }),
        ...repeatedRows(2, { durationSec: 600 }),
      ]);
      const below = paceAxis([
        ...repeatedRows(7, { durationSec: 601 }),
        ...repeatedRows(3, { durationSec: 600 }),
      ]);
      expect(exact).toMatchObject({
        category: "mid_late_master",
        categoryLabel: "Mid-Game Maestro",
        summary: { aboveTen: { games: 8, percent: 80 } },
      });
      // 70% over 10:00 clears no 80% gate, and the mean lands past 10:00.
      expect(below.category).toBe("late_game");
    });

    test("fallback mean categories use <5:00, inclusive 5:00-10:00, and >10:00", () => {
      const cheeser = paceAxis([
        ...repeatedRows(5, { durationSec: 299 }),
        ...repeatedRows(5, { durationSec: 300 }),
      ]);
      const exactlyFive = paceAxis([
        ...repeatedRows(5, { durationSec: 180 }),
        ...repeatedRows(5, { durationSec: 420 }),
      ]);
      const exactlyTen = paceAxis([
        ...repeatedRows(5, { durationSec: 500 }),
        ...repeatedRows(5, { durationSec: 700 }),
      ]);
      const overTen = paceAxis([
        ...repeatedRows(5, { durationSec: 500 }),
        ...repeatedRows(5, { durationSec: 702 }),
      ]);
      expect(cheeser).toMatchObject({ category: "cheeser", value: 299.5 });
      expect(exactlyFive).toMatchObject({ category: "flexible", value: 300 });
      expect(exactlyTen).toMatchObject({ category: "flexible", value: 600 });
      expect(overTen).toMatchObject({ category: "late_game", value: 601 });
    });

    test("a mostly-late distribution clears the broader mid/late mastery gate", () => {
      const axis = paceAxis(
        durationRows([...Array(9).fill(1200), ...Array(3).fill(700)]),
      );
      expect(axis.category).toBe("mid_late_master");
      expect(axis.position).toBeGreaterThan(50);
    });

    test("a uniformly ten-minute distribution sits inside the timing window", () => {
      const axis = paceAxis(durationRows(Array(12).fill(600)));
      expect(axis.category).toBe("timing_attacker");
      expect(axis.position).toBe(50);
    });

    test("a split of early and late games is two_speed, not flexible", () => {
      // The mislabel this axis was rewritten to remove: the mean of these is
      // ~12 minutes, which the old implementation called a Flexible Pacer.
      const axis = paceAxis(
        durationRows([
          ...Array(9).fill(240),
          ...Array(2).fill(600),
          ...Array(9).fill(1500),
        ]),
      );
      expect(axis.category).toBe("two_speed");
      expect(axis.detail.belowFive.percent).toBeGreaterThanOrEqual(25);
      expect(axis.detail.aboveFifteen.percent).toBeGreaterThanOrEqual(25);
    });

    test("an 80% under-five distribution is Cheeser before a long outlier distorts its mean", () => {
      const axis = paceAxis(
        durationRows([...Array(19).fill(240), 1500]),
      );
      expect(axis).toMatchObject({
        category: "cheeser",
        value: 303,
        detail: {
          classificationMethod: "dominant_under_five",
          belowFive: { games: 19, percent: 95 },
        },
      });
    });

    test("the under-five distribution gate is exact at 80%", () => {
      const exact = paceAxis(
        durationRows([...Array(8).fill(240), ...Array(2).fill(600)]),
      );
      const below = paceAxis(
        durationRows([...Array(7).fill(240), ...Array(3).fill(600)]),
      );
      expect(exact).toMatchObject({
        category: "cheeser",
        detail: { classificationMethod: "dominant_under_five" },
      });
      expect(below).toMatchObject({
        category: "flexible",
        detail: { classificationMethod: "mean_middle" },
      });
    });

    test("5:00 and 10:00 are both inside the timing-attacker window", () => {
      const atEdges = paceAxis(durationRows(Array(12).fill(600)));
      expect(atEdges.category).toBe("timing_attacker");
      expect(atEdges.detail.fiveToTen.percent).toBe(100);
      expect(atEdges.detail.aboveTen.percent).toBe(0);
      const atFive = paceAxis(durationRows(Array(12).fill(300)));
      expect(atFive.category).toBe("timing_attacker");
      expect(atFive.detail.belowFive.percent).toBe(0);
    });

    test("games under 45 seconds never reach the distribution", () => {
      const axis = paceAxis(
        durationRows([...Array(10).fill(600), 10, 30, 44]),
      );
      expect(axis.sampleSize).toBe(10);
    });

    test("below the duration floor it reports a reason instead of a category", () => {
      const axis = paceAxis(durationRows(Array(9).fill(600)));
      expect(axis).toMatchObject({
        category: null,
        position: null,
        sampleSize: 9,
        reason: "needs_more_timed_games",
        needed: 10,
        summary: {
          averageSec: 600,
          medianSec: 600,
          belowFive: { games: 0, percent: 0 },
          fiveToTen: { games: 9, percent: 100 },
          aboveTen: { games: 0, percent: 0 },
          tenToFifteen: { games: 0, percent: 0 },
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
          fiveToTen: { games: 0, percent: null },
          aboveTen: { games: 0, percent: null },
          tenToFifteen: { games: 0, percent: null },
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
        category: "timing_attacker",
        sampleSize: 10,
        summary: { averageSec: 500.1, medianSec: 500 },
      });
    });
  });

  describe("matchupEdgeAxis", () => {
    test("clearly above the other two reaches Matchup Specialist", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [5, 5], PvT: [5, 5], PvZ: [8, 2] }),
      );
      expect(axis.category).toBe("specialist");
      expect(axis.value).toBe(30);
      expect(axis.position).toBe(0);
      expect(axis.detail.tierScore).toBe(2);
      expect(axis.detail.comparedAgainst).toEqual(["PvP", "PvT"]);
    });

    test("clearly below the other two reaches Matchup Blind Spot", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [8, 2], PvT: [8, 2], PvZ: [2, 8] }),
      );
      expect(axis.category).toBe("blind_spot");
      expect(axis.position).toBe(100);
      expect(axis.detail.tierScore).toBe(-2);
    });

    test("all three matchup rates within five points is Universalist", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [5, 5], PvT: [5, 5], PvZ: [6, 6] }),
      );
      expect(axis.category).toBe("universalist");
      expect(axis.position).toBe(50);
      expect(axis.detail.allMatchupSpread).toBe(0);
    });

    test("7.5 points is the moderate Matchup Edge score anchor", () => {
      // PvZ 60%, others 50% and 55% -> mean 52.5, delta exactly 7.5.
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [10, 10], PvT: [11, 9], PvZ: [12, 8] }),
      );
      expect(axis.value).toBe(MODERATE_MATCHUP_ANCHOR);
      expect(axis.category).toBe("matchup_edge");
      expect(axis.position).toBe(25);
      expect(axis.detail.tierScore).toBe(1);
    });

    test("-7.5 points is the moderate Matchup Hurdle score anchor", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [20, 20], PvT: [20, 20], PvZ: [17, 23] }),
      );
      expect(axis).toMatchObject({
        value: -7.5,
        category: "matchup_hurdle",
        position: 75,
        detail: { signedEdge: -7.5, tierScore: -1 },
      });
    });

    test.each([
      ["PvZ", { PvP: [5, 5], PvT: [5, 5], PvZ: [6, 4] }, "specialist", 2, 0],
      ["PvZ", { PvP: [5, 5], PvT: [5, 5], PvZ: [4, 6] }, "blind_spot", -2, 100],
    ])(
      "an exact 10-point selected-matchup gap reaches %s",
      (selected, spec, category, tierScore, position) => {
        expect(matchupEdgeAxis(selected, edgeRows(spec))).toMatchObject({
          category,
          position,
          detail: { tierScore },
        });
      },
    );

    test("a middle-ranked selected matchup in a wide shape is Edge, not Universalist", () => {
      const axis = matchupEdgeAxis(
        "PvT",
        edgeRows({ PvP: [6, 4], PvT: [5, 5], PvZ: [4, 6] }),
      );
      expect(axis).toMatchObject({
        value: 0,
        category: "matchup_edge",
        position: 49,
        detail: { allMatchupSpread: 20, tierScore: 1 },
      });
    });

    test("a total spread of exactly five points is Universalist", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [22, 18], PvT: [21, 19], PvZ: [20, 20] }),
      );
      expect(axis).toMatchObject({
        category: "universalist",
        position: 50,
        detail: { allMatchupSpread: 5, tierScore: 0 },
      });
    });

    test("one qualifying comparator still rates, and names what it compared", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [2, 2], PvT: [5, 5], PvZ: [9, 1] }),
      );
      expect(axis.category).toBe("specialist");
      expect(axis.detail.comparedAgainst).toEqual(["PvT"]);
      expect(axis.detail.allMatchupSpread).toBeNull();
    });

    test("no qualifying comparator leaves the track unrated with a distinct reason", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [1, 1], PvT: [2, 2], PvZ: [9, 1] }),
      );
      expect(axis).toMatchObject({
        category: null,
        reason: "no_comparison_matchup",
      });
    });

    test("a thin selected matchup is unrated regardless of its comparators", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [10, 10], PvT: [10, 10], PvZ: [2, 2] }),
      );
      expect(axis).toMatchObject({
        category: null,
        reason: "needs_more_decided_games",
        needed: MIN_MATCHUP_GAMES,
        sampleSize: 4,
      });
    });
  });

  describe("matchupBalanceAxis (evidence block)", () => {
    test("needs enough decided games per matchup and excludes ties from win rate", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(5, 5, 8),
        PvT: outcomeRows(5, 5, 3),
        PvZ: outcomeRows(3, 4, 20),
      });
      expect(axis).toMatchObject({ value: null, strongestMatchup: null });
      const rows = Object.fromEntries(
        axis.matchups.map((row) => [row.matchup, row]),
      );
      expect(rows.PvP).toMatchObject({
        games: 18,
        decidedGames: 10,
        wins: 5,
        losses: 5,
        ties: 8,
        winRate: 50,
      });
      expect(rows.PvZ).toMatchObject({
        games: 27,
        decidedGames: 7,
        wins: 3,
        losses: 4,
        ties: 20,
        winRate: 42.857,
      });
    });

    test("summarises the race-wide spread once every matchup qualifies", () => {
      const axis = matchupBalanceAxis("P", {
        PvP: outcomeRows(2, 8),
        PvT: outcomeRows(5, 5),
        PvZ: outcomeRows(8, 2),
      });
      expect(axis).toMatchObject({
        value: 60,
        leaderGap: 30,
        weakGap: 30,
        strongestMatchup: "PvZ",
        weakestMatchup: "PvP",
      });
    });
  });

  describe("deriveArchetype", () => {
    const categoriesFor = (axisKey) => Object.keys(AXIS_VOCABULARY[axisKey]);

    function axisInput(axisKey, category, position, detail, distinctiveness) {
      return {
        key: axisKey,
        category,
        position,
        detail: detail || null,
        // Fixtures state the naming score explicitly. Derivation no longer
        // reads marker geometry; this default only keeps the older scenarios
        // concise while the dedicated tests below prove that separation.
        distinctiveness:
          distinctiveness ?? Math.abs(Number(position) - 50) / 50,
      };
    }

    test("every reachable combination yields a stable, non-empty name", () => {
      const seen = new Set();
      for (const repertoire of categoriesFor("repertoire")) {
        for (const pace of categoriesFor("pace")) {
          for (const edge of categoriesFor("matchup_edge")) {
            const input = [
              axisInput("repertoire", repertoire, 90),
              axisInput(
                "pace",
                pace,
                pace === "two_speed" ? 50 : 10,
                pace === "two_speed"
                  ? {
                      belowFive: { percent: 45 },
                      aboveFifteen: { percent: 45 },
                    }
                  : null,
              ),
              axisInput(
                "matchup_edge",
                edge,
                edge === "universalist" ? 50 : 5,
              ),
            ];
            const first = deriveArchetype(input);
            expect(deriveArchetype(input)).toEqual(first);
            expect(first).toMatchObject({
              key: `${repertoire}|${pace}|${edge}`,
              name: expect.any(String),
              description: expect.any(String),
              complete: true,
            });
            expect(first.name.length).toBeGreaterThan(0);
            seen.add(first.name);
          }
        }
      }
      // The whole point of composing: a broad spread of names, where the old
      // table funnelled most players into one cell.
      expect(seen.size).toBeGreaterThan(20);
    });

    test("nouns and adjectives are disjoint, so no name repeats a word", () => {
      const nouns = new Set();
      const adjectives = new Set();
      for (const categories of Object.values(AXIS_VOCABULARY)) {
        for (const entry of Object.values(categories)) {
          nouns.add(entry.noun);
          adjectives.add(entry.adjective);
        }
      }
      for (const noun of nouns) expect(adjectives.has(noun)).toBe(false);
    });

    test("an unremarkable player gets the neutral name, not the modal cell", () => {
      const archetype = deriveArchetype([
        axisInput("repertoire", "adaptive", 50),
        axisInput("pace", "flexible", 50),
        axisInput("matchup_edge", "universalist", 50),
      ]);
      expect(archetype.name).toBe(NEUTRAL_ARCHETYPE_NAME);
      expect(archetype.complete).toBe(true);
    });

    test("the most distinctive axis supplies the noun and the second the adjective", () => {
      // Deliberately not an override tuple — this asserts the composition
      // path, which is what the great majority of players land on.
      const archetype = deriveArchetype([
        axisInput("repertoire", "creative", 100),
        axisInput("pace", "late_game", 80),
        axisInput("matchup_edge", "matchup_hurdle", 55),
      ]);
      expect(ARCHETYPE_OVERRIDES[archetype.key]).toBeUndefined();
      expect(archetype.name).toBe(
        `${AXIS_VOCABULARY.pace.late_game.adjective} ${AXIS_VOCABULARY.repertoire.creative.noun}`,
      );
      expect(archetype.components[0]).toMatchObject({
        axis: "repertoire",
        role: "core",
      });
      expect(archetype.components[1]).toMatchObject({
        axis: "pace",
        role: "modifier",
      });
    });

    test("component roles follow calibrated score, with axis order breaking ties", () => {
      const archetype = deriveArchetype([
        axisInput("repertoire", "adaptive", 99, null, 0.4),
        axisInput("pace", "flexible", 1, null, 0.4),
        axisInput("matchup_edge", "matchup_hurdle", 50, null, 0.8),
      ]);
      expect(archetype.components).toEqual([
        expect.objectContaining({ axis: "matchup_edge", role: "core", distinctiveness: 0.8 }),
        expect.objectContaining({ axis: "repertoire", role: "modifier", distinctiveness: 0.4 }),
        expect.objectContaining({ axis: "pace", role: "supporting", distinctiveness: 0.4 }),
      ]);
    });

    test("an unavailable population composes every rated trait and ignores marker geometry", () => {
      const fallback = (positions) =>
        deriveArchetype([
          { key: "repertoire", category: "one_trick", position: positions[0], distinctiveness: null },
          { key: "pace", category: "timing_attacker", position: positions[1], distinctiveness: null },
          { key: "matchup_edge", category: "specialist", position: positions[2], distinctiveness: null },
        ]);
      const left = fallback([0, 50, 100]);
      const right = fallback([100, 0, 50]);

      expect(left).toMatchObject({
        name: "Dominant Clockwork Purist",
        namingMode: "taxonomy_fallback",
        complete: true,
        components: [
          { axis: "repertoire", category: "one_trick", role: "core", distinctiveness: null },
          { axis: "pace", category: "timing_attacker", role: "modifier", distinctiveness: null },
          { axis: "matchup_edge", category: "specialist", role: "supporting", distinctiveness: null },
        ],
      });
      expect(right).toEqual(left);
      expect(left.name).not.toBe(NEUTRAL_ARCHETYPE_NAME);
    });

    test("taxonomy fallback exposes every complete category combination", () => {
      const names = new Set();
      for (const repertoire of categoriesFor("repertoire")) {
        for (const pace of categoriesFor("pace")) {
          for (const edge of categoriesFor("matchup_edge")) {
            const archetype = deriveArchetype([
              { key: "repertoire", category: repertoire, distinctiveness: null },
              { key: "pace", category: pace, distinctiveness: null },
              { key: "matchup_edge", category: edge, distinctiveness: null },
            ]);
            expect(archetype.namingMode).toBe("taxonomy_fallback");
            names.add(archetype.name);
          }
        }
      }
      expect(names.size).toBe(5 * 7 * 5);
    });

    test("every override key resolves to a reachable combination", () => {
      const valid = new Set();
      for (const repertoire of categoriesFor("repertoire")) {
        for (const pace of categoriesFor("pace")) {
          for (const edge of categoriesFor("matchup_edge")) {
            valid.add(`${repertoire}|${pace}|${edge}`);
          }
        }
      }
      for (const key of Object.keys(ARCHETYPE_OVERRIDES)) {
        expect(valid.has(key)).toBe(true);
      }
    });

    test("a partial profile names the traits it has without claiming completeness", () => {
      const archetype = deriveArchetype([
        axisInput("repertoire", "creative", 100),
        { key: "pace", category: null, position: null },
        { key: "matchup_edge", category: null, position: null },
      ]);
      expect(archetype.complete).toBe(false);
      expect(archetype.key).toBe("partial:creative|?|?");
      expect(archetype.name).toBe(AXIS_VOCABULARY.repertoire.creative.noun);
    });

    test("no rated axis is still-forming", () => {
      const archetype = deriveArchetype(
        AXIS_ORDER.map((key) => ({ key, category: null, position: null })),
      );
      expect(archetype).toMatchObject({
        name: "Profile Still Forming",
        complete: false,
        components: [],
      });
    });
  });

  describe("axisDistinctiveness", () => {
    test("attaches scorer metadata without moving the visual marker", () => {
      const result = calibrateAxisResult(
        {
          scoreAxis: () => ({
            distinctiveness: 0.9,
            method: "tier_rarity",
            populationSize: 100,
            tierFrequency: 0.1,
          }),
        },
        { matchup: "PvZ" },
        "pace",
        { category: "timing_attacker", position: 50, value: 360 },
      );
      expect(result).toMatchObject({
        position: 50,
        value: 360,
        distinctiveness: 0.9,
        calibration: {
          method: "tier_rarity",
          populationSize: 100,
          tierFrequency: 0.1,
        },
      });
      expect(axisDistinctiveness("pace", result)).toBe(0.9);
    });

    test("missing population data stays unknown and activates taxonomy fallback", () => {
      const results = [0, 50, 100].map((position) =>
        calibrateAxisResult(
          { scoreAxis: () => null },
          null,
          "repertoire",
          { category: "creative", position, value: 12 },
        ),
      );
      for (const [index, result] of results.entries()) {
        expect(result).toMatchObject({
          position: [0, 50, 100][index],
          value: 12,
          distinctiveness: null,
          calibration: {
            method: TAXONOMY_FALLBACK_METHOD,
            status: "provisional",
            reason: "population_reference_unavailable",
          },
        });
      }
    });

    test("an undersampled axis falls back even when the matchup table is ready", () => {
      const result = calibrateAxisResult(
        { scoreAxis: () => null },
        { matchup: "PvZ", n: 50 },
        "pace",
        { category: "timing_attacker", position: 50, value: 600 },
      );
      expect(result).toMatchObject({
        distinctiveness: null,
        calibration: {
          method: TAXONOMY_FALLBACK_METHOD,
          status: "provisional",
          reason: "axis_population_undersampled",
        },
      });
    });

    test("reads the population score even when the marker sits at the centre", () => {
      const d = axisDistinctiveness("pace", {
        category: "two_speed",
        position: 50,
        distinctiveness: 0.91,
      });
      expect(d).toBe(0.91);
    });

    test("never infers distinctiveness from an endpoint marker", () => {
      const d = axisDistinctiveness("pace", {
        category: "cheeser",
        position: 0,
      });
      expect(d).toBe(0);
    });

    test("an unrated axis contributes nothing", () => {
      expect(axisDistinctiveness("pace", { category: null, position: null })).toBe(0);
    });
  });

  describe("buildTaxonomy", () => {
    test("describes every axis and category the service can emit", () => {
      const taxonomy = buildTaxonomy();
      expect(taxonomy.axes.map((axis) => axis.key)).toEqual([...AXIS_ORDER]);
      for (const axis of taxonomy.axes) {
        expect(axis.label).toEqual(expect.any(String));
        expect(Object.keys(AXIS_VOCABULARY[axis.key])).toEqual(
          axis.categories.map((category) => category.key),
        );
        for (const category of axis.categories) {
          expect(category.thresholdText).toEqual(expect.any(String));
          expect(category.blurb).toEqual(expect.any(String));
          if (axis.key === "matchup_edge") {
            expect(category.score).toEqual(expect.any(Number));
            expect(category.trackPosition).toEqual(expect.any(Number));
          }
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Route contract
// ---------------------------------------------------------------------------

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
    await db.db.collection(FINGERPRINT_CALIBRATION_COLLECTION).deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function getFingerprint(matchup = "PvZ", query = "") {
    return request(app)
      .get(`/v1/me/fingerprint?matchup=${encodeURIComponent(matchup)}${query}`)
      .set("authorization", "Bearer test-token");
  }

  async function seedCalibrationTable(matchup = "PvZ") {
    await db.db.collection(FINGERPRINT_CALIBRATION_COLLECTION).insertOne({
      version: FINGERPRINT_CALIBRATION_VERSION,
      matchup,
      n: MIN_POPULATION_SAMPLE,
      axes: {
        repertoire: {
          metric: "effectiveBuilds",
          n: MIN_POPULATION_SAMPLE,
          valueN: MIN_POPULATION_SAMPLE,
          histogram: [
            { value: 1, count: 40 },
            { value: 2, count: 10 },
          ],
          categoryCounts: { one_trick: 40, signature: 10 },
        },
        pace: {
          metric: "averageSec",
          n: MIN_POPULATION_SAMPLE,
          valueN: MIN_POPULATION_SAMPLE,
          histogram: [{ value: 600, count: MIN_POPULATION_SAMPLE }],
          categoryCounts: { timing_attacker: 45, flexible: 5 },
        },
        matchup_edge: {
          metric: "signedEdge",
          n: MIN_POPULATION_SAMPLE,
          valueN: MIN_POPULATION_SAMPLE,
          histogram: [{ value: 0, count: MIN_POPULATION_SAMPLE }],
          categoryCounts: {
            specialist: 5,
            universalist: 30,
            blind_spot: 5,
            matchup_edge: 5,
            matchup_hurdle: 5,
          },
        },
      },
      reference: {
        version: FINGERPRINT_CALIBRATION_VERSION,
        population: "global",
        unit: "player_matchup_window",
        windowGames: WINDOW_GAMES,
        windowMode: "latest",
        filters: "non_resumed_1v1_ptz_matchups",
      },
      updatedAt: new Date("2026-08-14T12:00:00.000Z"),
      _schemaVersion: FINGERPRINT_CALIBRATION_VERSION,
    });
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
      // Legacy rows predate `matchFormat` but still carry a player count,
      // which is the safe 1v1 fallback gamesMatchStage honours.
      if (options.omitMatchFormat) delete doc.matchFormat;
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

  /** A complete, rateable profile across all three matchups of one race. */
  async function seedCompleteRace({ builds, durationSec = 600 } = {}) {
    await seedMatchup("PvP", { wins: 2, losses: 8, builds, durationSec });
    await seedMatchup("PvT", { wins: 5, losses: 5, builds, durationSec });
    await seedMatchup("PvZ", { wins: 8, losses: 2, builds, durationSec });
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

    const malformed = await getFingerprint("PvX");
    expect(malformed.status).toBe(400);
  });

  test("404s only when the cohort is empty", async () => {
    const empty = await getFingerprint("PvZ");
    expect(empty.status).toBe(404);
    expect(empty.body.error.code).toBe("not_enough_games");

    await seedMatchup("PvZ", { wins: 1, losses: 0 });
    const thin = await getFingerprint("PvZ");
    expect(thin.status).toBe(200);
    expect(thin.body.fingerprint.status).toBe("insufficient");
  });

  test("a thin cohort returns progress per track instead of a dead end", async () => {
    await seedMatchup("PvZ", { wins: 2, losses: 2 });
    const res = await getFingerprint("PvZ");
    expect(res.status).toBe(200);
    const fp = res.body.fingerprint;
    expect(fp.status).toBe("insufficient");
    expect(fp.archetype.complete).toBe(false);
    const axes = Object.fromEntries(fp.axes.map((axis) => [axis.key, axis]));
    expect(axes.repertoire).toMatchObject({
      category: null,
      reason: "needs_more_classified_builds",
      have: 4,
      needed: 10,
    });
    expect(axes.pace).toMatchObject({
      category: null,
      reason: "needs_more_timed_games",
      needed: 10,
    });
    expect(axes.matchup_edge.reason).toBe("needs_more_decided_games");
  });

  test("returns complete axes, build counts, matchup rates, and an archetype", async () => {
    await seedCompleteRace({ builds: ["Standard Build", "Fast Expand"] });
    const res = await getFingerprint("PvZ");
    expect(res.status).toBe(200);
    const fp = res.body.fingerprint;

    expect(fp).toMatchObject({
      matchup: "PvZ",
      race: "P",
      games: 10,
      status: "complete",
      windowMode: "recent",
      windowGames: WINDOW_GAMES,
      strippedFilters: [],
    });
    expect(fp.axes.map((axis) => axis.key)).toEqual([
      "repertoire",
      "pace",
      "matchup_edge",
    ]);
    expect(fp.archetype.complete).toBe(true);
    expect(fp.playstyle).toBe(fp.archetype.name);
    expect(fp.buildOrders).toEqual([
      { name: "Fast Expand", games: 5 },
      { name: "Standard Build", games: 5 },
    ]);
    const rates = Object.fromEntries(
      fp.matchupWinRates.map((row) => [row.matchup, row]),
    );
    expect(rates.PvZ).toMatchObject({ wins: 8, losses: 2, winRate: 80 });
    expect(rates.PvP).toMatchObject({ wins: 2, losses: 8, winRate: 20 });
    const axes = Object.fromEntries(fp.axes.map((axis) => [axis.key, axis]));
    expect(axes.repertoire).toMatchObject({
      value: 2,
      category: "signature",
      categoryLabel: "Signature Pilot",
      sampleSize: 10,
      detail: {
        method: "shannon_perplexity",
        formula: "exp(-sum(p_i * ln(p_i)))",
        distinctBuilds: 2,
        effectiveBuilds: 2,
        topBuildShare: 0.5,
      },
    });
    expect(axes.pace).toMatchObject({
      value: 600,
      category: "timing_attacker",
      categoryLabel: "Timing Attacker",
      sampleSize: 10,
    });
    expect(axes.matchup_edge).toMatchObject({
      position: 0,
      value: 45,
      category: "specialist",
      categoryLabel: "Matchup Specialist",
      sampleSize: 10,
      detail: {
        winRate: 80,
        comparatorWinRate: 35,
        comparedAgainst: ["PvP", "PvT"],
        signedEdge: 45,
        tierScore: 2,
        allMatchupSpread: 60,
      },
    });
    expect(fp.paceSummary).toMatchObject({
      averageSec: 600,
      meanSec: 600,
      medianSec: 600,
      earlyShare: 0,
      midShare: 1,
      lateShare: 0,
    });
    expect(fp.matchupSummary).toMatchObject({
      spread: 60,
      selectedMatchup: "PvZ",
      selectedWinRate: 80,
      comparatorWinRate: 35,
      comparedAgainst: ["PvP", "PvT"],
      signedEdge: 45,
      tierScore: 2,
      strongestMatchup: "PvZ",
      weakestMatchup: "PvP",
    });
  });

  test("uses player-population scores for naming without moving spectrum markers", async () => {
    await seedCompleteRace({ builds: ["Standard Build", "Fast Expand"] });
    await seedCalibrationTable("PvZ");

    const fp = (await getFingerprint("PvZ")).body.fingerprint;
    expect(fp.populationCalibration).toMatchObject({
      status: "ready",
      method: "player_population",
      matchup: "PvZ",
      populationSize: MIN_POPULATION_SAMPLE,
      version: FINGERPRINT_CALIBRATION_VERSION,
      reference: {
        unit: "player_matchup_window",
        windowGames: WINDOW_GAMES,
      },
    });

    const axes = Object.fromEntries(fp.axes.map((axis) => [axis.key, axis]));
    expect(axes.repertoire).toMatchObject({
      category: "signature",
      distinctiveness: 0.8,
      calibration: {
        method: "two_sided_percentile",
        percentile: 0.9,
        populationSize: MIN_POPULATION_SAMPLE,
      },
    });
    expect(axes.pace).toMatchObject({
      category: "timing_attacker",
      position: 50,
      distinctiveness: 0.1,
      calibration: {
        method: "tier_rarity",
        tierFrequency: 0.9,
      },
    });
    expect(axes.matchup_edge).toMatchObject({
      category: "specialist",
      position: 0,
      distinctiveness: 0.9,
      calibration: {
        method: "tier_rarity",
        tierFrequency: 0.1,
      },
    });
    expect(fp.archetype.components).toEqual([
      expect.objectContaining({
        axis: "matchup_edge",
        role: "core",
        distinctiveness: 0.9,
      }),
      expect.objectContaining({
        axis: "repertoire",
        role: "modifier",
        distinctiveness: 0.8,
      }),
      expect.objectContaining({
        axis: "pace",
        role: "supporting",
        distinctiveness: 0.1,
      }),
    ]);
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
      fingerprint.axes.find((axis) => axis.key === "matchup_edge"),
    ).toMatchObject({
      category: "universalist",
      categoryLabel: "Matchup Universalist",
      position: 50,
      value: 0,
      sampleSize: 10,
      detail: { tierScore: 0, allMatchupSpread: 0 },
    });
  });

  test("axis.value keeps the units tickerFacts renders positionally", async () => {
    await seedCompleteRace({
      builds: ["Standard Build", "Fast Expand"],
      durationSec: 654,
    });
    const fp = (await getFingerprint("PvZ")).body.fingerprint;
    const axes = Object.fromEntries(fp.axes.map((axis) => [axis.key, axis]));
    // A raw build count, not a perplexity.
    expect(axes.repertoire.value).toBe(2);
    expect(axes.repertoire.detail.effectiveBuilds).toBeCloseTo(2, 1);
    // Seconds, not a share or a category.
    expect(axes.pace.value).toBe(654);
  });

  // --- Reported bug #1: the date filter did nothing -------------------------

  test("a date range changes the window, counts, and measured categories", async () => {
    const january = new Date(Date.UTC(2026, 0, 15));
    const march = new Date(Date.UTC(2026, 2, 15));

    // January: ten distinct builds. March: a single build, played 20 times.
    await seedRows("PvZ", 20, {
      myBuildAt: (i) => `Experiment ${i % 10}`,
      overrides: { date: january },
    });
    await seedRows("PvZ", 20, {
      myBuild: "Bread and Butter",
      overrides: { date: march },
    });
    await seedRows("PvP", 20, { overrides: { date: january } });
    await seedRows("PvT", 20, { overrides: { date: january } });

    const all = (await getFingerprint("PvZ")).body.fingerprint;
    expect(all.windowMode).toBe("recent");
    expect(all.games).toBe(40);

    const marchOnly = (
      await getFingerprint("PvZ", "&since=2026-03-01T00:00:00.000Z")
    ).body.fingerprint;
    expect(marchOnly.windowMode).toBe("range");
    expect(marchOnly.windowGames).toBe(RANGE_ROW_CAP);
    expect(marchOnly.games).toBe(20);

    // The measurement actually moved, not just the row count.
    const repertoireOf = (fp) =>
      fp.axes.find((axis) => axis.key === "repertoire");
    expect(repertoireOf(all).value).toBe(11);
    expect(repertoireOf(marchOnly).value).toBe(1);
    expect(repertoireOf(marchOnly).category).toBe("one_trick");
    expect(repertoireOf(marchOnly).category).not.toBe(
      repertoireOf(all).category,
    );
    // The isolated route fixture has no 50-player population table. Its
    // provisional taxonomy name still follows the measured categories.
    expect(marchOnly.populationCalibration.status).toBe("unavailable");
    expect(all.populationCalibration.status).toBe("unavailable");
    expect(all.populationCalibration.fallback).toMatchObject({
      method: TAXONOMY_FALLBACK_METHOD,
      axes: expect.arrayContaining(["repertoire", "pace"]),
    });
    expect(marchOnly.archetype.namingMode).toBe("taxonomy_fallback");
    expect(all.archetype.name).not.toBe(NEUTRAL_ARCHETYPE_NAME);
    expect(marchOnly.archetype.name).not.toBe(NEUTRAL_ARCHETYPE_NAME);
    expect(marchOnly.archetype.name).not.toBe(all.archetype.name);
  });

  test("an until bound excludes later games", async () => {
    await seedRows("PvZ", 12, {
      overrides: { date: new Date(Date.UTC(2026, 0, 10)) },
    });
    await seedRows("PvZ", 12, {
      overrides: { date: new Date(Date.UTC(2026, 5, 10)) },
    });
    const early = (
      await getFingerprint("PvZ", "&until=2026-02-01T00:00:00.000Z")
    ).body.fingerprint;
    expect(early.games).toBe(12);
    expect(early.windowMode).toBe("range");
  });

  // --- Reported bug #2: every matchup showed the same archetype -------------

  test("the three matchups of one race produce different matchup traits", async () => {
    // Same builds and pace everywhere, so only the matchup edge differs. Under
    // the old race-wide balance axis all three of these returned one name.
    await seedMatchup("PvP", { wins: 4, losses: 16 });
    await seedMatchup("PvT", { wins: 10, losses: 10 });
    await seedMatchup("PvZ", { wins: 16, losses: 4 });

    const [pvp, pvt, pvz] = await Promise.all([
      getFingerprint("PvP"),
      getFingerprint("PvT"),
      getFingerprint("PvZ"),
    ]);
    const edgeOf = (res) =>
      res.body.fingerprint.axes.find((axis) => axis.key === "matchup_edge");

    expect(edgeOf(pvz).category).toBe("specialist");
    // PvT is exactly level with the average of PvP and PvZ, but the 60-point
    // race-wide spread prevents the all-matchup Universalist classification.
    expect(edgeOf(pvt).category).toBe("matchup_edge");
    expect(edgeOf(pvp).category).toBe("blind_spot");

    for (const response of [pvp, pvt, pvz]) {
      expect(response.body.fingerprint.populationCalibration.status).toBe(
        "unavailable",
      );
      expect(response.body.fingerprint.archetype.namingMode).toBe(
        "taxonomy_fallback",
      );
    }
    const names = [pvp, pvt, pvz].map(
      (response) => response.body.fingerprint.archetype.name,
    );
    expect(new Set(names).size).toBeGreaterThan(1);
    expect(names).not.toContain(NEUTRAL_ARCHETYPE_NAME);
  });

  // --- Filter narrowing, proven end to end ---------------------------------

  test("a build filter does not collapse the repertoire axis", async () => {
    await seedCompleteRace({
      builds: ["Standard Build", "Fast Expand", "All-In", "Greedy Third"],
    });
    const filtered = (
      await getFingerprint("PvZ", "&build=Standard%20Build")
    ).body.fingerprint;
    const repertoire = filtered.axes.find((axis) => axis.key === "repertoire");
    expect(repertoire.value).toBe(4);
    expect(filtered.strippedFilters).toContain("build");
  });

  test("an MMR filter does not distort the matchup win rates", async () => {
    await seedCompleteRace();
    const plain = (await getFingerprint("PvZ")).body.fingerprint;
    const filtered = (await getFingerprint("PvZ", "&mmr_min=4000")).body
      .fingerprint;
    expect(filtered.matchupWinRates).toEqual(plain.matchupWinRates);
    expect(filtered.strippedFilters).toEqual(
      expect.arrayContaining(["mmr_min"]),
    );
  });

  test("a conflicting race filter is overridden by the matchup picker", async () => {
    await seedCompleteRace();
    const filtered = (await getFingerprint("PvZ", "&race=Z&opp_race=T")).body
      .fingerprint;
    expect(filtered.matchup).toBe("PvZ");
    expect(filtered.games).toBe(10);
    expect(filtered.strippedFilters).toEqual(
      expect.arrayContaining(["race", "opp_race"]),
    );
  });

  test("cohort filters that do apply actually narrow the window", async () => {
    await seedRows("PvZ", 12, { overrides: { isLadderGame: true } });
    await seedRows("PvZ", 12, { overrides: { isLadderGame: false } });
    const ladder = (await getFingerprint("PvZ", "&map_pool=ladder")).body
      .fingerprint;
    expect(ladder.games).toBe(12);
    expect(ladder.strippedFilters).toEqual([]);
  });

  // --- Window and payload shape --------------------------------------------

  test("uses the latest 50 rows and filters resumed, team, and wrong-race games", async () => {
    await seedRows("PvZ", 10, {
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
      categoryLabel: "One-Trick Wonder",
      position: 0,
      sampleSize: 50,
    });
    expect(
      fingerprint.axes.find((axis) => axis.key === "pace"),
    ).toMatchObject({
      value: 900,
      category: "mid_late_master",
      categoryLabel: "Mid-Game Maestro",
      position: 100,
      sampleSize: 50,
    });
    expect(fingerprint.repertoireSummary).toEqual({
      method: "shannon_perplexity",
      formula: "exp(-sum(p_i * ln(p_i)))",
      distinctBuilds: 1,
      effectiveBuilds: 1,
      topBuildShare: 1,
    });
    expect(fingerprint.paceSummary).toEqual({
      averageSec: 900,
      meanSec: 900,
      medianSec: 900,
      earlyShare: 0,
      midShare: 1,
      lateShare: 0,
      belowFive: { games: 0, percent: 0 },
      fiveToTen: { games: 0, percent: 0 },
      aboveTen: { games: 50, percent: 100 },
      tenToFifteen: { games: 50, percent: 100 },
      aboveFifteen: { games: 0, percent: 0 },
      classificationMethod: "dominant_over_ten",
    });
    expect(fingerprint.windowTruncated).toBe(true);
  });

  test("a legacy row without matchFormat counts as 1v1 only via playerCount", async () => {
    await seedRows("PvZ", 12, { omitMatchFormat: true });
    // No format metadata at all is not evidence of a 1v1 and stays excluded.
    await seedRows("PvZ", 7, { omitFormatMetadata: true });
    const fp = (await getFingerprint("PvZ")).body.fingerprint;
    expect(fp.games).toBe(12);
  });

  test("every emitted category exists in the taxonomy shipped with it", async () => {
    await seedCompleteRace({ builds: ["Standard Build", "Fast Expand"] });
    const fp = (await getFingerprint("PvZ")).body.fingerprint;
    const known = new Map(
      fp.taxonomy.axes.map((axis) => [
        axis.key,
        new Set(axis.categories.map((category) => category.key)),
      ]),
    );
    for (const axis of fp.axes) {
      if (!axis.category) continue;
      expect(known.get(axis.key)).toBeDefined();
      expect(known.get(axis.key).has(axis.category)).toBe(true);
    }
    for (const component of fp.archetype.components) {
      expect(known.get(component.axis).has(component.category)).toBe(true);
    }
  });

  test("is deterministic across repeated requests", async () => {
    await seedCompleteRace({ builds: ["Standard Build", "Fast Expand"] });
    const first = await getFingerprint("PvZ");
    const second = await getFingerprint("PvZ");
    expect(second.body).toEqual(first.body);
  });
});
