// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { PlatformIntegrationsService } = require("../src/services/platformIntegrations");
const oauth = require("../src/services/platformOauthClients");

const OWNER = "chat-fixture-owner", KEY = Buffer.alloc(32, 67), NOW = Date.UTC(2026, 10, 5, 12);
const config = { enabled: true, encryptionKey: KEY, ...Object.fromEntries(["twitch", "kick", "youtube"].map(platform => [platform,
  { clientId: `fixture-${platform}`, clientSecret: "fixture-secret", redirectUri: `https://api.fixture.invalid/${platform}/callback` }])) };
let mongo, client, db, service, hooks, grantedScopes, identity;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); const database = client.db("platform_chat_oauth");
  db = Object.fromEntries(["platformConnections", "platformOauthStates", "platformWebhookReceipts", "platformEvents"].map(key => [key, database.collection(key)]));
  await db.platformConnections.createIndex({ userId: 1, platform: 1 }, { unique: true });
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(db)) await collection.deleteMany({});
  identity = "42"; grantedScopes = [...oauth.CHAT_SCOPES.twitch];
  const token = async () => ({ accessToken: "new-private-access", refreshToken: "new-private-refresh", scopes: grantedScopes, expiresAt: new Date(NOW + 3_600_000) });
  hooks = { ...oauth, exchangeTwitchCode: jest.fn(token), exchangeKickCode: jest.fn(token), exchangeYoutubeCode: jest.fn(token),
    validateTwitchUserToken: jest.fn(async () => ({ userId: identity, userName: "fixture_streamer", clientId: config.twitch.clientId, scopes: grantedScopes })),
    getKickCurrentUser: jest.fn(async () => ({ userId: identity, userName: "fixture_streamer" })),
    getKickTokenInfo: jest.fn(async () => ({ clientId: config.kick.clientId, scopes: grantedScopes })),
    getYoutubeCurrentChannel: jest.fn(async () => ({ userId: identity, userName: "fixture_streamer" })),
    getTwitchAppToken: jest.fn(async () => "private-app-token"), reconcileTwitchEventSubscriptions: jest.fn(async () => {}),
    subscribeKickEvents: jest.fn(async () => {}), listYoutubeRecentSubscribers: jest.fn(async () => []),
    revokeTwitchToken: jest.fn(async () => {}), revokeKickToken: jest.fn(async () => {}), revokeYoutubeToken: jest.fn(async () => {}) };
  service = newService();
});
function newService() { return new PlatformIntegrationsService(db, { config, overlayTokens: { list: async () => [] }, oauth: hooks,
  fetchImpl: async () => { throw new Error("Real provider network forbidden"); }, now: () => NOW }); }
async function save(platform, metadata, scopes = oauth.CHAT_SCOPES[platform]) {
  await service.vault.saveConnection(OWNER, platform, { accessToken: "old-private-access", refreshToken: "old-private-refresh",
    platformUserId: "42", platformUserName: "fixture_streamer", scopes, metadata, expiresAt: new Date(NOW + 3_600_000) });
}
async function complete(platform, purpose = "chat") {
  const started = await service.begin(OWNER, platform, { purpose }); const authorize = new URL(started.authorizeUrl);
  grantedScopes = authorize.searchParams.get("scope").split(" ");
  await service.complete(platform, { state: authorize.searchParams.get("state"), code: "disposable-code" });
  return authorize;
}

test("chat scopes require an explicit purpose and preserve previously consented capabilities", () => {
  expect(oauth.scopesForPurpose("twitch")).not.toContain("user:write:chat"); expect(oauth.scopesForPurpose("kick")).not.toContain("chat:write");
  expect(oauth.scopesForPurpose("youtube")).not.toContain("https://www.googleapis.com/auth/youtube.force-ssl");
  expect(oauth.scopesForPurpose("twitch", "chat", [...oauth.STREAMING_SCOPES.twitch, "channel:manage:predictions"]))
    .toEqual([...oauth.CHAT_SCOPES.twitch, "channel:manage:broadcast", "channel:manage:predictions"]);
});

test.each(["twitch", "kick", "youtube"])("%s chat consent installs an authenticated grant without enabling stream controls", async platform => {
  await complete(platform); const row = await service.vault.getConnection(OWNER, platform);
  expect(row.metadata).toMatchObject({ chatConsent: true, streamingConsent: false }); expect(row.scopes).toEqual(oauth.CHAT_SCOPES[platform]);
  expect(await service.withChatGrant(OWNER, platform, async grant => { await grant.assertCurrent(); return grant.platformUserId; })).toBe("42");
  await expect(service.withStreamingGrant(OWNER, platform, async () => "must-not-enter")).rejects.toMatchObject({ status: 403 });
  const status = (await service.statuses(OWNER)).platforms.find(row => row.platform === platform);
  expect(status).toMatchObject({ chatConsent: true, chatAvailable: true }); expect(JSON.stringify(status)).not.toMatch(/private-access|private-refresh|private-app-token/);
});

test.each([true, false])("chat upgrade preserves prior streaming/prediction consent only for the same identity: %s", async sameIdentity => {
  await save("twitch", { streamingConsent: true, predictionsConsent: true }, [...oauth.STREAMING_SCOPES.twitch, "channel:manage:predictions"]);
  if (!sameIdentity) identity = "99";
  await complete("twitch"); const row = await service.vault.getConnection(OWNER, "twitch");
  expect(row.metadata).toMatchObject({ chatConsent: true, streamingConsent: sameIdentity, predictionsConsent: sameIdentity });
  expect(hooks.revokeTwitchToken).toHaveBeenCalled();
});

test.each(["twitch", "kick", "youtube"])("reconnecting %s stream controls preserves the same account's chat consent", async platform => {
  await save(platform, { chatConsent: true }); await complete(platform, "streaming");
  const row = await service.vault.getConnection(OWNER, platform); expect(row.metadata).toMatchObject({ chatConsent: true, streamingConsent: true });
  expect(oauth.CHAT_SCOPES[platform].every(scope => row.scopes.includes(scope))).toBe(true);
});

test.each(["consent", "scope"])("a raw grant without chat %s never enters the provider callback", async missing => {
  await save("twitch", missing === "consent" ? {} : { chatConsent: true }, missing === "scope" ? oauth.TWITCH_SCOPES : oauth.CHAT_SCOPES.twitch);
  const callback = jest.fn(); await expect(service.withChatGrant(OWNER, "twitch", callback)).rejects.toMatchObject({ status: 403 }); expect(callback).not.toHaveBeenCalled();
});

test("a missing chat scope at callback cannot replace the old encrypted connection", async () => {
  await save("twitch", { streamingConsent: true }, oauth.STREAMING_SCOPES.twitch); const revision = await service.vault.getConnectionRevision(OWNER, "twitch");
  const started = await service.begin(OWNER, "twitch", { purpose: "chat" }); grantedScopes = oauth.TWITCH_SCOPES;
  await expect(service.complete("twitch", { state: new URL(started.authorizeUrl).searchParams.get("state"), code: "disposable" })).rejects.toMatchObject({ status: 403 });
  expect(await service.vault.getConnectionRevision(OWNER, "twitch")).toBe(revision);
});

test("chat-only grants use the distributed account lease across workers", async () => {
  await save("twitch", { chatConsent: true }); let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const first = service.withChatGrant(OWNER, "twitch", async () => { entered(); await held; return "done"; }); await started;
  const peer = newService(), callback = jest.fn(); await expect(peer.withChatGrant(OWNER, "twitch", callback)).rejects.toMatchObject({ code: "streaming_account_busy" });
  expect(callback).not.toHaveBeenCalled(); release(); await expect(first).resolves.toBe("done");
  expect((await db.platformConnections.findOne({ userId: OWNER })).streamingLease).toBeUndefined();
});

test("a provider failure after callback entry is never replayed", async () => {
  await save("twitch", { chatConsent: true }); const callback = jest.fn(async () => { throw Object.assign(new Error("synthetic rejection"), { status: 401 }); });
  await expect(service.withChatGrant(OWNER, "twitch", callback)).rejects.toMatchObject({ status: 401 }); expect(callback).toHaveBeenCalledTimes(1);
});

test("unleased background refresh cannot overwrite chat credentials; disconnect revokes authorization", async () => {
  await save("twitch", { chatConsent: true }); const row = await service.vault.getConnection(OWNER, "twitch");
  expect(await service.vault.updateTokens(OWNER, "twitch", { accessToken: "stale-token" }, row.connectionRevision)).toBe(false);
  await service.disconnect(OWNER, "twitch"); expect(hooks.revokeTwitchToken).toHaveBeenCalled();
  await expect(service.withChatGrant(OWNER, "twitch", jest.fn())).rejects.toMatchObject({ status: 403 });
});
