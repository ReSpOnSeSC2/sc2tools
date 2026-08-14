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
  AXIS_ORDER,
  AXIS_VOCABULARY,
  ARCHETYPE_OVERRIDES,
  EDGE_MIN_DELTA,
  MIN_MATCHUP_GAMES,
  NEUTRAL_ARCHETYPE_NAME,
  RANGE_ROW_CAP,
  WINDOW_GAMES,
  axisDistinctiveness,
  buildTaxonomy,
  deriveArchetype,
  fingerprintFilters,
  matchupBalanceAxis,
  matchupEdgeAxis,
  paceAxis,
  perplexity,
  repertoireAxis,
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
      [2, "focused"],
      [3, "adaptive"],
      [5, "wide"],
      [10, "creative"],
    ])("%i evenly played builds classify as %s", (distinct, category) => {
      // Always clear MIN_BUILD_SAMPLE, and keep the count a multiple of
      // `distinct` so the distribution stays exactly uniform.
      const axis = repertoireAxis(uniformBuildRows(distinct, distinct * 10));
      expect(axis.category).toBe(category);
      expect(axis.detail.effectiveBuilds).toBeCloseTo(distinct, 1);
    });

    test("ten builds with one dominant is focused, not creative", () => {
      const rows = [
        ...repeatedRows(88, { myBuild: "Bread and Butter" }),
        ...Array.from({ length: 9 }, (_, i) => ({ myBuild: `One Off ${i}` })),
      ];
      const axis = repertoireAxis(rows);
      expect(axis.value).toBe(10);
      expect(axis.category).toBe("focused");
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
      });
    });
  });

  describe("paceAxis", () => {
    test("a mostly-early distribution is a cheeser", () => {
      const axis = paceAxis(
        durationRows([...Array(9).fill(240), ...Array(3).fill(600)]),
      );
      expect(axis.category).toBe("cheeser");
      expect(axis.position).toBeLessThan(50);
    });

    test("a mostly-late distribution is a late-game specialist", () => {
      const axis = paceAxis(
        durationRows([...Array(9).fill(1200), ...Array(3).fill(600)]),
      );
      expect(axis.category).toBe("late_game");
      expect(axis.position).toBeGreaterThan(50);
    });

    test("a mid-game distribution is a flexible pacer", () => {
      const axis = paceAxis(durationRows(Array(12).fill(600)));
      expect(axis.category).toBe("standard");
      expect(axis.position).toBe(50);
    });

    test("a split of early and late games is two_speed, not standard", () => {
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
      expect(axis.detail.earlyShare).toBeGreaterThanOrEqual(0.3);
      expect(axis.detail.lateShare).toBeGreaterThanOrEqual(0.3);
    });

    test("the median keeps a cheeser a cheeser despite one long game", () => {
      const durations = [...Array(9).fill(240), 2700];
      const axis = paceAxis(durationRows(durations));
      expect(axis.category).toBe("cheeser");
      // value is still seconds — tickerFacts formats it as M:SS.
      expect(axis.value).toBe(240);
      expect(axis.detail.meanSec).toBeGreaterThan(400);
    });

    test("band edges are exclusive at 7:00 and 14:00", () => {
      const atEdges = paceAxis(durationRows(Array(12).fill(420)));
      expect(atEdges.detail.earlyShare).toBe(0);
      expect(atEdges.detail.midShare).toBe(1);
      const late = paceAxis(durationRows(Array(12).fill(841)));
      expect(late.detail.lateShare).toBe(1);
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
        reason: "needs_more_timed_games",
        needed: 10,
      });
    });
  });

  describe("matchupEdgeAxis", () => {
    test("clearly above the other two is a strong edge", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [5, 5], PvT: [5, 5], PvZ: [8, 2] }),
      );
      expect(axis.category).toBe("edge_strong");
      expect(axis.value).toBe(30);
      expect(axis.position).toBeLessThan(50);
      expect(axis.detail.comparedAgainst).toEqual(["PvP", "PvT"]);
    });

    test("clearly below the other two is a weak edge", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [8, 2], PvT: [8, 2], PvZ: [2, 8] }),
      );
      expect(axis.category).toBe("edge_weak");
      expect(axis.position).toBeGreaterThan(50);
    });

    test("a small difference is on par", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [5, 5], PvT: [5, 5], PvZ: [6, 6] }),
      );
      expect(axis.category).toBe("edge_on_par");
    });

    test("the threshold is inclusive at the documented delta", () => {
      // PvZ 60%, others 50% and 55% -> mean 52.5, delta exactly 7.5.
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [10, 10], PvT: [11, 9], PvZ: [12, 8] }),
      );
      expect(axis.value).toBe(EDGE_MIN_DELTA);
      expect(axis.category).toBe("edge_strong");
    });

    test("one qualifying comparator still rates, and names what it compared", () => {
      const axis = matchupEdgeAxis(
        "PvZ",
        edgeRows({ PvP: [2, 2], PvT: [5, 5], PvZ: [9, 1] }),
      );
      expect(axis.category).toBe("edge_strong");
      expect(axis.detail.comparedAgainst).toEqual(["PvT"]);
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

    function axisInput(axisKey, category, position, detail) {
      return { key: axisKey, category, position, detail: detail || null };
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
                  ? { earlyShare: 0.45, lateShare: 0.45 }
                  : null,
              ),
              axisInput("matchup_edge", edge, edge === "edge_on_par" ? 50 : 5),
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
        axisInput("pace", "standard", 50),
        axisInput("matchup_edge", "edge_on_par", 52),
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
        axisInput("matchup_edge", "edge_weak", 55),
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
    test("two_speed is distinctive despite sitting at the centre of the track", () => {
      const d = axisDistinctiveness("pace", {
        category: "two_speed",
        position: 50,
        detail: { earlyShare: 0.45, lateShare: 0.45 },
      });
      expect(d).toBeGreaterThan(0.9);
    });

    test("a bare two_speed at the threshold is not distinctive", () => {
      const d = axisDistinctiveness("pace", {
        category: "two_speed",
        position: 50,
        detail: { earlyShare: 0.3, lateShare: 0.3 },
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

  test("a date range changes the window, the counts, and the archetype", async () => {
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

  test("the three matchups of one race can produce different archetypes", async () => {
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

    expect(edgeOf(pvz).category).toBe("edge_strong");
    expect(edgeOf(pvt).category).toBe("edge_on_par");
    expect(edgeOf(pvp).category).toBe("edge_weak");

    const names = [pvp, pvt, pvz].map((res) => res.body.fingerprint.archetype.name);
    expect(new Set(names).size).toBeGreaterThanOrEqual(2);
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
    await seedRows("PvZ", 60);
    await seedRows("PvZ", 5, { overrides: { isResumedFromReplay: true } });
    await seedRows("PvZ", 5, {
      overrides: { matchFormat: "team", playerCount: 4 },
    });
    await seedRows("PvT", 5);
    const fp = (await getFingerprint("PvZ")).body.fingerprint;
    expect(fp.games).toBe(WINDOW_GAMES);
    expect(fp.windowTruncated).toBe(true);
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
