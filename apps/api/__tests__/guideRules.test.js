// @ts-nocheck
"use strict";

/**
 * services/guideRules.js — the JS eligibility predicate (ingest capture)
 * and the Mongo ``$match`` (nightly aggregate) must select exactly the
 * same games, and the ``$match`` must be answerable from the
 * {myBuild, opponent.race} guide index.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const {
  GUIDE_LEAGUE_BANDS,
  GUIDE_MMR_BANDS,
  matchupOf,
  guideIneligibilityReason,
  isGuideEligibleGame,
  guideGamesMatch,
  strategyAllowed,
  leagueBandOf,
  mmrBandOf,
  leagueBandExpression,
  mmrBandExpression,
  leagueLabel,
  mmrBandLabel,
} = require("../src/services/guideRules");

const BUILD = "PvZ - Stargate into Glaives";

/** An eligible PvZ ladder game (slim-row shape). */
function game(overrides = {}) {
  return {
    userId: "u-rules",
    gameId: `g-${Math.random()}`,
    date: new Date("2026-07-01T00:00:00Z"),
    result: "Victory",
    myRace: "Protoss",
    myBuild: BUILD,
    map: "Site Delta LE",
    playerCount: 2,
    matchFormat: "1v1",
    isLadderGame: true,
    opponent: { race: "Zerg", leagueId: 4, mmr: 4120 },
    ...overrides,
  };
}

/** [label, row, expected reason (null = eligible)] */
const CASES = [
  ["eligible", game(), null],
  ["legacy: no ladder flag but a league", game({ isLadderGame: undefined, playerCount: undefined, matchFormat: undefined }), null],
  ["lowercase races", game({ myRace: "protoss", opponent: { race: "zerg", leagueId: 2 } }), null],
  ["race-generic name is not a Protoss build", game({ myBuild: "Protoss - Stargate Opener" }), "not_guide_build"],
  ["Zerg race-generic build", game({ myRace: "Zerg", myBuild: "Zerg - 8 Pool", opponent: { race: "Protoss", leagueId: 1 } }), null],
  ["resumed replay", game({ isResumedFromReplay: true }), "resumed"],
  ["custom build slug", game({ _customBuildSlug: "my-build" }), "custom_build"],
  ["team game", game({ playerCount: 4 }), "not_1v1"],
  ["team format", game({ matchFormat: "team" }), "not_1v1"],
  ["not ladder", game({ isLadderGame: false }), "not_ladder"],
  ["unknown ladder, no league", game({ isLadderGame: undefined, opponent: { race: "Zerg" } }), "not_ladder"],
  ["null ladder flag", game({ isLadderGame: null }), "not_ladder"],
  ["random race", game({ myRace: "Random" }), "bad_matchup"],
  ["unknown opponent race", game({ opponent: { race: "U", leagueId: 4 } }), "bad_matchup"],
  ["missing opponent", game({ isLadderGame: true, opponent: undefined }), "bad_matchup"],
  ["custom name", game({ myBuild: "My Secret Build" }), "not_guide_build"],
  ["game too short", game({ myBuild: "PvZ - Game Too Short" }), "not_guide_build"],
  ["unclassified", game({ myBuild: "PvZ - Macro Transition (Unclassified)" }), "not_guide_build"],
  ["wrong matchup build", game({ myBuild: "PvT - DT Drop" }), "not_guide_build"],
  ["missing build", game({ myBuild: undefined }), "not_guide_build"],
];

describe("guideRules (pure)", () => {
  test("matchupOf", () => {
    expect(matchupOf("Protoss", "Zerg")).toBe("PvZ");
    expect(matchupOf("terran", "terran")).toBe("TvT");
    expect(matchupOf("Random", "Zerg")).toBeNull();
    expect(matchupOf("Protoss", "")).toBeNull();
    expect(matchupOf(undefined, "Zerg")).toBeNull();
  });

  test.each(CASES)("%s", (_label, row, reason) => {
    expect(guideIneligibilityReason(row)).toBe(reason);
    expect(isGuideEligibleGame(row)).toBe(reason === null);
  });

  test("strategyAllowed uses the counters namespace of the user's matchup", () => {
    expect(strategyAllowed("PvZ", "Zerg - 8 Pool")).toBe(true);
    expect(strategyAllowed("PvZ", "ZvP - Ling Bane Bust")).toBe(true);
    expect(strategyAllowed("ZvP", "Protoss - DT Rush")).toBe(true);
    expect(strategyAllowed("ZvP", "PvZ - Stargate into Glaives")).toBe(false);
    expect(strategyAllowed("PvZ", "Zerg - Game Too Short")).toBe(false);
    expect(strategyAllowed("PvZ", null)).toBe(false);
  });

  test("bands and labels", () => {
    expect(leagueBandOf({ leagueId: 4 })).toBe(4);
    expect(leagueBandOf({ leagueId: 0 })).toBe(0);
    expect(leagueBandOf({ leagueId: 9 })).toBeNull();
    expect(leagueBandOf({ leagueId: 2.5 })).toBeNull();
    expect(leagueBandOf(undefined)).toBeNull();
    expect(mmrBandOf({ mmr: 4120 })).toBe(4000);
    expect(mmrBandOf({ mmr: 1500 })).toBe(1000);
    expect(mmrBandOf({ mmr: 7100 })).toBe(6500);
    expect(mmrBandOf({ mmr: 900 })).toBeNull();
    expect(mmrBandOf({ mmr: "4000" })).toBeNull();
    expect(leagueLabel(6)).toBe("Grandmaster");
    expect(leagueLabel(9)).toBe("League 9");
    expect(mmrBandLabel(4000)).toBe("4000–4500");
    expect(mmrBandLabel(1000)).toBe("<2000");
    expect(mmrBandLabel(123)).toBeNull();
    expect(GUIDE_LEAGUE_BANDS).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(GUIDE_MMR_BANDS).toContain(6500);
  });

  test("guideGamesMatch rejects an invalid matchup", () => {
    expect(() => guideGamesMatch("PvX")).toThrow(TypeError);
    expect(() => guideGamesMatch("pvz")).toThrow(TypeError);
  });
});

describe("guideRules against mongod", () => {
  let mongo;
  let client;
  let games;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    games = client.db("sc2tools_test_guide_rules").collection("games");
    // Strip undefined so absent fields are really absent, as on stored rows.
    const rows = CASES.map(([label, row]) => JSON.parse(JSON.stringify({ ...row, label, date: undefined })));
    await games.insertMany(rows.map((row) => ({ ...row, date: new Date("2026-07-01T00:00:00Z") })));
  });

  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  test("guideGamesMatch selects exactly the JS-eligible rows of each matchup", async () => {
    const all = await games.find({}).toArray();
    for (const matchup of ["PvZ", "ZvP", "TvT"]) {
      const matched = (await games.find(guideGamesMatch(matchup)).toArray()).map((r) => r.label).sort();
      const expected = all
        .filter((r) => isGuideEligibleGame(r) && matchupOf(r.myRace, r.opponent && r.opponent.race) === matchup)
        .map((r) => r.label)
        .sort();
      expect({ matchup, matched }).toEqual({ matchup, matched: expected });
      if (matchup === "PvZ") expect(matched).toEqual(["eligible", "legacy: no ladder flag but a league", "lowercase races"]);
      if (matchup === "ZvP") expect(matched).toEqual(["Zerg race-generic build"]);
    }
  });

  test("band expressions agree with the JS band helpers", async () => {
    const coll = client.db("sc2tools_test_guide_rules").collection("bands");
    const opponents = [
      { leagueId: 0 }, { leagueId: 6 }, { leagueId: 7 }, { leagueId: -1 }, { leagueId: 3.5 }, { leagueId: "4" },
      { mmr: 999 }, { mmr: 1000 }, { mmr: 1999 }, { mmr: 2000 }, { mmr: 4499 }, { mmr: 6499 }, { mmr: 6500 },
      { mmr: 7999 }, { mmr: 8000 }, { mmr: "4000" }, {},
    ];
    await coll.insertMany(opponents.map((opponent, i) => ({ i, opponent })));
    const rows = await coll.aggregate([
      { $project: { i: 1, opponent: 1, league: leagueBandExpression(), mmr: mmrBandExpression() } },
    ]).toArray();
    for (const row of rows) {
      expect({ i: row.i, league: row.league, mmr: row.mmr })
        .toEqual({ i: row.i, league: leagueBandOf(row.opponent), mmr: mmrBandOf(row.opponent) });
    }
  });

  test("the planner can answer guideGamesMatch from the {myBuild, opponent.race} index", async () => {
    await games.createIndex(
      { myBuild: 1, "opponent.race": 1 },
      { name: "guide_stats_build_opp_race", partialFilterExpression: { myBuild: { $type: "string" } } },
    );
    const plan = await games.find(guideGamesMatch("PvZ")).explain("queryPlanner");
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(text).toContain("IXSCAN");
    expect(text).toContain("guide_stats_build_opp_race");
  });
});
