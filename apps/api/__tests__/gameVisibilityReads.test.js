// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { computeStreak } = require("../src/services/overlayLiveAggregations");
const { CommunityService, K_ANONYMITY_THRESHOLD } = require("../src/services/community");
const { OpponentsService } = require("../src/services/opponents");
const { OpponentIdentityMatcherService } = require("../src/services/opponentIdentityMatcher");
const { AdminGlobalService } = require("../src/services/adminGlobal");
const { globalHistoryStages } = require("../src/services/adminGlobalTrendsScope");
const { guideGamesMatch, isGuideEligibleGame } = require("../src/services/guideRules");
const { buildSampleTotalsPipeline } = require("../src/services/guideStatsSamplePipelines");
const { LeaguePercentilesService } = require("../src/services/leaguePercentiles");
const { buildRecomputePipeline: ladderPipeline } = require("../src/services/ladderMeta");
const { buildPlayerWindowsPipeline } = require("../src/services/fingerprintPopulationCalibration");
const { slimGame, sampleRow } = require("./helpers/guideStatsSeed");

let mongo, db;
const pulseId = "1-S2-1-500";
function row(gameId, patch = {}) {
  return { userId: "owner", gameId, date: new Date("2026-10-24T12:00:00Z"), result: "Win",
    myRace: "Protoss", myToonHandle: "1-S2-1-main", myMmr: 4000, isLadderGame: true,
    playerCount: 2, matchFormat: "1v1", durationSec: 600, map: "Visible map",
    opponent: { pulseId, displayName: "Synthetic Foe", race: "Zerg" }, ...patch };
}
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "game_visibility_reads" });
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({}), db.guideSamples.deleteMany({}), db.communityReports.deleteMany({})]);
});

test("overlay streak ignores hidden and both deletion states before its20-row cap", async () => {
  await db.games.insertMany([
    ...Array.from({ length: 3 }, (_, i) => row(`visible-${i}`, { date: new Date(1000 + i) })),
    ...Array.from({ length: 30 }, (_, i) => row(`hidden-${i}`, { excluded: true, result: "Loss" })),
    row("deleted", { _deleted: true, result: "Loss" }), row("pending", { _deletionPending: true, result: "Loss" }),
  ]);
  expect(await computeStreak(db.games, "owner")).toEqual({ kind: "win", count: 3 });
  await db.games.updateOne({ gameId: "hidden-0" }, { $unset: { excluded: "" } });
  expect(await computeStreak(db.games, "owner")).toBeNull();
});

test("public k-floor drops hidden owner contributions, retains another uploader and restores on unhide", async () => {
  const service = new CommunityService(db);
  const n = K_ANONYMITY_THRESHOLD || 5;
  await db.games.insertMany(Array.from({ length: n }, (_, i) => row("same-replay", { userId: `owner-${i}` })));
  expect(await service.opponentProfileAvailable(pulseId)).toBe(true);
  await db.games.updateOne({ userId: "owner-0" }, { $set: { excluded: true } });
  service.invalidateForUser("owner-0");
  expect(await service.opponentProfileAvailable(pulseId)).toBe(false);
  const { filter } = await service._opponentScope(pulseId);
  expect(await db.games.countDocuments(filter)).toBe(n - 1);
  expect(await db.games.countDocuments({ ...filter, userId: "owner-1" })).toBe(1);
  await db.games.updateOne({ userId: "owner-0" }, { $unset: { excluded: "" } });
  service.invalidateForUser("owner-0");
  expect(await service.opponentProfileAvailable(pulseId)).toBe(true);
  for (const flag of ["_deleted", "_deletionPending"]) {
    await db.games.updateOne({ userId: "owner-0" }, { $set: { [flag]: true } });
    service.invalidateForUser("owner-0");
    expect(await service.opponentProfileAvailable(pulseId)).toBe(false);
    await db.games.updateOne({ userId: "owner-0" }, { $unset: { [flag]: "" } });
  }
});

test("opponent matching and dossier account scope reject hidden rows and empty scoped totals do not fall back", async () => {
  await db.opponents.insertOne({ userId: "owner", pulseId, displayNameSample: "Synthetic Foe", gameCount: 99, wins: 80, losses: 19 });
  await db.games.insertMany([
    row("visible", { myToonHandle: "1-S2-1-111", result: "Victory" }), row("alt", { myToonHandle: "2-S2-1-222", result: "Defeat" }),
    row("hidden", { myToonHandle: "1-S2-1-111", excluded: true }), row("deleted", { myToonHandle: "1-S2-1-111", _deleted: true }), row("pending", { myToonHandle: "1-S2-1-111", _deletionPending: true }),
  ]);
  const matcher = new OpponentIdentityMatcherService(db);
  expect((await matcher._targetGames("owner", { pulseId })).map((g) => g.gameId).sort()).toEqual(["alt", "visible"]);
  const service = new OpponentsService(db);
  const profile = await service.get("owner", pulseId, { filters: { accounts: ["1-S2-1-111"] } });
  expect(profile.games).toHaveLength(1);
  expect(profile.games[0].result).toBe("Victory");
  expect(profile.totals).toMatchObject({ total: 1, wins: 1, losses: 0 });
  const empty = await service.get("owner", pulseId, { filters: { accounts: ["1-S2-1-999"] } });
  expect(empty.games).toEqual([]);
  expect(empty.totals).toMatchObject({ total: 0, wins: 0, losses: 0 });
});

test("global canonical history filters before dedupe, retaining a visible copy from another owner", async () => {
  await db.games.insertMany([
    row("shared", { userId: "hidden-uploader", excluded: true, updatedAt: new Date("2026-10-25") }),
    row("shared", { userId: "visible-uploader" }),
    row("gone", { _deleted: true }), row("pending", { _deletionPending: true }),
  ]);
  const result = await db.games.aggregate([...globalHistoryStages(), { $project: { userId: 1, gameId: 1 } }]).toArray();
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ userId: "visible-uploader", gameId: "shared" });
  const admin = new AdminGlobalService({ db });
  expect((await admin.listPlayerGames(pulseId)).items.map((g) => g.userId)).toEqual(["visible-uploader"]);
  expect((await admin.breakdowns()).maps).toEqual([expect.objectContaining({ key: "Visible map", count: 1 })]);
});

test("a delayed opponent date overlay cannot overwrite an intervening visibility recount", async () => {
  const before = new Date("2026-01-01"), snapshot = new Date("2026-10-24"), recounted = new Date("2026-08-01");
  await db.opponents.insertOne({ userId: "owner", pulseId, lastSeen: before });
  let resume, started;
  const held = new Promise((resolve) => { resume = resolve; });
  const queried = new Promise((resolve) => { started = resolve; });
  const aggregate = jest.spyOn(db.games, "aggregate").mockReturnValue({
    async *[Symbol.asyncIterator]() { started(); await held; yield { _id: pulseId, latestDate: snapshot, latestRace: null, races: [] }; },
  });
  try {
    const response = [{ pulseId, lastSeen: before }];
    const work = new OpponentsService(db)._overlayLatestSeenFromGames("owner", response);
    await queried;
    await db.opponents.updateOne({ userId: "owner", pulseId }, { $set: { lastSeen: recounted } });
    resume(); await work;
    expect(response[0].lastPlayed).toEqual(snapshot);
    expect((await db.opponents.findOne({ userId: "owner", pulseId })).lastSeen).toEqual(recounted);
  } finally { aggregate.mockRestore(); resume(); }
});

test("guide JS eligibility and Mongo source agree on visibility, including reversible samples before cap/floor", async () => {
  const fixtures = [slimGame({ gameId: "visible" }), ...["excluded", "_deleted", "_deletionPending"].map((flag) => slimGame({ gameId: flag, [flag]: true }))];
  await db.games.insertMany(fixtures);
  expect(fixtures.filter(isGuideEligibleGame).map((g) => g.gameId)).toEqual(["visible"]);
  expect((await db.games.find(guideGamesMatch("PvZ")).toArray()).map((g) => g.gameId)).toEqual(["visible"]);
  const pipeline = buildSampleTotalsPipeline("PvZ");
  const cap = pipeline.findIndex((step) => step.$setWindowFields);
  await db.guideSamples.insertMany([
    sampleRow({ gameHash: "visible-sample" }), ...["excluded", "_deleted", "_deletionPending"].map((flag) => sampleRow({ gameHash: flag, [flag]: true })),
  ]);
  expect(cap).toBeGreaterThan(0);
  expect(await db.guideSamples.countDocuments(pipeline[0].$match)).toBe(1);
  await db.guideSamples.updateOne({ gameHash: "excluded" }, { $unset: { excluded: "" } });
  expect(await db.guideSamples.countDocuments(pipeline[0].$match)).toBe(2);
});

test("future public corpus rebuilds remove each visibility marker before population windows", async () => {
  await db.games.insertMany([
    slimGame({ userId: "owner", gameId: "visible", macroScore: 60 }),
    ...["excluded", "_deleted", "_deletionPending"].map((flag) => slimGame({ userId: "owner", gameId: flag, macroScore: 999, [flag]: true })),
  ]);
  const fingerprint = await db.games.aggregate(buildPlayerWindowsPipeline()).toArray();
  expect(fingerprint).toHaveLength(1); expect(fingerprint[0].rows).toHaveLength(1);
  expect(await db.games.countDocuments(ladderPipeline()[0].$match)).toBe(1);
  const service = new LeaguePercentilesService(db);
  await service.recompute();
  const tables = await db.db.collection("league_percentiles").find({}).toArray();
  expect(tables).toHaveLength(1); expect(tables[0].n).toBe(1); expect(tables[0].metrics.macroScore.n).toBe(1);
});
