// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites } = require("../src/services/gameStatsWrites");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { immutableMacroSurface } = require("../src/services/gameStatsCountNeutral");
const { MAINTENANCE_VERSION, PROTOCOL_VERSION } = require("../src/services/gameStatsMaintenance");
const { expectedVersion } = require("../src/db/schemaVersioning");
const { COLLECTIONS } = require("../src/config/constants");
const revision = "11111111-2222-4333-8444-555555555555", epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const played = new Date("2026-10-20T12:00:00Z");
const owner = { userId: "owner", id: new ObjectId(), epoch, compatibility: false };
const mutation = () => ({ kind: "macroSurface", gameId: "game", macroScore: 74, top3Leaks: [{ name: "idle", amount: 2 }] });
function tuple() {
  return { _id: owner.id, userId: owner.userId, gameStatsMutationEpoch: epoch,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional", gameStatsRevision: revision,
    gameStats: { total: 5, latest: played },
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner.id, epoch, revision } };
}
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(before = tuple()) {
  const events = [];
  const session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };
  const users = { findOne: jest.fn(async () => ({ _id: owner.id, gameStatsMutationEpoch: epoch })),
    findOneAndUpdate: jest.fn(async () => { events.push("owner"); return before; }),
    updateOne: jest.fn(async () => { events.push("save"); return { matchedCount: 1 }; }) };
  const games = { countDocuments: jest.fn(), find: jest.fn(), findOne: jest.fn(async () => ({ date: played })),
    updateOne: jest.fn(async () => { events.push("game"); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; }) };
  const db = { users, games, gameStatsTransactions: true, client: { startSession: jest.fn(() => session) } };
  return { db, users, games, session, events, writer: new GameStatsWrites(db) };
}
beforeEach(() => statsReadFloorFor.mockImplementation(() => () => new Timestamp({ t: 10, i: 7 })));
afterEach(() => jest.restoreAllMocks());

test("named macro operation carries only atomic preimage stats under its new UUID and same transaction", async () => {
  const h = harness();
  await expect(h.writer.write(owner, mutation())).resolves.toMatchObject({ modifiedCount: 1 });
  expect(h.events).toEqual(["owner", "game", "save"]);
  expect(h.users.findOne).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toEqual({ userId: owner.userId, _id: owner.id,
    gameStatsMutationEpoch: epoch, _gdprMutation: { $exists: false } });
  expect(h.users.findOneAndUpdate.mock.calls[0][2]).toMatchObject({ session: h.session, upsert: false,
    returnDocument: "before", projection: { userId: 1, _gdprMutation: 1 } });
  const saved = h.users.updateOne.mock.calls[0][1].$set;
  expect(saved.gameStats).toEqual({ total: 5, latest: played });
  expect(saved.gameStats.latest).not.toBe(played);
  expect(saved.gameStatsMaintenance).toMatchObject({ version: MAINTENANCE_VERSION, status: "ready", ownerId: owner.id, epoch });
  expect(saved.gameStatsMaintenance.revision).not.toBe(revision);
  expect(h.users.updateOne.mock.calls[0][0].gameStatsRevision).toBe(saved.gameStatsMaintenance.revision);
  expect(h.users.updateOne.mock.calls[0][2]).toEqual({ session: h.session, upsert: false });
  expect(h.games.updateOne).toHaveBeenCalledWith({ userId: owner.userId, gameId: "game", _deleted: { $ne: true }, _deletionPending: { $ne: true } },
    { $set: { macroScore: 74, top3Leaks: [{ name: "idle", amount: 2 }], _schemaVersion: expectedVersion(COLLECTIONS.GAMES) }, $unset: { macroBreakdown: "" } },
    { session: h.session, upsert: false });
  expect(h.games.countDocuments).not.toHaveBeenCalled(); expect(h.games.find).not.toHaveBeenCalled();
  expect(h.session.advanceOperationTime).toHaveBeenCalledWith(new Timestamp({ t: 10, i: 7 }));
  expect(h.session.withTransaction.mock.calls[0][1]).toMatchObject({ readConcern: { level: "snapshot" }, readPreference: "primary",
    writeConcern: { w: "majority", j: true, wtimeoutMS: 5000 }, timeoutMS: 10000, maxCommitTimeMS: 5000 });
});

test.each([{ total: 0, latest: null }, { total: 5, latest: null }])("valid null latest is carried exactly (%p)", async stats => {
  const row = tuple(); row.gameStats = stats; const h = harness(row);
  await h.writer.write(owner, mutation()); expect(h.users.updateOne.mock.calls[0][1].$set.gameStats).toEqual(stats);
});

test.each([
  row => { row.gameStatsProtocolVersion = 1; }, row => { row.gameStatsMaintenance.version = 1; },
  row => { delete row.gameStats; }, row => { row.gameStats.latest = "legacy"; row.gameStatsMaintenance.status = "unsupported_latest"; },
  row => { row.gameStats.latest = new Date(NaN); }, row => { row.gameStats.latest = false; },
  row => { row.gameStats.total = 0; }, row => { row.gameStats.total = Number.MAX_SAFE_INTEGER + 1; },
  row => { row.gameStatsMaintenance.ownerId = new ObjectId(); }, row => { row.gameStatsMaintenance.epoch = null; },
  row => { row.gameStatsMaintenance.revision = "different"; }, row => { row._gdprMutation = null; },
  row => { row.gameStats.extra = "x".repeat(17000); },
])("invalid proof retires without recount or latest normalization (%#)", async alter => {
  const row = tuple(); alter(row); const h = harness(row);
  await h.writer.write(owner, mutation());
  expect(h.users.findOneAndUpdate.mock.calls[0][1].$unset).toEqual({ gameStats: "", gameStatsMaintenance: "" });
  expect(h.users.updateOne).not.toHaveBeenCalled(); expect(h.games.updateOne).toHaveBeenCalledTimes(1);
  expect(h.games.countDocuments).not.toHaveBeenCalled(); expect(h.games.find).not.toHaveBeenCalled();
});

test.each(["date", "excluded", "userId", "upsert", "filter", "update", "_schemaVersion"])("descriptor rejects extra %s before dispatch", async key => {
  const h = harness(); await expect(h.writer.write(owner, { ...mutation(), [key]: true })).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.games.updateOne).not.toHaveBeenCalled();
});
test.each([{ fenceId: "not-a-macro-fence" }, { selection: { ids: [] } }, { countNeutral: true }])("named operation refuses authority/options widening %p", async options => {
  const h = harness(); await expect(h.writer.write(owner, mutation(), options)).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(h.games.updateOne).not.toHaveBeenCalled();
});
test("an arbitrary callback cannot claim neutrality with an option", async () => {
  const h = harness(), work = jest.fn();
  await expect(h.writer.write(owner, work, { countNeutral: true })).rejects.toThrow("game_stats_selection_required");
  expect(work).not.toHaveBeenCalled();
});
test("a decoded owner id which BSON would normalize cannot select another owner", async () => {
  const h = harness();
  await expect(h.writer.write({ ...owner, id: new Date(NaN) }, mutation())).rejects.toThrow("game_stats_owner_unavailable");
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.games.updateOne).not.toHaveBeenCalled();
  expect(h.db.client.startSession).not.toHaveBeenCalled();
});

test("named operation snapshots nested data before a held floor", async () => {
  const h = harness(), floor = held(); statsReadFloorFor.mockReturnValue(() => floor.promise);
  const input = mutation(), task = h.writer.write(owner, input);
  input.top3Leaks[0].amount = 999; input.top3Leaks.push({ name: "late", amount: 9 });
  expect(h.writer.pending.size).toBe(1); floor.resolve(new Timestamp({ t: 10, i: 7 })); await task;
  expect(h.games.updateOne.mock.calls[0][1].$set.top3Leaks).toEqual([{ name: "idle", amount: 2 }]);
});
test("named operation cannot rebind owner or add a fence during a held floor", async () => {
  const captured = { ...owner, id: new ObjectId() }, row = tuple(); row._id = new ObjectId(captured.id); row.gameStatsMaintenance.ownerId = new ObjectId(captured.id);
  const originalId = captured.id.toHexString(), h = harness(row), floor = held(), options = {};
  statsReadFloorFor.mockReturnValue(() => floor.promise);
  const task = h.writer.write(captured, mutation(), options);
  captured.userId = "different-owner"; captured.id.id.fill(0); captured.epoch = "different-epoch"; options.fenceId = "late-fence";
  floor.resolve(new Timestamp({ t: 10, i: 7 })); await task;
  const authority = h.users.findOneAndUpdate.mock.calls[0][0];
  expect(authority.userId).toBe(owner.userId); expect(authority._id.toHexString()).toBe(originalId);
  expect(authority.gameStatsMutationEpoch).toBe(epoch); expect(authority._gdprMutation).toEqual({ $exists: false });
  expect(authority).not.toHaveProperty("_gdprMutation.id"); expect(h.games.updateOne.mock.calls[0][0].userId).toBe(owner.userId);
  expect(h.users.updateOne.mock.calls[0][1].$set.gameStats).toEqual({ total: 5, latest: played });
});
test("stop owns a held macro floor until actual settlement, then dispatches no transaction", async () => {
  const h = harness(), floor = held(); statsReadFloorFor.mockReturnValue(() => floor.promise);
  const task = h.writer.write(owner, mutation()), rejected = expect(task).rejects.toThrow("game_stats_writer_stopping");
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(h.writer.pending.size).toBe(1);
  floor.resolve(new Timestamp({ t: 10, i: 7 })); await rejected; await drain;
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.games.updateOne).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
});
test("unknown initial owner ACK and failed game work never publish a tuple", async () => {
  const h = harness(), original = new Error("unknown owner outcome"); h.users.findOneAndUpdate.mockRejectedValue(original);
  await expect(h.writer.write(owner, mutation())).rejects.toBe(original); expect(h.games.updateOne).not.toHaveBeenCalled();
  h.users.findOneAndUpdate.mockResolvedValue(tuple()); h.games.updateOne.mockRejectedValue(original);
  await expect(h.writer.write(owner, mutation())).rejects.toBe(original); expect(h.users.updateOne).not.toHaveBeenCalled();
});
test("a no-op macro game update still preserves the unchanged count proof", async () => {
  const h = harness(); h.games.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
  expect(await h.writer.write(owner, mutation())).toMatchObject({ matchedCount: 0 });
  expect(h.users.updateOne.mock.calls[0][1].$set.gameStats).toEqual({ total: 5, latest: played });
});

test("PerGame copies macro payload before held owner read and keeps details after committed slim work", async () => {
  const h = harness(), capture = held(); h.users.findOne.mockReturnValue(capture.promise);
  const upsert = jest.fn(async () => { h.events.push("details"); });
  const service = new PerGameComputeService(h.db, { gameDetails: { upsert } });
  const payload = { macroScore: 74, top3Leaks: [{ name: "idle", amount: 2 }], breakdown: { raw: {} }, date: "ignored" };
  const task = service.writeMacroBreakdown(owner.userId, "game", payload);
  payload.top3Leaks[0].amount = 999; payload.top3Leaks.push({ name: "late", amount: 9 });
  expect(h.games.updateOne).not.toHaveBeenCalled(); capture.resolve({ _id: owner.id, gameStatsMutationEpoch: epoch }); await task;
  expect(h.games.updateOne.mock.calls[0][1].$set.top3Leaks).toEqual([{ name: "idle", amount: 2 }]);
  expect(h.events).toEqual(["owner", "game", "save", "details"]);
  expect(upsert).toHaveBeenCalledTimes(1); expect(upsert).toHaveBeenCalledWith(owner.userId, "game", played, { macroBreakdown: payload.breakdown });
  expect(h.games.findOne).toHaveBeenCalledWith({ userId: owner.userId, gameId: "game", _deleted: { $ne: true }, _deletionPending: { $ne: true } }, { projection: { _id: 0, date: 1 } });
});
test("the named patch retains the existing numeric scalar behavior", () => {
  expect(Number.isNaN(immutableMacroSurface({ ...mutation(), macroScore: NaN }).macroScore)).toBe(true);
  expect(immutableMacroSurface({ ...mutation(), macroScore: Infinity }).macroScore).toBe(Infinity);
});
test("standalone named macro work retires authority and never mints a tuple or session", async () => {
  const h = harness(); h.db.gameStatsTransactions = false;
  await h.writer.write({ ...owner, compatibility: true }, mutation());
  expect(h.users.updateOne.mock.calls[0][1]).toEqual({ $set: { gameStatsWriterStatus: "unsupported" },
    $unset: { gameStats: "", gameStatsRevision: "", gameStatsProtocolVersion: "", gameStatsMaintenance: "" } });
  expect(h.games.updateOne.mock.calls[0][2]).toEqual({ upsert: false }); expect(h.db.client.startSession).not.toHaveBeenCalled();
  expect(h.games.countDocuments).not.toHaveBeenCalled(); expect(h.games.find).not.toHaveBeenCalled();
});
test("unsupported production macro write fails before owner lookup or game work", async () => {
  const h = harness(), environment = process.env.NODE_ENV; h.db.gameStatsTransactions = false;
  try {
    process.env.NODE_ENV = "production";
    const service = new PerGameComputeService(h.db);
    await expect(service.writeMacroBreakdown(owner.userId, "game", { macroScore: 74, breakdown: {} })).rejects.toThrow("game_stats_transactions_required");
    expect(h.users.findOne).not.toHaveBeenCalled(); expect(h.games.updateOne).not.toHaveBeenCalled(); expect(h.db.client.startSession).not.toHaveBeenCalled();
  } finally { process.env.NODE_ENV = environment; }
});
