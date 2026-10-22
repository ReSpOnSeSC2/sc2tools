// @ts-nocheck
"use strict";

/**
 * Custom-build readers with build check-ins (contract §5): a declared game
 * counts for the declared build in W-L (``checkins`` says how many only do
 * because of a check-in), recent rows carry ``planned``, and build-shape
 * views (median timings, compositions/transitions) use only games whose
 * replay agrees with the label.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { applyOverridePipeline } = require("../src/services/buildIntentAttribution");

const USER = "u-guard-readers";
const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore", "[4:00] DarkShrine"];

const BUILDS = [
  {
    userId: USER, slug: "dt-rush", name: "DT Rush", race: "Protoss", vsRace: "Zerg",
    perspective: "you", rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 420 }],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
  {
    userId: USER, slug: "stargate-opener", name: "Stargate Opener", race: "Protoss", vsRace: "Zerg",
    perspective: "you", rules: [{ type: "before", name: "BuildStargate", time_lt: 300 }],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
  {
    userId: USER, slug: "pool-first", name: "Pool First", race: "Zerg", vsRace: "Protoss",
    perspective: "opponent", rules: [{ type: "before", name: "BuildSpawningPool", time_lt: 120 }],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
];

let mongo;
let client;
let games;
let service;

function game(gameId, day, fields) {
  return {
    userId: USER,
    gameId,
    date: new Date(`2026-10-${String(day).padStart(2, "0")}T18:00:00Z`),
    myRace: "Protoss",
    map: "Site Delta LE",
    durationSec: 600,
    buildLog: LOG,
    oppBuildLog: ["[0:50] SpawningPool"],
    opponent: { displayName: "Opp", race: "Zerg", strategy: "Zerg - 12 Pool" },
    _customOpponentStrategySlug: "pool-first",
    ...fields,
  };
}

async function declare(gameId, notes = "") {
  await games.updateOne(
    { userId: USER, gameId },
    applyOverridePipeline(DT_REF, { origin: "web", via: "web", notes }),
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  const db = client.db("build_intent_guard_readers");
  games = db.collection("games");
  const builds = db.collection("custom_builds");
  await builds.insertMany(BUILDS.map((build) => ({ ...build })));
  await games.insertMany([
    // Declared DT; the replay was generic. Counts only via the check-in.
    game("declared-win", 20, { myBuild: "PvZ - Macro Transition (Unclassified)", result: "Victory" }),
    // Declared DT; the replay matched another saved build.
    game("declared-loss", 19, {
      myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener", result: "Defeat",
    }),
    // Declared DT and the replay executed it: counts, but not as a check-in.
    game("executed", 18, { myBuild: "DT Rush", _customBuildSlug: "dt-rush", result: "Victory" }),
    game("plain-dt", 17, { myBuild: "DT Rush", _customBuildSlug: "dt-rush", result: "Victory" }),
    game("plain-stargate", 16, {
      myBuild: "Stargate Opener", _customBuildSlug: "stargate-opener", result: "Defeat",
    }),
    // Quarantined rows never count, check-in or not.
    game("resumed", 15, {
      myBuild: "PvZ - Macro", result: "Victory", isResumedFromReplay: true,
    }),
  ]);
  await declare("declared-win", "Got scouted, went macro");
  await declare("declared-loss");
  await declare("executed");
  await declare("resumed");
  service = new CustomBuildsService(
    { games, customBuilds: builds, customBuildJobs: db.collection("custom_build_jobs") },
    { perGame: new PerGameComputeService({ games }) },
  );
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("library stats count declared games for the declared slug and report check-ins", async () => {
  const stats = await service.evaluateAllStats(USER);
  const bySlug = Object.fromEntries(stats.map((row) => [row.slug, row]));
  expect(bySlug["dt-rush"]).toEqual(expect.objectContaining({
    total: 4, wins: 3, losses: 1, checkins: 2, winRate: 0.75,
  }));
  // The detector's Stargate label on a declared game never counts for it.
  expect(bySlug["stargate-opener"]).toEqual(expect.objectContaining({
    total: 1, wins: 0, losses: 1, checkins: 0,
  }));
  // Opponent strategies are unaffected by "you"-side check-ins.
  expect(bySlug["pool-first"]).toEqual(expect.objectContaining({ total: 5, checkins: 0 }));

  const paged = await service.evaluateAllStats(USER, { slugs: ["dt-rush"] });
  expect(paged).toEqual([expect.objectContaining({ slug: "dt-rush", total: 4, checkins: 2 })]);
});

test("build matches report check-ins and planned rows; median timings sample agreeing games", async () => {
  const hydrate = jest.spyOn(service, "_hydrateClassifiedTimingSample");
  const detail = await service.evaluateBuild(USER, "dt-rush");

  expect(detail.totals).toEqual(expect.objectContaining({
    wins: 3, losses: 1, total: 4, checkins: 2, winRate: 0.75,
  }));
  const planned = Object.fromEntries(detail.recent.map((row) => [row.gameId, row.planned]));
  expect(planned).toEqual({
    "declared-win": {
      detected: "PvZ - Macro Transition (Unclassified)",
      notes: "Got scouted, went macro",
    },
    "declared-loss": { detected: "Stargate Opener", notes: "" },
    executed: { detected: "DT Rush", notes: "" },
    "plain-dt": null,
  });
  expect(detail.recent.every((row) => !("buildIntent" in row))).toBe(true);
  expect(detail.resumedRecent).toEqual([
    expect.objectContaining({ gameId: "resumed", planned: null, isResumedFromReplay: true }),
  ]);
  const sampled = hydrate.mock.calls[0][1].map((row) => row.gameId);
  expect(sampled).toEqual(["executed", "plain-dt"]);
});

test("opponent-perspective matches carry no check-in markers", async () => {
  const detail = await service.evaluateBuild(USER, "pool-first");
  expect(detail.totals).toEqual(expect.objectContaining({ total: 5, checkins: 0 }));
  expect(detail.recent).toHaveLength(5);
  expect(detail.recent.every((row) => row.planned === null)).toBe(true);
});

test("compositions and transitions use only games whose replay agrees with the label", async () => {
  const listed = jest.spyOn(service, "_listForRulePhases");
  const pages = jest.spyOn(service.perGame, "iterateRulePreviewPages");

  await service.evaluateBuildPhases(USER, "dt-rush", { includeTransitions: true });
  expect(pages.mock.calls[0][1]).toEqual(expect.objectContaining({
    view: "agreeing",
    agreeOn: "you",
    match: { _customBuildSlug: "dt-rush" },
  }));
  const cohort = await listed.mock.results[0].value;
  expect(cohort.games.map((row) => row.gameId)).toEqual(["executed", "plain-dt"]);

  // An opponent definition's cohort agrees on the opponent axis only, so
  // "you"-side check-ins never narrow it.
  await service.evaluateBuildPhases(USER, "pool-first", { includeTransitions: false });
  expect(pages.mock.calls[1][1]).toEqual(expect.objectContaining({
    view: "agreeing",
    agreeOn: "opponent",
    match: { _customOpponentStrategySlug: "pool-first" },
  }));
  const opponentCohort = await listed.mock.results[1].value;
  expect(opponentCohort.games).toHaveLength(5);
});
