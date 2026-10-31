// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites, MAX_ACTIVE, writeOpponentGameIdentityRepair } = require("../src/services/gameStatsWrites");
const { issueOpponentIdentityRepair } = require("../src/services/gameStatsOpponentGame");
const { takeRepairLivenessIssuer } = require("../src/services/gdprRepairLiveness");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../src/services/gameStatsMaintenance");
const { stamped, original } = require("./helpers/corpusStamp");

const userId = "opponent-writes-owner", played = new Date("2026-10-20T12:00:00Z");
const region = () => ({ kind: "opponentGameRegion", gameId: "g1", region: "EU" });
const identity = () => ({ kind: "opponentGameIdentity", pulseId: "p1", region: "EU", pulseCharacterId: "77" });
const RETIRE = { $set: { gameStatsWriterStatus: "unsupported" },
  $unset: { gameStats: "", gameStatsRevision: "", gameStatsProtocolVersion: "", gameStatsMaintenance: "" } };
const gameCommands = h => h.games.updateOne.mock.calls.length + h.games.updateMany.mock.calls.length;
// Negative checks only: one macrotask turn lets every settled continuation run before asserting it did not.
const turn = () => new Promise(resolve => setImmediate(resolve));
let issuer, floor;
function held() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeAll(() => { issuer = takeRepairLivenessIssuer(); });
beforeEach(() => {
  floor = jest.fn(() => new Timestamp({ t: 12, i: 1 }));
  statsReadFloorFor.mockReset(); statsReadFloorFor.mockReturnValue(floor);
});
afterEach(() => jest.restoreAllMocks());

function readyRow(owner, extra = {}) {
  const revision = uuid();
  return { _id: owner.id, userId, gameStatsMutationEpoch: owner.epoch, gameStats: { total: 3, latest: played },
    gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsWriterStatus: "transactional",
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready", ownerId: owner.id, epoch: owner.epoch, revision }, ...extra };
}
function harness({ compatibility = false, preimage = readyRow } = {}) {
  const owner = Object.freeze({ userId, id: new ObjectId(), epoch: uuid(), compatibility }), events = [];
  const result = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };
  const users = { findOneAndUpdate: jest.fn(async () => { events.push("claim"); return preimage(owner); }),
    updateOne: jest.fn(async () => { events.push("users.updateOne"); return { acknowledged: true, matchedCount: 1 }; }) };
  const games = { updateOne: jest.fn(async () => { events.push("games.updateOne"); return result; }),
    updateMany: jest.fn(async () => { events.push("games.updateMany"); return result; }),
    countDocuments: jest.fn(), find: jest.fn(), aggregate: jest.fn() };
  const db = { users, games, gameStatsTransactions: !compatibility, client: { startSession: jest.fn(() => session) } };
  return { owner, events, session, users, games, db, writer: new GameStatsWrites(db, { warn: jest.fn() }) };
}
function repair(h, kind = "repair_opponents") {
  const fenceId = uuid(), owner = Object.freeze({ ...h.owner, epoch: fenceId });
  const handle = issuer.issue({ ...h.owner, epoch: uuid() }, fenceId, kind);
  return { fenceId, kind, owner, handle, context: Object.freeze({ owner, fenceId, kind, handle }) };
}
const ordinary = owner => ({ userId, _id: owner.id, gameStatsMutationEpoch: owner.epoch, _gdprMutation: { $exists: false } });
const fenced = r => ({ userId, _id: r.owner.id, gameStatsMutationEpoch: r.fenceId, "_gdprMutation.id": r.fenceId, "_gdprMutation.kind": r.kind });

test.each([["region", region, "updateOne"], ["identity", identity, "updateMany"]])("transactional %s claims the owner first and carries a strict-ready proof", async (_name, input, method) => {
  const h = harness();
  await expect(h.writer.write(h.owner, input())).resolves.toMatchObject({ matchedCount: 1 });
  const [claimFilter, claimUpdate, claimOptions] = h.users.findOneAndUpdate.mock.calls[0];
  expect(claimFilter).toEqual(ordinary(h.owner)); expect(claimOptions).toMatchObject({ session: h.session, upsert: false, returnDocument: "before" });
  expect(h.events).toEqual(["claim", `games.${method}`, "users.updateOne"]);
  expect(h.games[method].mock.calls[0][2]).toEqual({ session: h.session, upsert: false });
  const [saveFilter, saveUpdate] = h.users.updateOne.mock.calls[0], revision = claimUpdate.$set.gameStatsRevision;
  expect(saveFilter).toMatchObject({ ...ordinary(h.owner), gameStatsRevision: revision });
  expect(saveUpdate.$set.gameStats).toEqual({ total: 3, latest: played });
  expect(saveUpdate.$set.gameStatsMaintenance).toMatchObject({ status: "ready", revision, ownerId: h.owner.id, epoch: h.owner.epoch });
  for (const read of [h.games.countDocuments, h.games.find, h.games.aggregate]) expect(read).not.toHaveBeenCalled();
});

test.each([["maintenance1", { "gameStatsMaintenance.version": 1 }], ["fenced", { _gdprMutation: { id: uuid() } }],
  ["total 1.5", { gameStats: { total: 1.5, latest: played } }]])("a %s preimage leaves the proof retired without a recount", async (_name, change) => {
  const h = harness({ preimage: owner => {
    const row = readyRow(owner);
    if (change["gameStatsMaintenance.version"]) row.gameStatsMaintenance.version = 1; else Object.assign(row, change);
    return row;
  } });
  await h.writer.write(h.owner, identity());
  expect(h.games.updateMany).toHaveBeenCalledTimes(1); expect(h.users.updateOne).not.toHaveBeenCalled();
  for (const read of [h.games.countDocuments, h.games.find, h.games.aggregate]) expect(read).not.toHaveBeenCalled();
});

test("write() rejects the new kinds when stopping or busy before any floor or claim", async () => {
  const busy = harness();
  for (let i = 0; i < MAX_ACTIVE; i += 1) busy.writer.pending.add(new Promise(() => {}));
  await expect(busy.writer.write(busy.owner, region())).rejects.toMatchObject({ code: "game_stats_writer_busy" });
  const stopped = harness(); await stopped.writer.stopAndDrain();
  await expect(stopped.writer.write(stopped.owner, identity())).rejects.toMatchObject({ code: "game_stats_writer_stopping" });
  expect(floor).not.toHaveBeenCalled(); expect(busy.writer.pending.size).toBe(MAX_ACTIVE);
  for (const h of [busy, stopped]) { expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(gameCommands(h)).toBe(0); }
});

test.each([[{ acknowledged: false, matchedCount: 1 }], [{ acknowledged: true, matchedCount: 0 }]])("compat retirement %p vetoes only the new kinds", async retired => {
  for (const input of [region, identity]) {
    const h = harness({ compatibility: true }); h.users.updateOne.mockResolvedValue(retired);
    await expect(h.writer.write(h.owner, input())).rejects.toMatchObject({ code: "game_stats_authority_changed" });
    expect(h.users.updateOne.mock.calls[0]).toEqual([ordinary(h.owner), RETIRE, { upsert: false }]); expect(gameCommands(h)).toBe(0);
  }
  const legacy = harness({ compatibility: true }), callback = jest.fn(async () => 7); legacy.users.updateOne.mockResolvedValue(retired);
  const write = legacy.writer.write(legacy.owner, callback);
  if (retired.matchedCount === 1) { await expect(write).resolves.toBe(7); expect(callback).toHaveBeenCalledWith(undefined); }
  else { await expect(write).rejects.toMatchObject({ code: "game_stats_authority_changed" }); expect(callback).not.toHaveBeenCalled(); }
  const pulse = harness({ compatibility: true }); pulse.users.updateOne.mockResolvedValue(retired);
  const stamp = pulse.writer.write(pulse.owner, { kind: "pulseGameStamp", id: new ObjectId(), field: "mmr", value: 4000 });
  if (retired.matchedCount === 1) { await stamp; expect(pulse.games.updateOne).toHaveBeenCalledTimes(1); }
  else await expect(stamp).rejects.toMatchObject({ code: "game_stats_authority_changed" });
});

test("a held compat retirement keeps its slot through stop; the new kinds then refuse dispatch", async () => {
  for (const input of [region, identity]) {
    const h = harness({ compatibility: true }), retirement = held(); h.users.updateOne.mockReturnValueOnce(retirement.promise);
    const write = h.writer.write(h.owner, input()); let drained = false;
    const drain = h.writer.stopAndDrain().then(() => { drained = true; });
    await turn(); expect(h.writer.pending.size).toBe(1); expect(drained).toBe(false);
    retirement.resolve({ acknowledged: true, matchedCount: 1 });
    await expect(write).rejects.toMatchObject({ code: "game_stats_writer_stopping" }); await drain;
    expect(gameCommands(h)).toBe(0); expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
  }
  const legacy = harness({ compatibility: true }), retirement = held(), callback = jest.fn(async () => "legacy");
  legacy.users.updateOne.mockReturnValueOnce(retirement.promise);
  const write = legacy.writer.write(legacy.owner, callback), drain = legacy.writer.stopAndDrain();
  retirement.resolve({ acknowledged: true, matchedCount: 1 });
  await expect(write).resolves.toBe("legacy"); await drain; expect(callback).toHaveBeenCalledTimes(1);
});

test("the test-only null-id owner skips retirement for ordinary kinds and is refused for repair", async () => {
  const h = harness({ compatibility: true }), owner = { userId, id: null, compatibility: true };
  await h.writer.write(owner, region()); await h.writer.write(owner, identity());
  expect(h.users.updateOne).not.toHaveBeenCalled();
  expect(h.games.updateOne.mock.calls[0][2]).toEqual({ upsert: false }); expect(h.games.updateMany.mock.calls[0][2]).toEqual({ upsert: false });
  const r = repair(h), context = Object.freeze({ ...r.context, owner: { userId, id: null, epoch: r.fenceId, compatibility: true } });
  await expect(writeOpponentGameIdentityRepair(h.writer, context, identity())).rejects.toMatchObject({ status: 503 });
  expect(floor).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled(); expect(h.games.updateMany).toHaveBeenCalledTimes(1);
});

test("the repair capability owns one pending slot until settlement and stopAndDrain awaits it", async () => {
  const h = harness(), r = repair(h), claim = held();
  h.users.findOneAndUpdate.mockImplementationOnce(async () => { h.events.push("claim"); return claim.promise; });
  const task = writeOpponentGameIdentityRepair(h.writer, r.context, identity());
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(h.writer.pending.size).toBe(1); expect(drained).toBe(false);
  claim.resolve(readyRow(r.owner, { _gdprMutation: { id: r.fenceId, kind: r.kind } }));
  await expect(task).resolves.toMatchObject({ matchedCount: 1 }); await drain;
  expect(h.writer.pending.size).toBe(0); expect(h.games.updateMany.mock.calls[0][0]).toEqual({ userId, "opponent.pulseId": "p1" });
});

test("repair entry rejects stopped, busy, lookalike, forged, serialized, foreign and mismatched contexts before the floor", async () => {
  const h = harness(), r = repair(h), lookalike = { db: h.db, pending: new Set(), stopped: false };
  await expect(writeOpponentGameIdentityRepair(lookalike, r.context, identity())).rejects.toMatchObject({ code: "game_stats_repair_writer_required" });
  const forged = [{ ...r.context, handle: Object.freeze(Object.create(null)) }, JSON.parse(JSON.stringify(r.context)),
    { ...r.context, owner: { ...r.owner, userId: "foreign" } }, { ...r.context, kind: "admin_rebuild_opponents" }, { ...r.context, extra: 1 },
    { ...r.context, fenceId: uuid() }, null, undefined];
  for (const context of forged) await expect(writeOpponentGameIdentityRepair(h.writer, context, identity())).rejects.toMatchObject({ status: 503 });
  await expect(writeOpponentGameIdentityRepair(h.writer, r.context, region())).rejects.toMatchObject({ status: 503 });
  for (let i = 0; i < MAX_ACTIVE; i += 1) h.writer.pending.add(new Promise(() => {}));
  await expect(writeOpponentGameIdentityRepair(h.writer, r.context, identity())).rejects.toMatchObject({ code: "game_stats_writer_busy" });
  h.writer.pending.clear(); await h.writer.stopAndDrain();
  await expect(writeOpponentGameIdentityRepair(h.writer, r.context, identity())).rejects.toMatchObject({ code: "game_stats_writer_stopping" });
  expect(floor).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(gameCommands(h)).toBe(0);
});

test("a handle closed during a held floor vetoes before any session", async () => {
  const h = harness(), r = repair(h), gate = held(), entered = held();
  floor.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
  const task = writeOpponentGameIdentityRepair(h.writer, r.context, identity()); await entered.promise;
  const reason = new Error("lease lost while waiting"); issuer.fail(r.handle, reason); gate.resolve(new Timestamp({ t: 13, i: 1 }));
  await expect(task).rejects.toMatchObject({ code: "game_stats_repair_authority_unavailable", cause: reason });
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(h.users.findOneAndUpdate).not.toHaveBeenCalled();
});

test("a handle closed while the owner claim is held vetoes the fixed game command", async () => {
  const h = harness(), r = repair(h), claim = held(), entered = held();
  h.users.findOneAndUpdate.mockImplementationOnce(async () => { entered.resolve(); return claim.promise; });
  const task = writeOpponentGameIdentityRepair(h.writer, r.context, identity()); await entered.promise;
  issuer.release(r.handle); claim.resolve(readyRow(r.owner, { _gdprMutation: { id: r.fenceId, kind: r.kind } }));
  await expect(task).rejects.toMatchObject({ code: "game_stats_repair_authority_unavailable" });
  expect(h.games.updateMany).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled();
});

test("a handle closed between transaction callback attempts vetoes the second attempt", async () => {
  const h = harness(), r = repair(h), reason = new Error("known loss between attempts");
  h.session.withTransaction.mockImplementationOnce(async fn => { await fn(); issuer.fail(r.handle, reason); return fn(); });
  h.users.findOneAndUpdate.mockImplementation(async () => readyRow(r.owner, { _gdprMutation: { id: r.fenceId, kind: r.kind } }));
  await expect(writeOpponentGameIdentityRepair(h.writer, r.context, identity())).rejects.toMatchObject({ cause: reason });
  expect(h.games.updateMany).toHaveBeenCalledTimes(1); expect(h.users.findOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(h.session.endSession).toHaveBeenCalledTimes(1);
});

test("a handle closed during held compat retirement sends no game command and the retirement stands", async () => {
  const h = harness({ compatibility: true }), r = repair(h), retirement = held(), entered = held();
  h.users.updateOne.mockImplementationOnce(async () => { entered.resolve(); return retirement.promise; });
  const task = writeOpponentGameIdentityRepair(h.writer, r.context, identity()); await entered.promise;
  issuer.fail(r.handle, new Error("assert failed")); retirement.resolve({ acknowledged: true, matchedCount: 1 });
  await expect(task).rejects.toMatchObject({ code: "game_stats_repair_authority_unavailable" });
  expect(h.users.updateOne.mock.calls).toEqual([[fenced(r), RETIRE, { upsert: false }]]); expect(gameCommands(h)).toBe(0);
});

test("repair compat requires an acknowledged retirement and refuses dispatch after a stop that leaves the handle live", async () => {
  const h = harness({ compatibility: true }), r = repair(h);
  h.users.updateOne.mockResolvedValueOnce({ acknowledged: false, matchedCount: 1 });
  await expect(writeOpponentGameIdentityRepair(h.writer, r.context, identity())).rejects.toMatchObject({ code: "game_stats_authority_changed" });
  expect(h.users.updateOne.mock.calls).toEqual([[fenced(r), RETIRE, { upsert: false }]]); expect(gameCommands(h)).toBe(0);
  const retirement = held(), entered = held();
  h.users.updateOne.mockImplementationOnce(async () => { entered.resolve(); return retirement.promise; });
  const task = writeOpponentGameIdentityRepair(h.writer, r.context, identity()); await entered.promise;
  let drained = false; const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await turn(); expect(h.writer.pending.size).toBe(1); expect(drained).toBe(false);
  retirement.resolve({ acknowledged: true, matchedCount: 1 });
  await expect(task).rejects.toMatchObject({ code: "game_stats_writer_stopping" }); await drain;
  expect(gameCommands(h)).toBe(0); expect(h.writer.pending.size).toBe(0); expect(h.db.client.startSession).not.toHaveBeenCalled();
});

test("repair claim and retirement use exactly the fenced authority and never carry a fenced preimage", async () => {
  const h = harness(), r = repair(h, "admin_rebuild_opponents");
  h.users.findOneAndUpdate.mockImplementation(async () => readyRow(r.owner, { _gdprMutation: { id: r.fenceId, kind: r.kind } }));
  await writeOpponentGameIdentityRepair(h.writer, r.context, identity());
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toEqual(fenced(r)); expect(h.users.updateOne).not.toHaveBeenCalled();
  for (const read of [h.games.countDocuments, h.games.find, h.games.aggregate]) expect(read).not.toHaveBeenCalled();
  const compat = harness({ compatibility: true }), cr = repair(compat);
  await writeOpponentGameIdentityRepair(compat.writer, cr.context, identity());
  expect(compat.users.updateOne.mock.calls[0]).toEqual([fenced(cr), RETIRE, { upsert: false }]);
  expect(compat.games.updateMany.mock.calls[0]).toEqual([{ userId, "opponent.pulseId": "p1" },
    stamped({ $set: { "opponent.region": "EU", "opponent.pulseCharacterId": "77" } }), { upsert: false }]);
});

test("generic write() never accepts an issued repair mutation", async () => {
  const h = harness(), r = repair(h), mutation = issueOpponentIdentityRepair(r.context, r.owner, identity());
  await expect(h.writer.write(r.owner, mutation)).rejects.toMatchObject({ code: "game_stats_neutral_operation_invalid" });
  expect(floor).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
});

test("floor-unavailable and transaction-timeout rejections propagate", async () => {
  const unavailable = Object.assign(new Error("game_stats_read_floor_unavailable"), { code: "game_stats_read_floor_unavailable" });
  const h = harness(); floor.mockImplementationOnce(() => Promise.reject(unavailable));
  await expect(h.writer.write(h.owner, region())).rejects.toBe(unavailable);
  const timeout = Object.assign(new Error("operation timed out"), { name: "MongoOperationTimeoutError" });
  h.session.withTransaction.mockImplementationOnce(async () => { throw timeout; });
  await expect(h.writer.write(h.owner, identity())).rejects.toBe(timeout);
  expect(gameCommands(h)).toBe(0); expect(h.writer.pending.size).toBe(0);
});
