// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError } = require("mongodb");
const pino = require("pino");
const { randomUUID: uuid } = require("crypto");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { immutableMacroSurface, carryUnchangedGameStats } = require("../src/services/gameStatsCountNeutral");
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");
let mongo, mongoChild, db, dbB, clientB, writer, writerB, games, perGame;
const userId = "neutral-owner", played = new Date("2026-10-20T12:00:00Z"), commands = [];
const change = () => ({ kind: "macroSurface", gameId: "game", macroScore: 74, top3Leaks: [{ name: "idle", amount: 2 }] });
const ownerRow = () => db.users.findOne({ userId });
const gameQueries = rows => rows.filter(c => c.find === "games" || c.aggregate === "games" || c.count === "games");
async function seed(rows = [{ gameId: "game", date: played, macroScore: 10 }]) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() });
  if (rows.length) await db.games.insertMany(rows.map(row => ({ userId, ...row })));
  const owner = await ownerRow(), stats = await games.stats(userId), revision = uuid();
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", revision, ownerId: owner._id, epoch: owner.gameStatsMutationEpoch } } });
  return ownerRow();
}
beforeAll(async () => {
  // One cached member, no downloads: the admitted runner sets RUNTIME_DOWNLOAD=false.
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`game_revision_carry_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "game_revision_carry", awaitBackgroundIndexes: true }, { logger: pino({ level: "silent" }) });
  clientB = new MongoClient(mongo.getUri(), { monitorCommands: true }); await clientB.connect();
  const databaseB = clientB.db("game_revision_carry");
  dbB = { ...db, client: clientB, db: databaseB, users: databaseB.collection("users"), games: databaseB.collection("games") };
  writer = gameStatsWritesFor(db); writerB = gameStatsWritesFor(dbB); games = new GamesService(db); perGame = new PerGameComputeService(db);
  for (const client of [db.client, clientB]) client.on("commandStarted", event => commands.push(event.command));
  expect(db.gameStatsTransactions).toBe(true);
});
afterAll(async () => {
  try { await writer?.stopAndDrain(); await writerB?.stopAndDrain(); await clientB?.close(); await db?.close(); }
  finally {
    await mongo?.stop();
    if (mongoChild) {
      expect(mongoChild.exitCode !== null || mongoChild.signalCode !== null).toBe(true);
      process.stdout.write(`game_revision_carry_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => { jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({}); commands.length = 0; });

test("macro carries exact Mongo stats without stats reads, using one owner/game/tuple transaction", async () => {
  const before = await seed([{ gameId: "game", date: played, macroScore: 10 }, { gameId: "null-date", date: null },
    { gameId: "array-excluded", date: played, excluded: [true] }, { gameId: "resumed", date: played, isResumedFromReplay: true }]);
  commands.length = 0; await perGame.writeMacroBreakdown(userId, "game", { macroScore: 74, top3Leaks: [{ name: "idle", amount: 2 }], breakdown: {} });
  const operation = [...commands], after = await ownerRow();
  expect(gameQueries(operation)).toEqual([]);
  expect(after.gameStats).toEqual({ total: 2, latest: played }); expect(after.gameStats).toEqual(await games.stats(userId));
  expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision);
  expect(after.gameStatsMaintenance).toMatchObject({ version: MAINTENANCE_VERSION, status: "ready", revision: after.gameStatsRevision, ownerId: after._id, epoch: before.gameStatsMutationEpoch });
  expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(after.gameStats);
  const claim = operation.find(c => c.findAndModify === "users"), update = operation.find(c => c.update === "games"), commit = operation.find(c => c.commitTransaction);
  expect(claim).toMatchObject({ startTransaction: true, autocommit: false, upsert: false, new: false, readConcern: { level: "snapshot" } });
  expect(claim.readConcern.afterClusterTime).toBeDefined();
  expect(update.lsid).toEqual(claim.lsid); expect(update.txnNumber).toEqual(claim.txnNumber); expect(update.autocommit).toBe(false);
  expect(update.updates).toHaveLength(1); expect(update.updates[0]).toMatchObject({ q: { userId, gameId: "game", _deleted: { $ne: true }, _deletionPending: { $ne: true } }, upsert: false });
  expect(Object.keys(update.updates[0].u.$set).sort()).toEqual(["_schemaVersion", "macroScore", "top3Leaks"]);
  expect(commit.writeConcern).toMatchObject({ w: "majority", j: true });
});

test.each([{ rows: [] }, { rows: [{ gameId: "game", date: null }] }])("zero/positive totals with null latest carry without creating a missing game (%#)", async ({ rows }) => {
  const before = await seed(rows); commands.length = 0;
  await writer.write(await writer.capture(userId), change());
  const operation = [...commands], after = await ownerRow(); expect(gameQueries(operation)).toEqual([]);
  expect(after.gameStats).toEqual({ total: rows.length, latest: null }); expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision);
  expect(await db.games.countDocuments({ userId })).toBe(rows.length);
});

test.each(["protocol1", "maintenance1", "unsupported-latest"])("unqualified %s proof is retired without recount and authoritative fallback remains exact", async state => {
  const before = await seed([{ gameId: "game", date: state === "unsupported-latest" ? "truthy raw BSON date" : played }]);
  if (state === "protocol1") await db.users.updateOne({ userId }, { $set: { gameStatsProtocolVersion: 1 } });
  if (state === "maintenance1") await db.users.updateOne({ userId }, { $set: { "gameStatsMaintenance.version": 1 } });
  if (state === "unsupported-latest") await db.users.updateOne({ userId }, { $set: { "gameStatsMaintenance.status": "unsupported_latest" } });
  commands.length = 0; await writer.write(await writer.capture(userId), change());
  const operation = [...commands], after = await ownerRow(); expect(gameQueries(operation)).toEqual([]);
  expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined(); expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision);
  expect(readyStatsFromOwnerRow(after, userId, true)).toBeNull(); expect(await games.stats(userId)).toEqual(before.gameStats);
});

test("independent-client ingest and macro carry serialize without losing a maintained count", async () => {
  await seed(); const ownerB = await writerB.capture(userId), later = new Date("2026-10-21T12:00:00Z");
  await Promise.all([perGame.writeMacroBreakdown(userId, "game", { macroScore: 74, breakdown: {} }),
    writerB.write(ownerB, session => dbB.games.insertOne({ userId, gameId: "concurrent", date: later }, { session }), { selection: { gameIds: ["concurrent"] } })]);
  const after = await ownerRow(); expect(after.gameStats).toEqual({ total: 2, latest: later }); expect(after.gameStats).toEqual(await games.stats(userId));
  expect(after.gameStatsMaintenance.revision).toBe(after.gameStatsRevision); expect((await db.games.findOne({ userId, gameId: "game" })).macroScore).toBe(74);
});

test("transient retry repeats only fixed Mongo macro work; details publish once after commit", async () => {
  await seed(); const originalUpdate = db.games.updateOne.bind(db.games); let injected = false;
  jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => {
    const result = await originalUpdate(...args);
    if (args[2]?.session && !injected) { injected = true; const error = new MongoServerError({ message: "transient after actual macro write" }); error.addErrorLabel("TransientTransactionError"); throw error; }
    return result;
  });
  const upload = jest.fn(async () => { expect((await ownerRow()).gameStatsMaintenance.revision).toBe((await ownerRow()).gameStatsRevision); });
  const service = new PerGameComputeService(db, { gameDetails: { upsert: upload } });
  await service.writeMacroBreakdown(userId, "game", { macroScore: 74, breakdown: { raw: {} } });
  expect(injected).toBe(true); expect(upload).toHaveBeenCalledTimes(1); expect((await ownerRow()).gameStats).toEqual(await games.stats(userId));
});

test.each(["game", "tuple-publication"])("a %s error aborts both real macro content and new authority", async stage => {
  const before = await seed(), original = new Error("macro command outcome");
  if (stage === "game") {
    const update = db.games.updateOne.bind(db.games);
    jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => { await update(...args); throw original; });
  } else {
    const update = db.users.updateOne.bind(db.users);
    jest.spyOn(db.users, "updateOne").mockImplementation(async (...args) => { const result = await update(...args); if (args[2]?.session) throw original; return result; });
  }
  await expect(writer.write(await writer.capture(userId), change())).rejects.toBe(original);
  expect((await ownerRow()).gameStatsRevision).toBe(before.gameStatsRevision); expect((await ownerRow()).gameStats).toEqual(before.gameStats);
  expect((await db.games.findOne({ userId, gameId: "game" })).macroScore).toBe(10);
});

test.each(["retry-ack", "unknown-after-commit"])("commit %s keeps atomic macro/stats outcome", async state => {
  const before = await seed(), owner = await writer.capture(userId), start = db.client.startSession.bind(db.client); let commits = 0;
  const unknown = new MongoServerError({ message: "ambiguous return after actual macro commit" });
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); commits++;
      if (state === "unknown-after-commit") throw unknown;
      if (commits === 1) { const error = new MongoNetworkError("lost macro commit acknowledgement"); error.addErrorLabel("UnknownTransactionCommitResult"); throw error; }
    }; return session;
  });
  const task = writer.write(owner, change());
  if (state === "retry-ack") { await task; expect(commits).toBe(2); } else await expect(task).rejects.toBe(unknown);
  const after = await ownerRow(); expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision);
  expect(after.gameStatsMaintenance.revision).toBe(after.gameStatsRevision); expect(after.gameStats).toEqual(before.gameStats);
  expect((await db.games.findOne({ userId, gameId: "game" })).macroScore).toBe(74);
});

test.each(["removed", "replacement", "active-fence", "released-new-epoch"])("captured macro owner cannot write after %s", async state => {
  await seed(); const owner = await writer.capture(userId);
  if (state === "removed" || state === "replacement") await db.users.deleteOne({ userId });
  if (state === "replacement") await db.users.insertOne({ userId });
  if (state === "active-fence") await db.users.updateOne({ userId }, { $set: { _gdprMutation: { id: uuid() } } });
  if (state === "released-new-epoch") await db.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } });
  commands.length = 0; await expect(writer.write(owner, change())).rejects.toThrow("game_stats_authority_changed");
  expect(commands.filter(c => c.update === "games")).toEqual([]); expect((await db.games.findOne({ userId, gameId: "game" })).macroScore).toBe(10);
});

test("internal session-aware body composes with an existing transaction without nesting", async () => {
  const before = await seed(), owner = await writer.capture(userId), session = db.client.startSession({ causalConsistency: true });
  const floor = statsReadFloorFor(db)(); session.advanceOperationTime(await floor);
  const mutation = immutableMacroSurface(change());
  const starts = jest.spyOn(db.client, "startSession");
  try {
    await session.withTransaction(async () => {
      await carryUnchangedGameStats(db, owner, mutation, session);
      await db.users.updateOne({ _id: owner.id }, { $set: { composedMarker: true } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true }, readPreference: "primary" });
  } finally { await session.endSession(); }
  expect(starts).not.toHaveBeenCalled(); const after = await ownerRow();
  expect(after.composedMarker).toBe(true); expect(after.gameStats).toEqual(before.gameStats); expect(after.gameStatsMaintenance.revision).toBe(after.gameStatsRevision);
});
