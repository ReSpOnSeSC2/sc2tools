// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { TwitchAutomationReceipts } = require("../src/services/twitchAutomationReceipts");
const { TwitchAutomationService, receiptStatus } = require("../src/services/twitchAutomation");
const { TwitchAutomationProviderError } = require("../src/services/twitchAutomationProvider");
const { config } = require("../src/services/twitchAutomationPolicy");
let mongo, client, collection, usersCollection, receipts, service, provider, integrations, users, now, prefs, grant, heldOwners;
const ranked = { source: "verified-live-queue", ranked1v1: true };
const ids = { predictionId: "exact-prediction", winId: "exact-win", lossId: "exact-loss" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); collection = client.db("twitch_automation_controller").collection("receipts"); usersCollection = client.db("twitch_automation_controller").collection("users"); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await collection.deleteMany({}); now = Date.UTC(2026, 9, 25, 12); prefs = { ...config.defaults }; heldOwners = new Set();
  await usersCollection.deleteMany({}); await usersCollection.insertMany(["owner-A", "owner-B", "owner-C"].map(userId => ({ userId })));
  receipts = new TwitchAutomationReceipts({ collection, now: () => now }); await receipts.ensureIndexes();
  grant = { accessToken: "never-return-this-secret", platformUserId: "42", connectionRevision: "revision-A", assertCurrent: jest.fn(async () => {}), boundedFetch: jest.fn() };
  integrations = { withTwitchAutomationGrant: jest.fn(async (owner, permissions, callback) => {
    if (heldOwners.has(owner)) throw Object.assign(new Error("synthetic lease busy"), { code: "streaming_account_busy", status: 409 });
    heldOwners.add(owner); try { return await callback(grant); } finally { heldOwners.delete(owner); }
  }) };
  provider = { broadcaster: jest.fn(async () => ({ eligible: true })), isLive: jest.fn(async () => true), createPrediction: jest.fn(async () => ids),
    createMarker: jest.fn(async () => ({ markerId: "exact-marker", positionSeconds: 300 })),
    prediction: jest.fn(async () => ({ status: "ACTIVE", ...ids })), endPrediction: jest.fn(async (_grant, _id, status) => ({ status })) };
  users = { getPreferences: jest.fn(async () => prefs) };
  service = new TwitchAutomationService({ users, usersCollection, receipts, provider, integrations, enabled: true, now: () => now });
});
function envelope(changes = {}) { return { phase: "match_loading", gameKey: `Synthetic rival|Synthetic owner|${now}`, capturedAt: now / 1000, isReplay: false,
  players: [{ name: "Synthetic owner", type: "user" }, { name: "Synthetic rival", type: "user" }], user: { name: "Synthetic owner", race: "Protoss" }, opponent: { name: "Synthetic rival", race: "Zerg", mmr: 4000 }, map: "Synthetic map", ...changes }; }
const live = (env = envelope(), evidence = null, owner = "owner-A") => service.onLive(owner, env, { source: "device", receivedAt: now }, evidence);
const replay = (changes = {}) => ({ gameId: "replay-1", startedAt: new Date(now).toISOString(), date: new Date(now).toISOString(), durationSec: 600, playerCount: 2, matchFormat: "1v1", isLadderGame: true, result: "Victory", opponent: { displayName: "Synthetic rival", race: "Zerg" }, myRace: "Protoss", ...changes });
async function active() { prefs.predictionsEnabled = true; const env = envelope(); await live(env, ranked); return env; }

test("default-off does no receipt/provider/grant work and progress events do no preference reads", async () => {
  await live(); expect(await collection.countDocuments()).toBe(0); expect(integrations.withTwitchAutomationGrant).not.toHaveBeenCalled();
  users.getPreferences.mockClear(); await live(envelope({ phase: "match_in_progress" })); expect(users.getPreferences).not.toHaveBeenCalled();
});
test("server master gate defaults off even with saved opt-ins and valid mocked queue evidence", async () => {
  prefs.predictionsEnabled = true; prefs.markersEnabled = true;
  service = new TwitchAutomationService({ users, usersCollection, receipts, provider, integrations, now: () => now });
  await live(envelope(), ranked); await live(envelope({ phase: "match_started" })); expect(await service.recover()).toEqual({ checked: 0 }); service.start();
  expect(service.timer).toBeNull(); expect(users.getPreferences).not.toHaveBeenCalled(); expect(integrations.withTwitchAutomationGrant).not.toHaveBeenCalled(); expect(await collection.countDocuments()).toBe(0);
});
test("current desktop/raw queue metadata cannot create a prediction, while real human starts can mark", async () => {
  prefs.predictionsEnabled = true; expect(await live(envelope({ isRanked: true, queue: "ranked1v1" }))).toMatchObject({ prediction: "skipped", reason: "ranked_status_unavailable" });
  expect(provider.createPrediction).not.toHaveBeenCalled(); expect(integrations.withTwitchAutomationGrant).not.toHaveBeenCalled();
  prefs.markersEnabled = true; const env = envelope(); await live(env); expect((await receipts.read("owner-A", env.gameKey)).marker.status).toBe("waiting");
  await live({ ...env, phase: "match_started" }); await live({ ...env, phase: "match_started" });
  expect(provider.createMarker).toHaveBeenCalledTimes(1); expect(provider.createMarker.mock.calls[0][1]).toBe("vs Synthetic rival · PvZ · Synthetic map");
  expect(integrations.withTwitchAutomationGrant.mock.calls.every(call => call[1].predictions === false)).toBe(true);
});
test.each([{ isReplay: true }, { isReplay: undefined }, { synthetic: true }, { isObserver: true }, { players: [{ name: "A", type: "user" }, { name: "B", type: "opponent" }] }, { capturedAt: 1 }])("untrusted/unsupported start never reaches Twitch: %j", async changes => {
  prefs.markersEnabled = true; prefs.predictionsEnabled = true; await live(envelope({ phase: "match_started", ...changes }), ranked); expect(integrations.withTwitchAutomationGrant).not.toHaveBeenCalled();
});
test("verified future queue evidence creates once with exact outcome receipts, no secret DTO", async () => {
  const env = await active(); await live(env, ranked); const row = await receipts.read("owner-A", env.gameKey);
  expect(row.prediction).toMatchObject({ status: "active", ...ids }); expect(provider.createPrediction).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(receiptStatus(row))).not.toMatch(/never-return|exact-win|exact-loss|Synthetic|revision-A/);
});
test("a recent same-opponent prediction suppresses rematch creation without suppressing markers", async () => {
  await active(); now += 60_000; prefs.markersEnabled = true; const env = envelope(); await live(env, ranked); await live({ ...env, phase: "match_started" });
  expect(provider.createPrediction).toHaveBeenCalledTimes(1); expect(provider.createMarker).toHaveBeenCalledTimes(1);
  expect(await receipts.read("owner-A", env.gameKey)).toMatchObject({ reason: "rematch_cooldown", prediction: { status: "skipped" } });
});
test.each([false, true])("offline or non-affiliate/partner cannot create provider objects: %j", async offline => {
  prefs.markersEnabled = true; prefs.predictionsEnabled = true; if (offline) provider.isLive.mockResolvedValue(false); else provider.broadcaster.mockResolvedValue({ eligible: false });
  await live(envelope(), ranked); expect(provider.createPrediction).not.toHaveBeenCalled(); expect(provider.createMarker).not.toHaveBeenCalled();
});
test.each([[59, "CANCELED", undefined], [60, "RESOLVED", ids.winId]])("verified replay at %is selects safe settlement", async (durationSec, state, outcome) => {
  const env = await active(); await service.settleVerifiedReplay("owner-A", env.gameKey, replay({ durationSec }));
  expect(provider.endPrediction).toHaveBeenCalledWith(grant, ids.predictionId, state, outcome);
  expect((await receipts.read("owner-A", env.gameKey)).prediction.status).toBe(state === "CANCELED" ? "canceled" : "resolved");
});
test("a loss uses its immutable provider outcome ID", async () => {
  const env = await active(); await service.settleVerifiedReplay("owner-A", env.gameKey, replay({ result: "Defeat" })); expect(provider.endPrediction).toHaveBeenCalledWith(grant, ids.predictionId, "RESOLVED", ids.lossId);
});
test.each([{ isResumedFromReplay: true }, { startedAt: undefined }, { startedAt: "2000-01-01T00:00:00Z" }, { opponent: { name: "Different rival", race: "Zerg" } }, { myRace: "Terran" }, { isLadderGame: undefined }, { playerCount: 4 }, { matchFormat: "team" }, { result: "Tie" }])("ambiguous/replayed/unranked result never resolves: %j", async changes => {
  const env = await active(); await service.settleVerifiedReplay("owner-A", env.gameKey, replay(changes)); expect(provider.endPrediction).not.toHaveBeenCalled();
});
test("short-game cancellation arriving during CREATE is durable and drains after its exact receipt", async () => {
  prefs.predictionsEnabled = true; const env = envelope(), entered = deferred(), release = deferred(); provider.createPrediction.mockImplementation(async () => { entered.resolve(); await release.promise; return ids; });
  const creation = live(env, ranked); await entered.promise;
  await expect(service.settleVerifiedReplay("owner-A", env.gameKey, replay({ durationSec: 20 }))).resolves.toMatchObject({ prediction: "creating" });
  expect((await receipts.read("owner-A", env.gameKey)).settlement).toMatchObject({ action: "cancel", reason: "short_game" });
  release.resolve(); await creation; expect(provider.endPrediction).toHaveBeenCalledTimes(1); expect((await receipts.read("owner-A", env.gameKey)).prediction.status).toBe("canceled");
});
test("verified winning result arriving during CREATE survives the same race", async () => {
  prefs.predictionsEnabled = true; const env = envelope(), entered = deferred(), release = deferred(); provider.createPrediction.mockImplementation(async () => { entered.resolve(); await release.promise; return ids; });
  const creation = live(env, ranked); await entered.promise; await service.settleVerifiedReplay("owner-A", env.gameKey, replay()); release.resolve(); await creation;
  expect(provider.endPrediction).toHaveBeenCalledWith(grant, ids.predictionId, "RESOLVED", ids.winId);
});
test("restart recovers a known active no-result prediction with a refund at20min", async () => {
  const env = await active(); now += config.limits.resultTimeoutMs + 1; service = new TwitchAutomationService({ users, usersCollection, receipts, provider, integrations, enabled: true, now: () => now });
  expect(await service.recover()).toEqual({ checked: 1 }); expect(provider.endPrediction).toHaveBeenCalledWith(grant, ids.predictionId, "CANCELED", undefined);
  expect((await receipts.read("owner-A", env.gameKey)).settlement.reason).toBe("result_timeout");
});
test("unknown CREATE without provider ID is not blindly repeated by reconnect, recovery or Cancel", async () => {
  prefs.predictionsEnabled = true; provider.createPrediction.mockRejectedValue(new TwitchAutomationProviderError("unconfirmed", 504, true)); const env = envelope(); await live(env, ranked);
  now += 21 * 60_000; await service.recover(); await expect(service.action("owner-A", env.gameKey, "cancel")).rejects.toMatchObject({ code: "twitch_prediction_id_unavailable" }); await live(envelope({ gameKey: env.gameKey }), ranked);
  expect(receiptStatus(await receipts.read("owner-A", env.gameKey)).canCancel).toBe(false);
  expect(provider.createPrediction).toHaveBeenCalledTimes(1); expect(provider.endPrediction).not.toHaveBeenCalled(); expect(provider.prediction).not.toHaveBeenCalled();
});
test("partial CREATE IDs never authorize Resolve; known exact prediction can be refunded after timeout", async () => {
  prefs.predictionsEnabled = true; provider.createPrediction.mockRejectedValue(new TwitchAutomationProviderError("partial", 502, true, { predictionId: ids.predictionId }));
  const env = envelope(); await live(env, ranked); await service.settleVerifiedReplay("owner-A", env.gameKey, replay()); expect(provider.endPrediction).not.toHaveBeenCalled();
  expect(receiptStatus(await receipts.read("owner-A", env.gameKey)).canResolve).toBe(false);
  now += config.limits.resultTimeoutMs + 1; await service.recover(); expect(provider.prediction).toHaveBeenCalledWith(grant, ids.predictionId); expect(provider.endPrediction).toHaveBeenCalledWith(grant, ids.predictionId, "CANCELED", undefined);
});
test("uncertain PATCH reconciles its exact ID after restart without a second mutation", async () => {
  const env = await active(); provider.endPrediction.mockRejectedValueOnce(new TwitchAutomationProviderError("unknown", 504, true)); await service.settleVerifiedReplay("owner-A", env.gameKey, replay());
  expect((await receipts.read("owner-A", env.gameKey)).prediction.status).toBe("unknown"); now += 60_001; provider.prediction.mockResolvedValue({ status: "RESOLVED", ...ids, winningId: ids.winId });
  await service.recover(); expect(provider.prediction).toHaveBeenCalledWith(grant, ids.predictionId); expect(provider.endPrediction).toHaveBeenCalledTimes(1);
});
test("same-account reconnect renews receipt revision; different broadcaster cannot settle old IDs", async () => {
  const env = await active(); grant = { ...grant, platformUserId: "99", connectionRevision: "revision-B" };
  expect(await service.action("owner-A", env.gameKey, "cancel")).toBeNull(); expect(provider.endPrediction).not.toHaveBeenCalled();
  grant = { ...grant, platformUserId: "42", connectionRevision: "revision-C" }; await service.action("owner-A", env.gameKey, "cancel");
  expect((await receipts.read("owner-A", env.gameKey)).connectionRevision).toBe("revision-C"); expect(provider.endPrediction).toHaveBeenCalledTimes(1);
});
test("Dock cannot forge a result and a foreign owner cannot target an existing receipt", async () => {
  const env = await active(); await expect(service.action("owner-A", env.gameKey, "resolve")).rejects.toMatchObject({ code: "twitch_result_unavailable" });
  expect(await service.action("owner-B", env.gameKey, "cancel")).toBeNull(); expect(provider.endPrediction).not.toHaveBeenCalled();
});
test("expired in-flight CREATE and loading-only markers never issue late provider insertions", async () => {
  prefs.markersEnabled = true; const env = envelope(); await live(env); now += config.limits.resultTimeoutMs + 1; await service.recover();
  expect((await receipts.read("owner-A", env.gameKey)).marker.status).toBe("skipped"); expect(provider.createMarker).not.toHaveBeenCalled();
  now += 60_000; const second = envelope(); await receipts.reserve("owner-A", second.gameKey, { accountId: "42", connectionRevision: "revision-A", opponentKey: "hash", prediction: "pending", marker: "disabled" });
  await receipts.claim("owner-A", second.gameKey, "prediction", "pending", "creating"); now += config.limits.leaseMs + 1; await service.recover();
  expect((await receipts.read("owner-A", second.gameKey)).prediction.status).toBe("unknown"); expect(provider.createPrediction).not.toHaveBeenCalled();
});
test("two cold operations are admitted and a third is rejected before provider work", async () => {
  prefs.markersEnabled = true; const release = deferred(), entered = deferred(); provider.broadcaster.mockImplementation(async () => { if (provider.broadcaster.mock.calls.length === 2) entered.resolve(); await release.promise; return { eligible: true }; });
  const one = live(envelope(), null, "owner-A"), two = live(envelope(), null, "owner-B");
  await entered.promise;
  await expect(live(envelope(), null, "owner-C")).rejects.toMatchObject({ code: "twitch_automation_busy" }); expect(provider.broadcaster).toHaveBeenCalledTimes(2);
  release.resolve(); await Promise.all([one, two]); expect(service.active).toBe(0);
});
test.each(["stale", "changed"])("a held authorization read cannot dispatch an obsolete start: %s", async mode => {
  prefs.markersEnabled = true; provider.isLive.mockImplementation(async () => { if (mode === "stale") now += 20_000; else service.deps.isCurrent = () => false; return true; });
  await live(envelope({ phase: "match_started" })); expect(provider.createMarker).not.toHaveBeenCalled();
});
test("background provider work holds and releases the existing owner erasure lease", async () => {
  prefs.markersEnabled = true; const entered = deferred(), release = deferred(); provider.createMarker.mockImplementation(async () => { entered.resolve(); await release.promise; return { markerId: "owned-marker", positionSeconds: 20 }; });
  const task = live(envelope({ phase: "match_started" })); await entered.promise; expect((await usersCollection.findOne({ userId: "owner-A" }))._dataMutations).toHaveLength(1);
  release.resolve(); await task; expect((await usersCollection.findOne({ userId: "owner-A" }))._dataMutations).toHaveLength(0);
  await usersCollection.updateOne({ userId: "owner-A" }, { $set: { _gdprMutation: { operation: "fixture" } } }); now += 60_000;
  await expect(live(envelope({ phase: "match_started" }))).rejects.toMatchObject({ code: "gdpr_operation_busy" }); expect(provider.createMarker).toHaveBeenCalledTimes(1);
});
test("late Cancel cannot overwrite an already-dispatched resolution or claim a refund", async () => {
  const env = await active(), entered = deferred(), release = deferred(); provider.endPrediction.mockImplementation(async (_grant, _id, status) => { entered.resolve(); await release.promise; return { status }; });
  const resolving = service.settleVerifiedReplay("owner-A", env.gameKey, replay()); await entered.promise;
  await expect(service.action("owner-A", env.gameKey, "cancel")).rejects.toMatchObject({ status: 409, code: "twitch_settlement_in_progress" });
  expect((await receipts.read("owner-A", env.gameKey)).settlement.action).toBe("resolve"); release.resolve(); await resolving;
  expect((await receipts.read("owner-A", env.gameKey)).prediction.status).toBe("resolved"); expect(provider.endPrediction).toHaveBeenCalledTimes(1);
});
test.each(["prediction", "marker"])("a stale pending recovery snapshot cannot cancel a live %s claim", async kind => {
  const env = envelope(); await receipts.reserve("owner-A", env.gameKey, { accountId: "42", connectionRevision: "revision-A", opponentKey: "fixture", prediction: kind === "prediction" ? "pending" : "disabled", marker: kind === "marker" ? "pending" : "disabled" });
  const snapshot = await receipts.read("owner-A", env.gameKey); jest.spyOn(receipts, "due").mockResolvedValue([snapshot]);
  const claimed = await receipts.claim("owner-A", env.gameKey, kind, "pending", "creating"); expect(claimed).not.toBeNull();
  await service.recover(); const row = await receipts.read("owner-A", env.gameKey); expect(row[kind].status).toBe("creating"); expect(row.settlement).toBeUndefined();
});
test("fresh pending lanes have a dispatch grace, then conditional recovery abandons them without provider writes", async () => {
  const env = envelope(); await receipts.reserve("owner-A", env.gameKey, { accountId: "42", connectionRevision: "revision-A", opponentKey: "fixture", prediction: "pending", marker: "pending" });
  expect(await service.recover()).toEqual({ checked: 0 }); expect((await receipts.read("owner-A", env.gameKey)).prediction.status).toBe("pending");
  now += config.limits.leaseMs + 1; expect(await receipts.claim("owner-A", env.gameKey, "prediction", "pending", "creating")).toBeNull(); await service.recover();
  expect(await receipts.read("owner-A", env.gameKey)).toMatchObject({ prediction: { status: "canceled" }, marker: { status: "skipped" } }); expect(provider.createPrediction).not.toHaveBeenCalled(); expect(provider.createMarker).not.toHaveBeenCalled();
});
