// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoServerError, MongoNetworkError, Long } = require("mongodb");
const pino = require("pino");
const request = require("supertest");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { GamesService } = require("../src/services/games");
const { GameStatsWrites, PROTOCOL_VERSION } = require("../src/services/gameStatsWrites");
const { statsMatch, MAX_STATS_BYTES } = require("../src/services/gameStatsMaintenance");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { insertDeviceToken, sampleGame } = require("./helpers/browserIngestHarness");

let mongo, db, app, services, store, ownedMongo;
const gameCommands = [];
const queryCommands = [];
const userId = "stats-owner", other = "stats-other";
const logger = pino({ level: "silent" });
const original = { total: 77, latest: "old snapshot" };
const played = new Date("2026-10-20T12:00:00Z");
const config = { nodeEnv: "test", clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 3), rateLimitPerMinute: 10000, corsAllowedOrigins: [], adminUserIds: [], pythonAnalyzerDir: "/none", pythonExe: null };
function barrier() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const game = (gameId, extra = {}) => ({ userId, gameId, date: played, ...extra });
const readOwner = () => db.users.findOne({ userId });
async function expectRetired(before) {
  const row = await readOwner();
  expect(row.gameStats).toEqual(await services.games.stats(userId)); expect(row.gameStatsProtocolVersion).toBe(PROTOCOL_VERSION);
  expect(row.gameStatsWriterStatus).toBe("transactional");
  expect(row.gameStatsRevision).toEqual(expect.any(String)); expect(row.gameStatsRevision).not.toBe(before);
  expect(row.gameStatsMaintenance).toMatchObject({ version: 1, ownerId: row._id, revision: row.gameStatsRevision });
  return row.gameStatsRevision;
}

beforeAll(async () => {
  // A single real replica-set member, pinned to the already-cached binary.
  // Verification sets RUNTIME_DOWNLOAD=false; no test installs Mongo.
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  ownedMongo = { pid: mongo.servers[0].instanceInfo.instance.mongodProcess.pid, port: mongo.servers[0].instanceInfo.port };
  process.stdout.write(`game_stats_replset_owned_process ${JSON.stringify(ownedMongo)}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "game_stats_transactions", awaitBackgroundIndexes: true }, { logger });
  db.client.on("commandStarted", event => {
    if (["insert", "update", "delete"].some(name => event.command[name] === "games")) gameCommands.push(event.command);
    if (event.command.find === "games" || event.command.aggregate === "games" || event.command.findAndModify === "users") queryCommands.push(event.command);
  });
  store = createBackupStore(); ({ app, services } = buildApp({ db, userBackupsStore: store, logger, config }));
  expect(db.gameStatsTransactions).toBe(true);
});
afterAll(async () => {
  await services?.gameStatsWrites.stopAndDrain(); await db?.close();
  await mongo?.stop();
  // MongoMemoryReplSet.stop awaits its owned mongod process exit.
  if (ownedMongo) {
    expect(() => process.kill(ownedMongo.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    process.stdout.write(`game_stats_replset_owned_process_stopped ${JSON.stringify(ownedMongo)}\n`);
  }
});
beforeEach(async () => {
  jest.restoreAllMocks(); store.objects.clear(); store.calls.length = 0;
  for (const { name } of await db.db.listCollections().toArray()) {
    if (!name.startsWith("system.")) await db.db.collection(name).deleteMany({});
  }
  await db.users.insertMany([{ userId, clerkUserId: "stats-clerk", gameStats: original, gameStatsRevision: "before", gameStatsProtocolVersion: 1 }, { userId: other, gameStats: original, gameStatsRevision: "other-before" }]);
  gameCommands.length = 0;
  queryCommands.length = 0;
});

test("real transaction abort rolls back both partial ordered insertion and owner invalidation", async () => {
  await db.games.insertOne(game("duplicate"));
  const writer = new GameStatsWrites(db), owner = await writer.capture(userId);
  await expect(writer.write(owner, session => db.games.insertMany([game("partial"), game("duplicate")], { session }), { selection: { gameIds: ["partial", "duplicate"] } })).rejects.toMatchObject({ code: 11000 });
  expect(await db.games.findOne({ gameId: "partial" })).toBeNull();
  expect(await readOwner()).toMatchObject({ gameStats: original, gameStatsRevision: "before" });
});

test("a transient Mongo retry repeats only Mongo work, never the external details upload", async () => {
  const upload = jest.fn(async () => {}), api = new GamesService(db, { gameDetails: { upsert: upload } });
  const update = db.games.updateOne.bind(db.games); let injected = false;
  jest.spyOn(db.games, "updateOne").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[2]?.session && !injected) {
      injected = true; const error = new MongoServerError({ message: "synthetic retry after real write" });
      error.addErrorLabel("TransientTransactionError"); throw error;
    }
    return result;
  });
  expect(await api.upsert(userId, game("retry", { buildLog: [{ t: 1, name: "Pylon" }] }))).toBe(true);
  expect(injected).toBe(true); expect(upload).toHaveBeenCalledTimes(1);
  expect(await db.games.countDocuments({ userId, gameId: "retry" })).toBe(1); await expectRetired("before");
});

test("lost commit acknowledgement retries commit, without replaying the game callback", async () => {
  const writer = new GameStatsWrites(db), owner = await writer.capture(userId), start = db.client.startSession.bind(db.client);
  let commits = 0; const work = jest.fn(session => db.games.insertOne(game("ack-retry"), { session }));
  jest.spyOn(db.client, "startSession").mockImplementation(() => {
    const session = start(), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); if (++commits === 1) { const error = new MongoNetworkError("synthetic lost commit ACK"); error.addErrorLabel("UnknownTransactionCommitResult"); throw error; } };
    return session;
  });
  await writer.write(owner, work, { selection: { gameIds: ["ack-retry"] } });
  expect(commits).toBe(2); expect(work).toHaveBeenCalledTimes(1);
  expect(await db.games.countDocuments({ gameId: "ack-retry" })).toBe(1); await expectRetired("before");
});

test("an unclassified error after a real commit preserves the error and atomic durable outcome", async () => {
  const writer = new GameStatsWrites(db), owner = await writer.capture(userId), start = db.client.startSession.bind(db.client);
  const unknown = new MongoServerError({ message: "synthetic ambiguous return after actual commit" });
  jest.spyOn(db.client, "startSession").mockImplementation(() => {
    const session = start(), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); throw unknown; }; return session;
  });
  await expect(writer.write(owner, session => db.games.insertOne(game("unknown"), { session }), { selection: { gameIds: ["unknown"] } })).rejects.toBe(unknown);
  expect(await db.games.countDocuments({ gameId: "unknown" })).toBe(1); await expectRetired("before");
});

test.each(["deleted", "replacement"])("captured owner cannot write after owner %s", async state => {
  const writer = new GameStatsWrites(db), owner = await writer.capture(userId), work = jest.fn(session => db.games.insertOne(game("late"), { session }));
  await db.users.deleteOne({ userId }); if (state === "replacement") await db.users.insertOne({ userId, clerkUserId: "replacement-clerk", marker: "new instance" });
  await expect(writer.write(owner, work, { selection: { gameIds: ["late"] } })).rejects.toThrow("game_stats_authority_changed");
  expect(work).not.toHaveBeenCalled(); expect(await db.games.countDocuments({ userId })).toBe(0);
  expect(await db.users.countDocuments({ userId })).toBe(state === "replacement" ? 1 : 0);
});

test.each(["released", "replaced"])("stale exact GDPR fence rejects after it is %s", async state => {
  const fence = await services.gdpr._acquireMutationFence(userId, "stats-test");
  try {
    await db.users.updateOne({ userId }, state === "released" ? { $unset: { _gdprMutation: "" } } : { $set: { "_gdprMutation.id": "new-fence" } });
    const work = jest.fn(session => db.games.insertOne(game("late"), { session }));
    await expect(services.gameStatsWrites.write(fence.owner, work, { fenceId: fence.id, selection: { gameIds: ["late"] } })).rejects.toThrow("game_stats_authority_changed");
    expect(work).not.toHaveBeenCalled(); expect(await db.games.countDocuments({ userId })).toBe(0);
  } finally { await services.gdpr._releaseMutationFence(userId, fence); }
});

test("held external ingest cannot resurrect games after actual full erasure", async () => {
  const entered = barrier(), release = barrier();
  const api = new GamesService(db, { gameDetails: { upsert: async () => { entered.resolve(); await release.promise; } } });
  const pending = api.upsert(userId, game("post-erasure", { buildLog: ["heavy"] })).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  try { expect((await services.gdpr.deleteAll(userId)).users).toBe(1); }
  finally { release.resolve(); }
  expect((await pending).error?.message).toBe("game_stats_authority_changed");
  expect(await db.games.countDocuments({ userId })).toBe(0); expect(await db.users.countDocuments({ userId })).toBe(0);
});

test.each(["full", "range", "restore"])("held ingest remains retired after same-owner %s operation releases its fence", async operation => {
  await db.games.insertOne(game("old", { date: played }));
  const saved = operation === "restore" ? await services.gdpr.snapshot(userId) : null;
  const entered = barrier(), release = barrier(), before = await readOwner();
  // Simulate a still-live request whose outer data lease has expired. It
  // already owns a captured identity/epoch before its held payload work.
  const api = new GamesService(db, { gameDetails: { upsert: async () => { entered.resolve(); await release.promise; } } });
  const pending = api.upsert(userId, game("late", { buildLog: ["held"] })).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  try {
    if (operation === "restore") await services.gdpr.restoreSnapshot(userId, saved.id);
    else await services.gdpr.wipeGames(userId, operation === "range" ? { since: new Date("2026-10-01") } : {});
    const after = await readOwner();
    expect(after._id).toEqual(before._id); expect(after._gdprMutation).toBeUndefined();
    expect(after.gameStatsMutationEpoch).not.toBe(before.gameStatsMutationEpoch);
  } finally { release.resolve(); }
  expect((await pending).error?.message).toBe("game_stats_authority_changed");
  expect(await db.games.findOne({ userId, gameId: "late" })).toBeNull();
  // A newly admitted retry captures the current epoch and is allowed.
  expect(await services.games.upsert(userId, game("fresh-retry"))).toBe(true);
});

test("one expired HTTP batch cannot recapture after a wipe and continue inserting remaining games", async () => {
  const token = await insertDeviceToken(db, userId), entered = barrier(), release = barrier();
  jest.spyOn(services.gameDetails, "upsert").mockImplementation(async () => { entered.resolve(); await release.promise; });
  const capture = jest.spyOn(services.gameStatsWrites, "capture"), upsert = jest.spyOn(services.games, "upsertWithRevision"), quarantine = jest.spyOn(services.games, "quarantineResumedReplay");
  const pending = request(app).post("/v1/games").set("authorization", `Bearer ${token}`)
    .send({ games: [sampleGame(1), sampleGame(2, { isResumedFromReplay: true }), sampleGame(3)] }).then(response => response);
  await entered.promise;
  try {
    const before = await readOwner(); expect(before._dataMutations).toHaveLength(1);
    await db.users.updateOne({ userId }, { $set: { "_dataMutations.0.leaseUntil": new Date(0) } });
    await services.gdpr.wipeGames(userId);
    expect((await readOwner())._id).toEqual(before._id);
    expect((await readOwner())._gdprMutation).toBeUndefined();
  } finally { release.resolve(); }
  const response = await pending;
  expect(response.status).toBe(503); expect(response.body.error.code).toBe("game_stats_authority_changed");
  expect(capture).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledWith(userId);
  expect(upsert).toHaveBeenCalledTimes(1); expect(quarantine).not.toHaveBeenCalled();
  expect(await db.games.countDocuments({ userId })).toBe(0);
});

test("concurrent newly admitted ingests share the current epoch without retiring each other", async () => {
  const fence = await services.gdpr._acquireMutationFence(userId, "epoch-test"); await services.gdpr._releaseMutationFence(userId, fence);
  const epoch = (await readOwner()).gameStatsMutationEpoch;
  expect(await Promise.all([services.games.upsert(userId, game("parallel-a")), services.games.upsert(userId, game("parallel-b"))])).toEqual([true, true]);
  expect(await db.games.countDocuments({ userId })).toBe(2); expect((await readOwner()).gameStatsMutationEpoch).toBe(epoch);
  expect((await readOwner()).gameStats).toEqual({ total: 2, latest: played });
  expect((await readOwner()).gameStats).toEqual(await services.games.stats(userId));
});

test("ordinary admission cannot inherit an active exclusive epoch and wait until release", async () => {
  const fence = await services.gdpr._acquireMutationFence(userId, "wipe_games");
  try {
    await expect(services.gameStatsWrites.capture(userId)).rejects.toThrow("game_stats_owner_unavailable");
    expect(await services.gameStatsWrites.captureOptional(userId)).toMatchObject({ id: fence.owner.id, epoch: fence.id });
    await fence.assert(); expect((await readOwner()).gameStatsMutationEpoch).toBe(fence.id);
  } finally { await services.gdpr._releaseMutationFence(userId, fence); }
  const fresh = await services.gameStatsWrites.capture(userId);
  expect(fresh.epoch).toBe(fence.id); expect((await readOwner()).gameStatsMutationEpoch).toBe(fence.id);
});

test("a batch handle cannot be forwarded to a different user", async () => {
  const handle = await services.gameStatsWrites.capture(userId);
  await expect(services.games.upsert(other, game("wrong"), handle)).rejects.toThrow("game_stats_owner_unavailable");
  await expect(services.games.quarantineResumedReplay(other, game("wrong"), handle)).rejects.toThrow("game_stats_owner_unavailable");
  expect(await db.games.countDocuments({})).toBe(0);
});

test("all ordinary membership/date services rotate authority; stats predicate remains authoritative", async () => {
  await services.games.upsert(userId, game("normal")); let revision = await expectRetired("before");
  const later = new Date("2026-10-25T12:00:00Z");
  await services.games.upsert(userId, game("normal", { date: later })); revision = await expectRetired(revision);
  expect(await services.games.stats(userId)).toEqual({ total: 1, latest: later });
  await services.gameControls.setExcluded(userId, "normal", { excluded: true, reason: "other" }); revision = await expectRetired(revision);
  expect(await services.games.stats(userId)).toEqual({ total: 0, latest: null });
  await services.gameControls.setExcluded(userId, "normal", { excluded: false }); revision = await expectRetired(revision);
  await services.games.quarantineResumedReplay(userId, game("resumed", { resumedReplayGameIds: ["normal"] })); revision = await expectRetired(revision);
  expect(await services.games.stats(userId)).toEqual({ total: 0, latest: null });
  await services.gameControls.deleteGame(userId, "normal"); await expectRetired(revision);
  expect(await db.games.findOne({ userId, gameId: "normal" })).toMatchObject({ _deleted: true, excluded: true });
  expect(await db.users.findOne({ userId: other })).toMatchObject({ gameStats: original, gameStatsRevision: "other-before" });
  // Existing lease and object-cleanup metadata also writes games. Only the
  // exact membership/date mutations need this dedicated stats protocol.
  const membershipCommands = gameCommands.filter(command => command.insert || command.delete
    || command.updates?.some(update => /"(?:date|isResumedFromReplay|excluded|_deleted|_deletionPending)"\s*:/.test(JSON.stringify(update.u))));
  expect(membershipCommands.length).toBeGreaterThanOrEqual(8);
  for (const command of membershipCommands) { expect(command.autocommit).toBe(false); expect(command.txnNumber).toBeDefined(); }
});

test("legacy BSON latest and permissive visibility matching remain exact authoritative Mongo results", async () => {
  const rows = [game("legacy", { date: { legacy: "unsupported for a future retained snapshot" }, excluded: "true" }), game("array", { date: [played] }), game("hidden", { excluded: [true] }), game("deleted", { _deleted: true }), game("pending", { _deletionPending: true }), game("resumed", { isResumedFromReplay: true })];
  await db.games.insertMany(rows);
  const match = { userId, _deleted: { $ne: true }, _deletionPending: { $ne: true }, excluded: { $ne: true }, isResumedFromReplay: { $ne: true } };
  const latest = await db.games.find(match).sort({ date: -1 }).limit(1).next();
  expect(await services.games.stats(userId)).toEqual({ total: await db.games.countDocuments(match), latest: latest.date });
  expect((await readOwner()).gameStats).toEqual(original);
});

test("range and full wipes retain scope and use bounded transactions", async () => {
  await db.games.insertMany(Array.from({ length: 205 }, (_, n) => game(`wipe-${n}`, { date: n < 204 ? played : new Date("2026-01-01") })));
  await db.games.insertOne(game("other", { userId: other }));
  const batches = [], remove = db.games.deleteMany.bind(db.games);
  jest.spyOn(db.games, "deleteMany").mockImplementation(async (filter, options) => {
    if (options?.session) batches.push(filter.$and[1]._id.$in.length); return remove(filter, options);
  });
  await services.gdpr.wipeGames(userId, { since: new Date("2026-10-01") });
  expect(await db.games.countDocuments({ userId })).toBe(1); expect(await db.games.findOne({ userId })).toMatchObject({ gameId: "wipe-204" });
  expect(batches).toEqual([100, 100, 4]); let revision = await expectRetired("before");
  await services.gdpr.wipeGames(userId); await expectRetired(revision);
  expect(await db.games.countDocuments({ userId })).toBe(0); expect(await db.games.countDocuments({ userId: other })).toBe(1);
});

test("restoring 205 games uses immutable <=100 batches and never restores authority metadata", async () => {
  await db.games.insertMany(Array.from({ length: 205 }, (_, n) => game(`saved-${n}`)));
  const saved = await services.gdpr.snapshot(userId); await db.games.deleteMany({ userId });
  await db.users.updateOne({ userId }, { $set: { gameStatsRevision: "current", gameStats: { total: 0 } } });
  const batches = [], insert = db.games.insertMany.bind(db.games);
  jest.spyOn(db.games, "insertMany").mockImplementation(async (rows, options) => { expect(options?.session).toBeDefined(); batches.push(rows.length); return insert(rows, options); });
  await services.gdpr.restoreSnapshot(userId, saved.id);
  expect(batches).toEqual([100, 100, 5]); expect(await db.games.countDocuments({ userId })).toBe(205); await expectRetired("current");
  expect(await db.db.collection("backup_restore_staging").countDocuments()).toBe(0);
  const exported = await services.gdpr.export(userId);
  for (const key of ["gameStats", "gameStatsRevision", "gameStatsProtocolVersion", "gameStatsWriterStatus", "gameStatsMutationEpoch", "gameStatsMaintenance"]) expect(exported.user).not.toHaveProperty(key);
});

test.each(["fence", "owner"])("restore cannot insert a later batch after %s replacement", async replace => {
  await db.games.insertMany(Array.from({ length: 105 }, (_, n) => game(`saved-${n}`)));
  const saved = await services.gdpr.snapshot(userId); await db.games.deleteMany({ userId });
  const write = services.gameStatsWrites.write.bind(services.gameStatsWrites); let writes = 0;
  jest.spyOn(services.gameStatsWrites, "write").mockImplementation(async (...args) => {
    const result = await write(...args);
    // Empty delete now eagerly maintains stats too. Preserve this original
    // fault boundary: replace authority AFTER first committed insert batch.
    if (result?.insertedCount > 0 && ++writes === 1) {
      if (replace === "fence") await db.users.updateOne({ userId }, { $set: { "_gdprMutation.id": "replacement-fence" } });
      else { await db.users.deleteOne({ userId }); await db.users.insertOne({ userId, clerkUserId: "replacement-clerk", marker: "replacement-owner" }); }
    }
    return result;
  });
  await expect(services.gdpr.restoreSnapshot(userId, saved.id)).rejects.toThrow("gdpr_operation_lease_lost");
  expect(writes).toBe(1); expect(await db.games.countDocuments({ userId })).toBe(100);
  if (replace === "owner") expect(await readOwner()).toMatchObject({ marker: "replacement-owner" });
});

test("a failed later restore batch aborts that entire ordered batch and keeps prior revision", async () => {
  await db.games.insertMany(Array.from({ length: 105 }, (_, n) => game(`saved-${n}`)));
  const saved = await services.gdpr.snapshot(userId); await db.games.deleteMany({ userId });
  const insert = db.games.insertMany.bind(db.games); let batches = 0, firstRevision;
  jest.spyOn(db.games, "insertMany").mockImplementation(async (rows, options) => {
    if (++batches === 2) { firstRevision = (await readOwner()).gameStatsRevision; return insert([...rows, { ...rows[0] }], options); }
    return insert(rows, options);
  });
  await expect(services.gdpr.restoreSnapshot(userId, saved.id)).rejects.toMatchObject({ code: 11000 });
  expect(batches).toBe(2); expect(await db.games.countDocuments({ userId })).toBe(100);
  expect((await readOwner()).gameStatsRevision).toBe(firstRevision);
  expect((await readOwner()).gameStats).toEqual(await services.games.stats(userId));
  expect((await readOwner()).gameStats).toEqual({ total: 100, latest: played });
  expect((await readOwner()).gameStatsMaintenance.revision).toBe(firstRevision);
});

test("already-missing owner erasure deletes orphan games without owner or authority upsert", async () => {
  await db.users.deleteOne({ userId }); await db.games.insertOne(game("orphan"));
  expect((await services.gdpr.deleteAll(userId)).users).toBe(0);
  expect(await db.games.countDocuments({ userId })).toBe(0); expect(await db.users.findOne({ userId })).toBeNull();
});

async function maintainNoChange() {
  const owner = await services.gameStatsWrites.capture(userId);
  return services.gameStatsWrites.write(owner, async () => "unchanged", { selection: { ids: [] } });
}
const countCommands = () => queryCommands.filter(command => command.aggregate === "games" && command.pipeline?.some(stage => stage.$group));

test("qualified ingest uses only two bounded subset counts; bootstrap uses one original whole-owner count", async () => {
  await services.games.upsert(userId, game("latest", { date: new Date("2030-01-01") }));
  expect(countCommands()).toHaveLength(1); expect(countCommands()[0].pipeline[0].$match).toEqual(statsMatch(userId));
  const bootstrapWholeOwnerCounts = countCommands().length;
  queryCommands.length = 0;
  // Replacing the current latest with an earlier date must move latest back.
  await services.games.upsert(userId, game("latest", { date: new Date("2020-01-01") }));
  expect((await readOwner()).gameStats).toEqual({ total: 1, latest: new Date("2020-01-01") });
  expect(countCommands()).toHaveLength(2);
  for (const command of countCommands()) {
    expect(command.pipeline[0].$match).toEqual({ $and: [statsMatch(userId), { gameId: { $in: ["latest"] } }] });
    expect(command.autocommit).toBe(false); expect(command.txnNumber).toBeDefined();
  }
  const latestCommands = queryCommands.filter(command => command.find === "games" && command.projection?.date === 1);
  expect(latestCommands).toHaveLength(1); expect(latestCommands[0]).toMatchObject({ filter: statsMatch(userId), projection: { date: 1, _id: 0 }, limit: 1, autocommit: false });
  const sort = latestCommands[0].sort instanceof Map ? Object.fromEntries(latestCommands[0].sort) : latestCommands[0].sort;
  expect(sort).toEqual({ date: -1 }); expect(Object.keys(sort)).toEqual(["date"]);
  const atomic = queryCommands.find(command => command.findAndModify === "users");
  expect(atomic).toMatchObject({ new: false, upsert: false, autocommit: false });
  for (const command of [...countCommands(), ...latestCommands]) expect(command.lsid).toEqual(atomic.lsid);
  process.stdout.write(`game_stats_eager_query_cost ${JSON.stringify({ syntheticLocalMongo: true, bootstrapWholeOwnerCounts, qualifiedSubsetCounts: countCommands().length, qualifiedWholeOwnerCounts: countCommands().filter(command => !command.pipeline[0].$match.$and).length, originalLatestQueries: latestCommands.length, subsetMatches: countCommands().map(command => command.pipeline[0].$match), sort })}\n`);
});

test("eager Mongo eligibility preserves array-valued legacy flags", async () => {
  await db.games.insertMany([
    game("included", { excluded: [false], date: new Date("2027-01-01") }),
    game("hidden", { excluded: [true] }), game("deleted", { _deleted: [false, true] }),
    game("pending", { _deletionPending: [true] }), game("resumed", { isResumedFromReplay: [true] }),
    game("string-flag", { excluded: "true" }), game("empty-flag", { excluded: [] }),
  ]);
  await maintainNoChange();
  expect((await readOwner()).gameStats).toEqual(await services.games.stats(userId));
  expect((await readOwner()).gameStats.total).toBe(3);
  await services.games.upsert(userId, game("another"));
  expect((await readOwner()).gameStats.total).toBe(4);
});

test.each([
  ["empty", [], 0, null, "ready"],
  ["missing", [{ gameId: "missing" }], 1, null, "ready"],
  ["null", [{ gameId: "null", date: null }], 1, null, "ready"],
  ["falsy", [{ gameId: "falsy", date: false }], 1, null, "ready"],
  ["zero", [{ gameId: "zero", date: 0 }], 1, null, "ready"],
  ["string", [{ gameId: "string", date: "legacy-date" }], 1, "legacy-date", "unsupported_latest"],
  ["object", [{ gameId: "object", date: { legacy: "value" } }], 1, { legacy: "value" }, "unsupported_latest"],
  ["array", [{ gameId: "array", date: [new Date("2020-01-01"), new Date("2040-01-01")] }, { gameId: "scalar", date: new Date("2030-01-01") }], 2, [new Date("2020-01-01"), new Date("2040-01-01")], "unsupported_latest"],
])("raw sorted latest/no-data contract remains exact for %s", async (_label, rows, total, latest, status) => {
  if (rows.length) await db.games.insertMany(rows.map(row => ({ userId, ...row })));
  await maintainNoChange();
  const owner = await readOwner();
  expect(owner.gameStats).toEqual({ total, latest }); expect(owner.gameStats).toEqual(await services.games.stats(userId));
  expect(owner.gameStatsMaintenance.status).toBe(status);
});

test("oversize legacy latest remains exact in authoritative reads and cannot be retained", async () => {
  const raw = "legacy-".repeat(MAX_STATS_BYTES);
  await db.games.insertOne({ userId, gameId: "oversize", date: raw }); await maintainNoChange();
  expect((await readOwner()).gameStats).toBeUndefined(); expect((await readOwner()).gameStatsMaintenance.status).toBe("unretained");
  expect(await services.games.stats(userId)).toEqual({ total: 1, latest: raw });
});

test("out-of-range BSON Date stays an exact Invalid Date uncached rather than normalizing to epoch zero", async () => {
  // The real serializer writes this 64-bit BSON date. The real driver decodes
  // it outside the JS Date range; no product date/driver path is patched.
  const raw = new Date(0); raw.getTime = () => 9_000_000_000_000_000;
  await db.games.insertOne({ userId, gameId: "out-of-range", date: raw });
  const originalValue = await services.games.stats(userId);
  expect(originalValue.total).toBe(1); expect(originalValue.latest).toBeInstanceOf(Date); expect(originalValue.latest.getTime()).toBeNaN();
  await maintainNoChange();
  expect((await readOwner()).gameStats).toBeUndefined(); expect((await readOwner()).gameStatsMaintenance.status).toBe("unretained");
  const after = await services.games.stats(userId); expect(after.total).toBe(1); expect(after.latest.getTime()).toBeNaN();
  process.stdout.write(`game_stats_eager_bson_boundary ${JSON.stringify({ syntheticLocalMongo: true, actualBsonDateMillis: 9_000_000_000_000_000, originalInvalidDate: Number.isNaN(originalValue.latest.getTime()), unretained: (await readOwner()).gameStats === undefined, afterInvalidDate: Number.isNaN(after.latest.getTime()) })}\n`);
});

test("server-created Long.MAX_VALUE BSON Date remains Invalid Date through authoritative fallback", async () => {
  await db.games.insertOne(game("server-date"));
  await db.games.updateOne({ userId, gameId: "server-date" }, [{ $set: { date: { $toDate: { $literal: Long.MAX_VALUE } } } }]);
  const before = await services.games.stats(userId); expect(before.total).toBe(1); expect(before.latest.getTime()).toBeNaN();
  await maintainNoChange();
  const row = await readOwner(), after = await services.games.stats(userId);
  expect(row.gameStats).toBeUndefined(); expect(row.gameStatsMaintenance.status).toBe("unretained");
  expect(after.total).toBe(1); expect(after.latest.getTime()).toBeNaN();
  process.stdout.write(`game_stats_eager_server_bson_boundary ${JSON.stringify({ syntheticLocalMongo: true, operator: "$toDate", exactSigned64BitInput: Long.MAX_VALUE.toString(), originalInvalidDate: Number.isNaN(before.latest.getTime()), unretained: row.gameStats === undefined, afterInvalidDate: Number.isNaN(after.latest.getTime()) })}\n`);
});

test.each(["old-protocol", "revision", "owner", "epoch", "shape", "negative", "status"])("unqualified %s state bootstraps exact eager values", async corrupt => {
  await db.games.insertOne(game("old")); await maintainNoChange();
  const fields = corrupt === "old-protocol" ? {} : { "gameStats.total": 999 };
  if (corrupt === "old-protocol") { fields.gameStatsProtocolVersion = 1; fields.gameStatsRevision = "legacy-new-revision"; }
  if (corrupt === "revision") fields["gameStatsMaintenance.revision"] = "different";
  if (corrupt === "owner") fields["gameStatsMaintenance.ownerId"] = "different-owner";
  if (corrupt === "epoch") fields["gameStatsMaintenance.epoch"] = null;
  if (corrupt === "shape") fields["gameStats.latest"] = "a ready snapshot cannot contain this";
  if (corrupt === "negative") fields["gameStats.total"] = -1;
  if (corrupt === "status") fields["gameStatsMaintenance.status"] = "unretained";
  await db.users.updateOne({ userId }, { $set: fields, ...(corrupt === "old-protocol" ? { $unset: { gameStats: "" } } : {}) });
  queryCommands.length = 0;
  await services.games.upsert(userId, game("new"));
  expect((await readOwner()).gameStats).toEqual(await services.games.stats(userId)); expect((await readOwner()).gameStats.total).toBe(2);
  // Exclude the explicit assertion's authoritative read from this cost check.
  expect(countCommands().filter(command => command.autocommit === false)).toHaveLength(1);
  expect(countCommands()[0].pipeline[0].$match).toEqual(statsMatch(userId));
});

test("empty full wipe and zero-range-match wipe eagerly maintain the exact remaining history", async () => {
  await services.gdpr.wipeGames(userId); expect((await readOwner()).gameStats).toEqual({ total: 0, latest: null });
  await services.games.upsert(userId, game("outside"));
  await services.gdpr.wipeGames(userId, { since: new Date("2040-01-01") });
  expect((await readOwner()).gameStats).toEqual({ total: 1, latest: played });
});

test("overflow after a bounded delta recovers with the original full count", async () => {
  await db.games.insertOne(game("old")); await maintainNoChange();
  await db.users.updateOne({ userId }, { $set: { "gameStats.total": Number.MAX_SAFE_INTEGER } });
  queryCommands.length = 0;
  await services.games.upsert(userId, game("new"));
  expect((await readOwner()).gameStats).toEqual({ total: 2, latest: played });
  expect(countCommands()).toHaveLength(3);
  expect(countCommands()[2].pipeline[0].$match).toEqual(statsMatch(userId));
});

test("failed final eager publication aborts games and initial revision together", async () => {
  const update = db.users.updateOne.bind(db.users), originalError = new Error("synthetic stats publication failure");
  jest.spyOn(db.users, "updateOne").mockImplementation(async (filter, change, options) => {
    const result = await update(filter, change, options);
    if (options?.session && change.$set?.gameStatsMaintenance) throw originalError;
    return result;
  });
  await expect(services.games.upsert(userId, game("aborted"))).rejects.toBe(originalError);
  expect(await db.games.findOne({ userId, gameId: "aborted" })).toBeNull();
  expect(await readOwner()).toMatchObject({ gameStats: original, gameStatsRevision: "before" });
});
