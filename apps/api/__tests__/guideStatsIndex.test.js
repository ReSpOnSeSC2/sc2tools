// @ts-nocheck
"use strict";

/**
 * guide_stats query plans and scale: the per-matchup games ``$match``
 * must be an IXSCAN on the partial ``guide_stats_build_opp_race`` index
 * (never a COLLSCAN), the samples pipelines must use their index, and a
 * synthetic ~20k-game corpus must recompute well inside the budget.
 */

const { GuideStatsService } = require("../src/services/guideStats");
const { guideGamesMatch } = require("../src/services/guideRules");
const {
  GUIDE_GAMES_INDEX_NAME,
  GUIDE_SAMPLES_INDEX_NAME,
  GUIDE_PIPELINE_MAX_MS,
  GUIDE_LEAK_NAMES,
  guideAggregateOptions,
  buildGamesPipeline,
} = require("../src/services/guideStatsPipelines");
const { buildSampleMilestonesPipeline } = require("../src/services/guideStatsSamplePipelines");
const {
  MATCHUPS, buildNamesForMatchup, strategyNamesForMatchup,
} = require("../src/config/guideSlugs");
const { milestonesForRace } = require("../src/config/guideMilestones");
const { NOW_MS, DAY_MS, AFTER_BUILD, BEFORE_BUILD, startDb, resetDb } = require("./helpers/guideStatsSeed");

const RACE_WORDS = { P: "Protoss", T: "Terran", Z: "Zerg" };
const MAPS = [
  "Site Delta LE", "Alcyone LE", "Ghost River LE", "Goldenaura LE", "Oceanborn LE", "Post-Youth LE", "Amphion LE",
];
const SCALE_GAMES = 20000;
const SCALE_SAMPLES = 10000;
const SCALE_USERS = 200;
const INSERT_BATCH = 5000;
/** "Well under the budget": the whole 9-matchup run in a fraction of ONE aggregation's budget. */
const SCALE_BUDGET_MS = GUIDE_PIPELINE_MAX_MS / 4;

/** Deterministic realistic game ``i``: builds/strategies from the matchup's namespaces. */
function scaleGame(i) {
  const matchup = MATCHUPS[i % MATCHUPS.length];
  const builds = buildNamesForMatchup(matchup);
  const strategies = strategyNamesForMatchup(matchup);
  return {
    userId: `scale-user-${(i * 7919) % SCALE_USERS}`,
    gameId: `scale-game-${i}`,
    date: new Date(NOW_MS - (i % 60) * DAY_MS - i * 1000),
    result: (i * 2654435761) % 5 < 3 ? "Victory" : "Defeat",
    myRace: RACE_WORDS[matchup[0]],
    myBuild: builds[(i * 31) % builds.length],
    map: MAPS[i % MAPS.length],
    durationSec: 180 + ((i * 37) % 1500),
    playerCount: 2,
    isLadderGame: true,
    gameBuild: i % 10 < 7 ? AFTER_BUILD : BEFORE_BUILD,
    macroScore: i % 100,
    top3Leaks: [{ name: GUIDE_LEAK_NAMES[i % GUIDE_LEAK_NAMES.length] }],
    opponent: {
      displayName: `Opp${i}`, race: RACE_WORDS[matchup[2]], leagueId: i % 7, mmr: 1800 + (i % 60) * 80,
      // Real ladder opponents carry a SC2Pulse id; it is the second key of
      // the userId-free {myRace, opponent.pulseId, …} index the planner
      // could otherwise weigh against the guide index.
      pulseId: `1-S2-1-${(i * 104729) % 9000}`,
      strategy: strategies[(i * 13) % strategies.length],
    },
  };
}

function scaleSample(i) {
  const matchup = MATCHUPS[i % MATCHUPS.length];
  const builds = buildNamesForMatchup(matchup);
  const milestones = Object.fromEntries(
    milestonesForRace(matchup).slice(0, 8).map((m, k) => [m.key, 15 + k * 20 + (i % 13)]),
  );
  return {
    buildKey: builds[(i * 31) % builds.length], matchup, era: i % 10 < 7 ? "after" : "before", eraRule: 2,
    leagueBand: i % 7, mmrBand: 3000, result: i % 5 < 3 ? "Victory" : "Defeat", map: MAPS[i % MAPS.length],
    durationSec: 600, userHash: `scale-uh-${(i * 7919) % SCALE_USERS}`, gameHash: `scale-gh-${i}`, milestones,
    army: { 360: { Stalker: 1 + (i % 4), Adept: 2 }, 480: { Stalker: 4 + (i % 3) } },
    createdAt: new Date(NOW_MS - i * 1000), updatedAt: new Date(NOW_MS - i * 1000), _schemaVersion: 1,
  };
}

async function insertInBatches(coll, count, make) {
  for (let start = 0; start < count; start += INSERT_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(count, start + INSERT_BATCH); i += 1) batch.push(make(i));
    await coll.insertMany(batch, { ordered: false });
  }
}

/**
 * Aggregate options for ``explain`` (the driver refuses maxTimeMS together
 * with timeoutMS on explain commands; the plan is the same).
 */
function explainOptions(hint) {
  const options = { ...guideAggregateOptions(hint) };
  delete options.maxTimeMS;
  delete options.timeoutMS;
  return options;
}

/** All stage names / index names anywhere in an explain document. */
function planFacts(explain) {
  const json = JSON.stringify(explain);
  return {
    ixscanOnGuideIndex: json.includes(`"indexName":"${GUIDE_GAMES_INDEX_NAME}"`) && json.includes("IXSCAN"),
    collscan: json.includes("COLLSCAN"),
    json,
  };
}

describe("guide_stats query plans and scale", () => {
  let mongo; let db;

  beforeAll(async () => {
    ({ mongo, db } = await startDb("sc2tools_test_guide_stats_scale"));
    await resetDb(db);
    await insertInBatches(db.games, SCALE_GAMES, scaleGame);
    await insertInBatches(db.guideSamples, SCALE_SAMPLES, scaleSample);
  }, 120000);
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("the partial games index exists as specified", async () => {
    const index = (await db.games.indexes()).find((ix) => ix.name === GUIDE_GAMES_INDEX_NAME);
    expect(index.key).toEqual({ myBuild: 1, "opponent.race": 1 });
    expect(index.partialFilterExpression).toEqual({ myBuild: { $type: "string" } });
  });

  test.each(MATCHUPS)("%s: the planner picks an IXSCAN on the guide index for the games $match", async (matchup) => {
    const explain = await db.games.find(guideGamesMatch(matchup)).explain();
    const facts = planFacts(explain.queryPlanner.winningPlan);
    expect(facts.ixscanOnGuideIndex).toBe(true);
    expect(facts.collscan).toBe(false);
  });

  test("the games and samples aggregations start with an indexed $match", async () => {
    const games = planFacts(await db.games
      .aggregate(buildGamesPipeline("PvZ"), explainOptions(GUIDE_GAMES_INDEX_NAME)).explain());
    expect(games.ixscanOnGuideIndex).toBe(true);
    expect(games.collscan).toBe(false);
    const samples = planFacts(await db.guideSamples
      .aggregate(buildSampleMilestonesPipeline("PvZ"), explainOptions(GUIDE_SAMPLES_INDEX_NAME)).explain());
    expect(samples.json).toContain(`"indexName":"${GUIDE_SAMPLES_INDEX_NAME}"`);
    expect(samples.collscan).toBe(false);
  });

  test(`recomputes ${SCALE_GAMES} games + ${SCALE_SAMPLES} samples well inside the budget`, async () => {
    const service = new GuideStatsService(db, { logger: null, now: () => NOW_MS });
    const started = Date.now();
    const run = await service.recompute();
    const elapsedMs = Date.now() - started;
    console.error(`guide_stats scale check: ${SCALE_GAMES} games + ${SCALE_SAMPLES} samples in ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(SCALE_BUDGET_MS);
    expect(run.counts.builds).toBeGreaterThan(0);
    expect(await db.guideStats.countDocuments({ kind: "build" })).toBeGreaterThan(400);
  }, 120000);
});
