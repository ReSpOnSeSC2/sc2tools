// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { TwitchAutomationReceipts } = require("../src/services/twitchAutomationReceipts");
const { config } = require("../src/services/twitchAutomationPolicy");
let mongo, client, rows, journal, now;
const input = { accountId: "broadcaster-1", connectionRevision: "owned-revision", opponentKey: "opponent-hash", prediction: "pending", marker: "disabled" };
const ids = { predictionId: "provider-prediction", winId: "provider-win", lossId: "provider-loss" };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); rows = client.db("twitch_receipt_fixtures").collection("receipts"); journal = new TwitchAutomationReceipts({ collection: rows, now: () => now }); await journal.ensureIndexes(); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => { await rows.deleteMany({}); now = Date.UTC(2026, 9, 25, 12); });
const reserve = (game = "game-1", changes = {}, owner = "owner-A") => journal.reserve(owner, game, { ...input, ...changes });
async function activate(game = "game-1") { await reserve(game); const ticket = await journal.claim("owner-A", game, "prediction", "pending", "creating"); await journal.finish(ticket, "active", ids); }

test("unique owner/game reservations are idempotent across service instances", async () => {
  const other = new TwitchAutomationReceipts({ collection: rows, now: () => now });
  await Promise.all([reserve(), other.reserve("owner-A", "game-1", input), reserve()]);
  expect(await rows.countDocuments({})).toBe(1); expect(await journal.read("owner-B", "game-1")).toBeNull();
  const result = await journal.read("owner-A", "game-1"); expect(result).toMatchObject({ accountId: input.accountId, prediction: { status: "pending" } }); expect(result.expiresAt.getTime() - now).toBe(config.limits.receiptTtlMs);
});
test("concurrent workers claim creation once and stale tickets cannot finish", async () => {
  await reserve(); const tickets = await Promise.all([journal.claim("owner-A", "game-1", "prediction", "pending", "creating"), journal.claim("owner-A", "game-1", "prediction", "pending", "creating")]);
  expect(tickets.filter(Boolean)).toHaveLength(1); const winner = tickets.find(Boolean);
  expect(await journal.finish({ ...winner, leaseId: "foreign-worker" }, "active", ids)).toBeNull();
  expect(await journal.finish(winner, "active", ids)).toMatchObject({ prediction: { status: "active", ...ids } });
  expect(await journal.finish(winner, "unknown")).toBeNull();
});
test("markers have an independent once-only journal lane", async () => {
  await reserve("game-1", { prediction: "disabled", marker: "pending" }); const ticket = await journal.claim("owner-A", "game-1", "marker", "pending", "creating");
  await expect(journal.finish(ticket, "created")).rejects.toThrow("marker_receipt_id_required");
  const result = await journal.finish(ticket, "created", { markerId: "provider-marker", positionSeconds: 42 });
  expect(result.marker).toMatchObject({ status: "created", markerId: "provider-marker", positionSeconds: 42 }); expect(result.nextCheckAt).toBeNull();
  expect(await journal.claim("owner-A", "game-1", "marker", "pending", "creating")).toBeNull();
});
test("a marker reserved at loading waits for the actual start without recovery replay", async () => {
  await reserve("game-1", { prediction: "skipped", marker: "waiting" }); expect(await journal.due()).toHaveLength(0);
  await reserve("game-1", { prediction: "disabled", marker: "pending" });
  expect((await journal.read("owner-A", "game-1")).marker.status).toBe("waiting");
  const ticket = await journal.claim("owner-A", "game-1", "marker", "waiting", "creating");
  await journal.finish(ticket, "created", { markerId: "start-marker" }); expect(await journal.due()).toHaveLength(0);
});
test("an expired create becomes unknown and never returns to pending or auto-retries", async () => {
  await reserve(); const original = await journal.claim("owner-A", "game-1", "prediction", "pending", "creating"); now += config.limits.leaseMs + 1;
  expect(await journal.finish(original, "active", ids)).toBeNull(); expect(await journal.due()).toHaveLength(1);
  const recovery = await journal.claim("owner-A", "game-1", "prediction", "creating", "unknown"); await journal.finish(recovery, "unknown", { reason: "unconfirmed_create" });
  expect(await journal.due()).toHaveLength(0); await expect(journal.claim("owner-A", "game-1", "prediction", "unknown", "creating")).rejects.toThrow("invalid_twitch_transition");
  await expect(journal.claim("owner-A", "game-1", "prediction", "unknown", "canceling")).rejects.toThrow("invalid_twitch_transition");
});
test("known-ID patch uncertainty can be reconciled without changing provider identity", async () => {
  await activate(); const resolving = await journal.claim("owner-A", "game-1", "prediction", "active", "resolving");
  await journal.finish(resolving, "unknown", { reason: "unconfirmed_patch", retryAt: new Date(now + 60_000) });
  expect(await journal.due()).toHaveLength(0); now += 60_001; expect(await journal.due()).toHaveLength(1);
  const recovery = await journal.claim("owner-A", "game-1", "prediction", "unknown", "unknown");
  await expect(journal.finish(recovery, "resolved", { predictionId: "different-prediction" })).rejects.toThrow("immutable");
  expect(await journal.finish(recovery, "resolved")).toMatchObject({ prediction: { status: "resolved", predictionId: ids.predictionId } });
});
test("active timeout and explicit cancellation retain refund intent as a terminal receipt", async () => {
  await activate(); expect(await journal.due()).toHaveLength(0); now += config.limits.resultTimeoutMs + 1; expect(await journal.due()).toHaveLength(1);
  const refund = await journal.claim("owner-A", "game-1", "prediction", "active", "canceling");
  expect(await journal.finish(refund, "canceled", { reason: "result_timeout" })).toMatchObject({ prediction: { status: "canceled", reason: "result_timeout" } });
  expect(await journal.due()).toHaveLength(0); await expect(journal.claim("owner-A", "game-1", "prediction", "canceled", "resolving")).rejects.toThrow();
});
test("rematch lookup is bounded to its owner and recent opponent receipt", async () => {
  await activate(); expect(await journal.recentOpponent("owner-A", input.opponentKey, "next-game")).toMatchObject({ gameKey: "game-1" });
  expect(await journal.recentOpponent("owner-B", input.opponentKey, "next-game")).toBeNull(); expect(await journal.recentOpponent("owner-A", "different-opponent", "next-game")).toBeNull();
  now += config.limits.rematchMs + 1; expect(await journal.recentOpponent("owner-A", input.opponentKey, "next-game")).toBeNull();
});
test("recovery batches stay bounded and fields cannot carry secrets or expression injection", async () => {
  await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(`game-${i}`))); expect(await journal.due(1000)).toHaveLength(25);
  const ticket = await journal.claim("owner-A", "game-1", "prediction", "pending", "creating");
  await expect(journal.finish(ticket, "active", { ...ids, accessToken: "must-not-store" })).rejects.toThrow();
  const result = await journal.finish(ticket, "active", { ...ids, reason: "$literal-provider-reason" }); expect(result.prediction.reason).toBe("$literal-provider-reason");
});

test("cancel before dispatch prevents CREATE and never affects another owner", async () => {
  await reserve(); expect(await journal.requestSettlement("owner-B", "game-1", { action: "cancel", reason: "dock_cancel" })).toBeNull();
  const row = await journal.requestSettlement("owner-A", "game-1", { action: "cancel", reason: "dock_cancel" });
  expect(row).toMatchObject({ prediction: { status: "canceled" }, settlement: { action: "cancel", reason: "dock_cancel" } });
  expect(await journal.claim("owner-A", "game-1", "prediction", "pending", "creating")).toBeNull(); expect(await journal.due()).toHaveLength(0);
});

test.each(["verified_result", "short_game", "result_timeout", "dock_cancel"])("%s during CREATE survives completion and becomes immediately recoverable", async reason => {
  await reserve(); const ticket = await journal.claim("owner-A", "game-1", "prediction", "pending", "creating");
  const action = reason === "verified_result" ? "resolve" : "cancel";
  await journal.requestSettlement("owner-A", "game-1", { action, reason, ...(action === "resolve" ? { outcome: "win" } : {}) });
  expect(await journal.due()).toHaveLength(0); await journal.finish(ticket, "active", ids);
  const recovered = new TwitchAutomationReceipts({ collection: rows, now: () => now });
  expect((await recovered.due())[0]).toMatchObject({ settlement: { action, reason }, prediction: { status: "active", ...ids } });
});

test("duplicate/conflicting results cannot replace a durable result; cancellation cannot resurrect a terminal prediction", async () => {
  await activate(); await journal.requestSettlement("owner-A", "game-1", { action: "resolve", outcome: "win", reason: "verified_result" });
  expect(await journal.requestSettlement("owner-A", "game-1", { action: "resolve", outcome: "loss", reason: "verified_result" })).toBeNull();
  await journal.requestSettlement("owner-A", "game-1", { action: "cancel", reason: "dock_cancel" });
  const ticket = await journal.claim("owner-A", "game-1", "prediction", "active", "canceling"); await journal.finish(ticket, "canceled");
  expect(await journal.requestSettlement("owner-A", "game-1", { action: "resolve", outcome: "loss", reason: "verified_result" })).toBeNull();
  expect((await journal.read("owner-A", "game-1")).settlement.action).toBe("cancel");
});

test("an unknown CREATE without exact provider ID never becomes an automatic write candidate", async () => {
  await reserve(); const ticket = await journal.claim("owner-A", "game-1", "prediction", "pending", "creating"); await journal.finish(ticket, "unknown", { reason: "unconfirmed_create" });
  await journal.requestSettlement("owner-A", "game-1", { action: "cancel", reason: "dock_cancel" }); expect(await journal.due()).toHaveLength(0);
});
