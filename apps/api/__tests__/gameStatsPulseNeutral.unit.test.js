// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites } = require("../src/services/gameStatsWrites");
const { immutablePulseStamp, copyPulseId, MAX_ID_BYTES } = require("../src/services/gameStatsPulseNeutral");
const { MAINTENANCE_VERSION, PROTOCOL_VERSION } = require("../src/services/gameStatsMaintenance");
const { stamped, original } = require("./helpers/corpusStamp");
const revision = "11111111-2222-4333-8444-555555555555", epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const played = new Date("2026-10-20T12:00:00Z");
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const owner = { userId: "owner", id: new ObjectId(), epoch, compatibility: false }, events = [];
  const before = { _id: new ObjectId(owner.id), userId: owner.userId, gameStatsMutationEpoch: epoch,
    gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional", gameStatsRevision: revision,
    gameStats: { total: 3, latest: played },
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: new ObjectId(owner.id), epoch, revision } };
  const session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };
  const db = { gameStatsTransactions: true, client: { startSession: jest.fn(() => session) },
    users: { findOneAndUpdate: jest.fn(async () => { events.push("owner"); return before; }),
      updateOne: jest.fn(async () => { events.push("save"); return { matchedCount: 1 }; }) },
    games: { countDocuments: jest.fn(), find: jest.fn(), updateOne: jest.fn(async () => {
      events.push("game"); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }) } };
  return { owner, before, db, session, events, writer: new GameStatsWrites(db) };
}
beforeEach(() => statsReadFloorFor.mockReset().mockReturnValue(() => new Timestamp({ t: 10, i: 7 })));
afterEach(() => jest.restoreAllMocks());

test.each([
  ["mmr", 4100, { "opponent.mmr": 4100, "opponent.mmrSource": "pulse", "opponent.mmrLookupAttempted": true }],
  ["league", 4, { "opponent.leagueId": 4, "opponent.leagueLookupAttempted": true }],
  ["mmr", null, { "opponent.mmrLookupAttempted": true }],
  ["league", null, { "opponent.leagueLookupAttempted": true }],
])("%s stamp value %p carries only count/latest and owns its exact predicate", async (field, value, set) => {
  const h = harness(), id = new ObjectId();
  await h.writer.write(h.owner, { kind: "pulseGameStamp", id, field, value });
  const name = field === "mmr" ? "opponent.mmr" : "opponent.leagueId";
  const marker = field === "mmr" ? "opponent.mmrLookupAttempted" : "opponent.leagueLookupAttempted";
  expect(h.db.games.updateOne).toHaveBeenCalledWith({ userId: "owner", _id: { $eq: id },
    [name]: { $not: { $type: "number" } }, [marker]: { $ne: true } }, stamped({ $set: set }), { session: h.session, upsert: false });
  expect(h.events).toEqual(["owner", "game", "save"]);
  expect(h.db.users.updateOne.mock.calls[0][1].$set.gameStats).toEqual({ total: 3, latest: played });
  expect(h.db.users.updateOne.mock.calls[0][1].$set.gameStatsMaintenance.revision).not.toBe(revision);
  expect(h.db.games.countDocuments).not.toHaveBeenCalled(); expect(h.db.games.find).not.toHaveBeenCalled();
  expect(h.session.withTransaction.mock.calls[0][1]).toMatchObject({ readConcern: { level: "snapshot" },
    writeConcern: { w: "majority", j: true }, readPreference: "primary" });
});

test.each([
  { field: "date", value: 4100 }, { field: "mmr", value: NaN }, { field: "mmr", value: 999 },
  { field: "mmr", value: 8001 }, { field: "league", value: 7 }, { field: "league", value: 2.5 },
  { field: "mmr", value: 4100, excluded: true }, { field: "league", value: 4, userId: "other" },
])("rejects an unsupported named stamp before owner/floor/game work (%p)", async patch => {
  const h = harness();
  await expect(h.writer.write(h.owner, { kind: "pulseGameStamp", id: new ObjectId(), ...patch })).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(statsReadFloorFor).not.toHaveBeenCalled(); expect(h.db.client.startSession).not.toHaveBeenCalled();
  expect(h.db.games.updateOne).not.toHaveBeenCalled();
});

test("descriptor cannot smuggle a fence/query and BSON IDs cannot normalize or exceed the bound", () => {
  const input = { kind: "pulseGameStamp", id: new ObjectId(), field: "mmr", value: 4100 };
  expect(() => immutablePulseStamp(input, { fenceId: "foreign" })).toThrow("game_stats_neutral_operation_invalid");
  for (const id of [undefined, new Date(NaN), "x".repeat(MAX_ID_BYTES)]) expect(() => copyPulseId(id)).toThrow();
  const literal = { $gt: "not an operator" }, copied = copyPulseId(literal); literal.$gt = "changed";
  expect(copied).toEqual({ $gt: "not an operator" });
});

test("a BSON document ID is matched literally rather than interpreted as a query operator", async () => {
  const h = harness(), id = { $gt: "literal identity" };
  await h.writer.write(h.owner, { kind: "pulseGameStamp", id, field: "league", value: 4 });
  expect(h.db.games.updateOne.mock.calls[0][0]._id).toEqual({ $eq: { $gt: "literal identity" } });
});

test("owner, BSON game identity and stamp value cannot rebind during a held floor", async () => {
  const h = harness(), floor = held(); statsReadFloorFor.mockReturnValue(() => floor.promise);
  const id = new ObjectId(), originalId = id.toHexString(), ownerId = h.owner.id.toHexString();
  const input = { kind: "pulseGameStamp", id, field: "mmr", value: 4100 };
  const task = h.writer.write(h.owner, input);
  id.id.fill(0); h.owner.id.id.fill(0); h.owner.userId = "other"; h.owner.epoch = "late";
  input.field = "league"; input.value = 6;
  floor.resolve(new Timestamp({ t: 10, i: 7 })); await task;
  const authority = h.db.users.findOneAndUpdate.mock.calls[0][0], call = h.db.games.updateOne.mock.calls[0];
  expect(authority._id.toHexString()).toBe(ownerId); expect(authority.userId).toBe("owner");
  expect(authority.gameStatsMutationEpoch).toBe(epoch); expect(authority._gdprMutation).toEqual({ $exists: false });
  expect(call[0]._id.$eq.toHexString()).toBe(originalId); expect(call[0].userId).toBe("owner");
  expect(original(call[1])[0].$set["opponent.mmr"].$literal).toBe(4100); expect(original(call[1])[0].$set).not.toHaveProperty("opponent.leagueId");
  expect(h.db.users.updateOne.mock.calls[0][1].$set.gameStats).toEqual({ total: 3, latest: played });
});

test("unacknowledged stamp rejects without publishing a qualified tuple", async () => {
  const h = harness(); h.db.games.updateOne.mockResolvedValue({ acknowledged: false });
  await expect(h.writer.write(h.owner, { kind: "pulseGameStamp", id: new ObjectId(), field: "league", value: 4 }))
    .rejects.toThrow("game_stats_pulse_write_unacknowledged");
  expect(h.db.users.updateOne).not.toHaveBeenCalled(); expect(h.session.endSession).toHaveBeenCalledTimes(1);
});

test("a stopped writer owns a held floor until settlement without dispatching a Pulse stamp", async () => {
  const h = harness(), floor = held(); statsReadFloorFor.mockReturnValue(() => floor.promise);
  const task = h.writer.write(h.owner, { kind: "pulseGameStamp", id: new ObjectId(), field: "mmr", value: 4100 });
  const rejected = expect(task).rejects.toThrow("game_stats_writer_stopping");
  let stopped = false; const drain = h.writer.stopAndDrain().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(h.writer.pending.size).toBe(1);
  floor.resolve(new Timestamp({ t: 10, i: 7 })); await rejected; await drain;
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.db.games.updateOne).not.toHaveBeenCalled();
});
