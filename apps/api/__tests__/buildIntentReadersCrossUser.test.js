// @ts-nocheck
"use strict";

/**
 * Build check-in readers, cross-user surfaces (contract §1.6 / §5): guides
 * (eligibility, samples, backfill, the nightly match, the examples
 * pipeline), Ladder Meta, admin global breakdowns + trends, fingerprint
 * population calibration and ML training labels all see the classifier's
 * label, never a declared build. A user's own guide record still counts a
 * confirmed check-in.
 *
 * Fixtures (helpers/buildIntentReadersSeed.js) per surface:
 *   "normal"              no check-in, classified 2 Stargate Phoenix;
 *   "disagree"            declared 2 Stargate Phoenix, classified Unclassified;
 *   "agree"               declared and classified 2 Stargate Phoenix;
 *   "void-over-stargate"  declared 2 Stargate Void Ray, classified 2 Stargate Phoenix;
 *   "custom-over-catalog" declared custom "DT Rush", classified 2 Stargate Phoenix.
 */

const fs = require("fs");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore } = require("../src/services/gameDetailsStore");
const {
  classifierRow,
  guideGamesMatch,
  guideIneligibilityReason,
  isGuideEligibleGame,
} = require("../src/services/guideRules");
const { GuideSamplesService, extractSample } = require("../src/services/guideSamples");
const { personalGuideStats } = require("../src/services/guidesPersonal");
const { examplesForMatchup } = require("../src/services/guideStatsExamples");
const { buildGamesPipeline } = require("../src/services/guideStatsPipelines");
const { buildGuideSamplesBackfillJob } = require("../src/jobs/guideSamplesBackfillJob");
const { buildRecomputePipeline } = require("../src/services/ladderMeta");
const { AdminGlobalService } = require("../src/services/adminGlobal");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { globalHistoryStages } = require("../src/services/adminGlobalTrendsScope");
const { buildPlayerWindowsPipeline } = require("../src/services/fingerprintPopulationCalibration");
const { MLService } = require("../src/services/ml");
const { guideUserHash } = require("../src/util/guideHash");
const {
  STARGATE,
  VOID_RAY,
  UNCLASSIFIED,
  SECRET_NOTES,
  STARGATE_REF,
  DT_REF,
  slimGame,
  checkIn,
  seedThree,
} = require("./helpers/buildIntentReadersSeed");

const USER = "u-cross";
const PEPPER = Buffer.alloc(32, 9);
const BUILD_LOG = ["[0:00] Nexus", "[0:18] Pylon", "[0:45] Gateway", "[1:30] Nexus", "[3:05] Stargate"];
const VOID_RAY_REF = { key: "pvz-2-stargate-void-ray", name: VOID_RAY, slug: null, source: "catalog" };

let mongo;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "build_intent_readers_cross_test" });
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    db.games.deleteMany({}),
    db.gameDetails.deleteMany({}),
    db.guideSamples.deleteMany({}),
    db.db.collection("jobLocks").deleteMany({}),
  ]);
});

/**
 * The three standard rows plus two declarations over a 2 Stargate Phoenix
 * replay (another catalog build, a custom build).
 * @param {(row: Record<string, any>) => Record<string, any>} [shape]
 */
async function seedAll(shape = (row) => row) {
  await seedThree(db.games, USER, shape);
  await db.games.insertMany([
    shape(slimGame(USER, "void-over-stargate", { myBuild: STARGATE, date: new Date("2026-10-13T18:00:00.000Z") })),
    shape(slimGame(USER, "custom-over-catalog", { myBuild: STARGATE, date: new Date("2026-10-14T18:00:00.000Z") })),
  ]);
  await checkIn(db.games, USER, "void-over-stargate", VOID_RAY_REF);
  await checkIn(db.games, USER, "custom-over-catalog", DT_REF);
}

/** @param {Record<string, any>} filter */
async function idsOf(filter) {
  return (await db.games.find(filter).toArray()).map((row) => row.gameId).sort();
}

describe("guide eligibility and samples", () => {
  test("guideGamesMatch drops disagreeing check-ins; ownStats keeps them", async () => {
    await seedAll();
    expect(await idsOf(guideGamesMatch("PvZ"))).toEqual(["agree", "normal"]);
    expect(await idsOf(guideGamesMatch("PvZ", { ownStats: true })))
      .toEqual(["agree", "disagree", "normal", "void-over-stargate"]);
    // The nightly pipeline starts with exactly this match.
    expect(buildGamesPipeline("PvZ")[0]).toEqual({ $match: guideGamesMatch("PvZ") });
  });

  test("JS eligibility judges the classifier's label", async () => {
    await seedAll();
    const rows = Object.fromEntries((await db.games.find({}).toArray()).map((row) => [row.gameId, row]));
    expect(guideIneligibilityReason(rows.normal)).toBeNull();
    expect(guideIneligibilityReason(rows.agree)).toBeNull();
    expect(guideIneligibilityReason(rows.disagree)).toBe("not_guide_build");
    expect(isGuideEligibleGame(rows["void-over-stargate"])).toBe(true);
    expect(isGuideEligibleGame(rows["custom-over-catalog"])).toBe(true);

    expect(classifierRow(rows.normal)).toBe(rows.normal);
    expect(classifierRow(rows["custom-over-catalog"])).toMatchObject({ myBuild: STARGATE });
    expect(classifierRow(rows["custom-over-catalog"])).not.toHaveProperty("_customBuildSlug");

    const withLog = (row) => ({ ...row, buildLog: BUILD_LOG });
    expect(extractSample(withLog(rows["void-over-stargate"]))).toMatchObject({ buildKey: STARGATE });
    expect(extractSample(withLog(rows["custom-over-catalog"]))).toMatchObject({ buildKey: STARGATE });
    expect(extractSample(withLog(rows.agree))).toMatchObject({ buildKey: STARGATE });
    expect(extractSample(withLog(rows.disagree))).toEqual({ skip: "not_guide_build" });
  });

  test("a user's own guide record counts confirmed check-ins", async () => {
    await seedAll();
    const mine = await personalGuideStats(db, {
      userId: USER,
      userHash: guideUserHash(PEPPER, USER),
      matchup: "PvZ",
      buildKey: STARGATE,
    });
    expect(mine).toMatchObject({ games: 3, wins: 2, losses: 1 });
    const voidRay = await personalGuideStats(db, {
      userId: USER,
      userHash: guideUserHash(PEPPER, USER),
      matchup: "PvZ",
      buildKey: VOID_RAY,
    });
    expect(voidRay).toMatchObject({ games: 1, wins: 1 });
  });

  test("guide examples never pick a disagreeing check-in", async () => {
    // The disagreeing row is the newest STARGATE-labelled replay.
    await seedAll((row) => ({
      ...row,
      replayFile: { storedAt: new Date("2026-10-20T00:00:00Z") },
      ...(row.gameId === "disagree" ? { date: new Date("2026-10-19T18:00:00.000Z") } : {}),
    }));
    const profiles = new Map([[USER, { handle: "owner-0123456789", displayName: "Owner" }]]);
    const byBuild = await examplesForMatchup(db.games, "PvZ", [STARGATE], profiles);
    expect(byBuild.get(STARGATE)).toEqual([expect.objectContaining({
      result: "Victory",
      playedAt: new Date("2026-10-12T18:00:00.000Z"),
    })]);
  });

  test("the samples backfill stores the classifier's label, never a declared build", async () => {
    const details = new GameDetailsService(new MongoDetailsStore(db));
    const guideSamples = new GuideSamplesService(db, { pepper: PEPPER, logger: null, disabled: false });
    await seedAll();
    for (const row of await db.games.find({}).toArray()) {
      await details.upsert(USER, row.gameId, row.date, {
        buildLog: BUILD_LOG,
        macroBreakdown: { unit_timeline: [], stats_events: [] },
      });
    }
    const job = buildGuideSamplesBackfillJob({
      db,
      guideSamples,
      gameDetails: details,
      logger: pino({ level: "silent" }),
      nowFn: () => Date.parse("2026-10-20T00:00:00.000Z"),
      sleep: jest.fn(async () => {}),
    });
    job.start({ days: 30 });
    await job.inflight;
    expect(job.status()).toMatchObject({ processed: 5, written: 4, skipped: 1, failed: 0 });
    const samples = await db.guideSamples.find({}).toArray();
    expect(samples.map((s) => s.buildKey)).toEqual([STARGATE, STARGATE, STARGATE, STARGATE]);
    expect(JSON.stringify(samples)).not.toContain(SECRET_NOTES);
  });
});

describe("ladder meta", () => {
  test("openers count the classifier's label only", async () => {
    await seedAll();
    const rows = await db.games.aggregate(buildRecomputePipeline("league", "after")).toArray();
    const band = rows.find((row) => row._id.matchup === "PvZ");
    const openers = Object.fromEntries(band.openers.map((o) => [o.build, o.games]));
    expect(openers).toEqual({ [STARGATE]: 2 });
    expect(band.n).toBe(2);
  });
});

describe("admin global", () => {
  test("build breakdowns group on the detector label", async () => {
    await seedAll();
    const service = new AdminGlobalService({ db });
    const { builds } = await service.breakdowns();
    const counts = Object.fromEntries(builds.map((row) => [row.key, row.count]));
    expect(counts).toEqual({ [STARGATE]: 4, [UNCLASSIFIED]: 1 });
  });

  test("trends remap myBuild once, in the global history snapshot", async () => {
    await seedAll();
    await db.games.insertOne(slimGame(USER, "unlabelled-override", { date: new Date("2026-10-15T18:00:00Z") }));
    await checkIn(db.games, USER, "unlabelled-override", STARGATE_REF);
    const rows = Object.fromEntries(
      (await db.games.aggregate(globalHistoryStages()).toArray()).map((row) => [row.gameId, row]),
    );
    expect(rows.disagree.myBuild).toBe(UNCLASSIFIED);
    expect(rows["void-over-stargate"].myBuild).toBe(STARGATE);
    expect(rows["custom-over-catalog"].myBuild).toBe(STARGATE);
    expect(rows["unlabelled-override"]).not.toHaveProperty("myBuild");
    expect(rows.disagree).not.toHaveProperty("buildIntent");

    const service = new AdminGlobalTrendsService({ db });
    const options = await service.filterOptions({});
    expect(options.builds).toEqual([STARGATE, UNCLASSIFIED]);
  });
});

describe("fingerprint population calibration", () => {
  test("player windows carry the detector label", async () => {
    await seedAll();
    const [group] = await db.games.aggregate(buildPlayerWindowsPipeline()).toArray();
    expect(group).toMatchObject({ userId: USER, matchup: "PvZ" });
    expect(group.rows.map((row) => row.myBuild).sort())
      .toEqual([STARGATE, STARGATE, STARGATE, STARGATE, UNCLASSIFIED]);
  });
});

describe("ML training labels", () => {
  test("training rows use the classifier's label", async () => {
    await seedAll((row) => ({ ...row, buildLog: BUILD_LOG }));
    const ml = new MLService({ games: db.games });
    const prepared = await ml._writeTrainingNdjson(USER);
    try {
      const rows = fs.readFileSync(prepared.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const labels = Object.fromEntries(rows.map((row) => [row.gameId, row.myBuild]));
      expect(labels).toEqual({
        normal: STARGATE,
        disagree: UNCLASSIFIED,
        agree: STARGATE,
        "void-over-stargate": STARGATE,
        "custom-over-catalog": STARGATE,
      });
      expect(JSON.stringify(rows)).not.toMatch(/buildIntent|secret plan/);
    } finally {
      fs.rmSync(prepared.path, { force: true });
    }
  });
});
