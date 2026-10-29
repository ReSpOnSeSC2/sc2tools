// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError } = require("mongodb");
const pino = require("pino");
const { randomUUID: uuid } = require("crypto");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { BuildIntentGameState } = require("../src/services/buildIntentGameState");
const { BuildIntentBind } = require("../src/services/buildIntentBind");
const { applyOverridePipeline, clearOverridePipeline, mergeIntentPipeline, applyOpponentOverridePipeline } = require("../src/services/buildIntentAttribution");
let mongo, mongoChild, db, clientB, dbB, writer, writerB, games;
const userId = "build-state-owner", played = new Date("2026-10-20T12:00:00Z"), commands = [];
const ref = { key: "custom:opener", name: "$literal opener", slug: "opener", source: "custom" };
const baseGame = () => ({ gameId: "game", date: played, myRace: "Protoss", opponent: { race: "Zerg", displayName: "Opp", strategy: "Detected enemy" },
  myBuild: "Detected mine", matchFormat: "1v1", durationSec: 600 });
const pending = () => ({ kind: "buildIntentPending", gameId: "game", pipeline: mergeIntentPipeline({ status: "pending" }) });
const ownerRow = () => db.users.findOne({ userId });
const statsQueries = rows => rows.filter(c => c.aggregate === "games" || c.count === "games");
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function seed(rows = [baseGame()]) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid(), preferences: { buildCheckin: { enabled: true } } });
  if (rows.length) await db.games.insertMany(rows.map(row => ({ userId, ...row })));
  const owner = await ownerRow(), revision = uuid(), stats = await games.stats(userId);
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION,
    gameStatsWriterStatus: "transactional", gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner._id, epoch: owner.gameStatsMutationEpoch, revision } } });
  return ownerRow();
}
function services() {
  const notifier = { changed: jest.fn(), gamesChanged: jest.fn() }, options = { invalidate: jest.fn(), forMatchup: jest.fn(async () => null), forOpponent: jest.fn(async () => null) };
  const deps = { db, options, notifier, now: () => played.getTime() };
  const state = new BuildIntentGameState(deps), binder = new BuildIntentBind(deps);
  state._resolveConfirmKey = jest.fn(async () => ref); state._resolveOpponentKey = jest.fn(async () => ref);
  state.serialize = jest.fn(async (_owner, row) => row);
  return { state, binder, notifier, options };
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`build_state_revision_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "build_state_revision", awaitBackgroundIndexes: true }, { logger: pino({ level: "silent" }) });
  clientB = new MongoClient(mongo.getUri(), { monitorCommands: true }); await clientB.connect(); const databaseB = clientB.db("build_state_revision");
  dbB = { ...db, client: clientB, db: databaseB, users: databaseB.collection("users"), games: databaseB.collection("games") };
  writer = gameStatsWritesFor(db); writerB = gameStatsWritesFor(dbB); games = new GamesService(db);
  for (const client of [db.client, clientB]) client.on("commandStarted", event => commands.push(event.command));
  expect(db.gameStatsTransactions).toBe(true);
});
afterAll(async () => {
  try { await writer?.stopAndDrain(); await writerB?.stopAndDrain(); await clientB?.close(); await db?.close(); }
  finally {
    await mongo?.stop();
    if (mongoChild) {
      expect(mongoChild.exitCode !== null || mongoChild.signalCode !== null).toBe(true);
      process.stdout.write(`build_state_revision_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => { jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({}); await db.buildIntentLive.deleteMany({}); commands.length = 0; });

test.each([
  { mutation: { kind: "buildIntentUpdate", gameId: "game", pipeline: [...applyOverridePipeline(ref, { notes: "$private" }), ...applyOpponentOverridePipeline(ref, {})] } },
  { mutation: { kind: "buildIntentDismiss", gameIds: ["game"], pipeline: clearOverridePipeline({ status: "skipped" }) } },
  { mutation: pending() },
  { mutation: { ...pending(), kind: "buildIntentBind", guard: "empty" } },
  { mutation: { ...pending(), kind: "buildIntentBind", guard: "missingUpdatedAt" }, intent: {} },
  { mutation: { ...pending(), kind: "buildIntentBind", guard: "updatedAt", updatedAt: played }, intent: { updatedAt: played } },
])("$mutation.kind uses actual owner-first/session/majority and preserves exact Mongo count/latest", async ({ mutation, intent }) => {
  const before = await seed([{ ...baseGame(), ...(intent ? { buildIntent: intent } : {}) },
    { gameId: "null-date", date: null }, { gameId: "array-excluded", date: played, excluded: [true] }, { gameId: "resumed", date: played, isResumedFromReplay: true }]);
  const owner = await writer.capture(userId); commands.length = 0; await writer.write(owner, mutation);
  const operation = [...commands], after = await ownerRow(); expect(statsQueries(operation)).toEqual([]);
  expect(after.gameStats).toEqual({ total: 2, latest: played }); expect(after.gameStats).toEqual(await games.stats(userId));
  expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision); expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(after.gameStats);
  const claim = operation.find(c => c.findAndModify === "users"), update = operation.find(c => c.update === "games"), commit = operation.find(c => c.commitTransaction);
  expect(claim).toBeDefined(); expect(update).toBeDefined(); expect(commit).toBeDefined();
  expect(claim).toMatchObject({ startTransaction: true, autocommit: false, upsert: false, new: false, readConcern: { level: "snapshot" } });
  expect(claim.readConcern.afterClusterTime).toBeDefined(); expect(update.lsid).toEqual(claim.lsid); expect(update.txnNumber).toEqual(claim.txnNumber);
  expect(update.autocommit).toBe(false); expect(update.updates[0].upsert).toBe(false); expect(commit.writeConcern).toMatchObject({ w: "majority", j: true });
});
test("PUT preserves two-axis detected capture/clear/literal notes while all four public attempts carry stats", async () => {
  const before = await seed(), { state, notifier } = services();
  await state.put(userId, "game", { action: "confirm", buildKey: ref.key, opponentBuildKey: ref.key, notes: "$private" }, { source: "clerk" });
  const confirmed = await db.games.findOne({ userId, gameId: "game" });
  expect(confirmed.myBuild).toBe(ref.name); expect(confirmed.opponent.strategy).toBe(ref.name);
  expect(confirmed.buildIntent.detected).toEqual({ name: "Detected mine", slug: null });
  expect(confirmed.buildIntent.opponent.detected).toEqual({ name: "Detected enemy", slug: null }); expect(confirmed.buildIntent.notes).toBe("$private");
  await state.put(userId, "game", { action: "notes", notes: "$later" }, { source: "clerk" });
  await state.put(userId, "game", { action: "skip", opponentBuildKey: null }, { source: "clerk" });
  await state.put(userId, "game", { action: "defer" }, { source: "clerk" });
  const row = await db.games.findOne({ userId, gameId: "game" }), after = await ownerRow();
  expect(row.myBuild).toBe("Detected mine"); expect(row.opponent.strategy).toBe("Detected enemy"); expect(row.buildIntent.status).toBe("skipped");
  expect(row.buildIntent.notes).toBe("$later"); expect(notifier.changed).toHaveBeenCalledTimes(4);
  expect(after.gameStats).toEqual(before.gameStats); expect(after.gameStats).toEqual(await games.stats(userId));
});
test("dismiss touches at most the original500 selected rows and keeps zero-match publication semantics", async () => {
  const rows = Array.from({ length: 501 }, (_, n) => ({ ...baseGame(), gameId: `g${n}`, buildIntent: { status: "pending" } }));
  const before = await seed(rows), { state, notifier, options } = services(); commands.length = 0;
  const result = await state.dismissPending(userId, { source: "clerk" }), operation = [...commands];
  expect(result).toEqual({ dismissed: 500 }); expect(statsQueries(operation)).toEqual([]);
  const update = operation.find(c => c.update === "games"); expect(update.updates[0].q.gameId.$in).toHaveLength(500);
  expect(await db.games.countDocuments({ userId, "buildIntent.status": "pending" })).toBe(1);
  expect((await ownerRow()).gameStats).toEqual(before.gameStats); expect(notifier.changed).toHaveBeenCalledTimes(25); expect(options.invalidate).toHaveBeenCalledTimes(1);
  notifier.changed.mockClear(); options.invalidate.mockClear();
  const find = db.games.find.bind(db.games); jest.spyOn(db.games, "find").mockImplementation((...args) => {
    const cursor = find(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => { const selected = await toArray(); await dbB.games.updateMany({ userId }, { $set: { "buildIntent.status": "skipped" } }); return selected; }; return cursor;
  });
  expect(await state.dismissPending(userId, { source: "clerk" })).toEqual({ dismissed: 0 });
  expect(notifier.changed).toHaveBeenCalledTimes(1); expect(options.invalidate).toHaveBeenCalledTimes(1);
});
test("old epoch/owner and active-fence handles reject before any game command", async () => {
  await seed(); const owner = await writer.capture(userId);
  for (const change of [{ $set: { gameStatsMutationEpoch: uuid() } }, { $set: { gameStatsMutationEpoch: owner.epoch, _gdprMutation: { id: uuid() } } }]) {
    await db.users.updateOne({ userId }, change); commands.length = 0;
    await expect(writer.write(owner, pending())).rejects.toThrow("game_stats_authority_changed");
    expect(commands.filter(c => c.update === "games")).toHaveLength(0);
  }
  await db.users.deleteOne({ userId }); await db.users.insertOne({ userId, gameStatsMutationEpoch: owner.epoch }); commands.length = 0;
  await expect(writer.write(owner, pending())).rejects.toThrow("game_stats_authority_changed"); expect(commands.filter(c => c.update === "games")).toHaveLength(0);
});
test("invalid proof retires rather than recounting and raw BSON authoritative stats remain unchanged", async () => {
  const before = await seed([{ ...baseGame(), date: "raw BSON date" }]);
  await db.users.updateOne({ userId }, { $set: { "gameStatsMaintenance.status": "unsupported_latest" } });
  const owner = await writer.capture(userId); commands.length = 0; await writer.write(owner, pending());
  const operation = [...commands], after = await ownerRow(); expect(statsQueries(operation)).toEqual([]);
  expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined(); expect(await games.stats(userId)).toEqual(before.gameStats);
});
test("concurrent independent-client ingest and check-in preserve both the newer total and latest", async () => {
  await seed(); const later = new Date(played.getTime() + 60000), gate = held(), entered = held(), original = db.games.updateOne.bind(db.games);
  jest.spyOn(db.games, "updateOne").mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  const owner = await writer.capture(userId), ownerB = await writerB.capture(userId), first = writer.write(owner, pending()); await entered.promise;
  const second = writerB.write(ownerB, session => dbB.games.insertOne({ userId, gameId: "later", date: later }, { session }), { selection: { gameIds: ["later"] } });
  gate.resolve(); await Promise.all([first, second]);
  expect((await ownerRow()).gameStats).toEqual({ total: 2, latest: later }); expect((await ownerRow()).gameStats).toEqual(await games.stats(userId));
});
async function liveCandidate() {
  const keyStartedAtMs = played.getTime() - 620000, gameKey = `Opp|${keyStartedAtMs}`;
  await db.buildIntentLive.insertOne({ userId, gameId: null, gameKey, keyStartedAtMs, oppName: "Opp", loadingSeen: true });
  const h = services(); h.binder._plan = jest.fn(async () => ({ status: "confirmed", pipeline: applyOverridePipeline(ref, { gameKey }) }));
  return { ...h, gameKey, owner: await writer.capture(userId) };
}
test("transient game transaction retry does not repeat live claim/plan or post-commit publication", async () => {
  await seed(); const h = await liveCandidate(), original = db.games.updateOne.bind(db.games), error = new MongoServerError({ message: "retry", code: 112 });
  error.addErrorLabel("TransientTransactionError"); let attempts = 0;
  jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => { attempts += 1; if (attempts === 1) throw error; return original(...args); });
  const claim = jest.spyOn(db.buildIntentLive, "findOneAndUpdate");
  expect(await h.binder.bindIngestedGame(userId, baseGame(), { created: true, statsOwner: h.owner })).toEqual({ bound: true, status: "confirmed" });
  expect(attempts).toBe(2); expect(claim).toHaveBeenCalledTimes(1); expect(h.binder._plan).toHaveBeenCalledTimes(1); expect(h.notifier.changed).toHaveBeenCalledTimes(1);
  expect((await db.buildIntentLive.findOne({ userId })).gameId).toBe("game"); expect((await ownerRow()).gameStats).toEqual(await games.stats(userId));
});
test("failed game work rolls back owner/game/proof and releases the preexisting live claim once", async () => {
  const before = await seed(), h = await liveCandidate(), error = new Error("after game before commit"), original = db.games.updateOne.bind(db.games);
  jest.spyOn(db.games, "updateOne").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
  await expect(h.binder.bindIngestedGame(userId, baseGame(), { created: true, statsOwner: h.owner })).rejects.toBe(error);
  expect((await ownerRow()).gameStatsRevision).toBe(before.gameStatsRevision); expect((await ownerRow()).gameStats).toEqual(before.gameStats);
  expect((await db.games.findOne({ userId, gameId: "game" })).buildIntent).toBeUndefined(); expect((await db.buildIntentLive.findOne({ userId })).gameId).toBeNull();
  expect(h.notifier.changed).not.toHaveBeenCalled();
});
test("lost commit ACK retains an applied first-wins claim and propagates the original error", async () => {
  await seed(); const h = await liveCandidate(); await statsReadFloorFor(db)();
  const start = db.client.startSession.bind(db.client), error = new MongoNetworkError("lost commit ACK");
  let injected = 0; commands.length = 0;
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args), commit = session.withTransaction.bind(session);
    session.withTransaction = async (...call) => { await commit(...call); injected += 1; throw error; }; return session;
  });
  await expect(h.binder.bindIngestedGame(userId, baseGame(), { created: true, statsOwner: h.owner })).rejects.toBe(error);
  expect(injected).toBe(1); expect(commands.filter(command => command.commitTransaction)).toHaveLength(1);
  expect((await db.games.findOne({ userId, gameId: "game" })).buildIntent.gameKey).toBe(h.gameKey);
  expect((await db.buildIntentLive.findOne({ userId })).gameId).toBe("game"); expect(h.notifier.changed).not.toHaveBeenCalled();
  expect((await ownerRow()).gameStats).toEqual(await games.stats(userId));
});
test("null/absent updatedAt/gameKey predicates preserve original first-wins outcomes", async () => {
  await seed([{ ...baseGame(), buildIntent: { updatedAt: null, gameKey: null } }]); const owner = await writer.capture(userId);
  expect((await writer.write(owner, { ...pending(), kind: "buildIntentBind", guard: "missingUpdatedAt" })).matchedCount).toBe(0);
  expect((await writer.write(owner, pending())).matchedCount).toBe(0);
  await db.games.updateOne({ userId }, { $unset: { buildIntent: "" } });
  expect((await writer.write(owner, { ...pending(), kind: "buildIntentBind", guard: "empty" })).matchedCount).toBe(1);
  expect((await ownerRow()).gameStats).toEqual(await games.stats(userId));
});
