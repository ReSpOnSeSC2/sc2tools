// @ts-nocheck
"use strict";
const { MongoMemoryReplSet, MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient, MongoServerError, MongoNetworkError, ObjectId } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { GamesService } = require("../src/services/games");
const { UserRevision } = require("../src/util/userRevision");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { readyStatsFromOwnerRow } = require("../src/services/maintainedGameStatsRead");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { immutableCustomBuildDefinitionSave, applyCustomBuildDefinitionSave } = require("../src/services/gameStatsCustomBuildDefinitionSave");
const { COLLECTIONS } = require("../src/config/constants");
const logger = pino({ level: "silent" }), userId = "definition-mongo-owner", played = new Date("2026-10-20T12:00:00Z");
const commands = [], failedCommands = [], databaseName = "definition_save_revision", buildCollection = COLLECTIONS.CUSTOM_BUILDS;
let mongo, nativeChild, db, dbB, clientB, writer, writerB, games, standalone = false;
const row = () => db.users.findOne({ userId });
const definition = extra => ({ slug: "saved", name: "$Saved", race: "Protoss", vsRace: "Any", perspective: "you", rules: [], steps: [], ...extra });
const data = extra => ({ kind: "customBuildDefinitionSave", definition: definition(), ...extra });
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function service(options = {}, context = db) {
  const onGamesChanged = jest.fn(), onDefinitionsChanged = jest.fn();
  const custom = new CustomBuildsService(context, { logger, onGamesChanged, onDefinitionsChanged, ...options });
  return { custom, onGamesChanged, onDefinitionsChanged };
}
function replayRows(date) {
  const reference = { source: "custom", slug: "saved", name: "Old" };
  return [{ userId, gameId: "you", date, myBuild: "Old", _customBuildSlug: "saved", opponent: { strategy: "Old enemy", mmr: 3100 },
    buildIntent: { applied: true, build: reference, detected: { slug: "saved", name: "Old" } } },
  { userId, gameId: "opponent", date, myBuild: "Other", opponent: { strategy: "Old", mmr: 3200 }, _customOpponentStrategySlug: "saved",
    buildIntent: { opponent: { applied: true, build: reference, detected: { slug: "saved", name: "Old" } } } },
  { userId, gameId: "foreign-detector", date, myBuild: "Old", opponent: { mmr: 3300 }, _customBuildSlug: "saved",
    buildIntent: { applied: true, build: reference, detected: { slug: "other", name: "Other detector" } } }];
}
async function seed(date = played, extraDefinition = {}) {
  await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() });
  await db.games.insertMany([...replayRows(date), { ...replayRows(date)[0], userId: "foreign", gameId: "foreign" }]);
  const saved = await db.customBuilds.insertOne({ userId, slug: "saved", name: "Old", race: "Protoss", perspective: "you",
    definitionRevision: 0, notes: "Previous private notes", sourceGameId: "previous-private-replay", createdAt: played, updatedAt: played, ...extraDefinition });
  const owner = await row(), revision = uuid(), stats = await games.stats(userId);
  await db.users.updateOne({ _id: owner._id }, { $set: { gameStats: stats, gameStatsRevision: revision,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner._id, epoch: owner.gameStatsMutationEpoch, revision } } });
  return { before: await row(), definitionId: saved.insertedId };
}
async function openContext() {
  db = await connect({ uri: mongo.getUri(), dbName: databaseName, awaitBackgroundIndexes: true }, { logger });
  clientB = new MongoClient(mongo.getUri(), { monitorCommands: true }); await clientB.connect();
  const database = clientB.db(databaseName);
  dbB = { ...db, client: clientB, db: database, users: database.collection("users"), games: database.collection("games"), customBuilds: database.collection(buildCollection) };
  writer = gameStatsWritesFor(db); writerB = gameStatsWritesFor(dbB); games = new GamesService(db);
  for (const [name, client] of [["A", db.client], ["B", clientB]]) {
    client.on("commandStarted", event => commands.push({ client: name, ...event.command }));
    client.on("commandFailed", event => failedCommands.push({ client: name, commandName: event.commandName, code: event.failure?.code, message: String(event.failure?.message) }));
  }
}
async function closeContext() {
  try { await writer?.stopAndDrain(); await writerB?.stopAndDrain(); await clientB?.close(); await db?.close(); }
  finally {
    await mongo?.stop();
    if (nativeChild) {
      expect(nativeChild.exitCode !== null || nativeChild.signalCode !== null).toBe(true);
      process.stdout.write(`definition_owned_mongo_closed ${JSON.stringify({ pid: nativeChild.pid, exitCode: nativeChild.exitCode, signal: nativeChild.signalCode })}\n`);
    }
  }
}
async function switchToStandalone() {
  await closeContext(); standalone = true;
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" }, instance: { storageEngine: "wiredTiger" } });
  nativeChild = mongo.instanceInfo.instance.mongodProcess;
  process.stdout.write(`definition_owned_mongo ${JSON.stringify({ pid: nativeChild.pid, port: mongo.instanceInfo.port, standalone: true })}\n`);
  await openContext();
  const hello = await db.client.db("admin").command({ hello: 1 });
  expect(hello.setName).toBeUndefined(); expect(hello.isWritablePrimary).toBe(true); expect(db.gameStatsTransactions).toBe(false);
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  nativeChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`definition_owned_mongo ${JSON.stringify({ pid: nativeChild.pid, port: mongo.servers[0].instanceInfo.port, standalone: false })}\n`);
  await openContext(); expect(db.gameStatsTransactions).toBe(true);
});
afterAll(closeContext);
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.games, db.customBuilds]) await collection.deleteMany({});
  commands.length = 0; failedCommands.length = 0;
});
afterEach(() => jest.restoreAllMocks());
function expectNoRecount(operation) {
  expect(operation.filter(command => command.aggregate === "games" || command.count === "games" || command.find === "games")).toEqual([]);
}

test.each([played, null])("strict ready2 latest=%p shares owner/read/rename/CAS/history/carry session", async date => {
  const { before, definitionId } = await seed(date), saved = service(); commands.length = 0;
  await saved.custom.upsert(userId, definition({ notes: "New private", sourceGameId: "private-new", shareWithCommunity: true }),
    { expectedRevision: 0, expectedId: definitionId.toHexString(), recordHistory: true });
  const operation = [...commands], after = await row(), result = await db.customBuilds.findOne({ userId, slug: "saved" });
  expect(after.gameStatsRevision).not.toBe(before.gameStatsRevision); expect(after.gameStats).toEqual(before.gameStats);
  expect(readyStatsFromOwnerRow(after, userId, true)).toEqual(await games.stats(userId)); expectNoRecount(operation);
  expect(result).toMatchObject({ definitionRevision: 1, notes: "New private", sourceGameId: "private-new", shareWithCommunity: true });
  expect(result._definitionHistory).toHaveLength(1); expect(result._definitionHistory[0]).toMatchObject({ revision: 0, build: { name: "Old" } });
  expect(result._definitionHistory[0].build.notes).toBeUndefined(); expect(result._definitionHistory[0].build.sourceGameId).toBeUndefined();
  const claim = operation.find(command => command.findAndModify === "users"), read = operation.find(command => command.aggregate === buildCollection);
  const rename = operation.find(command => command.update === "games"), update = operation.find(command => command.update === buildCollection);
  const carry = operation.find(command => command.update === "users" && command.updates.some(item => item.u.$set?.gameStatsMaintenance));
  expect(claim).toMatchObject({ startTransaction: true, readConcern: { level: "snapshot" }, new: false }); expect(claim.readConcern.afterClusterTime).toBeDefined();
  for (const command of [read, rename, update, carry]) { expect(command).toBeDefined(); expect(command.lsid).toEqual(claim.lsid); expect(command.txnNumber).toEqual(claim.txnNumber); }
  expect(update.updates[0]).toMatchObject({ q: { userId, slug: "saved", _id: definitionId, deletedAt: { $exists: false },
    $or: [{ definitionRevision: 0 }, { definitionRevision: { $exists: false } }] }, upsert: false });
  expect(operation.find(command => command.commitTransaction).writeConcern).toMatchObject({ w: "majority", j: true });
  expect(saved.onGamesChanged).toHaveBeenCalledWith(userId, 2); expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(1);
});

const invalidProofs = [{ $set: { gameStatsProtocolVersion: 1 } }, { $set: { "gameStatsMaintenance.version": 1 } },
  { $set: { "gameStatsMaintenance.ownerId": new ObjectId() } }, { $set: { "gameStatsMaintenance.revision": uuid() } },
  { $set: { "gameStats.total": 1.5 } }, { $unset: { "gameStats.latest": "" } }];
test.each(invalidProofs)("invalid proof %p stays retired without a count/latest query", async patch => {
  await seed(); await db.users.updateOne({ userId }, patch); commands.length = 0;
  await service().custom.upsert(userId, definition()); const operation = [...commands], after = await row();
  expectNoRecount(operation); expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined();
  expect(readyStatsFromOwnerRow(after, userId, true)).toBeNull(); expect((await db.customBuilds.findOne({ userId })).name).toBe("$Saved");
});

test.each(["you", "opponent"])("%s rename preserves exact literal/provenance/whole-history predicates", async perspective => {
  await seed(played, { perspective }); const excluded = { ...replayRows(played)[perspective === "you" ? 0 : 1], gameId: "excluded", _deleted: true };
  await db.games.insertOne(excluded); commands.length = 0;
  await service().custom.upsert(userId, definition({ perspective })); const operation = [...commands];
  const renamed = await db.games.findOne({ userId, gameId: perspective === "you" ? "you" : "opponent" });
  const foreign = await db.games.findOne({ userId: "foreign" }), ignored = await db.games.findOne({ userId, gameId: "foreign-detector" });
  const command = operation.find(item => item.update === "games").updates[0];
  expect(command.q).toEqual(perspective === "you" ? { userId, _customBuildSlug: "saved", "buildIntent.applied": true,
    "buildIntent.build.source": "custom", "buildIntent.build.slug": "saved" } : { userId, _customOpponentStrategySlug: "saved",
    "buildIntent.opponent.applied": true, "buildIntent.opponent.build.source": "custom", "buildIntent.opponent.build.slug": "saved" });
  expect(command.multi).toBe(true); expect(JSON.stringify(command.u)).toContain('"$literal":"$Saved"');
  expect(perspective === "you" ? renamed.myBuild : renamed.opponent.strategy).toBe("$Saved");
  expect(perspective === "you" ? (await db.games.findOne({ userId, gameId: "excluded" })).myBuild
    : (await db.games.findOne({ userId, gameId: "excluded" })).opponent.strategy).toBe("$Saved");
  expect(foreign.myBuild).toBe("Old"); expect(ignored.buildIntent.detected.name).toBe("Other detector");
  expect(renamed.date).toEqual(played); expect(renamed.opponent.mmr).toBe(perspective === "you" ? 3100 : 3200);
  expect(renamed._schemaVersion).toBeUndefined(); expectNoRecount(operation);
});

test("same-name same-axis is a no-op; a perspective flip leaves old-axis declarations frozen", async () => {
  await seed(); commands.length = 0; await service().custom.upsert(userId, definition({ name: "Old" }));
  expect(commands.filter(command => command.update === "games")).toEqual([]);
  await service().custom.upsert(userId, definition({ perspective: "opponent" }));
  expect((await db.games.findOne({ userId, gameId: "you" })).myBuild).toBe("Old");
  expect((await db.games.findOne({ userId, gameId: "opponent" })).opponent.strategy).toBe("$Saved");
});

test("history remains public/bounded10 while private save fields and creation timestamp survive", async () => {
  const history = Array.from({ length: 12 }, (_, revision) => ({ revision, savedAt: played, build: { name: "History " + revision } }));
  await seed(played, { _definitionHistory: history });
  await service().custom.upsert(userId, definition({ notes: "Private retained", sourceGameId: "private", _schemaVersion: 999,
    deletedAt: new Date(), definitionRevision: 99, _definitionHistory: ["forged"], reclassifyJob: { status: "forged" } }), { expectedRevision: 0, recordHistory: true });
  const saved = await db.customBuilds.findOne({ userId }); expect(saved._definitionHistory).toHaveLength(10);
  expect(saved._definitionHistory[0].revision).toBe(3); expect(saved._definitionHistory.at(-1).revision).toBe(0);
  expect(saved._definitionHistory.at(-1).build).not.toHaveProperty("notes"); expect(saved._definitionHistory.at(-1).build).not.toHaveProperty("sourceGameId");
  expect(saved).toMatchObject({ notes: "Private retained", sourceGameId: "private", definitionRevision: 1 });
  expect(saved._schemaVersion).not.toBe(999); expect(saved.reclassifyJob).toBeUndefined(); expect(saved.deletedAt).toBeUndefined();
  expect(saved.createdAt).toEqual(played); expect(saved.updatedAt.getTime()).toBeGreaterThan(played.getTime());
});

test.each(["ordinary", "versioned"])("deleted definition preserves original %s behavior", async mode => {
  const { before } = await seed(played, { deletedAt: played }), saved = service();
  const task = saved.custom.upsert(userId, definition(), mode === "versioned" ? { expectedRevision: 0, recordHistory: true } : {});
  if (mode === "ordinary") {
    await task; expect((await db.customBuilds.findOne({ userId })).deletedAt).toBeUndefined(); expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(1);
  } else {
    await expect(task).rejects.toMatchObject({ code: "build_definition_changed", status: 409 });
    expect((await db.customBuilds.findOne({ userId })).deletedAt).toEqual(played); expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
    expect((await db.games.findOne({ userId, gameId: "you" })).myBuild).toBe("Old"); expect(saved.onDefinitionsChanged).not.toHaveBeenCalled();
  }
});

test("missing revision matches expected0, while wrong expectedId has no partial write", async () => {
  const { definitionId } = await seed(); await db.customBuilds.updateOne({ _id: definitionId }, { $unset: { definitionRevision: "" } });
  await service().custom.upsert(userId, definition(), { expectedRevision: 0, expectedId: definitionId.toHexString(), recordHistory: true });
  const before = await row(), saved = await db.customBuilds.findOne({ userId }), labels = await db.games.find({ userId }).toArray();
  await expect(service().custom.upsert(userId, definition({ name: "Stale" }), { expectedRevision: 1, expectedId: new ObjectId().toHexString(), recordHistory: true }))
    .rejects.toMatchObject({ code: "build_definition_changed" });
  expect(await db.customBuilds.findOne({ userId })).toEqual(saved); expect(await db.games.find({ userId }).toArray()).toEqual(labels);
  expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision);
});

test.each(["recreated", "retired", "fenced"])("captured owner %s before its queue turn never recaptures or publishes", async state => {
  await seed(); const captured = held(), release = held(), capture = writer.capture.bind(writer);
  const spy = jest.spyOn(writer, "capture").mockImplementation(async id => { const owner = await capture(id); captured.resolve(); await release.promise; return owner; });
  const saved = service(), task = saved.custom.upsert(userId, definition()), outcome = task.then(value => ({ value }), error => ({ error }));
  await captured.promise;
  try {
    if (state === "recreated") { await dbB.users.deleteOne({ userId }); await dbB.users.insertOne({ userId, gameStatsMutationEpoch: uuid() }); }
    if (state === "retired") await dbB.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } });
    if (state === "fenced") await dbB.users.updateOne({ userId }, { $set: { _gdprMutation: { id: uuid() } } });
  } finally { commands.length = 0; release.resolve(); }
  expect((await outcome).error).toMatchObject({ code: "game_stats_authority_changed" }); expect(spy).toHaveBeenCalledTimes(1);
  expect(commands.filter(command => command.update === buildCollection || command.update === "games")).toEqual([]);
  expect((await db.customBuilds.findOne({ userId })).name).toBe("Old"); expect(saved.onDefinitionsChanged).not.toHaveBeenCalled();
});

test("independent definition winner before owner claim preserves stale CAS rollback", async () => {
  const { before } = await seed(), captured = held(), release = held(), capture = writer.capture.bind(writer);
  jest.spyOn(writer, "capture").mockImplementation(async id => { const owner = await capture(id); captured.resolve(); await release.promise; return owner; });
  const task = service().custom.upsert(userId, definition(), { expectedRevision: 0, recordHistory: true });
  const rejected = expect(task).rejects.toMatchObject({ code: "build_definition_changed" }); await captured.promise;
  try { await dbB.customBuilds.updateOne({ userId }, { $set: { name: "Independent winner", definitionRevision: 1 } }); }
  finally { release.resolve(); }
  await rejected; expect((await db.customBuilds.findOne({ userId })).name).toBe("Independent winner");
  expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision); expect((await db.games.findOne({ userId, gameId: "you" })).myBuild).toBe("Old");
});

test("post-claim independent writer serializes without an impossible held-lock barrier", async () => {
  await seed(); const claimed = held(), release = held(), requested = held(), update = db.users.findOneAndUpdate.bind(db.users); let claims = 0;
  jest.spyOn(db.users, "findOneAndUpdate").mockImplementation(async (...args) => {
    const result = await update(...args); if (++claims === 1) { claimed.resolve(); await release.promise; } return result;
  });
  const observe = event => { if (event.command.findAndModify === "users") requested.resolve(); }; clientB.on("commandStarted", observe);
  const first = service(), second = service({}, dbB), a = first.custom.upsert(userId, definition({ name: "First" }), { expectedRevision: 0, recordHistory: true });
  await claimed.promise; let bSettled = false;
  const b = second.custom.upsert(userId, definition({ name: "Second" }), { expectedRevision: 0, recordHistory: true });
  const bOutcome = b.then(value => { bSettled = true; return { value }; }, error => { bSettled = true; return { error }; });
  try {
    await Promise.race([requested.promise, bOutcome.then(outcome => {
      throw Object.hasOwn(outcome, "error") ? outcome.error : new Error("second save settled before owner command");
    })]);
    expect(bSettled).toBe(false);
    expect(commands.filter(command => command.client === "B" && (command.find === buildCollection || command.aggregate === buildCollection))).toEqual([]);
  }
  finally { release.resolve(); clientB.off("commandStarted", observe); }
  await a; expect((await bOutcome).error).toMatchObject({ code: "build_definition_changed" });
  const saved = await db.customBuilds.findOne({ userId }); expect(saved.name).toBe("First"); expect(saved._definitionHistory).toHaveLength(1);
  expect(first.onDefinitionsChanged).toHaveBeenCalledTimes(1); expect(second.onDefinitionsChanged).not.toHaveBeenCalled();
});

test("transient actual definition write retries only fixed work and not history or notifications", async () => {
  await seed(); const update = db.customBuilds.updateOne.bind(db.customBuilds), capture = jest.spyOn(writer, "capture"); let injections = 0;
  jest.spyOn(db.customBuilds, "updateOne").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[2]?.session && injections++ === 0) { const error = new MongoServerError({ message: "retry actual definition write" }); error.addErrorLabel("TransientTransactionError"); throw error; }
    return result;
  });
  const saved = service(); await saved.custom.upsert(userId, definition(), { expectedRevision: 0, recordHistory: true });
  const result = await db.customBuilds.findOne({ userId }); expect(injections).toBe(2); expect(capture).toHaveBeenCalledTimes(1);
  expect(result.definitionRevision).toBe(1); expect(result._definitionHistory).toHaveLength(1);
  expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(1); expect(saved.onGamesChanged).toHaveBeenCalledTimes(1);
  expect((await row()).gameStats).toEqual(await games.stats(userId));
});

test("failure after a real linked rename rolls back labels, definition/history and count UUID", async () => {
  const { before } = await seed(), original = await db.games.find({ userId }).toArray(), prior = await db.customBuilds.findOne({ userId });
  const update = db.games.updateMany.bind(db.games), failure = new Error("after actual rename");
  jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => { await update(...args); throw failure; });
  const saved = service(); await expect(saved.custom.upsert(userId, definition(), { expectedRevision: 0, recordHistory: true })).rejects.toBe(failure);
  expect(await db.games.find({ userId }).toArray()).toEqual(original); expect(await db.customBuilds.findOne({ userId })).toEqual(prior);
  expect((await row()).gameStatsRevision).toBe(before.gameStatsRevision); expect(saved.onGamesChanged).not.toHaveBeenCalled(); expect(saved.onDefinitionsChanged).not.toHaveBeenCalled();
});

test("actual admitted definition transaction stays charged through shutdown until its commit settles", async () => {
  await seed(); const context = { ...db }, localWriter = gameStatsWritesFor(context), saved = service({}, context);
  const entered = held(), release = held(), update = db.customBuilds.updateOne.bind(db.customBuilds);
  jest.spyOn(db.customBuilds, "updateOne").mockImplementation(async (...args) => {
    const result = await update(...args); if (args[2]?.session) { entered.resolve(); await release.promise; } return result;
  });
  const task = saved.custom.upsert(userId, definition(), { expectedRevision: 0, recordHistory: true }); await entered.promise;
  let drained = false; const drain = localWriter.stopAndDrain().then(() => { drained = true; });
  try {
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false); expect(localWriter.pending.size).toBe(1);
    await expect(saved.custom.upsert(userId, definition())).rejects.toThrow("game_stats_writer_stopping");
  } finally { release.resolve(); }
  await task; await drain; expect(drained).toBe(true); expect(localWriter.pending.size).toBe(0);
  expect((await db.customBuilds.findOne({ userId })).definitionRevision).toBe(1); expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(1);
});

function sessionFault(mode, wrapper) {
  const original = new MongoServerError({ message: mode === "primary" ? "original definition failure" : "unknown committed definition" });
  const cleanup = new Error("actual disposed session diagnostic"), start = db.client.startSession.bind(db.client);
  const observed = { original, cleanup, sessions: 0, commits: 0, disposals: 0 };
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args), explicit = args[0]?.explicit !== false;
    if (explicit && (wrapper === "main" ? args[0]?.causalConsistency === true : args.length === 0)) {
      observed.sessions++; const commit = session.commitTransaction.bind(session), end = session.endSession.bind(session);
      session.commitTransaction = async () => {
        await commit(); observed.commits++;
        if (mode === "unknown" && observed.commits === 1) throw original;
        if (mode === "retry-ack" && observed.commits === 1) { const error = new MongoNetworkError("lost actual definition ACK"); error.addErrorLabel("UnknownTransactionCommitResult"); throw error; }
      };
      session.endSession = async () => { await end(); observed.disposals++; throw cleanup; };
    }
    return session;
  });
  if (mode === "primary") {
    const update = db.customBuilds.updateOne.bind(db.customBuilds);
    jest.spyOn(db.customBuilds, "updateOne").mockImplementation(async (...args) => { await update(...args); throw original; });
  }
  return observed;
}
const compoundCases = ["success", "primary", "unknown", "retry-ack"].flatMap(mode => [false, true].map(loggerThrows => ({ mode, loggerThrows })));
test.each(compoundCases)("main real outcome $mode + disposal failure/loggerThrows=$loggerThrows", async ({ mode, loggerThrows }) => {
  const { before } = await seed(); await statsReadFloorFor(db)();
  const diagnostic = { warn: jest.fn(() => { if (loggerThrows) throw new Error("logger failed"); }) };
  const revisions = new UserRevision(db.users, { enabled: true }), saved = service({ logger: diagnostic, userRevision: revisions });
  const oldView = await revisions.snapshot(userId), fault = sessionFault(mode, "main");
  const task = saved.custom.upsert(userId, definition(), { expectedRevision: 0, recordHistory: true });
  if (mode === "primary" || mode === "unknown") await expect(task).rejects.toBe(fault.original); else await expect(task).resolves.toBeUndefined();
  expect(fault.sessions).toBe(1); expect(fault.disposals).toBe(1); expect(fault.commits).toBe(mode === "primary" ? 0 : mode === "retry-ack" ? 2 : 1);
  expect(diagnostic.warn).toHaveBeenCalledWith({ err: fault.cleanup }, "game_stats_session_cleanup_failed");
  const result = await db.customBuilds.findOne({ userId }); expect(result.definitionRevision).toBe(mode === "primary" ? 0 : 1);
  expect(result._definitionHistory?.length || 0).toBe(mode === "primary" ? 0 : 1);
  expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(mode === "success" || mode === "retry-ack" ? 1 : 0);
  expect(saved.onGamesChanged).toHaveBeenCalledTimes(mode === "success" || mode === "retry-ack" ? 1 : 0);
  expect(revisions.current(oldView)).toBe(false); expect((await row()).gameStats).toEqual(before.gameStats);
});

// Direct fixed apply on a real replica set isolates the legacy wrapper's actual
// transaction/disposal behavior. It does not certify admission/retirement or
// pretend this topology is standalone; genuine standalone upsert follows below.
test.each(compoundCases)("isolated legacy real outcome $mode + disposal failure/loggerThrows=$loggerThrows", async ({ mode, loggerThrows }) => {
  await seed(); const owner = await writer.capture(userId), diagnostic = { warn: jest.fn(() => { if (loggerThrows) throw new Error("logger failed"); }) };
  const fault = sessionFault(mode, "legacy"), input = immutableCustomBuildDefinitionSave(data({ expectedRevision: 0, recordHistory: true }));
  const task = applyCustomBuildDefinitionSave(db, owner, input, undefined, diagnostic);
  if (mode === "primary" || mode === "unknown") await expect(task).rejects.toBe(fault.original); else await expect(task).resolves.toBe(2);
  expect(fault.sessions).toBe(1); expect(fault.disposals).toBe(1); expect(fault.commits).toBe(mode === "primary" ? 0 : mode === "retry-ack" ? 2 : 1);
  expect(diagnostic.warn).toHaveBeenCalledWith({ err: fault.cleanup }, "game_stats_session_cleanup_failed");
  const result = await db.customBuilds.findOne({ userId }); expect(result.definitionRevision).toBe(mode === "primary" ? 0 : 1);
  expect(result._definitionHistory?.length || 0).toBe(mode === "primary" ? 0 : 1);
});

test("legacy late code20 after an actual successful transactional read never falls back", async () => {
  await seed(); const owner = await writer.capture(userId), read = db.customBuilds.findOne.bind(db.customBuilds), rename = db.games.updateMany.bind(db.games);
  let initialReads = 0, renames = 0; const failure = Object.assign(new Error("Transaction numbers are only allowed late"), { code: 20 });
  jest.spyOn(db.customBuilds, "findOne").mockImplementation(async (...args) => { if (args[1]?.session) initialReads++; return read(...args); });
  jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => { await rename(...args); renames++; throw failure; });
  const save = jest.spyOn(db.customBuilds, "updateOne");
  await expect(applyCustomBuildDefinitionSave(db, owner, immutableCustomBuildDefinitionSave(data()), undefined, logger)).rejects.toBe(failure);
  expect(initialReads).toBe(1); expect(renames).toBe(1); expect(save).not.toHaveBeenCalled();
  expect((await db.customBuilds.findOne({ userId })).name).toBe("Old"); expect((await db.games.findOne({ userId, gameId: "you" })).myBuild).toBe("Old");
});

test("real standalone ordinary save observes exact early code20 and retains acknowledged legacy availability", async () => {
  await switchToStandalone(); await seed(); const saved = service(); commands.length = 0; failedCommands.length = 0;
  await saved.custom.upsert(userId, definition());
  expect(standalone).toBe(true); expect(db.gameStatsTransactions).toBe(false);
  expect(failedCommands.some(event => event.code === 20 && /Transaction numbers are only allowed/.test(event.message))).toBe(true);
  expect(commands.some(command => command.find === buildCollection && command.startTransaction === true)).toBe(true);
  expect((await db.customBuilds.findOne({ userId })).definitionRevision).toBe(1);
  expect((await row()).gameStats).toBeUndefined(); expect((await row()).gameStatsWriterStatus).toBe("unsupported");
  expect(saved.onGamesChanged).toHaveBeenCalledTimes(1); expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(1);
});

test("real standalone versioned save remains503 with no partial definition/history/labels", async () => {
  const { before } = await seed(), original = await db.customBuilds.findOne({ userId }), labels = await db.games.find({ userId }).toArray();
  const saved = service(); failedCommands.length = 0;
  await expect(saved.custom.upsert(userId, definition(), { expectedRevision: 0, recordHistory: true })).rejects.toMatchObject({ code: "build_definition_transactions_required", status: 503 });
  expect(failedCommands.some(event => event.code === 20)).toBe(true); expect(await db.customBuilds.findOne({ userId })).toEqual(original);
  expect(await db.games.find({ userId }).toArray()).toEqual(labels); expect(saved.onGamesChanged).not.toHaveBeenCalled(); expect(saved.onDefinitionsChanged).not.toHaveBeenCalled();
  expect(before.gameStats).toBeDefined(); expect((await row()).gameStats).toBeUndefined();
});

test("real standalone successful fallback survives actual session disposal failure and notifies once", async () => {
  await seed(); const start = db.client.startSession.bind(db.client), diagnostic = { warn: jest.fn() }; let disposals = 0;
  jest.spyOn(db.client, "startSession").mockImplementation((...args) => {
    const session = start(...args);
    if (args.length === 0) { const end = session.endSession.bind(session); session.endSession = async () => { await end(); disposals++; throw new Error("disposed standalone session"); }; }
    return session;
  });
  const saved = service({ logger: diagnostic }); await expect(saved.custom.upsert(userId, definition())).resolves.toBeUndefined();
  expect(disposals).toBe(1); expect(diagnostic.warn).toHaveBeenCalledTimes(1);
  expect(saved.onGamesChanged).toHaveBeenCalledTimes(1); expect(saved.onDefinitionsChanged).toHaveBeenCalledTimes(1);
  expect((await db.customBuilds.findOne({ userId })).definitionRevision).toBe(1);
});
