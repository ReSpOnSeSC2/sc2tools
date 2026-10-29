// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError, ObjectId } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");
const { buildOpponentMmrEnrichmentJob } = require("../src/jobs/opponentMmrEnrichmentJob");
const logger = pino({ level: "silent" }), userId = "pulse-owner", now = Date.parse("2026-10-28T12:00:00Z");
const played = new Date(now - 60_000), commands = [];
let mongo, mongoChild, db, dbB, clientB, writer, writerB, games;
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const row = () => db.users.findOne({ userId });
async function seed(opponent = {}, date = played) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() });
  const inserted = await db.games.insertOne({ userId, gameId: "pulse-game", date, createdAt: played,
    isLadderGame: true, opponent: { pulseCharacterId: "2001", race: "Protoss", ...opponent } });
  const owner = await row(), stats = await games.stats(userId), revision = uuid();
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", revision, ownerId: owner._id, epoch: owner.gameStatsMutationEpoch } } });
  return { before: await row(), id: inserted.insertedId };
}
function job(provider = jest.fn(async () => [{ race: "PROTOSS", mmr: 4100, league: "diamond" }]), database = db) {
  return { provider, service: buildOpponentMmrEnrichmentJob({ db: database, logger,
    pulseMmr: { getRaceBreakdown: provider }, nowFn: () => now, gamesPerTick: 25, windowDays: 14 }) };
}
beforeAll(async () => {
  // The admitted local runner pins the cached binary and disables downloads.
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`pulse_stamp_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "pulse_revision", awaitBackgroundIndexes: true }, { logger });
  clientB = new MongoClient(mongo.getUri(), { monitorCommands: true }); await clientB.connect();
  const databaseB = clientB.db("pulse_revision");
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
      process.stdout.write(`pulse_stamp_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => {
  jest.restoreAllMocks(); await db.games.deleteMany({}); await db.users.deleteMany({});
  await db.db.collection("jobLocks").deleteMany({}); commands.length = 0;
});

test.each([["mmr", 4100], ["league", 4], ["mmr", null], ["league", null]])(
  "%s %p uses a same-session atomic revision/count carry and no count/latest game reads", async (field, value) => {
    const { before, id } = await seed(), owner = await writer.capture(userId); commands.length = 0;
    await writer.write(owner, { kind: "pulseGameStamp", id, field, value });
    const operation = [...commands], after = await row();
    expect(operation.filter(c => c.find === "games" || c.aggregate === "games" || c.count === "games")).toEqual([]);
    expect(after.gameStats).toEqual(before.gameStats); expect(after.gameStats).toEqual(await games.stats(userId));
    expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision);
    expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(after.gameStats);
    const claim = operation.find(c => c.findAndModify === "users"), write = operation.find(c => c.update === "games");
    expect(claim).toMatchObject({ startTransaction: true, readConcern: { level: "snapshot" }, new: false, upsert: false });
    expect(claim.readConcern.afterClusterTime).toBeDefined();
    expect(write.lsid).toEqual(claim.lsid); expect(write.txnNumber).toEqual(claim.txnNumber);
    expect(write.updates[0]).toMatchObject({ q: { userId, _id: { $eq: id } }, upsert: false });
    expect(operation.find(c => c.commitTransaction).writeConcern).toMatchObject({ w: "majority", j: true });
  });

test("the actual job stamps both independent fields from one provider result", async () => {
  await seed(); const provider = jest.fn(async () => [{ race: "PROTOSS", mmr: 4100, league: "diamond" }]);
  const refresh = jest.fn(async () => {
    const after = await row(); expect(after.gameStatsMaintenance.revision).toBe(after.gameStatsRevision);
  });
  // Same production job callback boundary; no provider, scheduler or settings calls.
  const withRefresh = buildOpponentMmrEnrichmentJob({ db, logger, pulseMmr: { getRaceBreakdown: provider },
    nowFn: () => now, onLeagueEnriched: refresh });
  const result = await withRefresh.runOnce(); await withRefresh.stop();
  expect(provider).toHaveBeenCalledTimes(1); expect(provider).toHaveBeenCalledWith(["2001"], { throwOnError: true });
  expect(result).toMatchObject({ enriched: 1, leagueEnriched: 1, writeErrors: 0 }); expect(refresh).toHaveBeenCalledTimes(1);
  expect((await db.games.findOne({ userId })).opponent).toMatchObject({ mmr: 4100, mmrSource: "pulse", leagueId: 4,
    mmrLookupAttempted: true, leagueLookupAttempted: true });
  expect((await row()).gameStats).toEqual(await games.stats(userId));
});

test.each(["replacement", "active-fence", "new-epoch"])("held provider cannot rebind a captured owner after %s", async state => {
  const { before } = await seed(), entered = held(), release = held();
  const { service, provider } = job(jest.fn(async () => { entered.resolve(); return release.promise; }));
  const task = service.runOnce(); await entered.promise;
  if (state === "replacement") { await db.users.deleteOne({ userId }); await db.users.insertOne({ userId }); }
  if (state === "active-fence") await db.users.updateOne({ userId }, { $set: { _gdprMutation: { id: uuid() } } });
  if (state === "new-epoch") await db.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } });
  release.resolve([{ race: "PROTOSS", mmr: 4100, league: "diamond" }]);
  expect(await task).toMatchObject({ writeErrors: 1, leagueEnriched: 0 }); await service.stop();
  expect(provider).toHaveBeenCalledTimes(1); const game = await db.games.findOne({ userId });
  expect(game.opponent).not.toHaveProperty("mmr"); expect(game.opponent).not.toHaveProperty("leagueId");
  if (state !== "replacement") expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
});

test("concurrent independent-client ingest is included in the atomic carry after provider work", async () => {
  await seed(); const entered = held(), release = held(), later = new Date(now);
  const { service } = job(jest.fn(async () => { entered.resolve(); return release.promise; }));
  const task = service.runOnce(); await entered.promise;
  const otherOwner = await writerB.capture(userId);
  await writerB.write(otherOwner, session => dbB.games.insertOne({ userId, gameId: "later", date: later }, { session }), { selection: { gameIds: ["later"] } });
  release.resolve([{ race: "PROTOSS", mmr: 4100, league: "diamond" }]); await task; await service.stop();
  expect((await row()).gameStats).toEqual({ total: 2, latest: later });
  expect((await row()).gameStats).toEqual(await games.stats(userId));
});

test("selected candidate identity and race are copied before a held owner read", async () => {
  await seed(); const entered = held(), release = held(); let selected;
  const find = db.games.find.bind(db.games), findOwner = db.users.findOne.bind(db.users);
  jest.spyOn(db.games, "find").mockImplementation((...args) => {
    const cursor = find(...args), toArray = cursor.toArray.bind(cursor);
    if (args[0].createdAt) cursor.toArray = async () => { const rows = await toArray(); selected = rows[0]; return rows; };
    return cursor;
  });
  jest.spyOn(db.users, "findOne").mockImplementation(async (...args) => {
    const found = await findOwner(...args);
    if (args[1]?.projection?.gameStatsMutationEpoch) { entered.resolve(); await release.promise; }
    return found;
  });
  const { service, provider } = job(), task = service.runOnce(); await entered.promise;
  selected._id.id.fill(0); selected.userId = "other"; selected.opponent.pulseCharacterId = "other";
  selected.opponent.race = "Zerg"; selected.opponent.mmrLookupAttempted = true;
  release.resolve(); expect(await task).toMatchObject({ enriched: 1, leagueEnriched: 1, writeErrors: 0 }); await service.stop();
  expect(provider).toHaveBeenCalledWith(["2001"], { throwOnError: true });
  expect((await db.games.findOne({ gameId: "pulse-game" })).opponent).toMatchObject({ mmr: 4100, leagueId: 4 });
});

test("a concurrent replay-provided value wins without consuming its missing-field marker", async () => {
  await seed(); const entered = held(), release = held();
  const { service } = job(jest.fn(async () => { entered.resolve(); return release.promise; }));
  const task = service.runOnce(); await entered.promise;
  await dbB.games.updateOne({ userId }, { $set: { "opponent.mmr": 4500, "opponent.leagueId": 5 } });
  release.resolve([{ race: "PROTOSS", mmr: 4100, league: "diamond" }]);
  expect(await task).toMatchObject({ skipped: 1, leagueEnriched: 0, writeErrors: 0 }); await service.stop();
  const game = await db.games.findOne({ userId }); expect(game.opponent.mmr).toBe(4500); expect(game.opponent.leagueId).toBe(5);
  expect(game.opponent).not.toHaveProperty("mmrLookupAttempted"); expect(game.opponent).not.toHaveProperty("leagueLookupAttempted");
});

test("a Pulse stamp cannot target another account or upsert a missing identity", async () => {
  const { before } = await seed(), foreign = await db.games.insertOne({ userId: "other", date: played, opponent: {} });
  const owner = await writer.capture(userId);
  for (const id of [foreign.insertedId, new ObjectId()]) {
    expect(await writer.write(owner, { kind: "pulseGameStamp", id, field: "mmr", value: 4100 })).toMatchObject({ matchedCount: 0 });
  }
  expect((await db.games.findOne({ _id: foreign.insertedId })).opponent).toEqual({});
  expect(await db.games.countDocuments({})).toBe(2); expect((await row()).gameStats).toEqual(before.gameStats);
});

test("a failed transaction rolls back the actual game stamp and carried authority together", async () => {
  const { before, id } = await seed(), update = db.games.updateOne.bind(db.games), fault = new Error("after actual Pulse write");
  jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => { await update(...args); throw fault; });
  await expect(writer.write(await writer.capture(userId), { kind: "pulseGameStamp", id, field: "mmr", value: 4100 })).rejects.toBe(fault);
  expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision); expect((await row()).gameStats).toEqual(before.gameStats);
  expect((await db.games.findOne({ _id: id })).opponent).not.toHaveProperty("mmr");
});

test("transient transaction retry never repeats the provider call", async () => {
  await seed(); const update = db.games.updateOne.bind(db.games); let injected = false;
  jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[2]?.session && !injected) { injected = true; const error = new MongoServerError({ message: "retry actual Pulse mutation" }); error.addErrorLabel("TransientTransactionError"); throw error; }
    return result;
  });
  const { service, provider } = job(); expect(await service.runOnce()).toMatchObject({ writeErrors: 0, enriched: 1 }); await service.stop();
  expect(injected).toBe(true); expect(provider).toHaveBeenCalledTimes(1); expect((await row()).gameStats).toEqual(await games.stats(userId));
});

test.each(["retry-ack", "unknown-after-commit"])("actual commit %s preserves both field outcomes without false success", async state => {
  await seed(); const start = db.client.startSession.bind(db.client); let commits = 0;
  const unknown = new MongoServerError({ message: "unknown outcome after actual Pulse commit" });
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); commits++;
      if (commits === 1) {
        if (state === "unknown-after-commit") throw unknown;
        const lost = new MongoNetworkError("lost Pulse commit ACK"); lost.addErrorLabel("UnknownTransactionCommitResult"); throw lost;
      }
    }; return session;
  });
  const { service, provider } = job(), result = await service.runOnce(); await service.stop();
  expect(result.writeErrors).toBe(state === "unknown-after-commit" ? 1 : 0);
  expect(provider).toHaveBeenCalledTimes(1); expect(commits).toBe(state === "unknown-after-commit" ? 2 : 3);
  const game = await db.games.findOne({ userId }); expect(game.opponent).toMatchObject({ mmr: 4100, leagueId: 4 });
  expect((await row()).gameStats).toEqual(await games.stats(userId));
  expect((await row()).gameStatsMaintenance.revision).toBe((await row()).gameStatsRevision);
});

test.each(["maintenance1", "null-latest"])("%s proof retains strict qualification rather than recounting", async state => {
  const { id } = await seed({}, state === "null-latest" ? null : played);
  if (state === "maintenance1") await db.users.updateOne({ userId }, { $set: { "gameStatsMaintenance.version": 1 } });
  const owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, { kind: "pulseGameStamp", id, field: "league", value: 4 }); const operation = [...commands];
  expect(operation.filter(c => c.find === "games" || c.aggregate === "games" || c.count === "games")).toEqual([]);
  if (state === "maintenance1") { expect((await row()).gameStats).toBeUndefined(); expect(readyStatsFromOwnerRow(await row(), userId, true)).toBeNull(); }
  else expect(readyStatsFromOwnerRow(await row(), userId, true)).toEqual({ total: 1, latest: null });
});

test("job stop and writer drain own an actual held transaction until settlement", async () => {
  await seed({ leagueId: 4 }); const client = new MongoClient(mongo.getUri()); await client.connect();
  const database = client.db("pulse_revision"), scoped = { ...db, client, db: database,
    users: database.collection("users"), games: database.collection("games") };
  const scopedWriter = gameStatsWritesFor(scoped), update = scoped.games.updateOne.bind(scoped.games), entered = held(), release = held();
  const { service } = job(undefined, scoped);
  jest.spyOn(scoped.games, "updateOne").mockImplementation(async (...args) => {
    const result = await update(...args); if (args[2]?.session) { entered.resolve(); await release.promise; } return result;
  });
  try {
    const task = service.runOnce(); await entered.promise;
    let jobStopped = false, writerStopped = false;
    const stop = service.stop().then(() => { jobStopped = true; });
    const drain = scopedWriter.stopAndDrain().then(() => { writerStopped = true; });
    await Promise.resolve(); expect(jobStopped).toBe(false); expect(writerStopped).toBe(false); expect(scopedWriter.pending.size).toBe(1);
    release.resolve(); await task; await stop; await drain;
    expect((await db.games.findOne({ userId })).opponent.mmr).toBe(4100);
    expect((await row()).gameStats).toEqual(await games.stats(userId)); expect(scopedWriter.pending.size).toBe(0);
  } finally { release.resolve(); await service.stop(); await scopedWriter.stopAndDrain(); await client.close(); }
});
