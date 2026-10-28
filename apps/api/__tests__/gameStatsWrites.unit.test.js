// @ts-nocheck
"use strict";
const { GameStatsWrites, MAX_ACTIVE, assertGameStatsContext } = require("../src/services/gameStatsWrites");

const originalEnvironment = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = originalEnvironment; jest.restoreAllMocks(); });
const owner = { userId: "owner", id: "original-instance", compatibility: false };

function harness() {
  const events = [];
  const session = { withTransaction: jest.fn(async callback => callback(session)), endSession: jest.fn(async () => {}) };
  const users = { findOne: jest.fn(async () => ({ _id: owner.id })), updateOne: jest.fn(async () => { events.push("owner"); return { matchedCount: 1 }; }) };
  const db = { users, gameStatsTransactions: true, client: { startSession: jest.fn(() => session) } };
  return { events, session, users, db, writer: new GameStatsWrites(db) };
}

test("unsupported production topology fails before owner read, session or game work", async () => {
  process.env.NODE_ENV = "production";
  const h = harness(); h.db.gameStatsTransactions = false;
  const work = jest.fn();
  await expect(h.writer.capture("owner").then(handle => h.writer.write(handle, work))).rejects.toThrow("game_stats_transactions_required");
  expect(h.users.findOne).not.toHaveBeenCalled(); expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
});

test("omitting the topology capability cannot silently select production compatibility", async () => {
  process.env.NODE_ENV = "production";
  const h = harness(); delete h.db.gameStatsTransactions;
  await expect(h.writer.capture("owner")).rejects.toThrow("game_stats_transactions_required");
  expect(h.db.client.startSession).not.toHaveBeenCalled();
});

test("production composition rejects omitted capability even in a test process", () => {
  process.env.NODE_ENV = "test";
  const h = harness();
  expect(() => assertGameStatsContext(h.db, "production")).not.toThrow();
  delete h.db.gameStatsTransactions;
  expect(() => assertGameStatsContext(h.db, "production")).toThrow("game_stats_transactions_required");
  h.db.gameStatsTransactions = true; delete h.db.client;
  expect(() => assertGameStatsContext(h.db, "production")).toThrow("game_stats_transactions_required");
  expect(h.users.findOne).not.toHaveBeenCalled();
});

test.each([null, [], {}, "not-a-uuid"])("malformed epoch %p is never normalized into missing authority", async epoch => {
  const h = harness(); h.users.findOne.mockResolvedValue({ _id: owner.id, gameStatsMutationEpoch: epoch });
  await expect(h.writer.capture("owner")).rejects.toThrow("game_stats_mutation_epoch_malformed");
  expect(h.users.updateOne).not.toHaveBeenCalled(); expect(h.db.client.startSession).not.toHaveBeenCalled();
});

test("owner invalidation precedes work in the same session and pins exact owner and fence", async () => {
  const h = harness();
  const result = await h.writer.write(owner, async session => { h.events.push("games"); expect(session).toBe(h.session); return "committed"; }, { fenceId: "exclusive-operation" });
  expect(result).toBe("committed"); expect(h.events).toEqual(["owner", "games"]);
  expect(h.users.updateOne).toHaveBeenCalledWith({ userId: "owner", _id: "original-instance", gameStatsMutationEpoch: { $exists: false }, "_gdprMutation.id": "exclusive-operation" },
    expect.objectContaining({ $set: expect.objectContaining({ gameStatsProtocolVersion: 1, gameStatsRevision: expect.any(String), gameStatsWriterStatus: "transactional" }), $unset: { gameStats: "" } }), { session: h.session, upsert: false });
  expect(h.session.withTransaction.mock.calls[0][1]).toMatchObject({ timeoutMS: 10000, maxCommitTimeMS: 5000, readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } });
  expect(h.session.endSession).toHaveBeenCalledTimes(1);
});

test.each(["reject", "no-match"])("failed initial owner write (%s) never dispatches games", async mode => {
  const h = harness(), work = jest.fn();
  if (mode === "reject") h.users.updateOne.mockRejectedValue(new Error("unknown owner command"));
  else h.users.updateOne.mockResolvedValue({ matchedCount: 0 });
  await expect(h.writer.write(owner, work)).rejects.toThrow(mode === "reject" ? "unknown owner command" : "game_stats_authority_changed");
  expect(work).not.toHaveBeenCalled(); expect(h.session.endSession).toHaveBeenCalledTimes(1);
});

test("session cleanup cannot replace the original games error", async () => {
  const h = harness(); h.session.endSession.mockRejectedValue(new Error("cleanup failed"));
  const original = new Error("original games outcome");
  await expect(h.writer.write(owner, async () => { throw original; })).rejects.toBe(original);
});

test("bounded actual promises own admission until settlement, including after stop", async () => {
  const h = harness(); let release;
  const held = new Promise(resolve => { release = resolve; });
  h.session.withTransaction.mockImplementation(() => held);
  const active = Array.from({ length: MAX_ACTIVE }, () => h.writer.write(owner, jest.fn()));
  expect(h.writer.pending.size).toBe(MAX_ACTIVE);
  await expect(h.writer.write(owner, jest.fn())).rejects.toThrow("game_stats_writer_busy");
  expect(h.db.client.startSession).toHaveBeenCalledTimes(MAX_ACTIVE);
  let drained = false;
  const drain = h.writer.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  await expect(h.writer.write(owner, jest.fn())).rejects.toThrow("game_stats_writer_stopping");
  await expect(h.writer.capture("owner")).rejects.toThrow("game_stats_writer_stopping");
  release("finished"); await Promise.all(active); await drain;
  expect(h.writer.pending.size).toBe(0); expect(drained).toBe(true);
});

test("standalone compatibility invalidates but never creates a qualifying snapshot generation", async () => {
  process.env.NODE_ENV = "test";
  const h = harness(); h.db.gameStatsTransactions = false;
  const handle = await h.writer.capture("owner"), work = jest.fn(async session => { expect(session).toBeUndefined(); return "legacy"; });
  expect(await h.writer.write(handle, work)).toBe("legacy");
  expect(h.users.updateOne).toHaveBeenCalledWith({ userId: "owner", _id: "original-instance", gameStatsMutationEpoch: { $exists: false }, _gdprMutation: { $exists: false } },
    { $set: { gameStatsWriterStatus: "unsupported" }, $unset: { gameStats: "", gameStatsRevision: "", gameStatsProtocolVersion: "" } }, { upsert: false });
  expect(h.db.client.startSession).not.toHaveBeenCalled(); expect(work).toHaveBeenCalledTimes(1);
});

test("unknown standalone retirement cannot dispatch work or upsert an owner", async () => {
  const h = harness(); h.db.gameStatsTransactions = false;
  const handle = await h.writer.capture("owner"), work = jest.fn();
  h.users.updateOne.mockRejectedValue(new Error("unknown retirement"));
  await expect(h.writer.write(handle, work)).rejects.toThrow("unknown retirement"); expect(work).not.toHaveBeenCalled();
  expect(h.users.updateOne.mock.calls[0][2]).toEqual({ upsert: false });
});

test("a transactional fence cannot recapture a replacement owner after staging", async () => {
  const h = harness();
  await expect(h.writer.forFence("owner", {})).rejects.toThrow("game_stats_owner_unavailable");
  await expect(h.writer.forFence("other", { owner })).rejects.toThrow("game_stats_owner_unavailable");
  expect(h.users.findOne).not.toHaveBeenCalled();
});
