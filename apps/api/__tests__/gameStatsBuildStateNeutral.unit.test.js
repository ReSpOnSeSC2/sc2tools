// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites } = require("../src/services/gameStatsWrites");
const { immutableBuildState, buildStateFilter } = require("../src/services/gameStatsBuildStateNeutral");
const { capturedNeutralOwner } = require("../src/services/gameStatsCountNeutral");
const { BuildIntentGameState } = require("../src/services/buildIntentGameState");
const { BuildIntentBind } = require("../src/services/buildIntentBind");
const { applyOverridePipeline, clearOverridePipeline, mergeIntentPipeline, applyOpponentOverridePipeline } = require("../src/services/buildIntentAttribution");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { BUILD_INTENT, COLLECTIONS } = require("../src/config/constants");
const { expectedVersion } = require("../src/db/schemaVersioning");
const played = new Date("2026-10-20T12:00:00Z"), epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const owner = { userId: "owner", id: new ObjectId(), epoch, compatibility: false };
const revision = "11111111-2222-4333-8444-555555555555";
const ref = { key: "custom:opener", name: "$literal opener", slug: "opener", source: "custom" };
const pending = () => ({ kind: "buildIntentPending", gameId: "game", pipeline: mergeIntentPipeline({ status: "pending", notes: "$not an expression" }) });
function tuple(stats = { total: 5, latest: played }) {
  return { _id: owner.id, userId: owner.userId, gameStatsMutationEpoch: epoch, gameStatsProtocolVersion: PROTOCOL_VERSION,
    gameStatsWriterStatus: "transactional", gameStatsRevision: revision, gameStats: stats,
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner.id, epoch, revision } };
}
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(before = tuple()) {
  const events = [], session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async work => work()), endSession: jest.fn(async () => {}) };
  const result = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const users = { findOne: jest.fn(async () => ({ _id: owner.id, gameStatsMutationEpoch: epoch })),
    findOneAndUpdate: jest.fn(async () => { events.push("owner"); return before; }),
    updateOne: jest.fn(async () => { events.push("save"); return { matchedCount: 1 }; }) };
  const games = { countDocuments: jest.fn(), find: jest.fn(), findOne: jest.fn(),
    updateOne: jest.fn(async () => { events.push("game"); return result; }), updateMany: jest.fn(async () => { events.push("game"); return result; }) };
  const db = { users, games, gameStatsTransactions: true, client: { startSession: jest.fn(() => session) } };
  return { db, users, games, events, session, writer: new GameStatsWrites(db) };
}
beforeEach(() => statsReadFloorFor.mockReturnValue(() => new Timestamp({ t: 10, i: 7 })));
afterEach(() => jest.restoreAllMocks());

test.each([
  { mutation: { kind: "buildIntentUpdate", gameId: "game", pipeline: [...applyOverridePipeline(ref, { notes: "$private" }), ...applyOpponentOverridePipeline(ref, {})] }, method: "updateOne",
    filter: { userId: owner.userId, gameId: "game", _deleted: { $ne: true }, _deletionPending: { $ne: true }, isResumedFromReplay: { $ne: true } } },
  { mutation: { kind: "buildIntentDismiss", gameIds: ["game", "second"], pipeline: clearOverridePipeline({ status: "skipped" }) }, method: "updateMany",
    filter: { userId: owner.userId, gameId: { $in: ["game", "second"] }, _deleted: { $ne: true }, _deletionPending: { $ne: true }, "buildIntent.status": "pending", isResumedFromReplay: { $ne: true } } },
  { mutation: pending(), method: "updateOne", filter: { userId: owner.userId, gameId: "game", buildIntent: { $exists: false } } },
  { mutation: { ...pending(), kind: "buildIntentBind", guard: "empty" }, method: "updateOne",
    filter: { userId: owner.userId, gameId: "game", "buildIntent.gameKey": { $exists: false }, buildIntent: null } },
  { mutation: { ...pending(), kind: "buildIntentBind", guard: "missingUpdatedAt" }, method: "updateOne",
    filter: { userId: owner.userId, gameId: "game", "buildIntent.gameKey": { $exists: false }, "buildIntent.updatedAt": { $exists: false } } },
  { mutation: { ...pending(), kind: "buildIntentBind", guard: "updatedAt", updatedAt: played }, method: "updateOne",
    filter: { userId: owner.userId, gameId: "game", "buildIntent.gameKey": { $exists: false }, "buildIntent.updatedAt": played } },
])("$mutation.kind owns its original filter/session and carries only atomic preimage stats", async ({ mutation, method, filter }) => {
  const h = harness(); await h.writer.write(owner, mutation);
  expect(h.events).toEqual(["owner", "game", "save"]);
  expect(h.games[method]).toHaveBeenCalledWith(filter, mutation.pipeline, { session: h.session, upsert: false });
  expect(h.users.findOneAndUpdate.mock.calls[0][2]).toMatchObject({ session: h.session, returnDocument: "before", upsert: false });
  const saved = h.users.updateOne.mock.calls[0][1].$set;
  expect(saved.gameStats).toEqual({ total: 5, latest: played }); expect(saved.gameStatsMaintenance.revision).not.toBe(revision);
  expect(h.users.updateOne.mock.calls[0][0].gameStatsRevision).toBe(saved.gameStatsMaintenance.revision);
  expect(h.games.countDocuments).not.toHaveBeenCalled(); expect(h.games.find).not.toHaveBeenCalled();
});
test.each([{ total: 0, latest: null }, { total: 5, latest: null }])("valid null tuple carries on a zero-match command (%p)", async stats => {
  const h = harness(tuple(stats)); h.games.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
  await expect(h.writer.write(owner, pending())).resolves.toEqual({ matchedCount: 0, modifiedCount: 0 });
  expect(h.users.updateOne.mock.calls[0][1].$set.gameStats).toEqual(stats);
});
test.each([row => { row.gameStatsMaintenance.version = 1; }, row => { row.gameStats.latest = "raw"; row.gameStatsMaintenance.status = "unsupported_latest"; },
  row => { row.gameStatsMaintenance.revision = "wrong"; }, row => { delete row.gameStats; }])("invalid proof retires without count/latest reads (%#)", async alter => {
  const row = tuple(); alter(row); const h = harness(row); await h.writer.write(owner, pending());
  expect(h.users.updateOne).not.toHaveBeenCalled(); expect(h.games.updateOne).toHaveBeenCalledTimes(1);
  expect(h.games.countDocuments).not.toHaveBeenCalled(); expect(h.games.find).not.toHaveBeenCalled();
});
test.each(["date", "userId", "excluded", "isResumedFromReplay", "matchFormat", "opponent", "buildIntent.status", "_deleted"])("rejects non-allowlisted path %s before admission", async path => {
  const h = harness(); await expect(h.writer.write(owner, { ...pending(), pipeline: [{ $set: { [path]: true } }] })).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.games.updateOne).not.toHaveBeenCalled();
});
test.each([
  { pipeline: [{ $replaceWith: "$other" }] }, { pipeline: [{ $unset: "date" }] },
  { pipeline: [{ $set: { buildIntent: {} }, $unset: "date" }] }, { pipeline: [{ $set: { _schemaVersion: -1 } }] },
  { pipeline: [{ $set: { myBuild: "not pending" } }] }, { filter: { userId: "other" } }, { upsert: true },
  { pipeline: [{ $set: { buildIntent: { $literal: { updatedAt: new Date(NaN) } } } }] },
])("rejects pipeline/options/normalization widening %p", async delta => {
  const h = harness(); await expect(h.writer.write(owner, { ...pending(), ...delta })).rejects.toThrow();
  expect(h.games.updateOne).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled();
});
test("dismiss preserves the exact500 bound and refuses501 or client filters", () => {
  const mutation = { kind: "buildIntentDismiss", gameIds: Array.from({ length: BUILD_INTENT.DISMISS_MAX }, (_, n) => `g${n}`), pipeline: clearOverridePipeline({ status: "skipped" }) };
  expect(buildStateFilter(owner.userId, immutableBuildState(mutation)).gameId.$in).toHaveLength(500);
  expect(() => immutableBuildState({ ...mutation, gameIds: [...mutation.gameIds, "overflow"] })).toThrow();
  expect(() => immutableBuildState(mutation, { fenceId: "widen" })).toThrow();
});
test("owner/options/pipeline/date are copied before a held floor and bind cannot gain a fence", async () => {
  const h = harness(), floor = held(), local = { ...owner, id: new ObjectId(owner.id.toHexString()) }, options = {};
  statsReadFloorFor.mockReturnValue(() => floor.promise);
  const mutation = { ...pending(), kind: "buildIntentBind", guard: "updatedAt", updatedAt: new Date(played) };
  const task = h.writer.write(local, mutation, options);
  local.userId = "other"; local.id.id.fill(0); local.epoch = revision; options.fenceId = "late";
  mutation.updatedAt.setTime(0); mutation.pipeline[0].$set.buildIntent.$mergeObjects[1].$literal.notes = "late";
  floor.resolve(new Timestamp({ t: 10, i: 7 })); await task;
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toEqual({ userId: owner.userId, _id: owner.id, gameStatsMutationEpoch: epoch, _gdprMutation: { $exists: false } });
  expect(h.games.updateOne.mock.calls[0][0]["buildIntent.updatedAt"]).toEqual(played);
  expect(h.games.updateOne.mock.calls[0][1][0].$set.buildIntent.$mergeObjects[1].$literal.notes).toBe("$not an expression");
});
test("supplied cross-owner handle rejects before any owner read; supplied retired handle never recaptures", async () => {
  const h = harness(); await expect(capturedNeutralOwner(h.writer, "other", owner)).rejects.toThrow("game_stats_owner_unavailable");
  expect(h.users.findOne).not.toHaveBeenCalled();
  expect(await capturedNeutralOwner(h.writer, owner.userId, owner)).toEqual(owner); expect(h.users.findOne).not.toHaveBeenCalled();
});

function serviceHarness() {
  const h = harness(), notifier = { changed: jest.fn(), gamesChanged: jest.fn() };
  const options = { invalidate: jest.fn(), forMatchup: jest.fn(async () => null), forOpponent: jest.fn(async () => null) };
  const row = { userId: owner.userId, gameId: "game", date: played, myRace: "Protoss", opponent: { race: "Zerg" }, durationSec: 600, matchFormat: "1v1" };
  const deps = { db: h.db, options, notifier, now: () => played.getTime() };
  return { ...h, row, notifier, options, state: new BuildIntentGameState(deps), binder: new BuildIntentBind(deps) };
}
test("PUT captures once before reads and preserves literal two-axis attribution and post-write notifications", async () => {
  const h = serviceHarness(); h.games.findOne.mockResolvedValue(h.row);
  h.state._resolveConfirmKey = jest.fn(async () => ref); h.state._resolveOpponentKey = jest.fn(async () => ref);
  h.state.serialize = jest.fn(async (_user, row) => row);
  const hold = held(); h.users.findOne.mockReturnValueOnce(hold.promise);
  const body = { action: "confirm", buildKey: ref.key, notes: "$private", opponentBuildKey: ref.key };
  const task = h.state.put(owner.userId, "game", body, { source: "clerk" }); body.notes = "late"; body.buildKey = "late";
  expect(h.games.findOne).not.toHaveBeenCalled(); hold.resolve({ _id: owner.id, gameStatsMutationEpoch: epoch }); await task;
  const pipeline = h.games.updateOne.mock.calls[0][1];
  expect(pipeline).toHaveLength(3); expect(pipeline[1].$set.myBuild).toEqual({ $literal: ref.name });
  expect(pipeline[1].$set.buildIntent.$mergeObjects[1].$literal.notes).toBe("$private");
  expect(pipeline[2].$set["opponent.strategy"]).toEqual({ $literal: ref.name });
  expect(h.notifier.changed).toHaveBeenCalledWith(owner.userId, { gameId: "game" });
  expect(h.options.invalidate).toHaveBeenCalledWith(owner.userId);
});
test("bind retries exact optimistic guard under one supplied owner and never repeats capture", async () => {
  const h = serviceHarness(), now = new Date(played), row = { ...h.row, buildIntent: { updatedAt: now } };
  h.users.findOne.mockResolvedValue({ preferences: { buildCheckin: { enabled: true } } });
  h.binder._plan = jest.fn(async () => ({ pipeline: mergeIntentPipeline({ gameKey: "live" }), status: "confirmed" }));
  h.games.findOne.mockResolvedValue({ ...row, buildIntent: { updatedAt: new Date(played.getTime() + 1) } });
  h.games.updateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 });
  await expect(h.binder._bindClaimed(owner.userId, h.row, row, { gameKey: "live" }, owner)).resolves.toEqual({ bound: true, status: "confirmed" });
  expect(h.binder._plan).toHaveBeenCalledTimes(2); expect(h.users.findOne).toHaveBeenCalledTimes(1);
  expect(h.users.findOne.mock.calls[0][1].projection).not.toHaveProperty("gameStatsMutationEpoch");
  expect(h.games.updateOne.mock.calls.map(call => call[0]["buildIntent.updatedAt"])).toEqual([now, new Date(now.getTime() + 1)]);
  expect(h.users.findOneAndUpdate.mock.calls.map(call => call[0].gameStatsMutationEpoch)).toEqual([epoch, epoch]);
});
test("bind candidate selection uses its initial opponent snapshot after a held owner read", async () => {
  const h = serviceHarness(), hold = held(), game = { ...h.row, opponent: { race: "Zerg", displayName: "Original" } };
  const candidate = { _id: "live", gameKey: "live", oppName: "Original", keyStartedAtMs: played.getTime() - 620000,
    loadingSeen: true, postgame: { skip: true } };
  h.users.findOne.mockReturnValueOnce(hold.promise); h.games.findOne.mockResolvedValue(h.row);
  h.binder.live = { find: jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [candidate] }) }) })),
    findOneAndUpdate: jest.fn(async () => ({ ...candidate, gameId: "game" })) };
  h.binder._bindClaimed = jest.fn(async () => ({ bound: true, status: "skipped" }));
  const task = h.binder.bindIngestedGame(owner.userId, game, { created: false });
  game.opponent.displayName = "Mutated"; game.gameId = "other";
  hold.resolve({ _id: owner.id, gameStatsMutationEpoch: epoch });
  await expect(task).resolves.toEqual({ bound: true, status: "skipped" });
  expect(h.binder.live.findOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(h.binder._bindClaimed.mock.calls[0][1]).toMatchObject({ gameId: "game", opponent: { displayName: "Original" } });
  expect(h.binder._bindClaimed.mock.calls[0][4]).toMatchObject({ userId: owner.userId, epoch });
});
test("unknown write error propagates and pending does not publish success or fabricate a missing game", async () => {
  const h = serviceHarness(), error = new Error("unknown write ACK"); h.binder._suggest = jest.fn(async () => null);
  h.users.findOne.mockResolvedValue({ preferences: { buildCheckin: { enabled: true } } });
  h.games.updateOne.mockRejectedValue(error);
  await expect(h.binder._markPending(owner.userId, h.row, h.row, owner)).rejects.toBe(error);
  expect(h.notifier.changed).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled();
  h.games.updateOne.mockResolvedValue({ matchedCount: 0 });
  expect(await h.binder._markPending(owner.userId, h.row, h.row, owner)).toBeNull(); expect(h.notifier.changed).not.toHaveBeenCalled();
});
test("server schema value and all original literal expressions survive BSON snapshot", () => {
  const pipeline = applyOverridePipeline(ref, { notes: "$hello", updatedAt: played });
  expect(immutableBuildState({ kind: "buildIntentUpdate", gameId: "game", pipeline }).pipeline).toEqual(pipeline);
  expect(pipeline[0].$set._schemaVersion).toBe(expectedVersion(COLLECTIONS.GAMES));
});
