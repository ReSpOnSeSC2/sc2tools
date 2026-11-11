// @ts-nocheck
"use strict";

const { createHmac } = require("node:crypto");
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server"), { MongoClient } = require("mongodb");
const oauth = require("../src/services/platformOauthClients");
const { buildPlatformIntegrationsRouter } = require("../src/routes/platformIntegrations");
const { buildTwitchRewardsRouter } = require("../src/routes/twitchRewards");
const { PlatformIntegrationsService } = require("../src/services/platformIntegrations");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { MultichatStudioService } = require("../src/services/multichatStudio");
const { TwitchRewardActions } = require("../src/services/twitchRewardActions");
const { TwitchRewardProvider } = require("../src/services/twitchRewardProvider");
const { TwitchAutomationProvider } = require("../src/services/twitchAutomationProvider");
const { collectAccountExport } = require("../src/services/accountExportData");
const { TwitchRewardReceipts } = require("../src/services/twitchRewardReceipts");
const { TwitchRewardsService } = require("../src/services/twitchRewards");
const { targetId } = require("../src/services/twitchRewardPolicy");
const { nativeRandomizerRoll } = require("../src/services/buildIntentNativeRandomizer");

const SUBSCRIPTION = "channel.channel_points_custom_reward_redemption.add";
const SECRET = "only-a-synthetic-webhook-secret";
const OWNER = "test-owner", OTHER = "test-other", BROADCASTER = "42";
const NOW = Date.UTC(2026, 10, 11, 12);
const SETTINGS = "/v1/me/twitch-rewards";
let mongo, client, db, app, integrations, service, receipts, tokens, studio, token, fetchMock, speech, roll, current, now;
let live, manageable, confirmedStatus;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  const database = client.db("twitch_reward_actions");
  db = Object.fromEntries(["users", "platformConnections", "platformOauthStates", "platformWebhookReceipts", "platformEvents", "overlayTokens", "multichatStudio", "twitchRewardReceipts", "buildIntentLive"].map(name => [name, database.collection(name)]));
  await db.platformConnections.createIndex({ userId: 1, platform: 1 }, { unique: true });
  await db.platformEvents.createIndex({ userId: 1, platform: 1, eventId: 1 }, { unique: true });
  await db.platformWebhookReceipts.createIndex({ platform: 1, messageId: 1 }, { unique: true });
  await db.multichatStudio.createIndex({ studioKey: 1 }, { unique: true, sparse: true });
  receipts = new TwitchRewardReceipts(db.twitchRewardReceipts, () => now);
  await receipts.ensureIndexes();
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });

beforeEach(async () => {
  await Promise.all(Object.values(db).map(collection => collection.deleteMany({})));
  await db.users.insertMany([{ userId: OWNER, preferences: { multichat: { tts: { enabled: true } } } }, { userId: OTHER }]);
  now = NOW; live = true; manageable = true; confirmedStatus = "UNFULFILLED"; current = null;
  speech = jest.fn(async event => event === "overlay:rewardSpeechReady" ? "start-ack-v1" : event === "overlay:rewardSpeech");
  roll = jest.fn(async () => {});
  fetchMock = jest.fn(mockTwitch);
  tokens = new OverlayTokensService(db);
  token = (await tokens.create(OWNER, "My overlay")).token;
  await db.overlayTokens.updateOne({ token }, { $set: { enabledWidgets: ["randomizer", "chat-poll", "chat-highlight", "session-recap", "stream-scene", "multichat"] } });
  const io = {
    to: () => ({ emit: jest.fn() }),
    in: room => ({ fetchSockets: async () => room === `user:${OWNER}` ? [{ data: { kind: "device", userId: OWNER } }]
      : room === `overlay:${token}` ? ["chat-poll", "chat-highlight", "session-recap", "stream-scene", "multichat"].map(widget => ({
        data: { kind: "overlay", overlayToken: token, overlayUserId: OWNER, overlayPresence: { surface: "widget", widget } },
        timeout: () => ({ emitWithAck: speech }),
      })) : [] }),
  };
  studio = new MultichatStudioService(db, { overlayTokens: tokens, io, now: () => now });
  const config = { enabled: true, encryptionKey: Buffer.alloc(32, 27), twitch: { clientId: "fixture-app", clientSecret: "fixture-only", webhookSecret: SECRET, redirectUri: "https://fixture.invalid/callback" } };
  const scopes = oauth.scopesForPurpose("twitch", "rewards");
  integrations = new PlatformIntegrationsService(db, { config, overlayTokens: tokens, io, now: () => now, fetchImpl: fetchMock,
    oauth: { ...oauth, validateTwitchUserToken: jest.fn(async () => ({ userId: BROADCASTER, clientId: "fixture-app", scopes })) } });
  await integrations.vault.saveConnection(OWNER, "twitch", { accessToken: "fixture-access", refreshToken: "fixture-refresh", platformUserId: BROADCASTER,
    platformUserName: "Fixture broadcaster", expiresAt: new Date(now + 3_600_000), scopes, metadata: { rewardsConsent: true } });
  const builds = [{ slug: "build-a", name: "Macro" }, { slug: "build-b", name: "Pressure" }];
  const actions = new TwitchRewardActions({ tokens, studio, io, now: () => now,
    users: { getPreferences: async owner => (await db.users.findOne({ userId: owner }))?.preferences?.multichat },
    customBuilds: { list: async owner => owner === OWNER ? builds : [], get: async (owner, slug) => owner === OWNER ? builds.find(build => build.slug === slug) : null },
    buildIntents: { live: { users: db.users, rewardReroll: roll } },
    broker: { latest: () => current, currentGameKey: () => current?.gameKey || null },
  });
  service = new TwitchRewardsService({ users: db.users, integrations, receipts, actions, now: () => now,
    provider: new TwitchRewardProvider(new TwitchAutomationProvider({ clientId: "fixture-app", timeoutMs: 3000 })) });
  const auth = (req, _res, next) => { req.auth = { userId: req.headers["x-owner"] || OWNER, source: req.headers["x-source"] || "clerk" }; next(); };
  app = express();
  app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  app.use("/v1", buildPlatformIntegrationsRouter({ auth, integrations, rewards: service }));
  app.use("/v1", buildTwitchRewardsRouter({ auth, rewards: service }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code, message: error.message } }));
});

function mockTwitch(url, init) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://api.twitch.tv") throw new Error("Unexpected provider address");
  if (parsed.pathname === "/helix/streams") return Promise.resolve(Response.json({ data: live ? [{ user_id: BROADCASTER, type: "live" }] : [] }));
  if (parsed.pathname.endsWith("/custom_rewards")) {
    if (init.method === "POST") return Promise.resolve(Response.json({ data: [{ id: "created-reward", broadcaster_id: BROADCASTER, ...JSON.parse(init.body) }] }));
    const row = { id: "reward-id", title: "Fixture reward", broadcaster_id: BROADCASTER, is_enabled: true, should_redemptions_skip_request_queue: false };
    return Promise.resolve(Response.json({ data: parsed.searchParams.has("only_manageable_rewards") && !manageable ? [] : [row] }));
  }
  if (parsed.pathname.endsWith("/redemptions")) {
    const status = init.method === "PATCH" ? JSON.parse(init.body).status : confirmedStatus;
    return Promise.resolve(Response.json({ data: [{ id: parsed.searchParams.get("id"), status, broadcaster_id: BROADCASTER, reward: { id: "reward-id" } }] }));
  }
  throw new Error("Unexpected provider request");
}

function payload(id = "redeem-1", extra = {}) {
  return { subscription: { type: SUBSCRIPTION, version: "1", status: "enabled", condition: { broadcaster_user_id: BROADCASTER } },
    event: { id, broadcaster_user_id: BROADCASTER, user_id: "900", user_name: "Fixture viewer", user_login: "fixture-viewer",
      user_input: "<b>My private test line</b>", status: "unfulfilled", reward: { id: "reward-id", title: "Fixture reward" }, redeemed_at: new Date(now).toISOString(), ...extra } };
}

function webhook(messageId, event = payload(), { header = SUBSCRIPTION, signature } = {}) {
  const body = JSON.stringify(event), timestamp = new Date(now).toISOString();
  const signed = signature || `sha256=${createHmac("sha256", SECRET).update(messageId + timestamp + body).digest("hex")}`;
  return request(app).post("/v1/webhooks/twitch/eventsub").type("json").set("Twitch-EventSub-Message-Id", messageId)
    .set("Twitch-EventSub-Message-Type", "notification").set("Twitch-EventSub-Message-Timestamp", timestamp)
    .set("Twitch-EventSub-Subscription-Type", header).set("Twitch-EventSub-Message-Signature", signed).send(body);
}

function settings(action, settlement = "none", extra = {}) {
  return { enabled: true, target: targetId(token), mappings: [{ rewardId: "reward-id", action, cooldownSec: 60, enabled: true, settlement,
    buildIds: action === "buildVote" ? ["build-a", "build-b"] : [], ...extra }] };
}
const save = (action, settlement) => request(app).put(SETTINGS).send(settings(action, settlement)).expect(200);
const recent = () => receipts.recent(OWNER);
const patchCalls = () => fetchMock.mock.calls.filter(([, options]) => options.method === "PATCH");

test("scope is requested only for explicit Twitch reward consent and stays owner-only", async () => {
  for (const purpose of ["alerts", "predictions", "streaming", "chat"]) expect(oauth.scopesForPurpose("twitch", purpose)).not.toContain(oauth.TWITCH_REWARD_SCOPE);
  const connected = await request(app).post("/v1/me/integrations/twitch/connect").send({ purpose: "rewards" }).expect(200);
  expect(new URL(connected.body.authorizeUrl).searchParams.get("scope").split(" ")).toContain(oauth.TWITCH_REWARD_SCOPE);
  await request(app).post("/v1/me/integrations/kick/connect").send({ purpose: "rewards" }).expect(400);
  await request(app).get(SETTINGS).set("x-source", "device").expect(403);
  const status = await request(app).get(SETTINGS).expect(200);
  expect(status.headers["cache-control"]).toBe("private, no-store");
  expect(status.body.settings.enabled).toBe(false);
  expect(JSON.stringify(status.body)).not.toContain(token);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a signed webhook records before ACK, waits for no provider work and dedupes different transport messages", async () => {
  await save("recap", "both"); fetchMock.mockClear();
  const wake = jest.spyOn(service, "wake");
  await webhook("bad-sig", payload(), { signature: `sha256=${"0".repeat(64)}` }).expect(403);
  await webhook("other-type", payload(), { header: "channel.follow" }).expect(204);
  await webhook("other-owner", payload("redeem-1", { broadcaster_user_id: "77" })).expect(204);
  expect(await recent()).toEqual([]);
  await Promise.all([webhook("delivery-1").expect(204), webhook("delivery-2").expect(204)]);
  expect(wake).toHaveBeenCalledTimes(1);
  expect(await recent()).toEqual([expect.objectContaining({ state: "pending", action: "recap" })]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await studio.get(token)).recapSeq).toBe(0);
  await Promise.all([service.sweep(), service.sweep()]);
  expect((await studio.get(token)).recapSeq).toBe(1);
  expect(patchCalls()).toHaveLength(1);
  expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: "FULFILLED" });
  await webhook("late-duplicate").expect(204); await service.sweep();
  expect((await studio.get(token)).recapSeq).toBe(1);
  expect(await recent()).toEqual([expect.objectContaining({ state: "applied", settlement: "fulfilled" })]);
});

test("an explicit owner request creates a disabled manageable reward with the request queue enabled", async () => {
  const input = { title: "Fixture new reward", cost: 500, requiresInput: true };
  await request(app).post(`${SETTINGS}/catalog`).set("x-source", "device").send(input).expect(403);
  expect(fetchMock).not.toHaveBeenCalled();
  const created = await request(app).post(`${SETTINGS}/catalog`).send(input).expect(201);
  expect(created.body.reward).toMatchObject({ id: "created-reward", title: input.title, enabled: false, manageable: true, autoSkipsQueue: false });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: input.title, cost: 500, is_user_input_required: true, is_enabled: false, should_redemptions_skip_request_queue: false });
});

test("unknown actions, foreign targets and disabled permission cannot dispatch", async () => {
  await request(app).put(SETTINGS).send(settings("custom-command")).expect(400);
  await request(app).put(SETTINGS).set("x-owner", OTHER).send(settings("recap")).expect(403);
  await save("recap");
  await integrations.vault.updateMetadata(OWNER, "twitch", { rewardsConsent: false });
  await webhook("no-consent").expect(204);
  expect(await recent()).toEqual([]);
  expect((await studio.get(token)).recapSeq).toBe(0);
});

test("a viewer cooldown skips repeated distinct redemptions and a verified offline failure can refund", async () => {
  await save("recap", "refund");
  await webhook("delivery-1").expect(204); await service.sweep();
  now += 1000;
  await webhook("delivery-2", payload("redeem-2")).expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "skipped", reason: "viewer_cooldown", settlement: "refunded" });
  live = false; now += 2000;
  await webhook("delivery-3", payload("redeem-3", { user_id: "901" })).expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "skipped", reason: "channel_offline", settlement: "refunded" });
  expect(patchCalls().map(([, init]) => JSON.parse(init.body).status)).toEqual(["CANCELED", "CANCELED"]);
  expect((await studio.get(token)).recapSeq).toBe(1);
});

test("never sends a PATCH for an unmanaged reward or one already settled by Twitch", async () => {
  await save("recap", "both");
  manageable = false;
  await webhook("delivery-1").expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "applied", settlement: "unmanaged" });
  manageable = true; confirmedStatus = "FULFILLED"; now += 61_000;
  await webhook("delivery-2", payload("redeem-2")).expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "applied", settlement: "already_settled" });
  expect(patchCalls()).toHaveLength(0);
});

test("a queued action is invalidated after disabling and re-enabling the same settings", async () => {
  await save("recap", "both");
  await webhook("delivery-1").expect(204);
  await request(app).put(SETTINGS).send({ ...settings("recap"), enabled: false }).expect(200);
  await save("recap", "both");
  await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "skipped", reason: "mapping_changed" });
  expect((await studio.get(token)).recapSeq).toBe(0);
  expect(patchCalls()).toHaveLength(0);
});

test("pins sanitized viewer text and leaves it out of private activity and the terminal receipt", async () => {
  await save("pin");
  await webhook("delivery-1").expect(204); await service.sweep();
  expect((await studio.get(token)).highlight).toMatchObject({ text: "My private test line", user: "Fixture viewer" });
  const record = await db.twitchRewardReceipts.findOne({ kind: "redemption" });
  expect(record).not.toHaveProperty("input"); expect(record).not.toHaveProperty("viewerId");
  const result = await request(app).get(SETTINGS).expect(200);
  expect(JSON.stringify(result.body.activity)).not.toMatch(/private test line|Fixture viewer|redeem-1|900/);
  expect((await request(app).get(SETTINGS).set("x-owner", OTHER).expect(200)).body.activity).toEqual([]);
});

test("build vote uses saved owner builds and preserves an already open poll", async () => {
  await save("buildVote");
  await studio.update(token, { poll: { question: "Owner poll", options: ["Yes", "No"], status: "open" } });
  await webhook("delivery-1").expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ reason: "poll_open" });
  expect((await studio.get(token)).poll.question).toBe("Owner poll");
  await studio.update(token, { poll: null });
  now += 61_000;
  await webhook("delivery-2", payload("redeem-2")).expect(204); await service.sweep();
  expect((await studio.get(token)).poll).toMatchObject({ options: ["Macro", "Pressure"], meta: { kind: "build" } });
});

test("b-roll advances only an active configured cover and speech uses one current audio source", async () => {
  await save("broll");
  const clips = ["a", "b"].map((id, index) => ({ id, title: `Highlight ${id}`, videoId: "AAAAAAAAAAA", startSeconds: 15 * index, endSeconds: 15 * index + 10 }));
  await studio.update(token, { scene: { mode: "brb" }, broll: { clips } });
  await webhook("delivery-1").expect(204); await service.sweep();
  expect((await studio.get(token)).broll.skipNonce).toBe(1);
  await save("tts", "fulfill"); now += 61_000;
  await webhook("delivery-2", payload("redeem-2")).expect(204); await service.sweep();
  expect(speech.mock.calls.map(([event]) => event)).toEqual(["overlay:rewardSpeechReady", "overlay:rewardSpeech"]);
  expect(speech).toHaveBeenLastCalledWith("overlay:rewardSpeech", { id: "redeem-2", name: "Fixture viewer", text: "My private test line" });
  expect((await recent())[0]).toMatchObject({ state: "applied", settlement: "fulfilled" });
});

test("a negative speech start ACK leaves a redemption awaiting manual settlement", async () => {
  await save("tts", "fulfill");
  speech.mockImplementation(async event => event === "overlay:rewardSpeechReady" ? "start-ack-v1" : false);
  await webhook("delivery-1").expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "skipped", reason: "audio_unavailable" });
  expect(patchCalls()).toHaveLength(0);
});

test("randomizer waits for a different eligible desktop game and settles after the actual reroll", async () => {
  await db.users.updateOne({ userId: OWNER }, { $set: { "preferences.randomizer": { matchups: { PvZ: { enabled: true, builds: [
    { id: "build-a", name: "Macro", weight: 1 }, { id: "build-b", name: "Pressure", weight: 1 },
  ] } } } } });
  const game = key => ({ gameKey: key, phase: "match_started", isReplay: false, receivedAt: now, capturedAt: now,
    user: { name: "My player", race: "Protoss" }, opponent: { name: "Opponent", race: "Zerg" }, players: [{ name: "My player", type: "user" }, { name: "Opponent", type: "user" }] });
  current = game("Opponent|My player|123");
  await save("randomizer", "fulfill");
  await webhook("delivery-1").expect(204); await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "awaiting_game" });
  await service.onDeviceGame(OWNER, current);
  expect(roll).not.toHaveBeenCalled(); expect(patchCalls()).toHaveLength(0);
  now += 2000; current = game("Opponent|My player|456");
  await service.onDeviceGame(OWNER, current);
  expect(roll).toHaveBeenCalledWith(OWNER, current.gameKey, "PvZ", "redeem-1");
  expect((await recent())[0]).toMatchObject({ state: "applied", settlement: "fulfilled" });
});

test("a desktop-only game leaves its viewer reroll queued for the next eligible game", async () => {
  await db.users.updateOne({ userId: OWNER }, { $set: { "preferences.randomizer": { rollOnDesktop: true, matchups: { PvZ: {
    enabled: true, builds: [{ id: "a", name: "Macro" }, { id: "b", name: "Pressure" }],
  } } } } });
  const game = key => ({ gameKey: key, phase: "match_started", isReplay: false, receivedAt: now, capturedAt: now,
    user: { name: "My player", race: "Protoss" }, opponent: { name: "Opponent", race: "Zerg" },
    players: [{ name: "My player", type: "user" }, { name: "Opponent", type: "user" }] });
  current = game("Opponent|My player|123");
  await save("randomizer", "both");
  await webhook("delivery-1").expect(204);
  await service.sweep();
  const before = await receipts.waiting(OWNER);
  roll.mockRejectedValueOnce(Object.assign(new Error("local draw"), { code: "desktop_roll_local" }));
  now += 2000;
  current = game("Opponent|My player|456");
  await service.onDeviceGame(OWNER, current);
  const waiting = await receipts.waiting(OWNER);
  expect(waiting).toMatchObject({ gameKey: current.gameKey, deadlineAt: before.deadlineAt });
  expect(patchCalls()).toHaveLength(0);
  await service.onDeviceGame(OWNER, current);
  expect(roll).toHaveBeenCalledTimes(1);
  now += 2000;
  current = game("Opponent|My player|789");
  await service.onDeviceGame(OWNER, current);
  expect(roll).toHaveBeenCalledTimes(2);
  expect((await recent())[0]).toMatchObject({ state: "applied", settlement: "fulfilled" });
});

test("recovery marks an abandoned dispatch unconfirmed without replaying its action or refund", async () => {
  await save("recap", "both");
  await webhook("delivery-1").expect(204);
  const [row] = await receipts.pending();
  expect(await receipts.claim(row)).toBe(true);
  now += 3 * 60_000;
  await service.sweep();
  expect((await recent())[0]).toMatchObject({ state: "unknown", reason: "dispatch_unconfirmed" });
  expect((await studio.get(token)).recapSeq).toBe(0); expect(patchCalls()).toHaveLength(0);
});

test("the server-only next-game seam replaces a real first pick once under the Mongo CAS", async () => {
  const builds = [{ key: "build-a", name: "Macro", source: "catalog" }, { key: "build-b", name: "Pressure", source: "catalog" }];
  await db.users.updateOne({ userId: OWNER }, { $set: { "preferences.randomizer": { matchups: { PvZ: {
    enabled: true, builds: builds.map(build => ({ id: build.key, name: build.name, weight: 1 })),
  } } } } });
  const gameKey = "Opponent|My player|456";
  const candidate = { userId: OWNER, gameKey, gameId: null, declared: null, randomizer: { ...builds[0], verifiedPool: true } };
  await db.buildIntentLive.insertOne(candidate);
  const native = {
    collection: db.buildIntentLive, users: db.users, now: () => now,
    broker: { currentGameKey: () => gameKey, latest: () => ({ gameKey, phase: "match_started", isReplay: false, receivedAt: now,
      user: { race: "Protoss" }, opponent: { race: "Zerg" } }) },
    options: { forMatchup: async () => ({ builds }), resolveKey: async (_owner, _matchup, key) => builds.find(build => build.key === key), invalidate: jest.fn() },
    notifier: { overlay: jest.fn(), changed: jest.fn() }, _state: (_owner, state) => state,
  };
  const body = { matchup: "PvZ", revealInWidget: true, releaseHold: false };
  expect(await nativeRandomizerRoll(native, OWNER, gameKey, body)).toMatchObject({ randomizer: { key: "build-a" } });
  expect(native.notifier.changed).not.toHaveBeenCalled();
  const settled = await Promise.allSettled([nativeRandomizerRoll(native, OWNER, gameKey, body, "reward-a"), nativeRandomizerRoll(native, OWNER, gameKey, body, "reward-b")]);
  expect(settled.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect((await db.buildIntentLive.findOne({ userId: OWNER, gameKey })).randomizer).toMatchObject({ key: "build-b", rewardRerolled: true, rerolledAt: new Date(now), widgetReveal: true });
  await expect(nativeRandomizerRoll(native, OWNER, gameKey, body, "reward-c")).rejects.toMatchObject({ code: "randomizer_already_rerolled" });
  expect(native.notifier.changed).toHaveBeenCalledTimes(1);
});


test("account export includes only the caller's redacted Twitch activity", async () => {
  const receivedAt = new Date();
  const publicFields = { rewardId: "reward", rewardTitle: "Replay recap", receivedAt, action: "pin", state: "pending" };
  const privateFields = { input: "viewer private text", viewerId: "viewer-1", name: "Viewer", login: "view_login",
    broadcasterId: "42", redemptionId: "opaque-redemption", settingsKey: "internal-fence", gameKey: "private-game" };
  await db.twitchRewardReceipts.insertMany([
    { ...publicFields, ...privateFields, userId: OWNER, kind: "redemption" },
    { ...publicFields, userId: OTHER, kind: "redemption", rewardId: "other-owner-reward" },
    { userId: OWNER, kind: "cooldown", expiresAt: new Date(Date.now() + 60_000) },
  ]);
  const archive = await collectAccountExport(db, OWNER);
  expect(archive.data.twitchRewardReceipts).toEqual([publicFields]);
});
