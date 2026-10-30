// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError, ObjectId } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { OpponentsService } = require("../src/services/opponents");
const { UserRevision } = require("../src/util/userRevision");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { gameStampAdmission } = require("../src/services/opponentGameStamps");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");

const logger = pino({ level: "silent" }), userId = "opponent-family-owner", played = new Date("2026-10-20T12:00:00Z"), commands = [];
let mongo, mongoChild, db, writer, games;
const row = () => db.users.findOne({ userId });
const region = (gameId = "g1", value = "EU") => ({ kind: "opponentGameRegion", gameId, region: value });
const identity = (pulseId = "p1", patch = { region: "EU", pulseCharacterId: "77" }) => ({ kind: "opponentGameIdentity", pulseId, ...patch });
const gameReads = operation => operation.filter(c => c.find === "games" || c.aggregate === "games" || c.count === "games");
const warnLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
function held() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function seed(rows, proof) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() });
  const defaults = [{ gameId: "g1", opponent: { pulseId: "p1", mmr: 4000, region: "NA" } }, { gameId: "g2", opponent: { pulseId: "p1" } }];
  await db.games.insertMany((rows || defaults).map((game, i) => ({ userId, date: new Date(played.getTime() + i * 1000), ...game })));
  const owner = await row(), revision = uuid(), stats = await games.stats(userId);
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION,
    gameStatsWriterStatus: "transactional", gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner._id,
      epoch: owner.gameStatsMutationEpoch, revision } } });
  if (proof) await db.users.updateOne({ _id: owner._id }, proof);
  return { before: await row() };
}
async function scopedContext() {
  const client = new MongoClient(mongo.getUri(), { monitorCommands: true }); await client.connect();
  const database = client.db("opponent_family"), scopedCommands = [];
  client.on("commandStarted", event => scopedCommands.push(event.command));
  const scoped = { ...db, client, db: database, users: database.collection("users"), games: database.collection("games"),
    opponents: database.collection("opponents") };
  return { client, scoped, scopedCommands, writer: gameStatsWritesFor(scoped) };
}
beforeAll(async () => {
  // The admitted local runner pins the cached binary and disables downloads.
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`opponent_family_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "opponent_family", awaitBackgroundIndexes: true }, { logger });
  db.client.on("commandStarted", event => commands.push(event.command));
  writer = gameStatsWritesFor(db); games = new GamesService(db);
  expect(db.gameStatsTransactions).toBe(true);
});
afterAll(async () => {
  try { await writer?.stopAndDrain(); await db?.close(); }
  finally {
    await mongo?.stop();
    if (mongoChild) {
      expect(mongoChild.exitCode !== null || mongoChild.signalCode !== null).toBe(true);
      process.stdout.write(`opponent_family_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.games, db.opponents]) await collection.deleteMany({});
  commands.length = 0;
});

test.each([["region", () => region(), { q: { userId, gameId: "g1" }, u: { $set: { "opponent.region": "EU" } }, upsert: false }],
  ["identity", () => identity(), { q: { userId, "opponent.pulseId": "p1" }, u: { $set: { "opponent.region": "EU", "opponent.pulseCharacterId": "77" } },
    multi: true, upsert: false }]])("%s claims the owner first and sends one fixed game command in the same transaction", async (_name, input, statement) => {
  await seed(); const owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, input());
  const operation = [...commands], claim = operation.find(c => c.findAndModify === "users"), update = operation.find(c => c.update === "games");
  expect(operation.indexOf(claim)).toBeLessThan(operation.indexOf(update));
  expect(claim).toMatchObject({ startTransaction: true, readConcern: { level: "snapshot" }, new: false, upsert: false,
    query: { userId, _gdprMutation: { $exists: false } } });
  expect(claim.readConcern.afterClusterTime).toBeDefined();
  expect(update.lsid).toEqual(claim.lsid); expect(update.txnNumber).toEqual(claim.txnNumber);
  expect(update.updates).toEqual([expect.objectContaining(statement)]);
  expect(operation.filter(c => c.update === "games")).toHaveLength(1); expect(gameReads(operation)).toEqual([]);
  expect(operation.find(c => c.commitTransaction).writeConcern).toMatchObject({ w: "majority", j: true });
});

test("fixed bodies keep the original scope without visibility predicates, MMR writes or upserts", async () => {
  await seed([{ gameId: "g1", opponent: { pulseId: "", region: "NA", pulseCharacterId: "old", mmr: 4000 } },
    { gameId: "g2", excluded: true, opponent: { pulseId: "" } }, { gameId: "g3", _deleted: true, opponent: { pulseId: "$x.y" } },
    { gameId: "g4", isResumedFromReplay: true, opponent: { pulseId: "$x.y" } }, { gameId: "g5", opponent: { pulseId: "other" } }]);
  await db.games.insertOne({ userId: "foreign", gameId: "g1", opponent: { pulseId: "" } });
  const owner = await writer.capture(userId);
  expect(await writer.write(owner, identity(""))).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
  expect(await writer.write(owner, identity("$x.y", { region: "KR" }))).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
  expect(await writer.write(owner, region("g4", "$literal"))).toMatchObject({ matchedCount: 1 });
  expect(await writer.write(owner, region("missing", "KR"))).toMatchObject({ matchedCount: 0, upsertedCount: 0 });
  const opponents = Object.fromEntries((await db.games.find({ userId }).toArray()).map(game => [game.gameId, game.opponent]));
  expect(opponents).toEqual({ g1: { pulseId: "", region: "EU", pulseCharacterId: "77", mmr: 4000 },
    g2: { pulseId: "", region: "EU", pulseCharacterId: "77" }, g3: { pulseId: "$x.y", region: "KR" },
    g4: { pulseId: "$x.y", region: "$literal" }, g5: { pulseId: "other" } });
  expect((await db.games.findOne({ userId: "foreign" })).opponent).toEqual({ pulseId: "" });
  expect(await db.games.countDocuments({ gameId: "missing" })).toBe(0);
});

test.each([["a Date latest", undefined], ["a null latest", null]])("a strict ready proof with %s carries under a new UUID", async (_name, date) => {
  const rows = date === null ? [{ gameId: "g1", date: null, opponent: { pulseId: "p1" } }] : undefined;
  const { before } = await seed(rows); const owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, identity()); await writer.write(owner, region("missing"));
  const operation = [...commands], after = await row();
  expect(gameReads(operation)).toEqual([]);
  expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision); expect(after.gameStats).toEqual(before.gameStats);
  expect(after.gameStats).toEqual(await games.stats(userId)); expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(after.gameStats);
});

test.each([["protocol 1", { $set: { gameStatsProtocolVersion: 1 } }], ["maintenance 1", { $set: { "gameStatsMaintenance.version": 1 } }],
  ["wrong ownerId", { $set: { "gameStatsMaintenance.ownerId": new ObjectId() } }], ["wrong revision", { $set: { "gameStatsMaintenance.revision": uuid() } }],
  ["total 1.5", { $set: { "gameStats.total": 1.5 } }], ["missing latest", { $unset: { "gameStats.latest": "" } }],
  ["wrong epoch", { $set: { "gameStatsMaintenance.epoch": uuid() } }]])("a %s proof is retired without any recount", async (_name, proof) => {
  await seed(undefined, proof); const owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, identity());
  const after = await row();
  expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined();
  expect(readyStatsFromOwnerRow(after, userId, true)).toBeNull(); expect(gameReads(commands)).toEqual([]);
  expect(await db.games.countDocuments({ userId, "opponent.pulseCharacterId": "77" })).toBe(2);
});

test("a real write-then-throw rolls back, and one transient retry commits exactly once", async () => {
  const { before } = await seed(), owner = await writer.capture(userId), update = db.games.updateMany.bind(db.games), fault = new Error("after actual heal");
  const spy = jest.spyOn(db.games, "updateMany").mockImplementationOnce(async (...args) => { await update(...args); throw fault; });
  await expect(writer.write(owner, identity())).rejects.toBe(fault); spy.mockRestore();
  expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
  expect(await db.games.countDocuments({ userId, "opponent.pulseCharacterId": "77" })).toBe(0);
  let injected = false; commands.length = 0;
  jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[2]?.session && !injected) {
      injected = true; const error = new MongoServerError({ message: "retry actual heal" }); error.addErrorLabel("TransientTransactionError"); throw error;
    }
    return result;
  });
  await expect(writer.write(owner, identity())).resolves.toMatchObject({ modifiedCount: 2 });
  expect(injected).toBe(true); expect(commands.filter(c => c.commitTransaction)).toHaveLength(1);
  expect((await row()).gameStats).toEqual(before.gameStats);
});

test.each(["retry-ack", "unknown-after-commit"])("an actual commit %s keeps its outcome and always retires UserRevision", async state => {
  await seed(); const start = db.client.startSession.bind(db.client); let commits = 0;
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args), commit = session.commitTransaction.bind(session); let attempts = 0;
    session.commitTransaction = async () => {
      await commit(); commits += 1; attempts += 1;
      if (attempts > 1) return;
      if (state === "unknown-after-commit") throw new MongoServerError({ message: "unknown outcome after actual heal commit" });
      const lost = new MongoNetworkError("lost heal commit ACK"); lost.addErrorLabel("UnknownTransactionCommitResult"); throw lost;
    };
    return session;
  });
  const revisions = new UserRevision(db.users, { enabled: true }), log = warnLogger();
  const service = new OpponentsService(db, Buffer.alloc(32, 1), { userRevision: revisions, logger: log });
  const admission = await gameStampAdmission(service.gameStatsWrites, userId, undefined, true), snapshot = await revisions.snapshot(userId);
  const healed = await service._backfillGameIdentity(userId, "p1", { region: "EU", pulseCharacterId: "77" }, admission);
  expect(revisions.current(snapshot)).toBe(false);
  expect(await db.games.countDocuments({ userId, "opponent.pulseCharacterId": "77" })).toBe(2);
  if (state === "retry-ack") { expect(healed).toBe(2); expect(commits).toBe(2); expect(log.warn).not.toHaveBeenCalled(); return; }
  expect(healed).toBe(0); expect(commits).toBe(1);
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ userId, pulseId: "p1" }), "opponent_pulse_backfill_game_identity_failed");
  const regionSnapshot = await revisions.snapshot(userId);
  expect(await service._stampGameRegion(userId, "g2", {}, { region: "KR" }, admission)).toBeUndefined();
  expect(revisions.current(regionSnapshot)).toBe(false); expect(commits).toBe(2);
  expect((await db.games.findOne({ gameId: "g2" })).opponent.region).toBe("KR");
  expect(log.warn).toHaveBeenLastCalledWith(expect.objectContaining({ userId, gameId: "g2" }), "opponent_game_region_stamp_failed");
});

test("a bulk heal failure rolls back every matched game in one whole operation", async () => {
  await seed(Array.from({ length: 5 }, (_unused, i) => ({ gameId: `bulk-${i}`, opponent: { pulseId: "p1" } })));
  const log = warnLogger(), service = new OpponentsService(db, Buffer.alloc(32, 1), { logger: log });
  const update = db.games.updateMany.bind(db.games), limit = new MongoServerError({ message: "transaction too large" });
  jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => { await update(...args); throw limit; });
  const admission = await gameStampAdmission(service.gameStatsWrites, userId, undefined, true); commands.length = 0;
  expect(await service._backfillGameIdentity(userId, "p1", { region: "EU", pulseCharacterId: "77" }, admission)).toBe(0);
  const operation = [...commands];
  expect(operation.filter(c => c.update === "games")).toHaveLength(1); expect(gameReads(operation)).toEqual([]);
  expect(await db.games.countDocuments({ userId, "opponent.pulseCharacterId": "77" })).toBe(0);
  expect(log.warn).toHaveBeenCalledWith({ err: limit, userId, pulseId: "p1" }, "opponent_pulse_backfill_game_identity_failed");
});

test("a held real floor on a fresh client keeps its slot through stop and then sends nothing", async () => {
  await seed(); const ctx = await scopedContext(), entered = held(), release = held(), findOne = ctx.scoped.users.findOne.bind(ctx.scoped.users);
  jest.spyOn(ctx.scoped.users, "findOne").mockImplementation(async (...args) => {
    if (args[1]?.readConcern?.level === "majority") { entered.resolve(); await release.promise; }
    return findOne(...args);
  });
  try {
    const log = warnLogger(), service = new OpponentsService(ctx.scoped, Buffer.alloc(32, 1), { logger: log });
    const admission = await gameStampAdmission(ctx.writer, userId, undefined, true);
    const stamp = service._stampGameRegion(userId, "g1", {}, { region: "EU" }, admission); await entered.promise;
    let drained = false; const drain = ctx.writer.stopAndDrain().then(() => { drained = true; });
    await db.users.findOne({ userId }); expect(drained).toBe(false); expect(ctx.writer.pending.size).toBe(1);
    const mark = ctx.scopedCommands.length; release.resolve();
    expect(await stamp).toBeUndefined(); await drain;
    const after = ctx.scopedCommands.slice(mark);
    expect(after.filter(c => c.startTransaction || c.findAndModify || c.update === "games")).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith({ err: expect.objectContaining({ code: "game_stats_writer_stopping" }), userId, gameId: "g1" }, "opponent_game_region_stamp_failed");
    expect((await db.games.findOne({ gameId: "g1" })).opponent.region).toBe("NA");
  } finally { release.resolve(); await ctx.writer.stopAndDrain(); await ctx.client.close(); }
});

test("a held admitted transaction keeps the drain waiting until it settles", async () => {
  await seed(); const ctx = await scopedContext(), entered = held(), release = held(), update = ctx.scoped.games.updateOne.bind(ctx.scoped.games);
  jest.spyOn(ctx.scoped.games, "updateOne").mockImplementation(async (...args) => {
    const result = await update(...args); if (args[2]?.session) { entered.resolve(); await release.promise; } return result;
  });
  try {
    const owner = await ctx.writer.capture(userId), write = ctx.writer.write(owner, region("g1", "KR")); await entered.promise;
    let drained = false; const drain = ctx.writer.stopAndDrain().then(() => { drained = true; });
    await db.users.findOne({ userId }); expect(drained).toBe(false); expect(ctx.writer.pending.size).toBe(1);
    release.resolve(); await expect(write).resolves.toMatchObject({ matchedCount: 1 }); await drain;
    expect(drained).toBe(true); expect(ctx.writer.pending.size).toBe(0);
    expect((await db.games.findOne({ gameId: "g1" })).opponent.region).toBe("KR");
    await expect(ctx.writer.write(owner, identity())).rejects.toMatchObject({ code: "game_stats_writer_stopping" });
  } finally { release.resolve(); await ctx.writer.stopAndDrain(); await ctx.client.close(); }
});
