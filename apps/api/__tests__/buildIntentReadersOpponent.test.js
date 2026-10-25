// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in readers on the opponent axis (addendum §A.4), owner-facing
 * and build-shape surfaces:
 *
 *   - services/buildIntentReaders.js opponent helpers mirror the shape
 *     fragments;
 *   - own stats (/v1/games rows, opponent profile, /v1/opp-strategies, a
 *     build's byStrategy) count a correction toward the declared opponent
 *     build, flag it (oppStrategyPlanned/detectedOppStrategy,
 *     opp_strategy_planned/detected_opp_strategy, ``checkins``) and never
 *     carry notes;
 *   - build-shape views (strategy phases, the opponent profile's
 *     per-strategy envelopes) keep only rows agreeing on the opponent axis;
 *   - the public replay archive labels, filters and searches by the
 *     classifier's opponent label.
 *
 * Fixtures: helpers/buildIntentReadersOpponentSeed.js.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { OpponentsService } = require("../src/services/opponents");
const { BuildsService } = require("../src/services/builds");
const { StrategyPhasesService } = require("../src/services/strategyPhases");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { ReplayLibraryService } = require("../src/services/replayLibrary");
const { buildBuildsRouter } = require("../src/routes/builds");
const { buildPublicReplaysRouter } = require("../src/routes/publicReplays");
const { OPP_AGREES_WITH_DETECTOR_MATCH } = require("../src/services/buildIntentShape");
const {
  DETECTOR_OPP_STRATEGY_FIELD,
  opponentAgreesWithDetector,
  opponentDetectorLabelMatch,
  ownerBuildFlags,
  withOwnerBuildFlags,
} = require("../src/services/buildIntentReaders");
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
  OPP_IDS,
  correctOpponent,
  oppGame,
  seedOpponentAxis,
} = require("./helpers/buildIntentReadersOpponentSeed");

const USER = "u-readers-opp";
const PULSE = "1-S2-1-777";
const STARGATE_LOG = ["[0:00] Nexus", "[0:18] Pylon", "[0:45] Gateway", "[1:30] Nexus", "[3:05] Stargate"];

let mongo;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "build_intent_readers_opponent_test" });
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({})]);
});

/** @param {unknown} body */
function expectNoIntentLeak(body) {
  const json = JSON.stringify(body);
  expect(json).not.toContain(SECRET_NOTES);
  expect(json).not.toContain("buildIntent");
  expect(json).not.toContain("suggestion");
}

/** @param {Array<Record<string, any>>} rows */
function byId(rows, key = "gameId") {
  return Object.fromEntries(rows.map((row) => [row[key], row]));
}

/** @param {Array<Record<string, any>>} rows */
function byName(rows) {
  return Object.fromEntries(rows.map((row) => [row.name, row]));
}

/**
 * A row whose replay produced no opponent label at all.
 * @param {string} gameId
 * @param {number} day
 */
function unlabelled(gameId, day) {
  const row = oppGame(USER, gameId, day);
  delete row.opponent.strategy;
  return row;
}

/** @param {Record<string, any>} filter */
async function idsOf(filter) {
  return (await db.games.find({ userId: USER, ...filter }).toArray()).map((row) => row.gameId).sort();
}

describe("opponent-axis reader helpers", () => {
  test("opponentAgreesWithDetector mirrors OPP_AGREES_WITH_DETECTOR_MATCH row for row", async () => {
    await seedOpponentAxis(db.games, USER);
    await db.games.insertOne(unlabelled("opp-no-label", 15));
    await correctOpponent(db.games, USER, "opp-no-label");

    const all = await db.games.find({ userId: USER }).toArray();
    const agreeing = await idsOf(OPP_AGREES_WITH_DETECTOR_MATCH);
    expect(all.filter(opponentAgreesWithDetector).map((row) => row.gameId).sort()).toEqual(agreeing);
    expect(agreeing).toEqual(["opp-agree", "opp-normal"]);
    expect(opponentAgreesWithDetector(null)).toBe(true);
  });

  test("opponentDetectorLabelMatch selects rows by the classifier's opponent name or slug", async () => {
    await seedOpponentAxis(db.games, USER);
    await db.games.insertOne(oppGame(USER, "plain-custom", 15, {
      opponent: { strategy: CUSTOM_ROACH },
      _customOpponentStrategySlug: "roach-rush",
    }));
    expect(await idsOf(opponentDetectorLabelMatch("name", POOL)))
      .toEqual(["opp-agree", "opp-custom", "opp-normal"]);
    expect(await idsOf(opponentDetectorLabelMatch("name", ROACH))).toEqual(["opp-disagree"]);
    expect(await idsOf(opponentDetectorLabelMatch("name", /roach/i)))
      .toEqual(["opp-disagree", "opp-from-custom", "plain-custom"]);
    expect(await idsOf(opponentDetectorLabelMatch("slug", "roach-rush"))).toEqual(["opp-from-custom", "plain-custom"]);
    // Only declared, never classified.
    expect(await idsOf(opponentDetectorLabelMatch("slug", "pool-first"))).toEqual([]);
    expect(await idsOf(opponentDetectorLabelMatch("name", POOL_FIRST))).toEqual([]);
  });

  test("DETECTOR_OPP_STRATEGY_FIELD swaps in the detector label and keeps a missing label missing", async () => {
    await seedOpponentAxis(db.games, USER);
    await db.games.insertMany([
      unlabelled("opp-no-label", 15),
      unlabelled("opp-unlabelled-correction", 16),
    ]);
    await correctOpponent(db.games, USER, "opp-unlabelled-correction");
    const rows = byId(await db.games.aggregate([
      { $match: { userId: USER } },
      { $project: { _id: 0, gameId: 1, strategy: DETECTOR_OPP_STRATEGY_FIELD } },
    ]).toArray());
    expect(rows["opp-normal"].strategy).toBe(POOL);
    expect(rows["opp-disagree"].strategy).toBe(ROACH);
    expect(rows["opp-custom"].strategy).toBe(POOL);
    expect(rows["opp-from-custom"].strategy).toBe(CUSTOM_ROACH);
    expect(rows["opp-no-label"]).not.toHaveProperty("strategy");
    expect(rows["opp-unlabelled-correction"]).not.toHaveProperty("strategy");
  });

  test("ownerBuildFlags reports each axis on its own; withOwnerBuildFlags drops the subdocument", async () => {
    await seedOpponentAxis(db.games, USER);
    await db.games.insertOne(oppGame(USER, "both-axes", 15, { myBuild: UNCLASSIFIED, opponent: { strategy: ROACH } }));
    await checkIn(db.games, USER, "both-axes");
    await correctOpponent(db.games, USER, "both-axes");
    const rows = byId(await db.games.find({ userId: USER }).toArray());

    expect(ownerBuildFlags(rows["opp-normal"])).toEqual({
      buildPlanned: false, detectedBuild: null, oppStrategyPlanned: false, detectedOppStrategy: null,
    });
    expect(ownerBuildFlags(rows["opp-disagree"])).toEqual({
      buildPlanned: false, detectedBuild: null, oppStrategyPlanned: true, detectedOppStrategy: ROACH,
    });
    expect(ownerBuildFlags(rows["opp-agree"])).toMatchObject({ oppStrategyPlanned: true, detectedOppStrategy: POOL });
    expect(ownerBuildFlags(rows["opp-from-custom"]))
      .toMatchObject({ oppStrategyPlanned: true, detectedOppStrategy: CUSTOM_ROACH });
    expect(ownerBuildFlags(rows["both-axes"])).toEqual({
      buildPlanned: true, detectedBuild: UNCLASSIFIED, oppStrategyPlanned: true, detectedOppStrategy: ROACH,
    });
    expect(ownerBuildFlags(null)).toMatchObject({ oppStrategyPlanned: false, detectedOppStrategy: null });

    const flagged = withOwnerBuildFlags(rows["opp-custom"]);
    expect(flagged).not.toHaveProperty("buildIntent");
    expect(flagged).toMatchObject({ opponent: { strategy: POOL_FIRST }, oppStrategyPlanned: true, detectedOppStrategy: POOL });
  });
});

describe("GamesService owner rows (/v1/games)", () => {
  test("list, get and findMany flag a corrected opponent build and never expose notes", async () => {
    await seedOpponentAxis(db.games, USER);
    const games = new GamesService(db);

    const { items } = await games.list(USER, { limit: 10 });
    const listed = byId(items);
    expect(listed["opp-normal"]).toMatchObject({
      opponent: { strategy: POOL }, oppStrategyPlanned: false, detectedOppStrategy: null, buildPlanned: false,
    });
    expect(listed["opp-disagree"]).toMatchObject({
      opponent: { strategy: POOL }, oppStrategyPlanned: true, detectedOppStrategy: ROACH, buildPlanned: false,
    });
    expect(listed["opp-agree"]).toMatchObject({ oppStrategyPlanned: true, detectedOppStrategy: POOL });
    expect(listed["opp-custom"]).toMatchObject({
      opponent: { strategy: POOL_FIRST }, oppStrategyPlanned: true, detectedOppStrategy: POOL,
    });
    expectNoIntentLeak(items);

    const one = await games.get(USER, "opp-from-custom");
    expect(one).toMatchObject({ oppStrategyPlanned: true, detectedOppStrategy: CUSTOM_ROACH });
    expectNoIntentLeak(one);

    const many = await games.findMany(USER, ["opp-disagree", "opp-normal"]);
    expect(many.map((row) => [row.gameId, row.oppStrategyPlanned]))
      .toEqual([["opp-disagree", true], ["opp-normal", false]]);
    expectNoIntentLeak(many);
  });
});

describe("opponent profile", () => {
  beforeEach(async () => {
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
    await seedOpponentAxis(db.games, USER, (row) => ({ ...row, buildLog: STARGATE_LOG }));
  });

  test("cursor pages carry opp_strategy_planned / detected_opp_strategy", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const page = await opponents.listGames(USER, PULSE, {});
    const rows = byId(page.items, "id");
    expect(rows["opp-normal"]).toMatchObject({
      opp_strategy: POOL, opp_strategy_planned: false, detected_opp_strategy: null, build_planned: false,
    });
    expect(rows["opp-disagree"]).toMatchObject({
      opp_strategy: POOL, opp_strategy_planned: true, detected_opp_strategy: ROACH,
    });
    expect(rows["opp-custom"]).toMatchObject({
      opp_strategy: POOL_FIRST, opp_strategy_planned: true, detected_opp_strategy: POOL,
    });
    expectNoIntentLeak(page);
  });

  test("own stats count corrections; per-strategy phase envelopes keep agreeing games only", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await opponents.getAnalysis(USER, PULSE, { includeProfile: true });

    expect(profile.byStrategy).toEqual({
      [POOL]: { wins: 3, losses: 1 },
      [POOL_FIRST]: { wins: 0, losses: 1 },
    });
    const rows = byId(profile.games, "id");
    expect(rows["opp-from-custom"]).toMatchObject({
      opp_strategy: POOL, opp_strategy_planned: true, detected_opp_strategy: CUSTOM_ROACH,
    });
    expectNoIntentLeak(profile.games);
    expectNoIntentLeak(profile.last5Games);

    // Only "opp-normal" and "opp-agree" describe what a 12 Pool looks like.
    expect(profile.phases.byStrategy.map((row) => [row.strategy, row.games]))
      .toEqual([[POOL, 2]]);
    // The aggregate envelope still covers every game.
    expect(profile.analysisSampleSize).toBe(5);
  });
});

describe("BuildsService opponent strategy rows", () => {
  beforeEach(async () => {
    await seedOpponentAxis(db.games, USER);
  });

  test("oppStrategies counts corrections toward the declared build and reports them", async () => {
    const rows = byName(await new BuildsService(db).oppStrategies(USER, {}));
    expect(rows[POOL]).toMatchObject({ total: 4, wins: 3, losses: 1, checkins: 2 });
    expect(rows[POOL_FIRST]).toMatchObject({ total: 1, wins: 0, losses: 1, checkins: 1 });
    expect(rows[ROACH]).toBeUndefined();
    expect(rows[CUSTOM_ROACH]).toBeUndefined();
  });

  test("a build's byStrategy rows carry opponent-axis checkins", async () => {
    const detail = await new BuildsService(db).detail(USER, STARGATE, {});
    const rows = byName(detail.byStrategy);
    expect(rows[POOL]).toMatchObject({ total: 4, wins: 3, losses: 1, checkins: 2 });
    expect(rows[POOL_FIRST]).toMatchObject({ total: 1, checkins: 1 });
    // The "you" axis has no check-in in this cohort.
    expect(detail.totals.checkins).toBe(0);
    expect(detail.recent.every((row) => row.planned === null)).toBe(true);
    expectNoIntentLeak(detail.recent);
  });

  test("GET /v1/opp-strategies and /v1/builds/:name serve opponent-axis checkins", async () => {
    const app = express();
    app.use("/v1", buildBuildsRouter({
      builds: new BuildsService(db),
      auth: (req, _res, next) => {
        req.auth = { userId: USER, source: "clerk" };
        next();
      },
    }));
    const res = await request(app).get("/v1/opp-strategies").expect(200);
    expect(byName(res.body)[POOL]).toMatchObject({ total: 4, checkins: 2 });
    expectNoIntentLeak(res.body);
    const detail = await request(app).get(`/v1/builds/${encodeURIComponent(STARGATE)}`).expect(200);
    expect(byName(detail.body.byStrategy)[POOL_FIRST]).toMatchObject({ total: 1, checkins: 1 });
    expect(JSON.stringify(detail.body)).not.toContain(SECRET_NOTES);
  });
});

describe("StrategyPhasesService on the opponent axis", () => {
  beforeEach(async () => {
    await seedOpponentAxis(db.games, USER, (row) => ({ ...row, buildLog: STARGATE_LOG }));
  });

  function phasesService() {
    return new StrategyPhasesService(db, { perGame: new PerGameComputeService({ games: db.games }) });
  }

  test("evaluate uses only games whose opponent label agrees with the replay", async () => {
    const phases = phasesService();
    const pool = await phases.evaluate(USER, POOL, {});
    expect(pool.total).toBe(2);
    expect(pool.comparisonGames.map((g) => g.gameId).sort()).toEqual(["opp-agree", "opp-normal"]);
    // The only Pool First game is a correction the replay disagrees with.
    await expect(phases.evaluate(USER, POOL_FIRST, {})).resolves.toBeNull();
    const scoped = await phases.evaluate(USER, POOL, { buildName: STARGATE, perspective: "opponent" });
    expect(scoped.total).toBe(2);
  });

  test("evaluateByBuildName with a strategy agrees on both axes", async () => {
    await db.games.insertOne(oppGame(USER, "you-disagree", 15, {
      myBuild: UNCLASSIFIED,
      opponent: { strategy: POOL },
      buildLog: STARGATE_LOG,
    }));
    await checkIn(db.games, USER, "you-disagree");
    const phases = phasesService();
    const scoped = await phases.evaluateByBuildName(USER, STARGATE, { strategyName: POOL });
    expect(scoped.total).toBe(2);
    expect(scoped.comparisonGames.map((g) => g.gameId).sort()).toEqual(["opp-agree", "opp-normal"]);
    // Unscoped, only the "you" axis matters: every opponent-corrected row stays.
    const unscoped = await phases.evaluateByBuildName(USER, STARGATE, {});
    expect(unscoped.total).toBe(5);
  });

  test("each cohort asks the preview iterator for the right agreeing axes", async () => {
    /** @type {any[]} */
    const captured = [];
    const disagreeingOpp = {
      gameId: "d",
      myBuild: STARGATE,
      opponent: { strategy: POOL },
      buildIntent: {
        opponent: { status: "confirmed", applied: true, build: { name: POOL }, detected: { name: ROACH, slug: null } },
      },
    };
    const phases = new StrategyPhasesService({}, {
      perGame: {
        async *iterateRulePreviewPages(_userId, opts) {
          captured.push(opts);
          yield { games: [disagreeingOpp], candidates: 1, hasMore: false };
        },
      },
    });
    await expect(phases.evaluate(USER, POOL, {})).resolves.toBeNull();
    await expect(phases.evaluate(USER, POOL, { buildName: STARGATE })).resolves.toBeNull();
    await expect(phases.evaluateByBuildName(USER, STARGATE, { strategyName: POOL })).resolves.toBeNull();
    const unscoped = await phases.evaluateByBuildName(USER, STARGATE, {});
    expect(unscoped.total).toBe(1);

    expect(captured.map((opts) => [opts.view, opts.agreeOn])).toEqual([
      ["agreeing", "opponent"],
      ["agreeing", "both"],
      ["agreeing", "both"],
      ["agreeing", "you"],
    ]);
    for (const opts of captured.slice(0, 3)) expect(opts.metadataFilter(disagreeingOpp)).toBe(false);
    expect(captured[3].metadataFilter(disagreeingOpp)).toBe(true);
  });
});

describe("replay library", () => {
  const resolveReplaySharing = async () => ({
    userId: USER,
    profile: { handle: "owner", displayName: "Owner" },
  });

  function routerDeps(library) {
    return {
      replayLibrary: library,
      users: { resolveReplaySharing, getProfile: async () => ({ displayName: "Owner" }) },
      gameVods: { resolveForGames: async () => ({ linksByGameId: {} }) },
      perGame: {
        macroBreakdown: async () => null,
        // perGame reports the owner's effective labels.
        buildOrder: async () => ({ ok: true, game_id: "opp-disagree", my_build: STARGATE, opp_strategy: POOL, events: [] }),
      },
      auth: (req, _res, next) => {
        req.auth = { userId: USER, source: "clerk" };
        next();
      },
      rateLimitPerMinute: 1_000,
    };
  }

  function makeApp(deps) {
    const app = express();
    app.use("/v1", buildPublicReplaysRouter(deps));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
  }

  beforeEach(async () => {
    await seedOpponentAxis(db.games, USER);
  });

  test("owner rows carry the effective opponent label plus oppStrategyPlanned / detectedOppStrategy", async () => {
    const library = new ReplayLibraryService(db);
    const page = await library.list(USER, {});
    const rows = byId(page.items);
    expect(rows["opp-normal"]).toMatchObject({
      opponent: { strategy: POOL }, oppStrategyPlanned: false, detectedOppStrategy: null,
    });
    expect(rows["opp-disagree"]).toMatchObject({
      opponent: { strategy: POOL }, oppStrategyPlanned: true, detectedOppStrategy: ROACH,
    });
    expect(rows["opp-custom"]).toMatchObject({
      opponent: { strategy: POOL_FIRST }, oppStrategyPlanned: true, detectedOppStrategy: POOL,
    });
    expectNoIntentLeak(page.items);

    const detail = await library.getDetail(USER, "opp-from-custom");
    expect(detail.game).toMatchObject({
      opponent: { strategy: POOL }, oppStrategyPlanned: true, detectedOppStrategy: CUSTOM_ROACH,
    });

    // The owner filters and searches by the label they see.
    const filtered = await library.list(USER, { filters: { oppStrategy: POOL } });
    expect(filtered.items.map((row) => row.gameId).sort())
      .toEqual(["opp-agree", "opp-disagree", "opp-from-custom", "opp-normal"]);
    expect((await library.list(USER, { search: "Roach" })).items).toEqual([]);
  });

  test("detector view labels, filters and searches by the classifier's opponent label", async () => {
    const library = new ReplayLibraryService(db);
    const page = await library.list(USER, { view: "detector" });
    const strategies = Object.fromEntries(page.items.map((row) => [row.gameId, row.opponent.strategy]));
    expect(strategies).toEqual({
      "opp-normal": POOL,
      "opp-disagree": ROACH,
      "opp-agree": POOL,
      "opp-custom": POOL,
      "opp-from-custom": CUSTOM_ROACH,
    });
    for (const row of page.items) {
      expect(row).not.toHaveProperty("oppStrategyPlanned");
      expect(row).not.toHaveProperty("detectedOppStrategy");
    }
    // The server-only VOD inputs follow the view too.
    expect(byId(page.sourceGames)["opp-disagree"].opponent.strategy).toBe(ROACH);
    expect(byId((await library.list(USER, {})).sourceGames)["opp-disagree"].opponent.strategy).toBe(POOL);

    const pool = await library.list(USER, { view: "detector", filters: { oppStrategy: POOL } });
    expect(pool.items.map((row) => row.gameId).sort()).toEqual(["opp-agree", "opp-custom", "opp-normal"]);
    const roach = await library.list(USER, { view: "detector", filters: { oppStrategy: ROACH } });
    expect(roach.items.map((row) => row.gameId)).toEqual(["opp-disagree"]);
    const declaredOnly = await library.list(USER, { view: "detector", filters: { oppStrategy: POOL_FIRST } });
    expect(declaredOnly.items).toEqual([]);
    const searched = await library.list(USER, { view: "detector", search: "Roach" });
    expect(searched.items.map((row) => row.gameId).sort()).toEqual(["opp-disagree", "opp-from-custom"]);

    const detail = await library.getDetail(USER, "opp-custom", { view: "detector" });
    expect(detail.game.opponent.strategy).toBe(POOL);
    expect(detail.sourceGame.opponent.strategy).toBe(POOL);
  });

  test("the public archive shows only the classifier's opponent label", async () => {
    const app = makeApp(routerDeps(new ReplayLibraryService(db)));

    const list = await request(app).get("/v1/public/replays/owner").expect(200);
    const rows = byId(list.body.items);
    expect(rows["opp-disagree"].opponent.strategy).toBe(ROACH);
    expect(rows["opp-custom"].opponent.strategy).toBe(POOL);
    expect(rows["opp-normal"].opponent.strategy).toBe(POOL);
    expect(JSON.stringify(list.body)).not.toMatch(/oppStrategyPlanned|detectedOppStrategy|Pool First/);
    expectNoIntentLeak(list.body);

    const filtered = await request(app)
      .get(`/v1/public/replays/owner?opp_strategy=${encodeURIComponent(ROACH)}`)
      .expect(200);
    expect(filtered.body.items.map((row) => row.gameId)).toEqual(["opp-disagree"]);

    const detail = await request(app).get("/v1/public/replays/owner/opp-disagree").expect(200);
    expect(detail.body.game.opponent.strategy).toBe(ROACH);
    // perGame.buildOrder reports the owner's effective label; the public
    // payload replaces it with the classifier's.
    expect(detail.body.buildOrder).toMatchObject({ my_build: STARGATE, opp_strategy: ROACH });
    expectNoIntentLeak(detail.body);
  });

  test("an owner-view row reaching the public serializer still hides the correction", async () => {
    const library = {
      list: async () => ({
        items: [{
          gameId: "x",
          myBuild: STARGATE,
          opponent: { strategy: POOL },
          oppStrategyPlanned: true,
          detectedOppStrategy: ROACH,
        }],
        sourceGames: [],
        hasMore: false,
        nextCursor: null,
      }),
      getDetail: async () => null,
    };
    const res = await request(makeApp(routerDeps(library))).get("/v1/public/replays/owner").expect(200);
    expect(res.body.items[0].opponent.strategy).toBe(ROACH);
    expect(res.body.items[0]).not.toHaveProperty("oppStrategyPlanned");
  });
});

describe("fixture sanity", () => {
  test("the seed writes the documented corrections", async () => {
    await seedOpponentAxis(db.games, USER);
    const rows = byId(await db.games.find({ userId: USER }).toArray());
    expect(Object.keys(rows).sort()).toEqual([...OPP_IDS].sort());
    expect(rows["opp-from-custom"]).toMatchObject({
      opponent: { strategy: POOL },
      buildIntent: { notes: SECRET_NOTES, opponent: { applied: true, detected: { name: CUSTOM_ROACH, slug: "roach-rush" } } },
    });
    expect(rows["opp-from-custom"]).not.toHaveProperty("_customOpponentStrategySlug");
    expect(rows["opp-custom"]._customOpponentStrategySlug).toBe("pool-first");
  });
});
