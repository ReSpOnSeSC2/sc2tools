// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { UserRevision } = require("../src/util/userRevision");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { BuildIntentGameState } = require("../src/services/buildIntentGameState");
const { BuildIntentBind } = require("../src/services/buildIntentBind");
const { applyOverridePipeline } = require("../src/services/buildIntentAttribution");
const { original: ownStages } = require("./helpers/corpusStamp");
let mongo, db, revisions;
const row = () => ({ userId: "a", gameId: "game", date: new Date(), result: "Victory", myRace: "Protoss", map: "Site Delta LE", durationSec: 600,
  myBuild: "Unclassified", matchFormat: "1v1", opponent: { race: "Zerg" }, buildLog: ["[0:40] Gateway"] });
const definition = { slug: "opener", name: "Gateway opener", race: "Protoss", vsRace: "Zerg", perspective: "you", rules: [{ type: "before", name: "BuildGateway", time_lt: 90 }] };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "revision_attribution_writers" }); });
afterAll(async () => { await db.close(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks(); for (const key of ["users", "games", "customBuilds", "customBuildJobs", "buildIntentLive"]) await db[key].deleteMany({});
  await db.users.insertOne({ userId: "a", preferences: { buildCheckin: { enabled: true } } }); await db.games.insertOne(row());
  revisions = new UserRevision(db.users, { enabled: true });
});
test("standalone rename changes applied labels and retires only after the public save", async () => {
  const custom = new CustomBuildsService(db, { userRevision: revisions });
  await db.customBuilds.insertOne({ ...definition, userId: "a" });
  await db.games.updateOne({ userId: "a" }, { $set: { myBuild: definition.name, _customBuildSlug: "opener",
    buildIntent: { applied: true, build: { source: "custom", slug: "opener", name: definition.name } } } });
  const before = await revisions.snapshot("a"); await custom.upsert("a", { ...definition, name: "Renamed opener" });
  expect((await db.games.findOne({ userId: "a" })).myBuild).toBe("Renamed opener"); expect(revisions.current(before)).toBe(false);
});
test("transaction callback completion cannot end the fence before commit, including commit failure", async () => {
  let finishCommit, reachedCommit; const error = new Error("unknown transaction commit"), atCommit = new Promise((resolve) => { reachedCommit = resolve; });
  const actualStart = db.client.startSession.bind(db.client), session = actualStart();
  const dispose = jest.spyOn(session, "endSession");
  jest.spyOn(session, "withTransaction").mockImplementation(async (work) => {
    await work(session); await new Promise((resolve) => { finishCommit = resolve; reachedCommit(); }); throw error;
  });
  jest.spyOn(db.client, "startSession").mockImplementation((options) => options === undefined ? session : actualStart(options));
  const custom = new CustomBuildsService(db, { userRevision: revisions });
  const before = await revisions.snapshot("a"); const saving = custom.upsert("a", definition); const outcome = saving.catch((failure) => failure);
  await Promise.race([atCommit, outcome]);
  expect(finishCommit).toEqual(expect.any(Function)); expect(revisions.current(await revisions.snapshot("a"))).toBe(false);
  finishCommit(); expect(await outcome).toBe(error); expect(revisions.current(before)).toBe(false); expect(session.endSession).toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1);
});
test("single/all promotions and quick tag retire; staging alone never increments", async () => {
  await db.customBuilds.insertOne({ ...definition, userId: "a" });
  const perGame = new PerGameComputeService(db); const custom = new CustomBuildsService(db, { perGame, userRevision: revisions });
  const original = db.games.bulkWrite.bind(db.games);
  const staged = jest.spyOn(db.games, "bulkWrite").mockImplementation(async (...args) => {
    const before = await db.users.findOne({ userId: "a" }); const result = await original(...args);
    expect((await db.users.findOne({ userId: "a" })).dataRev).toBe(before.dataRev); return result;
  });
  for (const run of [() => custom.reclassify("a", "opener"), () => custom.reclassifyAll("a", { clearUnmatched: true }), () => custom.tagSingleGame("a", row())]) {
    const before = await revisions.snapshot("a"); await run(); expect(revisions.current(before)).toBe(false);
  }
  expect(staged).toHaveBeenCalled(); expect((await db.users.findOne({ userId: "a" })).dataRev).toBe(3);
});
test.each(["reclassify", "reclassifyAll", "tagSingleGame"])("%s's unknown promotion outcome retires without changing the error", async (method) => {
  await db.customBuilds.insertOne({ ...definition, userId: "a" });
  const custom = new CustomBuildsService(db, { perGame: new PerGameComputeService(db), userRevision: revisions });
  const name = method === "tagSingleGame" ? "findOneAndUpdate" : "updateMany", original = db.games[name].bind(db.games), error = new Error("unknown promote");
  const before = await revisions.snapshot("a");
  let injections = 0;
  const spy = jest.spyOn(db.games, name).mockImplementation(async (...args) => {
    const [filter, update] = args;
    const promotion = filter.userId === "a" && (method === "tagSingleGame"
      ? filter.gameId === "game"
      : typeof filter["_customBuildReclassify.runId"] === "string"
        && filter["_customBuildReclassify.runId"].length > 0
        && Array.isArray(update) && Object.hasOwn(ownStages(update)[0]?.$set || {}, "myBuild"));
    if (!promotion || injections) return original(...args);
    injections += 1;
    expect(revisions.current(before)).toBe(false);
    expect((await db.games.findOne({ userId: "a", gameId: "game" })).myBuild).toBe("Unclassified");
    const result = await original(...args);
    if (name === "updateMany") {
      expect(result.matchedCount).toBe(1); expect(result.modifiedCount).toBe(1);
    }
    expect(await db.games.findOne({ userId: "a", gameId: "game" })).toMatchObject({ myBuild: definition.name, _customBuildSlug: "opener" });
    expect(revisions.current(before)).toBe(false);
    throw error;
  });
  const run = method === "reclassify" ? custom.reclassify("a", "opener") : method === "reclassifyAll" ? custom.reclassifyAll("a") : custom.tagSingleGame("a", row());
  await expect(run).rejects.toBe(error); spy.mockRestore(); expect(revisions.current(before)).toBe(false);
  expect(injections).toBe(1);
});
test("confirm/skip/opponent/note/defer/dismiss writes retire independently of notifier labels", async () => {
  const ref = { key: "custom:opener", source: "custom", slug: "opener", name: definition.name };
  const notifier = { changed: jest.fn(), gamesChanged: jest.fn() }, options = { invalidate: jest.fn(), forMatchup: async () => null, forOpponent: async () => null };
  const state = new BuildIntentGameState({ db, notifier, options, userRevision: revisions });
  state._resolveConfirmKey = async () => ref; state._resolveOpponentKey = async () => ref; state.serialize = async (_owner, after) => after;
  for (const body of [{ action: "confirm", buildKey: ref.key }, { action: "notes", notes: "private" }, { action: "opponent", opponentBuildKey: ref.key }, { action: "skip" }, { action: "defer" }]) {
    const before = await revisions.snapshot("a"); await state.put("a", "game", body, { source: "clerk" }); expect(revisions.current(before)).toBe(false);
  }
  await db.games.updateOne({ userId: "a" }, { $set: { "buildIntent.status": "pending" } });
  const before = await revisions.snapshot("a"); await state.dismissPending("a", { source: "clerk" }); expect(revisions.current(before)).toBe(false);
});
test("pending and claimed ingest binding retire their actual game attempts", async () => {
  const binder = new BuildIntentBind({ db, notifier: { changed: jest.fn() }, options: { invalidate: jest.fn() }, userRevision: revisions });
  binder._suggest = async () => null;
  let before = await revisions.snapshot("a"); await binder._markPending("a", row(), row()); expect(revisions.current(before)).toBe(false);
  binder._plan = async () => ({ status: "confirmed", pipeline: applyOverridePipeline({ key: "custom:opener", source: "custom", slug: "opener", name: definition.name }, { updatedAt: new Date(), gameKey: "live" }) });
  const current = await db.games.findOne({ userId: "a" }); before = await revisions.snapshot("a");
  await binder._bindClaimed("a", row(), current, { gameKey: "live" }); expect(revisions.current(before)).toBe(false);
  expect((await db.games.findOne({ userId: "a" })).myBuild).toBe(definition.name);
});
