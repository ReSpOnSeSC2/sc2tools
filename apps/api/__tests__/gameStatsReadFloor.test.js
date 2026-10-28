// @ts-nocheck
"use strict";

const { Timestamp, ObjectId } = require("mongodb");
const { createReadFloorProvider, readMajorityFloor, statsReadFloorFor, RETRY_MS } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites, MAX_ACTIVE } = require("../src/services/gameStatsWrites");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const anchor = new Timestamp({ t: 10, i: 7 }), processId = new ObjectId();
  const hello = { setName: "replica", isWritablePrimary: true, operationTime: anchor,
    topologyVersion: { processId, counter: 1 }, $clusterTime: { clusterTime: new Timestamp({ t: 999, i: 1 }) } };
  const session = { operationTime: null, advanceOperationTime: jest.fn(value => { session.operationTime = value; }), endSession: jest.fn(async () => {}) };
  const admin = { command: jest.fn(async () => hello) }, users = { findOne: jest.fn(async () => null), updateOne: jest.fn() };
  const db = { client: { startSession: jest.fn(() => session) }, db: { admin: () => admin }, users };
  let now = 0;
  return { db, users, admin, session, anchor, hello, now: () => now, setNow: value => { now = value; } };
}

test("acknowledged real majority read anchors operationTime, not gossip, with explicit causal ownership", async () => {
  const h = harness();
  const floor = await readMajorityFloor(h.db);
  expect(floor.equals(h.anchor)).toBe(true); expect(floor.equals(h.hello.$clusterTime.clusterTime)).toBe(false);
  expect(h.db.client.startSession).toHaveBeenCalledWith({ causalConsistency: true });
  expect(h.session.advanceOperationTime).toHaveBeenCalledWith(h.anchor);
  expect(h.users.findOne).toHaveBeenCalledWith({}, { projection: { _id: 1 }, readPreference: "primary",
    readConcern: { level: "majority" }, session: h.session, maxTimeMS: 2000, timeoutMS: 5000 });
  expect(h.admin.command).toHaveBeenCalledTimes(2);
  for (const [command, options] of h.admin.command.mock.calls) {
    expect(command).toEqual({ hello: 1, maxTimeMS: 2000 }); expect(options).toEqual({ readPreference: "primary", timeoutMS: 5000 });
  }
  expect(h.users.updateOne).not.toHaveBeenCalled(); expect(h.session.endSession).toHaveBeenCalledTimes(1);
});
test("concurrent demand coalesces one actual barrier; cached floor copies cannot alias another caller", async () => {
  const h = harness(), held = deferred(), getFloor = createReadFloorProvider(h.db, { now: h.now });
  h.users.findOne.mockImplementation(() => held.promise);
  const first = getFloor(), second = getFloor(); await Promise.resolve();
  expect(h.users.findOne).toHaveBeenCalledTimes(1); expect(h.db.client.startSession).toHaveBeenCalledTimes(1);
  held.resolve(null); const [a, b] = await Promise.all([first, second]);
  expect(a.equals(b)).toBe(true); expect(a).not.toBe(b);
  const cached = getFloor(); expect(cached).toBeInstanceOf(Timestamp); expect(cached).not.toBe(a);
  expect(h.users.findOne).toHaveBeenCalledTimes(1); expect(h.admin.command).toHaveBeenCalledTimes(2);
});
test.each([
  hello => { delete hello.operationTime; }, hello => { hello.operationTime = { t: 10, i: 7 }; },
  hello => { hello.operationTime = new Timestamp({ t: 0, i: 0 }); }, hello => { hello.isWritablePrimary = false; },
  hello => { delete hello.setName; }, hello => { hello.topologyVersion = {}; },
])("unknown primary/time cannot grant a floor or start the majority read (%#)", alter => {
  const h = harness(); alter(h.hello);
  return expect(readMajorityFloor(h.db)).rejects.toMatchObject({ status: 503 }).then(() => {
    expect(h.users.findOne).not.toHaveBeenCalled(); expect(h.db.client.startSession).not.toHaveBeenCalled();
  });
});
test.each(["process", "counter", "secondary"])("a %s change during barrier never publishes readiness", async mode => {
  const h = harness(), after = { ...h.hello, topologyVersion: { ...h.hello.topologyVersion } };
  if (mode === "process") after.topologyVersion.processId = new ObjectId();
  else if (mode === "counter") after.topologyVersion.counter++;
  else after.isWritablePrimary = false;
  h.admin.command.mockResolvedValueOnce(h.hello).mockResolvedValue(after);
  await expect(readMajorityFloor(h.db)).rejects.toMatchObject({ code: "game_stats_read_floor_primary_changed" });
  expect(h.session.endSession).toHaveBeenCalledTimes(1);
});
test("failed/unknown barrier stays unready and retries only on bounded later demand", async () => {
  const h = harness(), error = new Error("unknown majority read"), getFloor = createReadFloorProvider(h.db, { now: h.now });
  h.users.findOne.mockRejectedValueOnce(error);
  await expect(getFloor()).rejects.toMatchObject({ status: 503, code: "game_stats_read_floor_unavailable", cause: error });
  await expect(getFloor()).rejects.toMatchObject({ code: "game_stats_read_floor_unavailable" });
  h.setNow(RETRY_MS - 1); await expect(getFloor()).rejects.toMatchObject({ status: 503 });
  expect(h.users.findOne).toHaveBeenCalledTimes(1);
  h.setNow(RETRY_MS); expect((await getFloor()).equals(h.anchor)).toBe(true);
  expect(h.users.findOne).toHaveBeenCalledTimes(2); expect(h.session.endSession).toHaveBeenCalledTimes(2);
});
test("barrier cleanup diagnostics cannot replace an acknowledged floor", async () => {
  const h = harness(), logger = { warn: jest.fn(() => { throw new Error("logger failed"); }) };
  h.session.endSession.mockRejectedValue(new Error("cleanup failed"));
  expect((await readMajorityFloor(h.db, logger)).equals(h.anchor)).toBe(true); expect(logger.warn).toHaveBeenCalledTimes(1);
});
test("readiness is bound to connected client identity, not a module-global cluster clock", () => {
  const h = harness(), other = harness();
  expect(statsReadFloorFor(h.db)).toBe(statsReadFloorFor(h.db));
  expect(statsReadFloorFor(h.db)).not.toBe(statsReadFloorFor(other.db));
});
test.each([NaN, Infinity])("invalid elapsed clock %p cannot start repeated barrier work", async now => {
  const h = harness(), getFloor = createReadFloorProvider(h.db, { now: () => now });
  await expect(getFloor()).rejects.toMatchObject({ status: 503 }); expect(h.admin.command).not.toHaveBeenCalled();
});

function writerHarness() {
  const h = harness(), owner = { userId: "owner", id: new ObjectId(), compatibility: false };
  const txn = { advanceOperationTime: jest.fn(), endSession: jest.fn(async () => {}), withTransaction: jest.fn(async callback => callback(txn)) };
  h.db.client.startSession.mockImplementationOnce(() => h.session).mockImplementation(() => txn);
  h.users.findOneAndUpdate = jest.fn(async () => ({ _id: owner.id }));
  h.users.updateOne.mockResolvedValue({ matchedCount: 1 });
  const cursor = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn(async () => []) };
  h.db.games = { countDocuments: jest.fn(async () => 0), find: jest.fn(() => cursor) };
  return { ...h, owner, txn, writer: new GameStatsWrites(h.db), selected: { selection: { ids: [] } } };
}

test("every actual writer TX gets the acknowledged causal floor before its first owner write", async () => {
  const h = writerHarness();
  h.users.findOneAndUpdate.mockImplementation(async () => {
    expect(h.txn.advanceOperationTime).toHaveBeenCalledWith(h.anchor); return { _id: h.owner.id };
  });
  expect(await h.writer.write(h.owner, async () => "committed", h.selected)).toBe("committed");
  expect(h.txn.withTransaction.mock.calls[0][1]).toMatchObject({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, timeoutMS: 10000 });
  expect(h.db.client.startSession).toHaveBeenNthCalledWith(1, { causalConsistency: true });
  expect(h.db.client.startSession).toHaveBeenNthCalledWith(2, { causalConsistency: true });
  await h.writer.write(h.owner, async () => "second", h.selected);
  expect(h.users.findOne).toHaveBeenCalledTimes(1); expect(h.admin.command).toHaveBeenCalledTimes(2);
  expect(h.txn.advanceOperationTime).toHaveBeenCalledTimes(2); expect(h.txn.endSession).toHaveBeenCalledTimes(2);
});

test("bounded admission and stop own a held floor until actual read/session settlement; no late mint", async () => {
  const h = writerHarness(), entered = deferred(), held = deferred(), work = jest.fn();
  h.users.findOne.mockImplementation(() => { entered.resolve(); return held.promise; });
  const tasks = Array.from({ length: MAX_ACTIVE }, () => h.writer.write(h.owner, work, h.selected).catch(error => error));
  await entered.promise; expect(h.writer.pending.size).toBe(MAX_ACTIVE);
  await expect(h.writer.write(h.owner, work, h.selected)).rejects.toMatchObject({ code: "game_stats_writer_busy" });
  let drained = false; const stopping = h.writer.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(h.session.endSession).not.toHaveBeenCalled();
  held.resolve(null); const outcomes = await Promise.all(tasks); await stopping;
  for (const error of outcomes) expect(error.code).toBe("game_stats_writer_stopping");
  expect(h.users.findOne).toHaveBeenCalledTimes(1); expect(h.session.endSession).toHaveBeenCalledTimes(1);
  expect(h.db.client.startSession).toHaveBeenCalledTimes(1); expect(h.txn.withTransaction).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  expect(drained).toBe(true); expect(h.writer.pending.size).toBe(0);
});

test("unavailable floor issues no owner/game transaction and cannot silently mint maintenance2", async () => {
  const h = writerHarness(), work = jest.fn(); h.users.findOne.mockRejectedValue(new Error("majority timeout"));
  await expect(h.writer.write(h.owner, work, h.selected)).rejects.toMatchObject({ code: "game_stats_read_floor_unavailable", status: 503 });
  await expect(h.writer.write(h.owner, work, h.selected)).rejects.toMatchObject({ code: "game_stats_read_floor_unavailable" });
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.txn.withTransaction).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0); expect(h.users.findOne).toHaveBeenCalledTimes(1);
});
