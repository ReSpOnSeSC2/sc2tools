// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError, ObjectId } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { UserRevision } = require("../src/util/userRevision");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const logger = pino({ level: "silent" }), userId = "custom-ingest-owner", played = new Date("2026-10-20T12:00:00Z"), commands = [];
let mongo, mongoChild, db, clientB, dbB, writer, writerB, games;
const row = () => db.users.findOne({ userId });
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const decision = extra => ({ you: { mode: "set", name: "$Saved", slug: "saved" }, opponent: { mode: "set", name: "$Enemy", slug: "enemy" },
  payloadBuild: "Agent", payloadStrategy: "Agent enemy", policyBuild: null, policyStrategy: null, clearStaging: true, ...extra });
const mutation = extra => ({ kind: "customBuildIngestTag", gameId: "one", expectedRevision: "revision-one", decision: decision(), ...extra });
const payload = () => ({ gameId: "one", myRace: "Protoss", myBuild: "Agent", opponent: { race: "Zerg", strategy: "Agent enemy" }, buildLog: [], oppBuildLog: [] });
async function seed(date = played) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() });
  await db.games.insertOne({ userId, gameId: "one", date, myBuild: "Agent", opponent: { race: "Zerg", strategy: "Agent enemy", mmr: 3000 },
    _customBuildRevision: "revision-one", _customBuildReclassify: [{ runId: uuid() }], _customBuildClassificationSequence: 12 });
  const owner = await row(), revision = uuid(), stats = await games.stats(userId);
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner._id, epoch: owner.gameStatsMutationEpoch, revision } } });
  return row();
}
function service(beforePage = async () => {}, options = {}) {
  const custom = new CustomBuildsService(db, { perGame: { catalog: null }, logger, ...options });
  custom._iterateForClassification = jest.fn(async function* () { await beforePage(); yield []; });
  return custom;
}
function expectNoRecount(operation) {
  expect(operation.some(c => c.findAndModify === "games")).toBe(true);
  expect(operation.filter(c => c.aggregate === "games" || c.count === "games" || c.find === "games")).toEqual([]);
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`custom_ingest_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "custom_ingest_revision", awaitBackgroundIndexes: true }, { logger });
  clientB = new MongoClient(mongo.getUri(), { monitorCommands: true }); await clientB.connect();
  const database = clientB.db("custom_ingest_revision");
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
      process.stdout.write(`custom_ingest_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.games, db.customBuilds, db.customBuildJobs]) await collection.deleteMany({});
  commands.length = 0;
});

test.each([played, null])("strict ready2 with latest=%p carries only count/latest under one real session", async date => {
  const before = await seed(date), owner = await writer.capture(userId); commands.length = 0;
  await expect(writer.write(owner, mutation())).resolves.toHaveProperty("_id");
  const operation = [...commands], after = await row(), stored = await db.games.findOne({ userId, gameId: "one" });
  expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision); expect(after.gameStats).toEqual(before.gameStats);
  expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(await games.stats(userId)); expectNoRecount(operation);
  expect(stored).toMatchObject({ myBuild: "$Saved", _customBuildSlug: "saved", opponent: { strategy: "$Enemy", mmr: 3000 },
    _customOpponentStrategySlug: "enemy", _customBuildRevision: "revision-one" });
  expect(stored.date).toEqual(date); expect(stored._customBuildReclassify).toBeUndefined(); expect(stored._customBuildClassificationSequence).toBeUndefined();
  const claim = operation.find(c => c.findAndModify === "users"), tag = operation.find(c => c.findAndModify === "games");
  expect(claim).toMatchObject({ startTransaction: true, readConcern: { level: "snapshot" }, new: false });
  expect(claim.readConcern.afterClusterTime).toBeDefined(); expect(tag.lsid).toEqual(claim.lsid); expect(tag.txnNumber).toEqual(claim.txnNumber);
  expect(tag).toMatchObject({ query: { userId, gameId: "one", _customBuildRevision: "revision-one" }, fields: { _id: 1 }, upsert: false });
  const save = operation.find(c => c.update === "users" && c.updates.some(u => u.u.$set?.gameStatsMaintenance));
  expect(save).toBeDefined(); expect(save.lsid).toEqual(claim.lsid); expect(save.txnNumber).toEqual(claim.txnNumber);
  expect(operation.find(c => c.commitTransaction).writeConcern).toMatchObject({ w: "majority", j: true });
});
const invalidProofs = [
  { $set: { gameStatsProtocolVersion: 1 } }, { $set: { "gameStatsMaintenance.version": 1 } },
  { $set: { "gameStatsMaintenance.status": "unsupported_latest", "gameStats.latest": "legacy-date" } },
  { $set: { "gameStatsMaintenance.ownerId": new ObjectId() } }, { $set: { "gameStatsMaintenance.revision": uuid() } },
  { $set: { "gameStatsMaintenance.epoch": uuid() } }, { $set: { "gameStats.total": 1.5 } },
  { $unset: { "gameStats.latest": "" } }, { $set: { "gameStats.total": 0 } },
];
test.each(invalidProofs)("invalid prior proof %p stays retired without a count/latest query", async update => {
  await seed(); await db.users.updateOne({ userId }, update); const owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, mutation()); const operation = [...commands], after = await row();
  expectNoRecount(operation); expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined();
  expect(readyStatsFromOwnerRow(after, userId, true)).toBeNull(); expect((await db.games.findOne({ userId })).myBuild).toBe("$Saved");
});
test("both check-in declarations retain labels while fixed outcomes update only detector provenance", async () => {
  await seed(); const reference = { source: "custom", name: "Declared", slug: "declared" };
  await db.games.updateOne({ userId }, { $set: { buildIntent: { status: "confirmed", applied: true, build: reference,
    opponent: { status: "confirmed", applied: true, build: { ...reference, name: "Declared enemy", slug: "declared-enemy" } } } } });
  await writer.write(await writer.capture(userId), mutation()); const stored = await db.games.findOne({ userId });
  expect(stored).toMatchObject({ myBuild: "Declared", _customBuildSlug: "declared", opponent: { strategy: "Declared enemy", mmr: 3000 },
    _customOpponentStrategySlug: "declared-enemy", buildIntent: { detected: { name: "$Saved", slug: "saved" }, opponent: { detected: { name: "$Enemy", slug: "enemy" } } } });
});
test("restore-only keep outcomes preserve staging and use agent payload detector fallbacks", async () => {
  await seed(); await db.games.updateOne({ userId }, { $set: { buildIntent: { status: "confirmed", applied: true,
    build: { source: "custom", name: "Declared", slug: "declared" } } } });
  await writer.write(await writer.capture(userId), mutation({ decision: decision({ you: { mode: "keep" }, opponent: { mode: "keep" }, clearStaging: false }) }));
  const stored = await db.games.findOne({ userId }); expect(stored.myBuild).toBe("Declared");
  expect(stored.buildIntent.detected.name).toBe("Agent"); expect(stored.opponent.strategy).toBe("Agent enemy");
  expect(stored._customBuildReclassify).toHaveLength(1); expect(stored._customBuildClassificationSequence).toBe(12);
});
test.each(["recreated", "retired", "fenced"])("the original ingest owner %s during classification cannot publish or recapture", async state => {
  await seed(); const owner = await writer.capture(userId), entered = held(), release = held(), custom = service(async () => { entered.resolve(); await release.promise; });
  const capture = jest.spyOn(writer, "capture"), task = custom.tagSingleGame(userId, payload(), { statsOwner: owner, expectedRevision: "revision-one" });
  const outcome = task.then(result => ({ result }), error => ({ error })); await entered.promise;
  try {
    if (state === "recreated") { await dbB.users.deleteOne({ userId }); await dbB.users.insertOne({ userId, gameStatsMutationEpoch: uuid() }); }
    if (state === "retired") await dbB.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } });
    if (state === "fenced") await dbB.users.updateOne({ userId }, { $set: { _gdprMutation: { id: uuid() } } });
  } finally { commands.length = 0; release.resolve(); }
  expect((await outcome).error).toMatchObject({ code: "game_stats_authority_changed" });
  expect(capture).not.toHaveBeenCalled(); expect(commands.filter(c => c.findAndModify === "games")).toEqual([]);
  expect((await db.games.findOne({ userId })).myBuild).toBe("Agent");
});
test("a newer replay revision rejects the stale tag and rolls back its owner rotation", async () => {
  const before = await seed(), owner = await writer.capture(userId), entered = held(), release = held();
  const custom = service(async () => { entered.resolve(); await release.promise; });
  const task = custom.tagSingleGame(userId, payload(), { statsOwner: owner, expectedRevision: "revision-one" });
  const rejected = expect(task).rejects.toMatchObject({ code: "custom_build_tag_superseded" }); await entered.promise;
  try { await dbB.games.updateOne({ userId }, { $set: { _customBuildRevision: "newer", myBuild: "Fresh parse" } }); }
  finally { release.resolve(); }
  await rejected; expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
  expect((await db.games.findOne({ userId })).myBuild).toBe("Fresh parse");
});
test("independent-client ingest during classification is carried from the later atomic preimage", async () => {
  await seed(); const owner = await writer.capture(userId), entered = held(), release = held(), later = new Date(played.getTime() + 60000);
  const custom = service(async () => { entered.resolve(); await release.promise; });
  const task = custom.tagSingleGame(userId, payload(), { statsOwner: owner, expectedRevision: "revision-one" }); await entered.promise;
  try { await writerB.write(await writerB.capture(userId), session => dbB.games.insertOne({ userId, gameId: "later", date: later }, { session }), { selection: { gameIds: ["later"] } }); }
  finally { release.resolve(); }
  await task; expect((await row()).gameStats).toEqual({ total: 2, latest: later });
  expect((await row()).gameStats).toEqual(await games.stats(userId)); expect((await db.games.findOne({ gameId: "later" })).myBuild).toBeUndefined();
});
test("a transient actual tag retry does not replay classification or policy reads", async () => {
  await seed(); const policies = { current: jest.fn(async () => ({ entries: [] })) }, custom = service(undefined, { presetPolicies: policies });
  const input = payload(); input.presetEvidence = { schemaVersion: 1, evaluatorVersion: 1, you: { baseline: "Policy label", complete: true, events: [] } };
  const update = db.games.findOneAndUpdate.bind(db.games); let injections = 0;
  const write = jest.spyOn(db.games, "findOneAndUpdate").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[2]?.session && injections++ === 0) { const error = new MongoServerError({ message: "retry actual ingest tag" }); error.addErrorLabel("TransientTransactionError"); throw error; }
    return result;
  });
  await custom.tagSingleGame(userId, input, { statsOwner: await writer.capture(userId), expectedRevision: "revision-one" });
  expect(injections).toBe(2); expect(write).toHaveBeenCalledTimes(2); expect(custom._iterateForClassification).toHaveBeenCalledTimes(1);
  expect(policies.current).toHaveBeenCalledTimes(1); expect((await db.games.findOne({ userId })).myBuild).toBe("Policy label");
  expect((await row()).gameStats).toEqual(await games.stats(userId));
});
test("failure after the actual game write rolls back labels, staging and count UUID", async () => {
  const before = await seed(), originalGame = await db.games.findOne({ userId }), update = db.games.findOneAndUpdate.bind(db.games), error = new Error("after tag");
  jest.spyOn(db.games, "findOneAndUpdate").mockImplementation(async (...args) => { await update(...args); throw error; });
  await expect(writer.write(await writer.capture(userId), mutation())).rejects.toBe(error);
  expect(await db.games.findOne({ userId })).toEqual(originalGame); expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
  expect((await row()).gameStats).toEqual(before.gameStats);
});
test.each(["retry-ack", "unknown-after-commit"])("actual tag commit %s preserves outcome and notification boundaries", async state => {
  await seed(); await statsReadFloorFor(db)(); const owner = await writer.capture(userId), start = db.client.startSession.bind(db.client);
  const revisions = new UserRevision(db.users, { enabled: true }), onGamesChanged = jest.fn(), onReclassified = jest.fn();
  const custom = service(undefined, { userRevision: revisions, onGamesChanged, onReclassified });
  const before = await revisions.snapshot(userId), unknown = new MongoServerError({ message: "unknown actual tag commit" }); let commits = 0, injectedSessions = 0;
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args);
    if (args[0]?.causalConsistency === true && args[0]?.explicit !== false) {
      injectedSessions++; const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        await commit(); commits++;
        if (commits === 1) {
          if (state === "unknown-after-commit") throw unknown;
          const error = new MongoNetworkError("lost actual tag ACK"); error.addErrorLabel("UnknownTransactionCommitResult"); throw error;
        }
      };
    }
    return session;
  });
  const task = custom.tagSingleGame(userId, payload(), { statsOwner: owner, expectedRevision: "revision-one" });
  if (state === "unknown-after-commit") await expect(task).rejects.toBe(unknown);
  else await expect(task).resolves.toMatchObject({ gameId: "one", matched: 0 });
  expect(injectedSessions).toBe(1); expect(commits).toBe(state === "retry-ack" ? 2 : 1);
  expect(custom._iterateForClassification).toHaveBeenCalledTimes(1); expect(onGamesChanged).not.toHaveBeenCalled(); expect(onReclassified).not.toHaveBeenCalled();
  expect(revisions.current(before)).toBe(false); expect((await row()).gameStats).toEqual(await games.stats(userId));
  expect((await db.games.findOne({ userId }))._customBuildReclassify).toBeUndefined();
});
test("drain owns an actual tag transaction until settlement and rejects new admission", async () => {
  await seed(); const update = db.games.findOneAndUpdate.bind(db.games), entered = held(), release = held();
  jest.spyOn(db.games, "findOneAndUpdate").mockImplementation(async (...args) => { const result = await update(...args); entered.resolve(); await release.promise; return result; });
  const owner = await writer.capture(userId), task = writer.write(owner, mutation()); await entered.promise;
  let settled = false; const drain = writer.stopAndDrain().then(() => { settled = true; });
  try {
    await Promise.resolve(); expect(settled).toBe(false); expect(writer.pending.size).toBe(1);
    await expect(writer.write(owner, mutation())).rejects.toThrow("game_stats_writer_stopping");
  } finally { release.resolve(); }
  await task; await drain; expect(writer.pending.size).toBe(0); expect(settled).toBe(true);
});
