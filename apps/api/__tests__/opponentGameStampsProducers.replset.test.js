// @ts-nocheck
"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, MongoServerError } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { OpponentsService } = require("../src/services/opponents");
const { GdprService } = require("../src/services/gdpr");
const { DataRepairsService } = require("../src/services/dataRepairs");
const { UserBackupsService } = require("../src/services/userBackups");
const { gameStatsWritesFor, MAX_ACTIVE } = require("../src/services/gameStatsWrites");
const { buildPulseBackfillJob } = require("../src/jobs/pulseBackfillJob");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { createBackupStore } = require("./helpers/userBackupsStore");

const logger = pino({ level: "silent" }), userId = "producer-owner", TOON = "2-S2-1-5", played = new Date("2026-10-20T12:00:00Z");
const commands = [], DB = "opponent_producers", CAPTURE = JSON.stringify({ _id: 1, gameStatsMutationEpoch: 1 }), RENEW_MS = 60 * 1000;
const HEAL_WARNING = "opponent_pulse_backfill_game_identity_failed", STAMP_WARNING = "opponent_game_region_stamp_failed";
let mongo, mongoChild, db, games, store;
const row = (id = userId) => db.users.findOne({ userId: id });
const gameUpdates = list => list.filter(c => c.update === "games");
const healed = () => db.games.countDocuments({ userId, "opponent.pulseCharacterId": "777" });
const payload = extra => ({ pulseId: "p1", gameId: "g1", toonHandle: TOON, displayName: "Rival", race: "P", result: "Victory", playedAt: played, ...extra });
const repairOf = (fence, kind = "repair_opponents") => ({ repair: { owner: fence.owner, fenceId: fence.id, kind, handle: fence.liveness } });
const firstWarning = (s, code) => s.log.warn.mock.calls.find(call => call[1] === code)?.[0];
function held() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function transient(message) { const error = new MongoServerError({ message }); error.addErrorLabel("TransientTransactionError"); return error; }
async function seedOwner(id) {
  const epoch = uuid(), revision = uuid();
  const { insertedId } = await db.users.insertOne({ userId: id, clerkUserId: `clerk-${id}`, gameStatsMutationEpoch: epoch }), stats = await games.stats(id);
  await db.users.updateOne({ _id: insertedId }, { $set: { gameStats: stats, gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION,
    gameStatsWriterStatus: "transactional", gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: insertedId, epoch, revision } } });
  return row(id);
}
async function seed({ opponents = true, rows = 1, id = userId } = {}) {
  const pulses = Array.from({ length: rows }, (_unused, i) => `p${i + 1}`);
  await db.games.insertMany([{ userId: id, gameId: "g1", date: played, opponent: { pulseId: "p1", toonHandle: TOON, mmr: 4000 } },
    ...pulses.map((pulseId, i) => ({ userId: id, gameId: `g${i + 2}`, date: played, opponent: { pulseId, toonHandle: TOON } }))]);
  if (opponents) await db.opponents.insertMany(pulses.map(pulseId => ({ userId: id, pulseId, toonHandle: TOON, displayNameSample: "Rival", gameCount: 2 })));
  return seedOwner(id);
}
function build(database = db) {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const mmr = jest.fn(async () => ({ mmr: 4100, region: "EU" })), pulseResolver = { resolve: jest.fn(async () => "777") };
  const opponents = new OpponentsService(database, Buffer.alloc(32, 1), { logger: log, pulseResolver, pulseMmr: { getCurrentMmr: mmr, getCurrentMmrByToon: mmr } });
  const gdpr = new GdprService(database, { logger, opponents });
  gdpr.backups = new UserBackupsService(database, { gdpr, store, logger });
  return { log, mmr, pulseResolver, opponents, gdpr, writer: gameStatsWritesFor(database),
    job: () => buildPulseBackfillJob({ db: database, opponents, logger }) };
}
function holdOnce(fn, value) {
  const entered = held(), release = held();
  fn.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return value; });
  return { entered: entered.promise, release: release.resolve };
}
function holdWhere(collection, method, match, after = false) {
  const entered = held(), release = held(), original = collection[method].bind(collection);
  const spy = jest.spyOn(collection, method).mockImplementation(async (...args) => {
    if (!match(...args)) return original(...args);
    if (!after) { entered.resolve(); const outcome = await release.promise; if (outcome instanceof Error) throw outcome; return original(...args); }
    const result = await original(...args); entered.resolve(); await release.promise; return result;
  });
  return { entered: entered.promise, release: release.resolve, spy };
}
const claimHeld = () => holdWhere(db.users, "findOneAndUpdate", (query, _update, options) => !!options?.session && !!query["_gdprMutation.kind"], true);
function faultRenewals(collection, fault) {
  const original = collection.updateOne.bind(collection); let left = 1;
  return jest.spyOn(collection, "updateOne").mockImplementation(async (...args) => {
    if (left > 0 && Object.hasOwn(args[1]?.$set || {}, "_gdprMutation.leaseUntil")) { left -= 1; throw fault; }
    return original(...args);
  });
}
const MUTATIONS = {
  replacement: async () => { await db.users.deleteOne({ userId }); await db.users.insertOne({ userId, gameStatsMutationEpoch: uuid() }); },
  snapshot: s => s.gdpr.snapshot(userId),
  wipe: s => s.gdpr.wipeGames(userId),
  restore: (s, saved) => s.gdpr.restoreSnapshot(userId, saved.id),
};
const ENTRIES = {
  recordGame: { hold: s => holdOnce(s.mmr, { mmr: 4100, region: "EU" }), run: s => s.opponents.recordGame(userId, payload()), warning: STAMP_WARNING },
  refreshMetadata: { hold: () => holdWhere(db.games, "findOne", query => query?.isResumedFromReplay === true),
    run: s => s.opponents.refreshMetadata(userId, payload()), warning: STAMP_WARNING },
  retryPulseResolution: { hold: s => holdOnce(s.pulseResolver.resolve, "777"), run: s => s.opponents.retryPulseResolution(userId, "p1"), warning: HEAL_WARNING },
  backfillJob: { hold: s => holdOnce(s.pulseResolver.resolve, "777"), run: s => s.job().runOnce(), warning: HEAL_WARNING },
};
async function scoped() {
  const client = new MongoClient(mongo.getUri(), { monitorCommands: true }); await client.connect();
  const database = client.db(DB), log = [], events = [];
  client.on("commandStarted", event => {
    log.push(event.command); const name = Object.keys(event.command)[0]; events.push(`command:${name}:${event.command[name]}`);
  });
  const context = { ...db, client, db: database, users: database.collection("users"), games: database.collection("games"),
    opponents: database.collection("opponents"), userBackups: database.collection("user_backups") };
  return { client, context, log, events, services: build(context) };
}
const holdCapture = ctx => holdWhere(ctx.context.users, "findOne", (_query, options) => JSON.stringify(options?.projection) === CAPTURE);
const holdFloor = context => holdWhere(context.users, "findOne", (_query, options) => options?.readConcern?.level === "majority");
beforeAll(async () => {
  // The admitted local runner pins the cached binary and disables downloads.
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  mongoChild = mongo.servers[0].instanceInfo.instance.mongodProcess;
  process.stdout.write(`opponent_producers_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.servers[0].instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: DB, awaitBackgroundIndexes: true }, { logger });
  db.client.on("commandStarted", event => commands.push(event.command));
  games = new GamesService(db); store = createBackupStore();
  expect(db.gameStatsTransactions).toBe(true);
});
afterAll(async () => {
  try { await gameStatsWritesFor(db).stopAndDrain(); await db?.close(); }
  finally {
    await mongo?.stop();
    if (mongoChild) {
      expect(mongoChild.exitCode !== null || mongoChild.signalCode !== null).toBe(true);
      process.stdout.write(`opponent_producers_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => {
  jest.restoreAllMocks(); store.objects.clear();
  for (const name of ["users", "games", "gameDetails", "opponents", "userBackups", "notifications", "macroJobs"]) await db[name].deleteMany({});
  for (const name of ["jobLocks", "backup_restore_staging"]) await db.db.collection(name).deleteMany({});
  commands.length = 0;
});

test.each(Object.keys(MUTATIONS))("an ingest-forwarded owner never stamps after a held provider and %s", async state => {
  await seed(); const s = build(), saved = state === "restore" ? await s.gdpr.snapshot(userId) : null;
  const statsOwner = await s.writer.capture(userId), hold = holdOnce(s.mmr, { mmr: 4100, region: "EU" });
  const refreshOwner = await s.writer.capture(userId), capture = jest.spyOn(s.writer, "capture");
  const record = s.opponents.recordGame(userId, payload(), { statsOwner }); await hold.entered;
  await MUTATIONS[state](s, saved); const mark = commands.length; hold.release(); await record;
  const after = commands.slice(mark);
  expect(gameUpdates(after)).toEqual([]); expect(after.filter(c => c.update === "opponents")).toHaveLength(1);
  expect(s.log.warn).toHaveBeenCalledWith(expect.objectContaining({ userId, gameId: "g1" }), STAMP_WARNING);
  await MUTATIONS.replacement();
  const before = commands.length; await s.opponents.refreshMetadata(userId, payload(), { statsOwner: refreshOwner });
  expect(gameUpdates(commands.slice(before))).toEqual([]); expect(capture).not.toHaveBeenCalled();
  expect(s.log.warn.mock.calls.filter(call => call[1] === STAMP_WARNING)).toHaveLength(2);
});

test.each(Object.keys(ENTRIES).flatMap(entry => Object.keys(MUTATIONS).map(state => [entry, state])))("omission %s captures once and then vetoes after %s", async (entry, state) => {
  await seed(); const s = build(), saved = state === "restore" ? await s.gdpr.snapshot(userId) : null;
  const capture = jest.spyOn(s.writer, "capture"), hold = ENTRIES[entry].hold(s);
  const task = ENTRIES[entry].run(s); await hold.entered;
  expect(capture).toHaveBeenCalledTimes(1);
  await MUTATIONS[state](s, saved); const mark = commands.length; hold.release(); const result = await task;
  const after = commands.slice(mark);
  expect(gameUpdates(after)).toEqual([]);
  expect(s.log.warn).toHaveBeenCalledWith(expect.anything(), ENTRIES[entry].warning);
  if (entry === "retryPulseResolution") expect(result.gamesRestamped).toBe(0);
});

test.each([["stamp", "updateOne"], ["heal", "updateMany"]])("a transient %s retry repeats no provider or opponents work", async (kind, method) => {
  await seed(); const s = build(), original = db.games[method].bind(db.games); let injected = false;
  jest.spyOn(db.games, method).mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2]?.session && !injected) { injected = true; throw transient(`retry ${kind}`); }
    return result;
  });
  commands.length = 0;
  if (kind === "stamp") await s.opponents.recordGame(userId, payload({ gameId: "g2" }));
  else expect((await s.opponents.retryPulseResolution(userId, "p1")).gamesRestamped).toBe(2);
  expect(injected).toBe(true); expect(s.mmr).toHaveBeenCalledTimes(1);
  expect(commands.filter(c => c.update === "opponents")).toHaveLength(1); expect(commands.filter(c => c.commitTransaction)).toHaveLength(1);
  if (kind === "stamp") expect((await db.opponents.findOne({ userId, pulseId: "p1" })).gameCount).toBe(3);
  const [g1, g2] = await Promise.all(["g1", "g2"].map(gameId => db.games.findOne({ gameId })));
  expect(g1.opponent.mmr).toBe(4000); expect(g2.opponent).not.toHaveProperty("mmr");
  for (const game of [g1, g2]) for (const marker of ["mmrLookupAttempted", "leagueLookupAttempted"]) expect(game.opponent).not.toHaveProperty(marker);
});

test("DataRepairs heals under its genuine repair_opponents fence without capture and retires the proof", async () => {
  await seed({ opponents: false }); const s = build(), notify = jest.fn(async () => {});
  const repairs = new DataRepairsService(db, { gdpr: s.gdpr, notifications: { notify }, logger });
  const fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents"), id = uuid();
  await db.users.updateOne({ userId }, { $set: { "repairs.opponents": { id, status: "running" } } });
  const capture = jest.spyOn(s.writer, "capture"); commands.length = 0;
  await repairs.run(userId, "opponents", id, "repairs.opponents", fence);
  expect(capture).not.toHaveBeenCalled(); expect(await healed()).toBe(2);
  const claim = commands.find(c => c.findAndModify === "users" && c.startTransaction);
  expect(claim.query).toMatchObject({ gameStatsMutationEpoch: fence.id, "_gdprMutation.id": fence.id, "_gdprMutation.kind": "repair_opponents" });
  expect(commands.filter(c => c.txnNumber !== undefined && (c.find === "games" || c.aggregate === "games" || c.count === "games"))).toEqual([]);
  const after = await row();
  expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined();
  expect(after.repairs.opponents.status).toBe("complete"); expect(after._gdprMutation).toBeUndefined();
  expect(notify).toHaveBeenCalledWith(userId, expect.objectContaining({ title: "Data repair completed" }));
});

test("the admin rebuild forwards its admin_rebuild_opponents fence and releases it", async () => {
  await seed({ opponents: false }); const s = build(), capture = jest.spyOn(s.writer, "capture"); commands.length = 0;
  const result = await s.gdpr.rebuildOpponentsForAdmin(userId);
  expect(result.pulseBackfill).toMatchObject({ scanned: 1, resolved: 1 }); expect(capture).not.toHaveBeenCalled();
  const claim = commands.find(c => c.findAndModify === "users" && c.startTransaction);
  expect(claim.query).toMatchObject({ "_gdprMutation.kind": "admin_rebuild_opponents" });
  expect(commands.filter(c => c.txnNumber !== undefined && (c.find === "games" || c.aggregate === "games" || c.count === "games"))).toEqual([]);
  const after = await row();
  expect(await healed()).toBe(2); expect(after._gdprMutation).toBeUndefined();
  expect(after.gameStats).toBeUndefined(); expect(after.gameStatsMaintenance).toBeUndefined();
});

test("a background renewal failure closes the handle before any later assert", async () => {
  await seed(); const realSetInterval = global.setInterval, renewals = [];
  const intervals = jest.spyOn(global, "setInterval").mockImplementation((fn, ms, ...rest) => {
    if (ms === RENEW_MS) renewals.push(fn);
    return realSetInterval(fn, ms, ...rest);
  });
  const failed = held(), s = build();
  const gdprLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(() => failed.resolve()), child() { return this; } };
  const gdpr = new GdprService(db, { logger: gdprLogger, opponents: s.opponents }), fence = await gdpr._acquireMutationFence(userId, "repair_opponents");
  const fault = new Error("background renewal fault"); let renewal;
  try {
    expect(renewals).toHaveLength(1); renewal = faultRenewals(db.users, fault);
    renewals[0](); await failed.promise;
    expect(gdprLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: fault, kind: "repair_opponents" }), "gdpr_operation_lease_renew_failed");
    commands.length = 0;
    expect(await s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) })).toMatchObject({ resolved: 1 });
    expect(gameUpdates(commands)).toEqual([]); expect(commands.filter(c => c.findAndModify === "users")).toEqual([]);
    expect(firstWarning(s, HEAL_WARNING).err.cause).toBe(fault); expect(await healed()).toBe(0);
  } finally { renewal?.mockRestore(); intervals.mockRestore(); await gdpr._releaseMutationFence(userId, fence); }
});

test("a context dropped at the GDPR entry vetoes heals without recapturing under the fence", async () => {
  await seed({ opponents: false }); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    const capture = jest.spyOn(s.writer, "capture"), backfill = jest.spyOn(s.opponents, "backfillPulseCharacterId"); commands.length = 0;
    const result = await s.gdpr.rebuildOpponentsAndHealForUser(userId);
    expect(result.pulseBackfill).toMatchObject({ scanned: 1, resolved: 1 }); expect(capture).not.toHaveBeenCalled();
    const options = backfill.mock.calls[0][1];
    expect(Object.hasOwn(options, "repair")).toBe(true); expect(options.repair).toBeUndefined();
    expect(gameUpdates(commands)).toEqual([]); expect(firstWarning(s, HEAL_WARNING).err).toMatchObject({ code: "game_stats_repair_authority_unavailable" });
    expect(await healed()).toBe(0);
  } finally { await s.gdpr._releaseMutationFence(userId, fence); }
});

const NEGATIVE = {
  released: (s, fence) => s.gdpr._releaseMutationFence(userId, fence),
  "wrong-kind": () => db.users.updateOne({ userId }, { $set: { "_gdprMutation.kind": "restore" } }),
  "replaced-fence": () => db.users.updateOne({ userId }, { $set: { "_gdprMutation.id": uuid() } }),
  "replaced-owner": async (_s, fence) => { const old = await row(); await db.users.deleteOne({ _id: old._id });
    await db.users.insertOne({ userId, gameStatsMutationEpoch: fence.id, _gdprMutation: old._gdprMutation }); },
  "retired-epoch": () => db.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } }),
  forged: async () => {},
};
test.each(Object.keys(NEGATIVE))("a %s repair context sends no game update", async state => {
  await seed(); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    await NEGATIVE[state](s, fence);
    const context = state === "forged" ? { repair: { ...repairOf(fence).repair, handle: Object.freeze(Object.create(null)) } } : repairOf(fence);
    commands.length = 0;
    expect(await s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...context })).toMatchObject({ scanned: 1, resolved: 1 });
    expect(gameUpdates(commands)).toEqual([]);
    if (state === "forged" || state === "released") expect(commands.filter(c => c.findAndModify === "users")).toEqual([]);
    expect(s.log.warn).toHaveBeenCalledWith(expect.objectContaining({ userId, pulseId: "p1" }), HEAL_WARNING);
  } finally { await s.gdpr._releaseMutationFence(userId, fence); }
});

test("a known loss while the owner claim is held aborts the heal without any renewal under the lock", async () => {
  await seed(); const ticks = [], realSetInterval = global.setInterval;
  const intervals = jest.spyOn(global, "setInterval").mockImplementation((fn, ms, ...rest) => realSetInterval(
    ms === RENEW_MS ? () => { ticks.push(ms); fn(); } : fn, ms, ...rest));
  const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents"), fault = new Error("renewal transport fault");
  let renewals;
  try {
    const hold = claimHeld(), heal = s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) }); await hold.entered;
    const mark = commands.length; renewals = faultRenewals(db.users, fault);
    await expect(fence.assert()).rejects.toBe(fault);
    expect(await db.users.findOne({ userId, "_gdprMutation.id": fence.id, "_gdprMutation.kind": "repair_opponents" })).not.toBeNull();
    hold.release(); expect(await heal).toMatchObject({ resolved: 1 });
    const after = commands.slice(mark);
    expect(after.filter(c => c.update === "users" && JSON.stringify(c.updates).includes("leaseUntil"))).toEqual([]);
    expect(gameUpdates(after)).toEqual([]); expect(after.filter(c => c.abortTransaction)).toHaveLength(1);
    expect(firstWarning(s, HEAL_WARNING).err.cause).toBe(fault); expect(ticks).toEqual([]);
    expect(intervals.mock.calls.filter(call => call[1] === RENEW_MS)).toHaveLength(1);
  } finally { renewals?.mockRestore(); intervals.mockRestore(); await s.gdpr._releaseMutationFence(userId, fence); }
});

test("release-begin under a held claim vetoes at once while its unset waits for the aborted transaction", async () => {
  await seed(); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents");
  const hold = claimHeld(), heal = s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) }); await hold.entered;
  let unset = false; const release = s.gdpr._releaseMutationFence(userId, fence).then(() => { unset = true; });
  await db.games.findOne({ userId }); expect(unset).toBe(false);
  const mark = commands.length; hold.release(); await heal; await release;
  expect(unset).toBe(true); expect(gameUpdates(commands.slice(mark))).toEqual([]);
  expect(firstWarning(s, HEAL_WARNING).err.cause).toMatchObject({ code: "gdpr_repair_fence_released" });
  expect((await row())._gdprMutation).toBeUndefined(); expect(await healed()).toBe(0);
});

test("a faulted release unset or a later successful assert never re-enables heals", async () => {
  await seed(); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents"), fault = new Error("unset faulted");
  const original = db.users.updateOne.bind(db.users);
  const unset = jest.spyOn(db.users, "updateOne").mockImplementation(async (...args) => { if (args[1]?.$unset?._gdprMutation === "") throw fault; return original(...args); });
  await expect(s.gdpr._releaseMutationFence(userId, fence)).rejects.toBe(fault); unset.mockRestore();
  expect((await row())._gdprMutation.id).toBe(fence.id); commands.length = 0;
  await s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) });
  expect(gameUpdates(commands)).toEqual([]); await s.gdpr._releaseMutationFence(userId, fence);
  const second = await s.gdpr._acquireMutationFence(userId, "repair_opponents"), renewals = faultRenewals(db.users, new Error("network"));
  await expect(second.assert()).rejects.toThrow("network"); await expect(second.assert()).resolves.toBeUndefined(); renewals.mockRestore();
  commands.length = 0; await s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(second) });
  expect(gameUpdates(commands)).toEqual([]); expect(await healed()).toBe(0); await s.gdpr._releaseMutationFence(userId, second);
});

test("a known loss between transaction attempts vetoes the retry and calls the provider once", async () => {
  await seed(); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents"), fault = new Error("lost between attempts");
  const original = db.games.updateMany.bind(db.games); let attempts = 0, renewals;
  const heals = jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!args[2]?.session || attempts++) return result;
    renewals = faultRenewals(db.users, fault); await expect(fence.assert()).rejects.toBe(fault); throw transient("retry after known loss");
  });
  try {
    commands.length = 0;
    await s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) });
    expect(attempts).toBe(1); expect(s.mmr).toHaveBeenCalledTimes(1); expect(commands.filter(c => c.commitTransaction)).toEqual([]);
    expect(await healed()).toBe(0); expect(firstWarning(s, HEAL_WARNING).err.cause).toBe(fault);
  } finally { heals.mockRestore(); renewals?.mockRestore(); await s.gdpr._releaseMutationFence(userId, fence); }
});

test("a loss first observed after the game command is dispatched cannot cancel the commit", async () => {
  await seed(); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents"), fault = new Error("lost after dispatch");
  const hold = holdWhere(db.games, "updateMany", (_filter, _update, options) => !!options?.session, true); let renewals;
  try {
    const heal = s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) }); await hold.entered;
    renewals = faultRenewals(db.users, fault); await expect(fence.assert()).rejects.toBe(fault); hold.release();
    expect(await heal).toMatchObject({ resolved: 1 }); expect(await healed()).toBe(2);
    expect(s.mmr).toHaveBeenCalledTimes(1); expect(s.log.warn.mock.calls.filter(call => call[1] === HEAL_WARNING)).toEqual([]);
  } finally { hold.spy.mockRestore(); renewals?.mockRestore(); await s.gdpr._releaseMutationFence(userId, fence); }
});

test("a failed heal after a resolved opponent row keeps the summary and is never retried durably", async () => {
  await seed(); const s = build(), failure = new MongoServerError({ message: "heal failed" });
  const heals = jest.spyOn(db.games, "updateMany").mockRejectedValue(failure);
  expect(await s.opponents.backfillPulseCharacterId(userId, { limit: 5 })).toEqual({ scanned: 1, resolved: 1, updated: 1, skipped: 0 });
  expect(s.log.warn).toHaveBeenCalledWith({ err: failure, userId, pulseId: "p1" }, HEAL_WARNING);
  heals.mockRestore();
  expect(await s.opponents.backfillPulseCharacterId(userId, { limit: 5 })).toEqual({ scanned: 0, resolved: 0, updated: 0, skipped: 0 });
  expect(await db.games.countDocuments({ userId, "opponent.pulseCharacterId": { $exists: true } })).toBe(0);
});

test("a cron tick during an active repair fence resolves rows, vetoes heals, and the repair scan then skips them", async () => {
  await seed(); const s = build(), fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    commands.length = 0; const summary = await s.job().runOnce();
    expect(summary).toMatchObject({ users: 1, scanned: 1, resolved: 1, updated: 1 }); expect(gameUpdates(commands)).toEqual([]);
    expect(firstWarning(s, HEAL_WARNING).err).toMatchObject({ code: "game_stats_owner_unavailable" });
    expect((await db.opponents.findOne({ userId, pulseId: "p1" })).pulseCharacterId).toBe("777");
    expect(await s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) })).toMatchObject({ scanned: 0 });
    expect(await healed()).toBe(0);
  } finally { await s.gdpr._releaseMutationFence(userId, fence); }
});

test("a held real floor plus a known assertion failure vetoes before any session or claim", async () => {
  await seed(); const ctx = await scoped(), s = ctx.services, fence = await s.gdpr._acquireMutationFence(userId, "repair_opponents");
  const floor = holdFloor(ctx.context); let renewals;
  try {
    const heal = s.opponents.backfillPulseCharacterId(userId, { limit: 5, force: true, ...repairOf(fence) }); await floor.entered;
    const fault = new Error("assert failed under floor"); renewals = faultRenewals(ctx.context.users, fault); await expect(fence.assert()).rejects.toBe(fault);
    const sessions = jest.spyOn(ctx.client, "startSession"), mark = ctx.log.length; floor.release(); await heal;
    expect(ctx.log.slice(mark).filter(c => c.startTransaction || c.findAndModify || c.update === "games")).toEqual([]);
    expect(sessions.mock.calls.filter(([options]) => options?.causalConsistency === true)).toEqual([]); sessions.mockRestore();
    expect(firstWarning(s, HEAL_WARNING).err.cause).toBe(fault);
  } finally { renewals?.mockRestore(); floor.spy.mockRestore(); await s.gdpr._releaseMutationFence(userId, fence); await s.writer.stopAndDrain(); await ctx.client.close(); }
});

const HELD = { record: [s => s.opponents.recordGame(userId, payload()), STAMP_WARNING, 1, { upgraded: false, from: null, to: null, mmr: 4100, region: "EU" }],
  backfill: [s => s.opponents.backfillPulseCharacterId(userId, { limit: 5 }), HEAL_WARNING, 3, { scanned: 3, resolved: 3, updated: 3, skipped: 0 }] };
test.each([["record", "read"], ["record", "reject"], ["backfill", "read"], ["backfill", "reject"]])("a held %s omission capture stays outside the writer slot and drain (release by %s)", async (name, mode) => {
  await seed({ rows: 3 }); const ctx = await scoped(), s = ctx.services, capture = jest.spyOn(s.writer, "capture"), [run, warning, count, expected] = HELD[name];
  s.mmr.mockImplementation(async () => { ctx.events.push("provider"); return { mmr: 4100, region: "EU" }; });
  const helper = jest.spyOn(s.opponents, name === "record" ? "_stampGameRegion" : "_backfillGameIdentity");
  try {
    const hold = holdCapture(ctx); let settled = false;
    const task = run(s).then(result => { settled = true; return result; }); await hold.entered;
    expect(capture).toHaveBeenCalledTimes(1); expect(s.writer.pending.size).toBe(0);
    await s.writer.stopAndDrain(); expect(settled).toBe(false);
    expect(ctx.events.filter(event => /opponents|games|provider/.test(event))).toEqual([]);
    ctx.events.push("release"); const fault = new Error("capture read failed"); hold.release(mode === "reject" ? fault : undefined);
    expect(await task).toEqual(expected);
    const marker = ctx.events.indexOf("release"), opponentWork = ctx.events.findIndex(event => /opponents|provider/.test(event));
    expect(opponentWork).toBeGreaterThan(marker);
    expect(ctx.log.filter(c => c.update === "games" || c.findAndModify || c.startTransaction)).toEqual([]);
    const codes = s.log.warn.mock.calls.filter(call => call[1] === warning).map(call => call[0].err.code || call[0].err.message);
    expect(codes).toEqual(Array(count).fill(mode === "reject" ? fault.message : "game_stats_writer_stopping"));
    expect(await Promise.all(helper.mock.results.map(call => call.value))).toEqual(Array(count).fill(name === "record" ? undefined : 0));
    const rows = await db.opponents.find({ userId }).toArray();
    expect(rows.every(row => (name === "record" ? row.pulseId !== "p1" || row.mmr === 4100 : row.pulseCharacterId === "777"))).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1); expect(await db.games.countDocuments({ userId, "opponent.region": { $exists: true } })).toBe(0);
  } finally { await ctx.client.close(); }
});

test("the real backfill job owns a held capture: the writer drains while job.stop() waits", async () => {
  await seed({ rows: 3 }); const ctx = await scoped(), s = ctx.services, job = s.job();
  try {
    const hold = holdCapture(ctx), cycle = job.runOnce(); await hold.entered;
    await s.writer.stopAndDrain(); let stopped = false; const stop = job.stop().then(() => { stopped = true; });
    await db.users.findOne({ userId }); expect(stopped).toBe(false);
    hold.release(); expect(await cycle).toMatchObject({ users: 1, scanned: 3, resolved: 3, updated: 3, skipped: 0 }); await stop;
    expect(stopped).toBe(true); expect(gameUpdates(ctx.log)).toEqual([]);
    expect(s.log.warn.mock.calls.filter(call => call[1] === HEAL_WARNING)).toHaveLength(3);
  } finally { await ctx.client.close(); }
});

test("MAX8: capture still runs once at capacity and only the producer writes are refused busy", async () => {
  await seed({ rows: 3 }); const ctx = await scoped(), s = ctx.services, owners = [];
  for (let i = 0; i < MAX_ACTIVE; i += 1) { await seed({ id: `other-${i}` }); owners.push(await s.writer.capture(`other-${i}`)); }
  const floor = holdFloor(ctx.context);
  const writes = owners.map(owner => s.writer.write(owner, { kind: "opponentGameRegion", gameId: "g1", region: "KR" })); await floor.entered;
  try {
    expect(s.writer.pending.size).toBe(MAX_ACTIVE);
    const capture = jest.spyOn(s.writer, "capture"), write = jest.spyOn(s.writer, "write"), mark = ctx.log.length;
    expect(await s.opponents.recordGame(userId, payload())).toEqual({ upgraded: false, from: null, to: null, mmr: 4100, region: "EU" });
    expect(await s.opponents.backfillPulseCharacterId(userId, { limit: 5 })).toEqual({ scanned: 3, resolved: 3, updated: 3, skipped: 0 });
    expect(capture).toHaveBeenCalledTimes(2);
    for (const call of capture.mock.results) await expect(call.value).resolves.toMatchObject({ userId });
    expect(write).toHaveBeenCalledTimes(4);
    for (const call of write.mock.results) await expect(call.value).rejects.toMatchObject({ code: "game_stats_writer_busy" });
    expect(s.writer.pending.size).toBe(MAX_ACTIVE);
    expect(ctx.log.slice(mark).filter(c => c.findAndModify || c.startTransaction || c.update === "games")).toEqual([]);
    expect(s.log.warn.mock.calls.map(call => call[0].err.code)).toEqual(Array(4).fill("game_stats_writer_busy"));
  } finally { floor.release(); await Promise.allSettled(writes); }
  expect(s.writer.pending.size).toBe(0); expect(await db.games.countDocuments({ "opponent.region": "KR" })).toBe(MAX_ACTIVE);
  await s.writer.stopAndDrain(); await ctx.client.close();
});
