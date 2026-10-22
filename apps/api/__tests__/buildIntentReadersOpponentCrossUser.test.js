// @ts-nocheck
"use strict";

/**
 * Build check-in readers on the opponent axis, cross-user surfaces
 * (addendum §A.4): guide counter stats, the community k-anonymous opponent
 * profile and published-card owner totals, admin global breakdowns, player
 * profile, player games and the trends snapshot, review snapshots and the
 * opponent identity matcher's behavioural evidence all see the classifier's
 * opponent label, never a player's correction. Counts stay intact: a
 * corrected game is still counted, only under its detector label.
 *
 * Fixtures: helpers/buildIntentReadersOpponentSeed.js.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { buildGamesPipeline } = require("../src/services/guideStatsPipelines");
const { CommunityService } = require("../src/services/community");
const { AdminGlobalService } = require("../src/services/adminGlobal");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { globalHistoryStages } = require("../src/services/adminGlobalTrendsScope");
const { ReviewsService } = require("../src/services/reviews");
const {
  OpponentIdentityMatcherService,
  scoreCandidate,
} = require("../src/services/opponentIdentityMatcher");
const {
  STARGATE,
  UNCLASSIFIED,
  SECRET_NOTES,
  checkIn,
} = require("./helpers/buildIntentReadersSeed");
const {
  POOL,
  ROACH,
  CUSTOM_ROACH,
  POOL_FIRST,
  POOL_FIRST_REF,
  correctOpponent,
  oppGame,
  seedOpponentAxis,
} = require("./helpers/buildIntentReadersOpponentSeed");

const USER = "u-cross-opp";
const PULSE = "1-S2-1-777";

let mongo;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "build_intent_readers_opponent_cross_test" });
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    db.games.deleteMany({}),
    db.opponents.deleteMany({}),
    db.communityBuilds.deleteMany({}),
    db.reviewRequests.deleteMany({}),
  ]);
});

/** @param {unknown} body */
function expectNoIntentLeak(body) {
  const json = JSON.stringify(body);
  expect(json).not.toContain(SECRET_NOTES);
  expect(json).not.toContain("buildIntent");
}

describe("guide counter stats", () => {
  test("the strategy cell is the classifier's catalog label; corrected rows still count", async () => {
    await seedOpponentAxis(db.games, USER);
    const pipeline = buildGamesPipeline("PvZ");
    const projectAt = pipeline.findIndex((stage) => stage.$project);
    const rows = await db.games.aggregate(pipeline.slice(0, projectAt + 1)).toArray();
    const byDay = Object.fromEntries(rows.map((row) => [row.date.getUTCDate(), row]));
    expect(rows).toHaveLength(5);
    expect(byDay[10].strategy).toBe(POOL); // opp-normal
    expect(byDay[11].strategy).toBe(ROACH); // opp-disagree, corrected to 12 Pool
    expect(byDay[12].strategy).toBe(POOL); // opp-agree
    expect(byDay[13].strategy).toBe(POOL); // opp-custom, corrected to Pool First
    // opp-from-custom: the classifier's label is a private custom strategy.
    expect(byDay[14].strategy).toBeNull();
    for (const row of rows) expect(row.build).toBe(STARGATE);
  });

  test("a disagreeing \"you\" check-in still drops the row whatever its opponent label", async () => {
    await db.games.insertOne(oppGame(USER, "both", 15, { myBuild: UNCLASSIFIED, opponent: { strategy: ROACH } }));
    await checkIn(db.games, USER, "both");
    await correctOpponent(db.games, USER, "both");
    const pipeline = buildGamesPipeline("PvZ");
    const projectAt = pipeline.findIndex((stage) => stage.$project);
    expect(await db.games.aggregate(pipeline.slice(0, projectAt + 1)).toArray()).toEqual([]);
  });
});

describe("community", () => {
  test("the k-anonymous opponent profile tallies the classifier's strategies", async () => {
    for (let i = 0; i < 5; i += 1) await seedOpponentAxis(db.games, `${USER}-${i}`);
    const profile = await new CommunityService(db).aggregateOpponent(PULSE);
    expect(profile).toMatchObject({ contributors: 5, games: 25, wins: 10, losses: 15 });
    expect(profile.strategies[POOL]).toBe(15);
    expect(profile.strategies[ROACH]).toBe(5);
    expect(profile.strategies[CUSTOM_ROACH]).toBe(5);
    expect(profile.strategies).not.toHaveProperty([POOL_FIRST]);
    expectNoIntentLeak(profile);
  });

  test("published-card owner totals key on the classifier's opponent slug", async () => {
    await seedOpponentAxis(db.games, USER);
    await db.games.insertMany([
      oppGame(USER, "plain-pool-first", 15, {
        opponent: { strategy: POOL_FIRST },
        _customOpponentStrategySlug: "pool-first",
      }),
      oppGame(USER, "pool-first-corrected-away", 16, {
        result: "Defeat",
        opponent: { strategy: POOL_FIRST },
        _customOpponentStrategySlug: "pool-first",
      }),
    ]);
    await correctOpponent(db.games, USER, "pool-first-corrected-away");
    await db.communityBuilds.insertMany([
      { ownerUserId: USER, removed: false, slug: "pool-first-public-0123456789", sourceSlug: "pool-first" },
      { ownerUserId: USER, removed: false, slug: "roach-rush-public-0123456789", sourceSlug: "roach-rush" },
    ]);
    const cards = Object.fromEntries(
      (await new CommunityService(db).listOwnerReplayStats(USER)).map((card) => [card.publicSlug, card]),
    );
    // plain-pool-first + pool-first-corrected-away; "opp-custom" only declared it.
    expect(cards["pool-first-public-0123456789"]).toEqual({
      publicSlug: "pool-first-public-0123456789", total: 2, wins: 1, losses: 1,
    });
    // "opp-from-custom": classified roach-rush, corrected to 12 Pool.
    expect(cards["roach-rush-public-0123456789"]).toEqual({
      publicSlug: "roach-rush-public-0123456789", total: 1, wins: 1, losses: 0,
    });
  });
});

describe("admin global", () => {
  beforeEach(async () => {
    await seedOpponentAxis(db.games, USER);
    await db.opponents.insertOne({
      userId: USER,
      pulseId: PULSE,
      displayNameSample: "Opp",
      race: "Z",
      gameCount: 5,
      wins: 3,
      losses: 2,
      firstSeen: new Date("2026-10-10T00:00:00Z"),
      lastSeen: new Date("2026-10-14T00:00:00Z"),
    });
  });

  const DETECTOR_COUNTS = { [POOL]: 3, [ROACH]: 1, [CUSTOM_ROACH]: 1 };

  test("breakdowns group strategies on the detector label", async () => {
    const { strategies, builds } = await new AdminGlobalService({ db }).breakdowns();
    expect(Object.fromEntries(strategies.map((row) => [row.key, row.count]))).toEqual(DETECTOR_COUNTS);
    // opp-normal + opp-agree won; opp-custom lost.
    expect(strategies.find((row) => row.key === POOL)).toMatchObject({ count: 3, wins: 2 });
    expect(Object.fromEntries(builds.map((row) => [row.key, row.count]))).toEqual({ [STARGATE]: 5 });
  });

  test("the player profile and player games show the detector label", async () => {
    const service = new AdminGlobalService({ db });
    const profile = await service.playerProfile(PULSE);
    expect(Object.fromEntries(profile.strategies.map((row) => [row.key, row.count]))).toEqual(DETECTOR_COUNTS);

    const { items } = await service.listPlayerGames(PULSE);
    const strategies = Object.fromEntries(items.map((row) => [row.gameId, row.opponent.strategy]));
    expect(strategies).toEqual({
      "opp-normal": POOL,
      "opp-disagree": ROACH,
      "opp-agree": POOL,
      "opp-custom": POOL,
      "opp-from-custom": CUSTOM_ROACH,
    });
    expectNoIntentLeak(items);
  });

  test("the trends snapshot remaps opponent.strategy once", async () => {
    await db.games.insertOne(oppGame(USER, "opp-unlabelled-correction", 15));
    await db.games.updateOne(
      { userId: USER, gameId: "opp-unlabelled-correction" },
      { $unset: { "opponent.strategy": "" } },
    );
    await correctOpponent(db.games, USER, "opp-unlabelled-correction", POOL_FIRST_REF);
    const legacy = oppGame(USER, "no-opponent", 16);
    delete legacy.opponent;
    await db.games.insertOne(legacy);
    const rows = Object.fromEntries(
      (await db.games.aggregate(globalHistoryStages()).toArray()).map((row) => [row.gameId, row]),
    );
    expect(rows["opp-disagree"].opponent.strategy).toBe(ROACH);
    expect(rows["opp-custom"].opponent.strategy).toBe(POOL);
    expect(rows["opp-from-custom"].opponent.strategy).toBe(CUSTOM_ROACH);
    expect(rows["opp-normal"].opponent).toMatchObject({ strategy: POOL, race: "Zerg" });
    expect(rows["opp-unlabelled-correction"].opponent).not.toHaveProperty("strategy");
    expect(rows["opp-unlabelled-correction"].opponent.race).toBe("Zerg");
    expect(rows["no-opponent"].opponent?.strategy).toBeUndefined();
    expect(rows["no-opponent"].opponent?.race).toBeUndefined();
    expectNoIntentLeak(Object.values(rows));

    const options = await new AdminGlobalTrendsService({ db }).filterOptions({});
    expect(options.strategies).toEqual([CUSTOM_ROACH, ROACH, POOL]);
  });
});

describe("review snapshots", () => {
  function reviewsService() {
    return new ReviewsService(db, {
      replayLibrary: { getDetail: async () => ({ game: {}, sourceGame: {} }) },
      perGame: {
        macroBreakdown: async () => ({ ok: true }),
        buildOrder: async () => null,
        mapPlayback: async () => null,
      },
      reputation: {},
      notifications: {},
    });
  }

  test("a review publishes the classifier's opponent strategy", async () => {
    await seedOpponentAxis(db.games, USER);
    const reviews = reviewsService();
    const question = "How should I hold this early pool better next time?";
    const snapshotOf = async (gameId) => {
      const { id } = await reviews.create(USER, { gameId, question });
      return db.reviewRequests.findOne({ _id: id });
    };
    const disagree = await snapshotOf("opp-disagree");
    expect(disagree).toMatchObject({ matchup: "PvZ", myBuild: STARGATE, oppStrategy: ROACH });
    expectNoIntentLeak(disagree);
    // The declared custom opponent build is never published.
    expect((await snapshotOf("opp-custom")).oppStrategy).toBe(POOL);
    // The classifier's own label was a private custom strategy.
    expect((await snapshotOf("opp-from-custom")).oppStrategy).toBeNull();
  });
});

describe("opponent identity matcher", () => {
  test("behavioural evidence compares the classifier's opponent labels", async () => {
    const CANDIDATE_PULSE = "1-S2-1-888";
    await db.games.insertMany([
      oppGame(USER, "target-corrected", 10, { opponent: { strategy: ROACH } }),
      oppGame(USER, "candidate-plain", 11, { opponent: { strategy: ROACH, pulseId: CANDIDATE_PULSE } }),
    ]);
    await correctOpponent(db.games, USER, "target-corrected");
    const matcher = new OpponentIdentityMatcherService(db);
    const target = await matcher._targetGames(USER, { pulseId: PULSE });
    const candidate = await matcher._targetGames(USER, { pulseId: CANDIDATE_PULSE });
    expect(target.map((game) => game.opponent.strategy)).toEqual([POOL]);

    const score = scoreCandidate(target, candidate, "P");
    expect(score.evidence.buildOrders).toMatchObject({ sharedBuilds: [ROACH] });
    expect(score.evidence.buildOrders.highlights).toContain(`Shared build: ${ROACH}`);
    expect(JSON.stringify(score)).not.toContain(POOL);
  });
});
