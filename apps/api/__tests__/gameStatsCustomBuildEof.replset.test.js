// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { GdprService } = require("../src/services/gdpr");
const { DataRepairsService } = require("../src/services/dataRepairs");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");
const { removeReclassifyRunPipeline } = require("../src/services/customBuildReclassifyPipeline");
const logger = pino({ level: "silent" }), userId = "custom-eof-owner", played = new Date("2026-10-20T12:00:00Z"), commands = [];
let mongo, mongoChild, db, dbB, clientB, writer, writerB, games;
const row = () => db.users.findOne({ userId });
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const mutation = (runId, extra = {}) => ({ kind: "customBuildEof", runId, sequence: 10, mode: "all", ...extra });
const marker = (runId, extra = {}) => ({ runId, sequence: 10, perspective: "you", action: "set", desiredBuild: "Saved opener", desiredSlug: "saved", ...extra });
async function seed(rows, runId = uuid()) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() });
  const defaults = [{ gameId: "one", _customBuildReclassify: [marker(runId)] }, { gameId: "two", _customBuildReclassify: [marker(runId)] }];
  await db.games.insertMany((rows || defaults).map(game => ({ userId, date: played, myBuild: "Old", opponent: { strategy: "Old enemy" }, ...game })));
  const owner = await row(), revision = uuid(), stats = await games.stats(userId);
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner._id, epoch: owner.gameStatsMutationEpoch, revision } } });
  return { runId, before: await row() };
}
function service(beforeHydrate = async () => {}) {
  const hydrate = jest.fn(beforeHydrate), perGame = { async *iterateRulePreviewPages() {
    await hydrate(); yield { candidates: 1, hasMore: false, games: [{ gameId: "one", myRace: "Protoss", oppRace: "Zerg",
      myBuild: "Old", events: [], oppEvents: [], detailAvailableYou: true, detailAvailableOpponent: true }] };
  } };
  return { hydrate, custom: new CustomBuildsService(db, { perGame, logger }) };
}
async function definition() {
  await db.customBuilds.insertOne({ userId, slug: "saved", name: "Saved opener", race: "Protoss", vsRace: "Any",
    perspective: "you", rules: [{ type: "not_before", name: "BuildPylon", time_lt: 300 }], updatedAt: played });
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`custom_eof_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "custom_eof_revision", awaitBackgroundIndexes: true }, { logger });
  clientB = new MongoClient(mongo.getUri(), { monitorCommands: true }); await clientB.connect();
  const database = clientB.db("custom_eof_revision");
  dbB = { ...db, client: clientB, db: database, users: database.collection("users"), games: database.collection("games") };
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
      process.stdout.write(`custom_eof_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.games, db.customBuilds, db.customBuildJobs, db.db.collection("jobLocks")]) await collection.deleteMany({});
  commands.length = 0;
});

test.each(["single", "all"])("%s whole EOF rotates the owner UUID with exact count/latest and one session", async mode => {
  const { runId, before } = await seed();
  await db.games.insertOne({ userId: "foreign", gameId: "foreign", myBuild: "Foreign", _customBuildReclassify: [marker(runId)] });
  const owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, mutation(runId, { mode })); const operation = [...commands], after = await row();
  expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision); expect(after.gameStats).toEqual(before.gameStats);
  expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(await games.stats(userId));
  expect(await db.games.countDocuments({ userId, myBuild: "Saved opener", _customBuildSlug: "saved" })).toBe(2);
  expect(operation.filter(c => c.aggregate === "games" || c.count === "games")).toEqual([]);
  const claim = operation.find(c => c.findAndModify === "users"), eof = operation.find(c => c.update === "games");
  expect(claim).toMatchObject({ startTransaction: true, readConcern: { level: "snapshot" }, new: false });
  expect(claim.readConcern.afterClusterTime).toBeDefined(); expect(eof.lsid).toEqual(claim.lsid); expect(eof.txnNumber).toEqual(claim.txnNumber);
  expect(eof.updates).toHaveLength(1); expect(eof.updates[0]).toMatchObject({ q: { userId, "_customBuildReclassify.runId": runId }, multi: true, upsert: false });
  expect(operation.find(c => c.commitTransaction).writeConcern).toMatchObject({ w: "majority", j: true });
  expect((await db.games.findOne({ userId: "foreign" })).myBuild).toBe("Foreign");
});
test("legacy markers, opposite-side labels, overrides and sequence retirement keep original EOF behavior", async () => {
  const runId = uuid(), newer = marker(uuid(), { sequence: 20 }), old = marker(uuid(), { sequence: 2 });
  await seed([
    { gameId: "legacy", _customBuildReclassify: { ...marker(runId), perspective: undefined } },
    { gameId: "both", _customBuildReclassify: [marker(runId), marker(runId, { perspective: "opponent", desiredBuild: "Enemy saved", desiredSlug: "enemy" }), old, newer] },
    { gameId: "newer-label", _customBuildClassificationSequence: 30, _customBuildReclassify: [marker(runId)] },
    { gameId: "declared", buildIntent: { status: "confirmed", applied: true, build: { name: "Declared", slug: "declared", source: "custom" } }, _customBuildReclassify: [marker(runId)] },
  ], runId);
  await writer.write(await writer.capture(userId), mutation(runId));
  expect(await db.games.findOne({ gameId: "legacy" })).toMatchObject({ myBuild: "Saved opener", _customBuildSlug: "saved" });
  const both = await db.games.findOne({ gameId: "both" });
  expect(both).toMatchObject({ myBuild: "Saved opener", opponent: { strategy: "Enemy saved" }, _customOpponentStrategySlug: "enemy" });
  expect(both._customBuildReclassify).toEqual([newer]);
  expect(await db.games.findOne({ gameId: "newer-label" })).toMatchObject({ myBuild: "Old", _customBuildClassificationSequence: 30 });
  const declared = await db.games.findOne({ gameId: "declared" });
  expect(declared.myBuild).toBe("Declared"); expect(declared.buildIntent.detected).toMatchObject({ name: "Saved opener", slug: "saved" });
});
test("failed-run cleanup removes only its own private staging without publishing or retiring newer work", async () => {
  const runId = uuid(), other = marker(uuid(), { sequence: 20 });
  await seed([{ gameId: "one", _customBuildReclassify: [marker(runId), other] }], runId);
  await db.games.updateMany({ userId, "_customBuildReclassify.runId": runId }, removeReclassifyRunPipeline(runId));
  expect(await db.games.findOne({ gameId: "one" })).toMatchObject({ myBuild: "Old", _customBuildReclassify: [other] });
});
test.each(["single", "all"])("actual %s service entry captures before hydration and hydrates once across transaction retry", async mode => {
  await seed([{ gameId: "one", myRace: "Protoss", opponent: { race: "Zerg" } }]); await definition();
  const { custom, hydrate } = service(), update = db.games.updateMany.bind(db.games); let retried = false;
  jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[2]?.session && !retried) { retried = true; const error = new MongoServerError({ message: "retry EOF after actual write" }); error.addErrorLabel("TransientTransactionError"); throw error; }
    return result;
  });
  const result = mode === "single" ? await custom.reclassify(userId, "saved") : await custom.reclassifyAll(userId);
  expect(result.tagged).toBe(1); expect(retried).toBe(true); expect(hydrate).toHaveBeenCalledTimes(1);
  expect((await db.games.findOne({ gameId: "one" })).myBuild).toBe("Saved opener");
  expect((await row()).gameStats).toEqual(await games.stats(userId)); await custom.stopReclassifications();
});
test.each(["replace", "retire", "fence"])("owner %s during real service hydration cannot publish staged labels", async state => {
  await seed([{ gameId: "one" }]); await definition(); const entered = held(), release = held();
  const { custom } = service(async () => { entered.resolve(); await release.promise; });
  const task = custom.reclassifyAll(userId); await entered.promise;
  if (state === "replace") { await dbB.users.deleteOne({ userId }); await dbB.users.insertOne({ userId, gameStatsMutationEpoch: uuid() }); }
  if (state === "retire") await dbB.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } });
  if (state === "fence") await dbB.users.updateOne({ userId }, { $set: { _gdprMutation: { id: uuid() } } });
  release.resolve(); await expect(task).rejects.toThrow("game_stats_authority_changed");
  expect((await db.games.findOne({ gameId: "one" })).myBuild).toBe("Old");
  expect(await db.games.countDocuments({ "_customBuildReclassify.runId": { $exists: true } })).toBe(0);
  await custom.stopReclassifications();
});
test("a replay payload revision changed during hydration rejects that stale staged verdict", async () => {
  await seed([{ gameId: "one" }]); await definition(); const entered = held(), release = held();
  const { custom } = service(async () => { entered.resolve(); await release.promise; });
  const task = custom.reclassifyAll(userId); await entered.promise;
  await dbB.games.updateOne({ gameId: "one" }, { $set: { _customBuildRevision: uuid(), myBuild: "Fresh replay" } });
  release.resolve(); await task;
  expect((await db.games.findOne({ gameId: "one" })).myBuild).toBe("Fresh replay");
  expect((await row()).gameStats).toEqual(await games.stats(userId)); await custom.stopReclassifications();
});
test("actual DataRepairs delegates its acquired custom-build owner/fence without recapture", async () => {
  await seed([{ gameId: "one" }]); await definition(); const { custom } = service();
  const gdpr = new GdprService(db, { customBuilds: custom, logger }), fence = await gdpr._acquireMutationFence(userId, "repair_custom-builds");
  const id = uuid(), notify = jest.fn(async () => {}), repairs = new DataRepairsService(db, { gdpr, notifications: { notify }, logger });
  await db.users.updateOne({ userId }, { $set: { "repairs.custom-builds": { id, status: "running" } } });
  const capture = jest.spyOn(writer, "capture"); await repairs.run(userId, "custom-builds", id, "repairs.custom-builds", fence);
  expect(capture).not.toHaveBeenCalled(); expect((await row()).repairs["custom-builds"].status).toBe("complete");
  expect((await db.games.findOne({ gameId: "one" })).myBuild).toBe("Saved opener");
  expect((await row())._gdprMutation).toBeUndefined(); expect((await row()).gameStats).toBeUndefined();
  expect(notify).toHaveBeenCalledWith(userId, expect.objectContaining({ title: "Data repair completed" }));
  await custom.stopReclassifications();
});
test.each(["foreign-kind", "replaced", "retired"])("a captured repair %s is rejected atomically", async state => {
  const { runId } = await seed(), gdpr = new GdprService(db, { logger });
  const fence = await gdpr._acquireMutationFence(userId, "repair_custom-builds");
  try {
    if (state === "foreign-kind") await dbB.users.updateOne({ userId }, { $set: { "_gdprMutation.kind": "restore" } });
    if (state === "replaced") await dbB.users.updateOne({ userId }, { $set: { "_gdprMutation.id": uuid() } });
    if (state === "retired") await dbB.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() }, $unset: { _gdprMutation: "" } });
    await expect(writer.write(fence.owner, mutation(runId, { repairFenceId: fence.id }))).rejects.toThrow("game_stats_authority_changed");
    expect(await db.games.countDocuments({ myBuild: "Old" })).toBe(2);
  } finally { await gdpr._releaseMutationFence(userId, fence); }
});
test("releasing a real repair fence retires EOF authority even when owner and epoch are unchanged", async () => {
  const { runId } = await seed(), gdpr = new GdprService(db, { logger });
  const fence = await gdpr._acquireMutationFence(userId, "repair_custom-builds");
  try {
    await gdpr._releaseMutationFence(userId, fence); const released = await row();
    expect(released._id).toEqual(fence.owner.id); expect(released.gameStatsMutationEpoch).toBe(fence.owner.epoch);
    expect(released.gameStatsMutationEpoch).toBe(fence.id); expect(released._gdprMutation).toBeUndefined();
    await expect(writer.write(fence.owner, mutation(runId, { repairFenceId: fence.id }))).rejects.toThrow("game_stats_authority_changed");
    expect(await db.games.countDocuments({ myBuild: "Old" })).toBe(2);
    expect((await row()).gameStatsRevision).toBe(released.gameStatsRevision);
  } finally { await gdpr._releaseMutationFence(userId, fence); }
});
test("a failed full EOF rolls back every game, lease renewal and count UUID together", async () => {
  const { runId, before } = await seed(), lease = { generation: uuid(), leaseToken: uuid() }, expired = new Date(0);
  await db.customBuildJobs.insertOne({ userId, ...lease, status: "running", leaseUntil: expired });
  const update = db.games.updateMany.bind(db.games), fault = new Error("after whole EOF write");
  jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => { const result = await update(...args); if (args[2]?.session) throw fault; return result; });
  await expect(writer.write(await writer.capture(userId), mutation(runId, { lease }))).rejects.toBe(fault);
  expect(await db.games.countDocuments({ myBuild: "Old" })).toBe(2); expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
  expect((await db.customBuildJobs.findOne({ userId })).leaseUntil).toEqual(expired); expect((await row()).gameStats).toEqual(before.gameStats);
});
test("the ordinary job path retains its callback checks and renews captured lease inside EOF", async () => {
  await seed([{ gameId: "one" }]); await definition(); const { custom } = service();
  const lease = { generation: uuid(), leaseToken: uuid() }, assertLease = jest.fn(async () => {
    expect(await db.customBuildJobs.countDocuments({ userId, ...lease, status: "running" })).toBe(1);
  });
  await db.customBuildJobs.insertOne({ userId, ...lease, status: "running", leaseUntil: new Date(0) }); commands.length = 0;
  await custom.reclassifyAll(userId, { leaseAuthority: lease, assertLease, jobSequence: 12 });
  expect(assertLease).toHaveBeenCalled();
  const claim = commands.find(c => c.findAndModify === "users"), renewal = commands.find(c => c.update === "custom_build_jobs" && c.txnNumber);
  expect(renewal.updates[0].q).toEqual({ userId, ...lease, status: "running" });
  expect(renewal.lsid).toEqual(claim.lsid); expect(renewal.txnNumber).toEqual(claim.txnNumber);
  expect((await db.games.findOne({ gameId: "one" }))._customBuildClassificationSequence).toBe(12);
  expect((await row()).gameStats).toEqual(await games.stats(userId)); await custom.stopReclassifications();
});
test.each(["abort", "lease-replaced", "opponent-write"])("%s during the owner await cannot reach full EOF", async state => {
  const { runId, before } = await seed(), controller = new AbortController(), lease = { generation: uuid(), leaseToken: uuid() };
  await db.customBuildJobs.insertOne({ userId, ...lease, status: "running" });
  const claim = db.users.findOneAndUpdate.bind(db.users), entered = held(), release = held();
  jest.spyOn(db.users, "findOneAndUpdate").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return claim(...args); });
  const task = writer.write(await writer.capture(userId), mutation(runId, { lease, signal: controller.signal })); await entered.promise;
  if (state === "abort") controller.abort();
  if (state === "lease-replaced") await db.customBuildJobs.updateOne({ userId }, { $set: { leaseToken: uuid() } });
  if (state === "opponent-write") await dbB.games.updateOne({ gameId: "one" }, { $set: { _opponentBuildOrderWriteLease: { leaseUntil: new Date(Date.now() + 60000) } } });
  release.resolve(); await expect(task).rejects.toThrow(state === "opponent-write" ? "opponent_build_order_write_in_progress" : "reclassify_aborted");
  expect(await db.games.countDocuments({ myBuild: "Old" })).toBe(2); expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
});
test("concurrent independent-client ingest is retained by the later count-neutral EOF", async () => {
  const { runId } = await seed(), owner = await writer.capture(userId), later = new Date(played.getTime() + 60000);
  await writerB.write(await writerB.capture(userId), session => dbB.games.insertOne({ userId, gameId: "later", date: later }, { session }), { selection: { gameIds: ["later"] } });
  await writer.write(owner, mutation(runId));
  expect((await row()).gameStats).toEqual({ total: 3, latest: later }); expect((await row()).gameStats).toEqual(await games.stats(userId));
  expect((await db.games.findOne({ gameId: "later" })).myBuild).toBeUndefined();
});
test("an unsupported count tuple stays retired rather than triggering a neutral recount", async () => {
  const { runId } = await seed(); await db.users.updateOne({ userId }, { $set: { "gameStatsMaintenance.version": 1 } });
  const owner = await writer.capture(userId); commands.length = 0; await writer.write(owner, mutation(runId));
  expect(commands.filter(c => c.aggregate === "games" || c.count === "games")).toEqual([]);
  expect((await row()).gameStats).toBeUndefined(); expect(readyStatsFromOwnerRow(await row(), userId, true)).toBeNull();
  expect(await db.games.countDocuments({ myBuild: "Saved opener" })).toBe(2);
});
test.each(["retry-ack", "unknown-after-commit"])("actual EOF commit %s keeps atomic labels and does not invent success", async state => {
  const { runId } = await seed(), start = db.client.startSession.bind(db.client); let commits = 0;
  const unknown = new MongoServerError({ message: "unknown after actual EOF commit" });
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); commits++;
      if (commits === 1) {
        if (state === "unknown-after-commit") throw unknown;
        const error = new MongoNetworkError("lost EOF commit ACK"); error.addErrorLabel("UnknownTransactionCommitResult"); throw error;
      }
    }; return session;
  });
  const task = writer.write(await writer.capture(userId), mutation(runId));
  if (state === "unknown-after-commit") await expect(task).rejects.toBe(unknown);
  else { await expect(task).resolves.toMatchObject({ acknowledged: true, matchedCount: 2 }); expect(commits).toBe(2); }
  expect(await db.games.countDocuments({ myBuild: "Saved opener" })).toBe(2);
  expect((await row()).gameStats).toEqual(await games.stats(userId));
});
test("writer drain owns the entire actual EOF transaction through its final settlement", async () => {
  const { runId } = await seed(), client = new MongoClient(mongo.getUri()); await client.connect();
  const database = client.db("custom_eof_revision"), scoped = { ...db, client, db: database,
    users: database.collection("users"), games: database.collection("games") };
  const scopedWriter = gameStatsWritesFor(scoped), update = scoped.games.updateMany.bind(scoped.games), entered = held(), release = held();
  jest.spyOn(scoped.games, "updateMany").mockImplementation(async (...args) => {
    const result = await update(...args); if (args[2]?.session) { entered.resolve(); await release.promise; } return result;
  });
  try {
    const task = scopedWriter.write(await scopedWriter.capture(userId), mutation(runId)); await entered.promise;
    let settled = false; const drain = scopedWriter.stopAndDrain().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); expect(scopedWriter.pending.size).toBe(1);
    release.resolve(); await task; await drain; expect(scopedWriter.pending.size).toBe(0);
    expect(await db.games.countDocuments({ myBuild: "Saved opener" })).toBe(2);
  } finally { release.resolve(); await scopedWriter.stopAndDrain(); await client.close(); }
});
