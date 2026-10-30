// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { GdprService } = require("../src/services/gdpr");
const { UserRevision } = require("../src/util/userRevision");
const { gameStatsWritesFor } = require("../src/services/gameStatsWrites");
const { gameStampAdmission, backfillStampAdmission } = require("../src/services/opponentGameStamps");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");

const logger = pino({ level: "silent" }), userId = "standalone-stamp-owner", played = new Date("2026-10-20T12:00:00Z"), commands = [];
const RETIRED = ["gameStats", "gameStatsRevision", "gameStatsProtocolVersion", "gameStatsMaintenance"];
let mongo, mongoChild, db, writer, clientB;
const row = () => db.users.findOne({ userId });
const warnLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
const service = (database = db, opts = {}) => new OpponentsService(database, Buffer.alloc(32, 1), { logger: warnLogger(), ...opts });
const gameUpdates = operation => operation.filter(c => c.update === "games");
function held() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function seed(rows) {
  const epoch = uuid(), revision = uuid();
  const inserted = await db.users.insertOne({ userId, gameStatsMutationEpoch: epoch, gameStats: { total: 2, latest: played },
    gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional" });
  await db.users.updateOne({ _id: inserted.insertedId }, { $set: { gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready",
    ownerId: inserted.insertedId, epoch, revision } } });
  const defaults = [{ gameId: "g1", opponent: { pulseId: "p1", region: "NA" } }, { gameId: "g2", opponent: { pulseId: "p1" } }];
  await db.games.insertMany((rows || defaults).map(game => ({ userId, date: played, ...game })));
  return row();
}
function holdRetirement(collection) {
  const entered = held(), release = held(), original = collection.updateOne.bind(collection);
  jest.spyOn(collection, "updateOne").mockImplementation(async (...args) => {
    if (args[1]?.$set?.gameStatsWriterStatus === "unsupported") { entered.resolve(); await release.promise; }
    return original(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}
const repairOf = fence => ({ repair: { owner: fence.owner, fenceId: fence.id, kind: "repair_opponents", handle: fence.liveness } });
async function freshContext() {
  const client = new MongoClient(mongo.getUri(), { monitorCommands: true }); await client.connect();
  const database = client.db("standalone_stamps"), log = [];
  client.on("commandStarted", event => log.push(event.command));
  const scoped = { ...db, client, db: database, users: database.collection("users"), games: database.collection("games"),
    opponents: database.collection("opponents") };
  return { client, scoped, log, writer: gameStatsWritesFor(scoped) };
}
beforeAll(async () => {
  // The admitted local runner pins the cached binary and disables downloads.
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  mongoChild = mongo.instanceInfo.instance.mongodProcess;
  process.stdout.write(`standalone_stamp_owned_mongo ${JSON.stringify({ pid: mongoChild.pid, port: mongo.instanceInfo.port })}\n`);
  db = await connect({ uri: mongo.getUri(), dbName: "standalone_stamps", awaitBackgroundIndexes: true }, { logger });
  db.client.on("commandStarted", event => commands.push(event.command));
  clientB = new MongoClient(mongo.getUri()); await clientB.connect();
  writer = gameStatsWritesFor(db);
  expect(db.gameStatsTransactions).toBe(false);
});
afterAll(async () => {
  try { await writer?.stopAndDrain(); await clientB?.close(); await db?.close(); }
  finally {
    await mongo?.stop();
    if (mongoChild) {
      expect(mongoChild.exitCode !== null || mongoChild.signalCode !== null).toBe(true);
      process.stdout.write(`standalone_stamp_owned_mongo_closed ${JSON.stringify({ pid: mongoChild.pid, exitCode: mongoChild.exitCode, signal: mongoChild.signalCode })}\n`);
    }
  }
});
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.games, db.opponents]) await collection.deleteMany({});
  commands.length = 0;
});

test("ordinary compat retires the proof under the exact ordinary authority, then sends one fixed command", async () => {
  const before = await seed(), owner = await writer.capture(userId); commands.length = 0;
  await writer.write(owner, { kind: "opponentGameRegion", gameId: "g1", region: "EU" });
  const operation = [...commands], retire = operation.find(c => c.update === "users"), [game] = gameUpdates(operation);
  expect(retire.updates[0]).toMatchObject({ q: { userId, _id: before._id, gameStatsMutationEpoch: before.gameStatsMutationEpoch,
    _gdprMutation: { $exists: false } }, upsert: false });
  expect(operation.indexOf(retire)).toBeLessThan(operation.indexOf(game)); expect(gameUpdates(operation)).toHaveLength(1);
  expect(game.updates).toEqual([expect.objectContaining({ q: { userId, gameId: "g1" }, u: { $set: { "opponent.region": "EU" } }, upsert: false })]);
  expect(operation.some(c => c.startTransaction)).toBe(false);
  const after = await row(); expect(after.gameStatsWriterStatus).toBe("unsupported");
  for (const field of RETIRED) expect(after).not.toHaveProperty(field);
  expect((await db.games.findOne({ gameId: "g1" })).opponent.region).toBe("EU");
});

test("an epoch retired after capture matches nothing and vetoes the game command", async () => {
  await seed(); const opponents = service(), admission = await gameStampAdmission(writer, userId, undefined, true);
  await db.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } }); commands.length = 0;
  expect(await opponents._stampGameRegion(userId, "g1", {}, { region: "EU" }, admission)).toBeUndefined();
  expect(await opponents._backfillGameIdentity(userId, "p1", { region: "EU" }, admission)).toBe(0);
  expect(gameUpdates(commands)).toEqual([]);
  expect(opponents.logger.warn.mock.calls.map(call => [call[0].err.code, call[1]])).toEqual([
    ["game_stats_authority_changed", "opponent_game_region_stamp_failed"], ["game_stats_authority_changed", "opponent_pulse_backfill_game_identity_failed"]]);
});

test("a held compat retirement on a fresh client keeps its slot through stop and the helper resolves only afterwards", async () => {
  await seed(); const ctx = await freshContext(), opponents = service(ctx.scoped);
  try {
    const admission = await gameStampAdmission(ctx.writer, userId, undefined, true), hold = holdRetirement(ctx.scoped.users);
    let settled = false; const stamp = opponents._stampGameRegion(userId, "g1", {}, { region: "EU" }, admission).then(() => { settled = true; });
    await hold.entered; ctx.log.length = 0;
    let drained = false; const drain = ctx.writer.stopAndDrain().then(() => { drained = true; });
    await db.users.findOne({ userId }); expect(drained).toBe(false); expect(settled).toBe(false); expect(ctx.writer.pending.size).toBe(1);
    hold.release(); await drain; await stamp;
    expect(settled).toBe(true); expect(gameUpdates(ctx.log)).toEqual([]);
    expect(opponents.logger.warn.mock.calls[0][0].err).toMatchObject({ code: "game_stats_writer_stopping" });
    expect((await db.games.findOne({ gameId: "g1" })).opponent.region).toBe("NA");
  } finally { await ctx.client.close(); }
});

test("a real repair fence requires an acknowledged retirement before its heal", async () => {
  await seed(); const gdpr = new GdprService(db, { logger }), fence = await gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    const opponents = service(), admission = await backfillStampAdmission(writer, userId, repairOf(fence)), original = db.users.updateOne.bind(db.users);
    jest.spyOn(db.users, "updateOne").mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[1]?.$set?.gameStatsWriterStatus === "unsupported" ? { ...result, acknowledged: false } : result;
    });
    commands.length = 0;
    expect(await opponents._backfillGameIdentity(userId, "p1", { region: "EU", pulseCharacterId: "77" }, admission)).toBe(0);
    expect(gameUpdates(commands)).toEqual([]); expect(opponents.logger.warn.mock.calls[0][0].err).toMatchObject({ code: "game_stats_authority_changed" });
    const after = await row(); expect(after.gameStatsWriterStatus).toBe("unsupported");
    for (const field of RETIRED) expect(after).not.toHaveProperty(field);
  } finally { jest.restoreAllMocks(); await gdpr._releaseMutationFence(userId, fence); }
});

test("a stop during a held real repair retirement refuses the heal while the handle is still live", async () => {
  await seed(); const ctx = await freshContext(), gdpr = new GdprService(ctx.scoped, { logger }), opponents = service(ctx.scoped);
  const fence = await gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    const admission = await backfillStampAdmission(ctx.writer, userId, repairOf(fence)), hold = holdRetirement(ctx.scoped.users);
    let settled = false; const heal = opponents._backfillGameIdentity(userId, "p1", { region: "EU" }, admission).then(result => { settled = true; return result; });
    await hold.entered; ctx.log.length = 0;
    let drained = false; const drain = ctx.writer.stopAndDrain().then(() => { drained = true; });
    await db.users.findOne({ userId }); expect(drained).toBe(false); expect(settled).toBe(false); expect(ctx.writer.pending.size).toBe(1);
    hold.release(); await drain; expect(await heal).toBe(0);
    expect(gameUpdates(ctx.log)).toEqual([]); expect(opponents.logger.warn.mock.calls[0][0].err).toMatchObject({ code: "game_stats_writer_stopping" });
    expect(await db.games.countDocuments({ userId, "opponent.region": "EU" })).toBe(0);
  } finally { jest.restoreAllMocks(); await gdpr._releaseMutationFence(userId, fence); await ctx.client.close(); }
});

test("both helpers reach the write-then-throw seam and still retire UserRevision membership", async () => {
  await seed(); const revisions = new UserRevision(db.users, { enabled: true }), opponents = service(db, { userRevision: revisions });
  const admission = await gameStampAdmission(writer, userId, undefined, true);
  for (const [method, collectionMethod, args] of [["_stampGameRegion", "updateOne", [userId, "g1", {}, { region: "EU" }, admission]],
    ["_backfillGameIdentity", "updateMany", [userId, "p1", { region: "KR" }, admission]]]) {
    const original = db.games[collectionMethod].bind(db.games), before = await revisions.snapshot(userId);
    const spy = jest.spyOn(db.games, collectionMethod).mockImplementationOnce(async (...input) => { await original(...input); throw new Error("lost stamp ack"); });
    await opponents[method](...args);
    expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore(); expect(revisions.current(before)).toBe(false);
  }
  expect(opponents.logger.warn.mock.calls.map(call => call[0].err.message)).toEqual(["lost stamp ack", "lost stamp ack"]);
  expect((await db.games.findOne({ gameId: "g1" })).opponent.region).toBe("KR");
});

test("a real repair_opponents fence retires under the exact fenced authority and heals", async () => {
  await seed(); const gdpr = new GdprService(db, { logger }), fence = await gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    const opponents = service(), admission = await backfillStampAdmission(writer, userId, { force: true, ...repairOf(fence) }); commands.length = 0;
    expect(await opponents._backfillGameIdentity(userId, "p1", { region: "EU", pulseCharacterId: "77" }, admission)).toBe(2);
    const retire = commands.find(c => c.update === "users");
    expect(retire.updates[0].q).toMatchObject({ userId, _id: fence.owner.id, gameStatsMutationEpoch: fence.id, "_gdprMutation.id": fence.id,
      "_gdprMutation.kind": "repair_opponents" });
    expect(gameUpdates(commands)).toHaveLength(1); expect((await row()).gameStats).toBeUndefined();
    await clientB.db("standalone_stamps").collection("users").updateOne({ userId }, { $set: { "_gdprMutation.kind": "restore" } }); commands.length = 0;
    expect(await opponents._backfillGameIdentity(userId, "p1", { region: "KR" }, admission)).toBe(0);
    expect(gameUpdates(commands)).toEqual([]); expect(opponents.logger.warn.mock.calls[0][0].err).toMatchObject({ code: "game_stats_authority_changed" });
  } finally { await gdpr._releaseMutationFence(userId, fence); }
});

test("a held repair retirement plus a faulted assert sends no game command and never remints the proof", async () => {
  await seed(); const gdpr = new GdprService(db, { logger }), fence = await gdpr._acquireMutationFence(userId, "repair_opponents");
  try {
    const opponents = service(), admission = await backfillStampAdmission(writer, userId, repairOf(fence));
    const fault = new Error("renewal transport fault"), hold = holdRetirement(db.users), spied = db.users.updateOne;
    const heal = opponents._backfillGameIdentity(userId, "p1", { region: "EU", pulseCharacterId: "77" }, admission); await hold.entered;
    spied.mockImplementationOnce(async () => { throw fault; });
    await expect(fence.assert()).rejects.toBe(fault); commands.length = 0;
    hold.release(); expect(await heal).toBe(0);
    expect(gameUpdates(commands)).toEqual([]);
    expect(opponents.logger.warn.mock.calls[0][0].err).toMatchObject({ code: "game_stats_repair_authority_unavailable", cause: fault });
    const after = await row(); expect(after.gameStatsWriterStatus).toBe("unsupported");
    for (const field of RETIRED) expect(after).not.toHaveProperty(field);
    expect(await db.games.countDocuments({ userId, "opponent.pulseCharacterId": "77" })).toBe(0);
  } finally { jest.restoreAllMocks(); await gdpr._releaseMutationFence(userId, fence); }
});

test.each(["write-then-throw", "unacknowledged"])("a %s retirement prevents the game command", async state => {
  await seed(); const opponents = service(), admission = await gameStampAdmission(writer, userId, undefined, true);
  const original = db.users.updateOne.bind(db.users), lost = new Error("lost retirement acknowledgement");
  jest.spyOn(db.users, "updateOne").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1]?.$set?.gameStatsWriterStatus !== "unsupported") return result;
    if (state === "write-then-throw") throw lost;
    return { ...result, acknowledged: false };
  });
  commands.length = 0;
  expect(await opponents._stampGameRegion(userId, "g1", {}, { region: "EU" }, admission)).toBeUndefined();
  expect(await opponents._backfillGameIdentity(userId, "p1", { region: "EU" }, admission)).toBe(0);
  expect(gameUpdates(commands)).toEqual([]);
  const codes = opponents.logger.warn.mock.calls.map(call => call[0].err.code || call[0].err.message);
  expect(codes).toEqual(state === "unacknowledged" ? ["game_stats_authority_changed", "game_stats_authority_changed"] : [lost.message, lost.message]);
});

test("retry with an unresolved id heals only the toon-derived region", async () => {
  await seed(); await db.opponents.insertOne({ userId, pulseId: "p1", toonHandle: "2-S2-1-5", displayNameSample: "Rival" });
  const opponents = service(db, { pulseResolver: { resolve: jest.fn(async () => null) } });
  const result = await opponents.retryPulseResolution(userId, "p1");
  expect(result).toMatchObject({ resolvedPulseCharacterId: false, pulseCharacterId: null, region: "EU" });
  expect(result.gamesRestamped).toBeGreaterThan(0);
  for (const game of await db.games.find({ userId }).toArray()) {
    expect(game.opponent.region).toBe("EU"); expect(game.opponent).not.toHaveProperty("pulseCharacterId");
  }
});

test("a literal empty-string pulseId heal matches only the owner's empty-key games", async () => {
  await seed([{ gameId: "g1", opponent: { pulseId: "" } }, { gameId: "g2", opponent: { pulseId: "" } }, { gameId: "g3", opponent: { pulseId: "p1" } }]);
  await db.games.insertOne({ userId: "foreign", gameId: "f1", opponent: { pulseId: "" } });
  const opponents = service(), admission = await gameStampAdmission(writer, userId, undefined, true);
  expect(await opponents._backfillGameIdentity(userId, "", { pulseCharacterId: "77" }, admission)).toBe(2);
  expect(await db.games.countDocuments({ "opponent.pulseCharacterId": "77" })).toBe(2);
  expect((await db.games.findOne({ gameId: "g3" })).opponent).toEqual({ pulseId: "p1" });
  expect((await db.games.findOne({ gameId: "f1" })).opponent).toEqual({ pulseId: "" });
});

test("swallowed compat failures still retire UserRevision filter membership", async () => {
  await seed(); const revisions = new UserRevision(db.users, { enabled: true }), opponents = service(db, { userRevision: revisions });
  const admission = await gameStampAdmission(writer, userId, undefined, true);
  await db.users.updateOne({ userId }, { $set: { gameStatsMutationEpoch: uuid() } });
  for (const call of [() => opponents._stampGameRegion(userId, "g1", {}, { region: "EU" }, admission),
    () => opponents._backfillGameIdentity(userId, "p1", { region: "EU" }, admission)]) {
    const before = await revisions.snapshot(userId); await call(); expect(revisions.current(before)).toBe(false);
  }
  expect(opponents.logger.warn).toHaveBeenCalledTimes(2); expect(await db.games.countDocuments({ "opponent.region": "EU" })).toBe(0);
});
