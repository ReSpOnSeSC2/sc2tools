// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { UserRevision } = require("../src/util/userRevision");
const { GamesService } = require("../src/services/games");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { OpponentsService } = require("../src/services/opponents");
let mongo, db, revisions;
const game = (overrides = {}) => ({ gameId: "game", date: new Date(), result: "Victory", myRace: "Protoss", map: "Site Delta LE", durationSec: 600,
  opponent: { race: "Zerg", pulseId: "opponent" }, ...overrides });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "revision_game_writers" }); });
afterAll(async () => { await db.close(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({});
  await db.users.insertOne({ userId: "a" }); revisions = new UserRevision(db.users, { enabled: true });
});
test("insert, existing-row reupload and quarantine retire real chart inputs without io", async () => {
  const games = new GamesService(db, { userRevision: revisions });
  for (const operation of [() => games.upsert("a", game()), () => games.upsert("a", game({ macroScore: 88 })),
    () => games.quarantineResumedReplay("a", game())]) {
    const before = await revisions.snapshot("a"); await operation(); expect(revisions.current(before)).toBe(false);
  }
  expect((await db.users.findOne({ userId: "a" })).dataRev).toBe(3);
  expect(await db.games.findOne({ userId: "a", gameId: "game" })).toMatchObject({ macroScore: 88, isResumedFromReplay: true });
});
test("an upsert's lost acknowledgement preserves its rejection and retires the committed row", async () => {
  const games = new GamesService(db, { userRevision: revisions }); const original = db.games.updateOne.bind(db.games), error = new Error("unknown commit");
  await db.games.insertOne({ ...game(), userId: "a" });
  jest.spyOn(db.games, "updateOne").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  const before = await revisions.snapshot("a"); await expect(games.upsert("a", game({ macroScore: 83 }))).rejects.toBe(error);
  expect(await db.games.countDocuments({ userId: "a" })).toBe(1); expect(revisions.current(before)).toBe(false);
  expect((await db.games.findOne({ userId: "a" })).macroScore).toBe(83);
  expect((await db.users.findOne({ userId: "a" })).dataRev).toBe(1);
});
test("quarantine's partial bulk transition retires even when the driver rejects", async () => {
  const games = new GamesService(db, { userRevision: revisions }); await db.games.insertOne({ ...game(), userId: "a" });
  const original = db.games.updateMany.bind(db.games), error = new Error("partial quarantine");
  jest.spyOn(db.games, "updateMany").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  const before = await revisions.snapshot("a"); await expect(games.quarantineResumedReplay("a", game())).rejects.toBe(error);
  expect((await db.games.findOne({ userId: "a" })).isResumedFromReplay).toBe(true); expect(revisions.current(before)).toBe(false);
});
test("macro slim commit survives later detail failure and always retires old means/leak filters", async () => {
  await db.games.insertOne({ ...game(), userId: "a" }); const error = new Error("details unavailable");
  const compute = new PerGameComputeService(db, { userRevision: revisions, gameDetails: { upsert: async () => { throw error; } } });
  const before = await revisions.snapshot("a");
  await expect(compute.writeMacroBreakdown("a", "game", { macroScore: 73, top3Leaks: [{ name: "Supply Blocked" }], breakdown: {} })).rejects.toBe(error);
  expect(await db.games.findOne({ userId: "a" })).toMatchObject({ macroScore: 73, top3Leaks: [{ name: "Supply Blocked" }] });
  expect(revisions.current(before)).toBe(false);
});
test("swallowed region/identity write failures still retire filter membership", async () => {
  await db.games.insertOne({ ...game(), userId: "a" });
  const opponents = new OpponentsService(db, Buffer.alloc(32), { userRevision: revisions });
  for (const [method, collectionMethod, args] of [
    ["_stampGameRegion", "updateOne", ["a", "game", {}, { region: "EU" }]],
    ["_backfillGameIdentity", "updateMany", ["a", "opponent", { region: "NA", pulseCharacterId: "123" }]],
  ]) {
    const original = db.games[collectionMethod].bind(db.games); const before = await revisions.snapshot("a");
    const spy = jest.spyOn(db.games, collectionMethod).mockImplementationOnce(async (...input) => { await original(...input); throw new Error("lost stamp ack"); });
    await opponents[method](...args); spy.mockRestore(); expect(revisions.current(before)).toBe(false);
  }
  expect((await db.games.findOne({ userId: "a" })).opponent.region).toBe("NA");
});
test("disabled real writers add no revision command and retain legacy outcomes", async () => {
  const disabled = new UserRevision(db.users, { enabled: false }); const spy = jest.spyOn(db.users, "findOneAndUpdate");
  const games = new GamesService(db, { userRevision: disabled });
  expect(await games.upsert("a", game())).toBe(true); expect(await games.upsert("a", game())).toBe(false);
  expect(spy).not.toHaveBeenCalled(); expect((await db.users.findOne({ userId: "a" })).dataRev).toBeUndefined();
});
