// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites } = require("../src/services/gameStatsWrites");
const { immutableCustomBuildEof, assertEofNotAborted } = require("../src/services/gameStatsCustomBuildEof");
const { neutralAuthority } = require("../src/services/gameStatsCountNeutral");
const { commitReclassifyRunPipeline, removeReclassifyRunPipeline } = require("../src/services/customBuildReclassifyPipeline");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { stamped, original } = require("./helpers/corpusStamp");
const userId = "eof-owner", owner = { userId, id: new ObjectId(), epoch: uuid(), compatibility: false };
const mutation = (extra = {}) => ({ kind: "customBuildEof", mode: "all", runId: uuid(), sequence: 9, ...extra });
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const events = [], session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };
  const users = { findOneAndUpdate: jest.fn(async () => { events.push("owner"); return {}; }), updateOne: jest.fn() };
  const games = { findOne: jest.fn(async () => null), updateMany: jest.fn(async () => { events.push("eof"); return { acknowledged: true, matchedCount: 2 }; }) };
  const customBuildJobs = { updateOne: jest.fn(async () => { events.push("lease"); return { acknowledged: true, matchedCount: 1 }; }) };
  const db = { users, games, customBuildJobs, gameStatsTransactions: true, client: { startSession: jest.fn(() => session) } };
  return { ...db, db, session, events, writer: new GameStatsWrites(db) };
}
beforeEach(() => statsReadFloorFor.mockReturnValue(() => new Timestamp({ t: 12, i: 1 })));
afterEach(() => jest.restoreAllMocks());

test.each(["filter", "update", "pipeline", "upsert", "userId", "countNeutral", "leaseValid"])("rejects arbitrary %s before owner/session work", async key => {
  const h = harness(); await expect(h.writer.write(owner, mutation({ [key]: true }))).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled();
  expect(h.games.updateMany).not.toHaveBeenCalled();
});
test.each([
  { runId: [uuid()] }, { sequence: Infinity }, { sequence: -1 }, { sequence: 1.5 }, { mode: "other" },
  { lease: { generation: "g", leaseToken: "t", status: "running" } }, { lease: { generation: "", leaseToken: "t" } },
  { mode: "single", lease: { generation: "g", leaseToken: "t" } }, { repairFenceId: [uuid()] },
  { repairFenceId: uuid(), lease: { generation: "g", leaseToken: "t" } }, { mode: "single", repairFenceId: uuid() },
])("rejects malformed closed authority %p", patch => {
  expect(() => immutableCustomBuildEof(mutation(patch))).toThrow("game_stats_neutral_operation_invalid");
});
test("rejects accessors, symbols and extra options without invoking caller code", () => {
  const getter = jest.fn(), input = mutation(); Object.defineProperty(input, "lease", { get: getter });
  expect(() => immutableCustomBuildEof(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
  expect(() => immutableCustomBuildEof({ ...mutation(), [Symbol("extra")]: true })).toThrow();
  expect(() => immutableCustomBuildEof(mutation(), { fenceId: uuid() })).toThrow();
});
test("copies mutable lease data and retains only a branded native cancellation control", () => {
  const controller = new AbortController(), input = mutation({ signal: controller.signal, lease: { generation: "g", leaseToken: "t" } });
  const copied = immutableCustomBuildEof(input); input.lease.leaseToken = "replacement"; input.runId = uuid();
  expect(copied.lease).toEqual({ generation: "g", leaseToken: "t" }); expect(Object.isFrozen(copied.lease)).toBe(true);
  expect(copied.signal).toBe(controller.signal); expect(() => assertEofNotAborted(copied)).not.toThrow();
  Object.defineProperty(controller.signal, "aborted", { get: () => false }); controller.abort();
  expect(() => assertEofNotAborted(copied)).toThrow("reclassify_aborted");
  expect(() => immutableCustomBuildEof(mutation({ signal: Object.create(AbortSignal.prototype) }))).toThrow();
});
test("same-session EOF uses fixed run/user selectors, exact job authority and a whole update", async () => {
  const h = harness(), input = mutation({ lease: { generation: "g", leaseToken: "t" } });
  await h.writer.write(owner, input); expect(h.events).toEqual(["owner", "lease", "eof"]);
  expect(h.customBuildJobs.updateOne.mock.calls[0][0]).toEqual({ userId, generation: "g", leaseToken: "t", status: "running" });
  expect(h.customBuildJobs.updateOne.mock.calls[0][2]).toEqual({ session: h.session });
  expect(h.games.updateMany).toHaveBeenCalledTimes(1);
  expect(h.games.updateMany).toHaveBeenCalledWith({ userId, "_customBuildReclassify.runId": input.runId },
    stamped(commitReclassifyRunPipeline(input.runId, input.sequence)), { session: h.session, upsert: false });
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: owner.id, gameStatsMutationEpoch: owner.epoch, _gdprMutation: { $exists: false } });
  expect(h.session.withTransaction.mock.calls[0][1].writeConcern).toMatchObject({ w: "majority", j: true });
});
test.each(["signal", "lease"])("a %s lost during an added floor await cannot dispatch EOF", async state => {
  const h = harness(), floor = held(), controller = new AbortController();
  statsReadFloorFor.mockReturnValue(() => floor.promise);
  const task = h.writer.write(owner, mutation({ signal: controller.signal, lease: { generation: "g", leaseToken: "t" } }));
  if (state === "signal") controller.abort();
  else h.customBuildJobs.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 0 });
  floor.resolve(new Timestamp({ t: 12, i: 1 })); await expect(task).rejects.toThrow("reclassify_aborted");
  expect(h.games.updateMany).not.toHaveBeenCalled(); expect(h.session.endSession).toHaveBeenCalledTimes(1);
});
test("active opponent work and unacknowledged EOF never report successful publication", async () => {
  const h = harness(); h.games.findOne.mockResolvedValue({ _opponentBuildOrderWriteLease: { leaseUntil: new Date(Date.now() + 10000) } });
  await expect(h.writer.write(owner, mutation())).rejects.toThrow("opponent_build_order_write_in_progress");
  expect(h.games.updateMany).not.toHaveBeenCalled(); h.games.findOne.mockResolvedValue(null);
  h.games.updateMany.mockResolvedValue({ acknowledged: false });
  await expect(h.writer.write(owner, mutation())).rejects.toThrow("custom_build_eof_unacknowledged");
});
test("only an exact captured repair owner can select the fixed custom-build fence kind", () => {
  const id = uuid(), input = immutableCustomBuildEof(mutation({ repairFenceId: id }));
  expect(neutralAuthority({ ...owner, epoch: id }, input)).toEqual({ userId, _id: owner.id,
    gameStatsMutationEpoch: id, "_gdprMutation.id": id, "_gdprMutation.kind": "repair_custom-builds" });
  expect(() => neutralAuthority(owner, input)).toThrow("game_stats_owner_unavailable");
  expect(() => neutralAuthority({ ...owner, epoch: id, id: null }, input)).toThrow("game_stats_owner_unavailable");
});
test.each([1, 0])("standalone repair retirement matched=%s keeps its fixed kind and precedes EOF", async matchedCount => {
  const h = harness(), id = uuid(), captured = { ...owner, epoch: id, compatibility: true };
  h.db.gameStatsTransactions = false;
  h.users.updateOne.mockImplementation(async () => { h.events.push("retire"); return { acknowledged: true, matchedCount }; });
  const task = h.writer.write(captured, mutation({ repairFenceId: id }));
  if (matchedCount) await expect(task).resolves.toMatchObject({ acknowledged: true, matchedCount: 2 });
  else await expect(task).rejects.toThrow("game_stats_authority_changed");
  expect(h.users.updateOne).toHaveBeenCalledWith({ userId, _id: owner.id, gameStatsMutationEpoch: id,
    "_gdprMutation.id": id, "_gdprMutation.kind": "repair_custom-builds" }, {
    $set: { gameStatsWriterStatus: "unsupported" },
    $unset: { gameStats: "", gameStatsRevision: "", gameStatsProtocolVersion: "", gameStatsMaintenance: "" },
  }, { upsert: false });
  expect(h.events).toEqual(matchedCount ? ["retire", "eof"] : ["retire"]);
  expect(h.games.updateMany).toHaveBeenCalledTimes(matchedCount); expect(h.db.client.startSession).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled();
});
test("public factory reexports retain the single pure pipeline implementation", () => {
  const exported = require("../src/services/customBuilds");
  expect(exported.commitReclassifyRunPipeline).toBe(commitReclassifyRunPipeline);
  expect(exported.removeReclassifyRunPipeline).toBe(removeReclassifyRunPipeline);
  expect(CustomBuildsService).toBeDefined();
});
