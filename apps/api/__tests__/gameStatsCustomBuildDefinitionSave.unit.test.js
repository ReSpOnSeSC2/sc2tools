// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites, MAX_ACTIVE, reserveCustomDefinitionSave } = require("../src/services/gameStatsWrites");
const { immutableNeutralMutation } = require("../src/services/gameStatsCountNeutral");
const { immutableCustomBuildDefinitionSave } = require("../src/services/gameStatsCustomBuildDefinitionSave");
const { definitionWriteCommand } = require("../src/services/customBuildDefinitionCommands");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { UserRevision } = require("../src/util/userRevision");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const userId = "definition-unit-owner", played = new Date("2026-10-20T12:00:00Z");
const definition = extra => ({ slug: "saved", name: "Saved", race: "Protoss", vsRace: "Any", perspective: "you", rules: [], steps: [], ...extra });
const data = extra => ({ kind: "customBuildDefinitionSave", definition: definition(), ...extra });
function held() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const owner = { userId, id: new ObjectId(), epoch: uuid(), compatibility: false }, revision = uuid(), events = [];
  const previous = { name: "Old", perspective: "you", definitionRevision: 0 };
  const before = { _id: new ObjectId(owner.id), userId, gameStatsMutationEpoch: owner.epoch, gameStats: { total: 1, latest: played },
    gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: new ObjectId(owner.id), epoch: owner.epoch, revision } };
  const session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };
  const users = { findOne: jest.fn(async () => ({ _id: owner.id, gameStatsMutationEpoch: owner.epoch })),
    findOneAndUpdate: jest.fn(async (_filter, update) => {
      if (update.$inc) return { dataRev: 1 };
      events.push("owner"); return before;
    }), updateOne: jest.fn(async () => ({ acknowledged: true, matchedCount: 1 })) };
  const games = { updateMany: jest.fn(async () => { events.push("rename"); return { acknowledged: true, modifiedCount: 1 }; }),
    countDocuments: jest.fn(), find: jest.fn() };
  const customBuilds = { findOne: jest.fn(async () => { events.push("definition-read"); return previous; }),
    aggregate: jest.fn(() => ({ next: async () => { events.push("definition-read"); return previous; } })),
    updateOne: jest.fn(async () => { events.push("definition-save"); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; }) };
  const db = { users, games, customBuilds, customBuildJobs: {}, gameStatsTransactions: true, client: { startSession: jest.fn(() => session) } };
  const logger = { warn: jest.fn() }, writer = new GameStatsWrites(db, logger);
  const custom = new CustomBuildsService(db, { logger }); custom.gameStatsWrites = writer;
  return { owner, before, previous, events, session, users, games, customBuilds, db, logger, writer, custom };
}
beforeEach(() => { statsReadFloorFor.mockReset(); statsReadFloorFor.mockReturnValue(() => new Timestamp({ t: 12, i: 1 })); });
afterEach(() => jest.restoreAllMocks());

test.each(["filter", "update", "pipeline", "session", "owner", "fenceId", "countNeutral", "onInitialRead", "work"])("reserved data rejects arbitrary %s before capture or queue", key => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  expect(() => reserveCustomDefinitionSave(h.writer, userId, data({ [key]: true }))).toThrow();
  expect(capture).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
  expect(h.custom._buildMutationTails.size).toBe(0); expect(statsReadFloorFor).not.toHaveBeenCalled();
});

test("a structural writer or public neutral descriptor cannot bypass reserved admission", async () => {
  const h = harness(), input = data();
  expect(() => reserveCustomDefinitionSave({ pending: new Set(), capture: jest.fn() }, userId, input)).toThrow("game_stats_definition_writer_required");
  expect(() => immutableNeutralMutation(input)).toThrow("game_stats_neutral_operation_invalid");
  await expect(h.writer.write(h.owner, input)).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(statsReadFloorFor).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled();
  expect(h.customBuilds.updateOne).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
});

test("root and private-definition getters or symbols cannot run during immutable preparation", () => {
  const getter = jest.fn(() => "saved"), root = data();
  Object.defineProperty(root, "definition", { enumerable: true, get: getter });
  expect(() => immutableCustomBuildDefinitionSave(root)).toThrow(); expect(getter).not.toHaveBeenCalled();
  const nested = data(); Object.defineProperty(nested.definition, "slug", { enumerable: true, get: getter });
  expect(() => immutableCustomBuildDefinitionSave(nested)).toThrow(); expect(getter).not.toHaveBeenCalled();
  expect(() => immutableCustomBuildDefinitionSave({ ...data(), [Symbol("extra")]: true })).toThrow();
});

test("accepted large private data is copied without a 16 KiB public-history substitution", () => {
  const input = data({ definition: definition({ notes: "n".repeat(8000), description: "d".repeat(4000),
    signature: Array.from({ length: 200 }, () => ({ unit: "x".repeat(80), count: 1, beforeSec: 100 })), sourceGameId: "private-replay", shareWithCommunity: true }) });
  const captured = immutableCustomBuildDefinitionSave(input); input.definition.signature[0].unit = "changed";
  expect(Buffer.byteLength(JSON.stringify(captured.definition))).toBeGreaterThan(16384);
  expect(captured.definition).toMatchObject({ notes: "n".repeat(8000), description: "d".repeat(4000), sourceGameId: "private-replay", shareWithCommunity: true });
  expect(captured.definition.signature[0].unit).toBe("x".repeat(80));
});

test("legacy falsey ID/undefined revision stay ordinary but invalid null revision rejects", () => {
  const ordinary = immutableCustomBuildDefinitionSave(data({ expectedRevision: undefined, expectedId: "", recordHistory: "yes" }));
  const command = definitionWriteCommand(userId, ordinary, null, played);
  expect(ordinary.recordHistory).toBe(true); expect(command.upsert).toBe(true); expect(command.filter).toEqual({ userId, slug: "saved" });
  expect(() => immutableCustomBuildDefinitionSave(data({ expectedRevision: null }))).toThrow("game_stats_neutral_operation_invalid");
});

test("MAX8 is charged before FIFO or capture, and shutdown closes unused reservations", async () => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  const tickets = Array.from({ length: MAX_ACTIVE }, () => reserveCustomDefinitionSave(h.writer, userId, data()));
  expect(MAX_ACTIVE).toBe(8); expect(h.writer.pending.size).toBe(8);
  expect(() => reserveCustomDefinitionSave(h.writer, userId, data())).toThrow("game_stats_writer_busy");
  expect(capture).not.toHaveBeenCalled(); expect(h.custom._buildMutationTails.size).toBe(0);
  await h.writer.stopAndDrain(); expect(h.writer.pending.size).toBe(0);
  for (const ticket of tickets) await expect(ticket.commit()).rejects.toThrow();
  expect(() => reserveCustomDefinitionSave(h.writer, userId, data())).toThrow("game_stats_writer_stopping");
  expect(h.db.client.startSession).not.toHaveBeenCalled();
});

test("start requires its actual native queue promise and cannot be reused", async () => {
  const h = harness(), ticket = reserveCustomDefinitionSave(h.writer, userId, data()), reason = new Error("setup failed");
  expect(() => ticket.start({ then: jest.fn() })).toThrow("game_stats_definition_ticket_used");
  await expect(ticket.abandon(reason)).rejects.toBe(reason); expect(h.writer.pending.size).toBe(0);
  expect(() => ticket.start(Promise.resolve())).toThrow("game_stats_definition_ticket_used");
  await expect(ticket.commit()).rejects.toBe(reason); expect(h.users.findOne).not.toHaveBeenCalled();
});

test("WORK returns the precise rename count while JOIN waits for queue completion", async () => {
  const h = harness(), queue = held(), ticket = reserveCustomDefinitionSave(h.writer, userId, data());
  const joined = ticket.start(queue.promise), work = ticket.commit();
  expect(() => ticket.start(queue.promise)).toThrow("game_stats_definition_ticket_used");
  await expect(ticket.commit()).rejects.toThrow("game_stats_definition_ticket_used");
  await expect(work).resolves.toBe(1); expect(h.writer.pending.size).toBe(1);
  expect(h.events).toEqual(["owner", "definition-read", "rename", "definition-save"]);
  expect(h.games.updateMany.mock.calls[0][2]).toEqual({ session: h.session });
  expect(h.games.countDocuments).not.toHaveBeenCalled(); expect(h.games.find).not.toHaveBeenCalled();
  queue.resolve(); await expect(joined).resolves.toBeUndefined(); expect(h.writer.pending.size).toBe(0);
});

test("a fulfilled unused queue is not mistaken for successful definition work", async () => {
  const h = harness(), ticket = reserveCustomDefinitionSave(h.writer, userId, data());
  await expect(ticket.start(Promise.resolve())).rejects.toThrow("game_stats_definition_ticket_unused");
  await expect(ticket.commit()).rejects.toThrow(); expect(h.writer.pending.size).toBe(0);
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
});

test("original queue failure remains primary while a failed capture is still charged", async () => {
  const h = harness(), captured = held(), queueError = new Error("queue failed first"), captureError = new Error("capture failed later");
  jest.spyOn(h.writer, "capture").mockReturnValue(captured.promise);
  const ticket = reserveCustomDefinitionSave(h.writer, userId, data()), joined = ticket.start(Promise.reject(queueError));
  const rejected = expect(joined).rejects.toBe(queueError); await turn(); expect(h.writer.pending.size).toBe(1);
  captured.reject(captureError); await rejected; expect(h.writer.pending.size).toBe(0);
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
});

test("abandon blocks late commit but retains the actual capture and queued promise", async () => {
  const h = harness(), captured = held(), queue = held(), original = new Error("abandoned setup");
  jest.spyOn(h.writer, "capture").mockReturnValue(captured.promise);
  const ticket = reserveCustomDefinitionSave(h.writer, userId, data()), joined = ticket.start(queue.promise);
  const first = expect(joined).rejects.toBe(original), abandoned = expect(ticket.abandon(original)).rejects.toBe(original);
  await expect(ticket.commit()).rejects.toBe(original); queue.resolve(); await turn();
  expect(h.writer.pending.size).toBe(1); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
  captured.resolve(h.owner); await first; await abandoned; expect(h.writer.pending.size).toBe(0);
});

test("abandon cannot cancel or relabel WORK that has already started", async () => {
  const h = harness(), entered = held(), release = held(), queue = held(), original = new Error("too late to abandon");
  h.customBuilds.updateOne.mockImplementation(async () => { entered.resolve(); await release.promise; return { acknowledged: true, matchedCount: 1 }; });
  const ticket = reserveCustomDefinitionSave(h.writer, userId, data()), joined = ticket.start(queue.promise), work = ticket.commit();
  await entered.promise; const abandoned = ticket.abandon(original);
  expect(h.writer.pending.size).toBe(1); release.resolve(); await expect(work).resolves.toBe(1);
  expect(h.writer.pending.size).toBe(1); queue.resolve(); await expect(joined).resolves.toBeUndefined();
  await expect(abandoned).resolves.toBeUndefined(); expect(h.writer.pending.size).toBe(0);
});

test("capture failure while queued has immediate handlers and preserves its reserved turn", async () => {
  const h = harness(), prior = held(), original = new Error("capture rejected"), unhandled = [], observe = error => unhandled.push(error);
  const blocker = h.custom._withUserBuildMutation(userId, () => prior.promise);
  jest.spyOn(h.writer, "capture").mockRejectedValue(original); process.on("unhandledRejection", observe);
  try {
    const task = h.custom.upsert(userId, definition()), rejected = expect(task).rejects.toBe(original);
    await turn(); expect(unhandled).toEqual([]); expect(h.writer.pending.size).toBe(1);
    expect(h.customBuilds.updateOne).not.toHaveBeenCalled(); prior.resolve(); await blocker; await rejected;
    expect(h.writer.pending.size).toBe(0); expect(h.custom._buildMutationTails.size).toBe(0);
  } finally { prior.resolve(); process.off("unhandledRejection", observe); }
});

test("slow capture A and fast capture B retain the original synchronous FIFO order", async () => {
  const h = harness(), first = held(), capture = jest.spyOn(h.writer, "capture");
  capture.mockReturnValueOnce(first.promise).mockResolvedValue(h.owner);
  const a = h.custom.upsert(userId, definition({ name: "First" })), b = h.custom.upsert(userId, definition({ name: "Second" }));
  await turn(); expect(capture).toHaveBeenCalledTimes(2); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
  expect(h.writer.pending.size).toBe(2); first.resolve(h.owner); await Promise.all([a, b]);
  expect(h.customBuilds.updateOne.mock.calls.map(call => call[1].$set.name)).toEqual(["First", "Second"]);
  expect(h.custom._buildMutationTails.size).toBe(0); expect(h.writer.pending.size).toBe(0);
});

test("nested private data and options are copied before capture, owner before a held floor", async () => {
  const h = harness(), floor = held(), entered = held(), id = new ObjectId(h.owner.id), epoch = h.owner.epoch;
  statsReadFloorFor.mockReturnValue(() => { entered.resolve(); return floor.promise; });
  jest.spyOn(h.writer, "capture").mockResolvedValue(h.owner);
  const build = definition({ notes: "Private", rules: [{ name: "Original", count: 1 }] });
  const expectedId = new ObjectId().toHexString(), options = { expectedRevision: 0, expectedId, recordHistory: true };
  const task = h.custom.upsert(userId, build, options); build.rules[0].name = "Rebound"; build.notes = "Changed";
  options.expectedRevision = 99; options.expectedId = new ObjectId().toHexString(); options.recordHistory = false;
  await entered.promise; h.owner.id.id.fill(0); h.owner.userId = "replacement"; h.owner.epoch = uuid();
  floor.resolve(new Timestamp({ t: 12, i: 1 })); await task;
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ userId, _id: id, gameStatsMutationEpoch: epoch });
  const [filter, update] = h.customBuilds.updateOne.mock.calls[0];
  expect(filter).toMatchObject({ userId, _id: new ObjectId(expectedId), $or: [{ definitionRevision: 0 }, { definitionRevision: { $exists: false } }] });
  expect(update.$set).toMatchObject({ notes: "Private", rules: [{ name: "Original", count: 1 }] }); expect(update.$push).toBeDefined();
});

test("busy rejection adds no extra FIFO tail, capture or second admission", async () => {
  const h = harness(), prior = held(), blocker = h.custom._withUserBuildMutation(userId, () => prior.promise);
  const capture = jest.spyOn(h.writer, "capture"), tasks = Array.from({ length: MAX_ACTIVE }, (_, index) => h.custom.upsert(userId, definition({ name: String(index) })));
  const tail = h.custom._buildMutationTails.get(userId); await expect(h.custom.upsert(userId, definition())).rejects.toThrow("game_stats_writer_busy");
  expect(h.custom._buildMutationTails.get(userId)).toBe(tail); expect(capture).toHaveBeenCalledTimes(MAX_ACTIVE);
  expect(h.writer.pending.size).toBe(MAX_ACTIVE); prior.resolve(); await blocker; await Promise.all(tasks);
  expect(h.writer.pending.size).toBe(0); expect(h.custom._buildMutationTails.size).toBe(0);
});

test("pending and drain own a held actual UserRevision finish after Mongo work settles", async () => {
  const h = harness(), finish = held(), entered = held(), update = h.users.findOneAndUpdate;
  h.custom.userRevision = new UserRevision(h.users, { enabled: true });
  update.mockImplementation(async (_filter, mutation) => {
    if (mutation.$inc) { entered.resolve(); await finish.promise; return { dataRev: 1 }; }
    return h.before;
  });
  const task = h.custom.upsert(userId, definition()); await entered.promise;
  expect(h.customBuilds.updateOne).toHaveBeenCalledTimes(1); expect(h.session.endSession).toHaveBeenCalledTimes(1);
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(drained).toBe(false); expect(h.writer.pending.size).toBe(1); expect(h.custom._buildMutationTails.size).toBe(1);
  finish.resolve(); await task; await drain; expect(drained).toBe(true); expect(h.writer.pending.size).toBe(0);
});

test("JOIN includes a held queued-task finally before the unchanged FIFO releases", async () => {
  const h = harness(), entered = held(), release = held(), original = h.custom._withUserBuildMutation.bind(h.custom);
  jest.spyOn(h.custom, "_withUserBuildMutation").mockImplementation((id, task) => original(id, async () => {
    try { return await task(); } finally { entered.resolve(); await release.promise; }
  }));
  const task = h.custom.upsert(userId, definition()); await entered.promise;
  expect(h.customBuilds.updateOne).toHaveBeenCalledTimes(1); expect(h.writer.pending.size).toBe(1);
  expect(h.custom._buildMutationTails.size).toBe(1);
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(drained).toBe(false); release.resolve(); await task; await drain;
  expect(h.writer.pending.size).toBe(0); expect(h.custom._buildMutationTails.size).toBe(0);
});

test("session disposal remains charged and precedes known-success notifications", async () => {
  const h = harness(), entered = held(), release = held(), notify = jest.fn(); h.custom.onDefinitionsChanged = notify;
  h.session.endSession.mockImplementation(async () => { entered.resolve(); await release.promise; });
  const task = h.custom.upsert(userId, definition()); await entered.promise;
  expect(h.customBuilds.updateOne).toHaveBeenCalledTimes(1); expect(notify).not.toHaveBeenCalled();
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(drained).toBe(false); expect(h.writer.pending.size).toBe(1);
  release.resolve(); await task; await drain; expect(notify).toHaveBeenCalledTimes(1); expect(h.writer.pending.size).toBe(0);
});

test("shutdown waits a held capture and prevents late transaction dispatch", async () => {
  const h = harness(), captured = held(); jest.spyOn(h.writer, "capture").mockReturnValue(captured.promise);
  const task = h.custom.upsert(userId, definition()), rejected = expect(task).rejects.toThrow("game_stats_writer_stopping");
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(drained).toBe(false); expect(h.writer.pending.size).toBe(1);
  captured.resolve(h.owner); await rejected; await drain;
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
  expect(h.custom._buildMutationTails.size).toBe(0); expect(h.writer.pending.size).toBe(0);
});

test("shutdown during compatibility retirement cannot open a late legacy session or definition command", async () => {
  const h = harness(), entered = held(), release = held(); h.db.gameStatsTransactions = false;
  h.users.updateOne.mockImplementation(async () => { entered.resolve(); await release.promise; return { acknowledged: true, matchedCount: 1 }; });
  const task = h.custom.upsert(userId, definition()), rejected = expect(task).rejects.toThrow("game_stats_writer_stopping"); await entered.promise;
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(drained).toBe(false); expect(h.writer.pending.size).toBe(1);
  release.resolve(); await rejected; await drain;
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.customBuilds.findOne).not.toHaveBeenCalled();
  expect(h.customBuilds.aggregate).not.toHaveBeenCalled(); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
  expect(h.writer.pending.size).toBe(0); expect(h.custom._buildMutationTails.size).toBe(0);
});

test.each(["null-owner", "no-client"])("%s cannot select a synthetic compatibility definition path", async mode => {
  const h = harness();
  jest.spyOn(h.writer, "capture").mockResolvedValue({ ...h.owner, ...(mode === "null-owner" ? { id: null, compatibility: true } : {}) });
  if (mode === "no-client") delete h.db.client;
  await expect(h.custom.upsert(userId, definition())).rejects.toThrow("game_stats_owner_unavailable");
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled();
  expect(h.customBuilds.updateOne).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
});

test("setup throw abandons its reservation without capture or a stranded drain", async () => {
  const h = harness(), original = new Error("queue setup failed"), capture = jest.spyOn(h.writer, "capture");
  jest.spyOn(h.custom, "_withUserBuildMutation").mockImplementation(() => { throw original; });
  await expect(h.custom.upsert(userId, definition())).rejects.toBe(original); await h.writer.stopAndDrain();
  expect(capture).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
});

test.each([{ $ne: null }, { $gt: "" }, ["saved"], 42, true, null, undefined, ""].map(slug => ({ slug })))("nonstring or empty slug %p never enters an owner/game command", async ({ slug }) => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  await expect(h.custom.upsert(userId, definition({ slug }))).rejects.toThrow("slug required");
  expect(capture).not.toHaveBeenCalled(); expect(statsReadFloorFor).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled();
  expect(h.customBuilds.findOne).not.toHaveBeenCalled(); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
  expect(h.games.updateMany).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
  expect(h.custom._buildMutationTails.size).toBe(0);
});

test.each([null, { $ne: null }, { $gte: 0 }, "0", true, []].map(expectedRevision => ({ expectedRevision })))("defined nonnumber revision %p rejects before reserved work", async ({ expectedRevision }) => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  await expect(h.custom.upsert(userId, definition(), { expectedRevision })).rejects.toMatchObject({ code: "game_stats_neutral_operation_invalid", status: 503 });
  expect(capture).not.toHaveBeenCalled(); expect(statsReadFloorFor).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.customBuilds.findOne).not.toHaveBeenCalled();
  expect(h.customBuilds.updateOne).not.toHaveBeenCalled(); expect(h.games.updateMany).not.toHaveBeenCalled();
  expect(h.writer.pending.size).toBe(0); expect(h.custom._buildMutationTails.size).toBe(0);
});

test("repeated abandon retains the first terminal reason for late commit without extra work", async () => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture"), ticket = reserveCustomDefinitionSave(h.writer, userId, data());
  const first = 0, a = ticket.abandon(first), b = ticket.abandon(new Error("later terminal reason"));
  expect(b).toBe(a); await expect(a).rejects.toBe(first); await expect(ticket.commit()).rejects.toBe(first);
  expect(capture).not.toHaveBeenCalled(); expect(statsReadFloorFor).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.customBuilds.updateOne).not.toHaveBeenCalled();
  expect(h.games.updateMany).not.toHaveBeenCalled(); await h.writer.stopAndDrain(); expect(h.writer.pending.size).toBe(0);
});

test("a valid foreign capture handle cannot replace the reserved user's identity", async () => {
  const h = harness(), foreign = { userId: "foreign-owner", id: new ObjectId(), epoch: uuid(), compatibility: false };
  const capture = jest.spyOn(h.writer, "capture").mockResolvedValue(foreign);
  await expect(h.custom.upsert(userId, definition())).rejects.toMatchObject({ code: "game_stats_owner_unavailable" });
  expect(capture).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledWith(userId);
  expect(statsReadFloorFor).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled();
  expect(h.users.updateOne).not.toHaveBeenCalled(); expect(h.customBuilds.findOne).not.toHaveBeenCalled();
  expect(h.customBuilds.updateOne).not.toHaveBeenCalled(); expect(h.games.updateMany).not.toHaveBeenCalled();
  expect(h.writer.pending.size).toBe(0); expect(h.custom._buildMutationTails.size).toBe(0);
});
