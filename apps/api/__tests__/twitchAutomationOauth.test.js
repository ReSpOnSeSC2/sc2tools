// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const express = require("express"), request = require("supertest");
const oauth = require("../src/services/platformOauthClients");
const { PlatformIntegrationsService } = require("../src/services/platformIntegrations");
const { buildPlatformIntegrationsRouter } = require("../src/routes/platformIntegrations");
let mongo, client, db, service, providerFetch, hooks, scopes, identity, now;
const KEY = Buffer.alloc(32, 53), OWNER = "automation-owner";
const configuration = { enabled: true, encryptionKey: KEY, twitch: { clientId: "mock-client", clientSecret: "mock-secret", redirectUri: "https://api.fixture.invalid/v1/integrations/twitch/callback" } };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); const database = client.db("twitch_automation_oauth"); db = { platformConnections: database.collection("connections"), platformOauthStates: database.collection("states"), platformWebhookReceipts: database.collection("receipts"), platformEvents: database.collection("events") }; await db.platformConnections.createIndex({ userId: 1, platform: 1 }, { unique: true }); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(db)) await collection.deleteMany({}); now = Date.UTC(2026, 9, 25, 12); scopes = oauth.scopesForPurpose("twitch", "predictions"); identity = "42";
  providerFetch = jest.fn(async () => { throw new Error("Real provider access is forbidden"); });
  hooks = { ...oauth, validateTwitchUserToken: jest.fn(async () => ({ userId: identity, userName: "Synthetic broadcaster", clientId: configuration.twitch.clientId, scopes })),
    exchangeTwitchCode: jest.fn(async () => ({ accessToken: "mock-new-access", refreshToken: "mock-new-refresh", scopes, expiresAt: new Date(now + 3600000) })),
    getTwitchAppToken: jest.fn(async () => "mock-app-token"), reconcileTwitchEventSubscriptions: jest.fn(async () => {}), revokeTwitchToken: jest.fn(async () => {}) };
  service = new PlatformIntegrationsService(db, { config: configuration, overlayTokens: { list: async () => [] }, oauth: hooks, fetchImpl: providerFetch, now: () => now });
});
async function connect(metadata = { predictionsConsent: true }, granted = scopes) {
  await service.vault.saveConnection(OWNER, "twitch", { accessToken: "mock-access", refreshToken: "mock-refresh", expiresAt: new Date(now + 3600000), platformUserId: "42", platformUserName: "Synthetic broadcaster", scopes: granted, metadata });
}
const complete = async (purpose = "predictions") => { const flow = await service.begin(OWNER, "twitch", { purpose }); const state = new URL(flow.authorizeUrl).searchParams.get("state"); await service.complete("twitch", { state, code: "disposable-code" }); };

test("predictions permission is incremental, explicit and Twitch-only", () => {
  expect(oauth.scopesForPurpose("twitch")).not.toContain("channel:manage:predictions");
  expect(oauth.scopesForPurpose("twitch", "streaming")).not.toContain("channel:manage:predictions");
  expect(oauth.scopesForPurpose("twitch", "predictions")).toEqual([...oauth.TWITCH_SCOPES, "channel:manage:predictions"]);
  expect(oauth.scopesForPurpose("twitch", "predictions", oauth.STREAMING_SCOPES.twitch)).toEqual([...oauth.TWITCH_SCOPES, "channel:manage:predictions", "channel:manage:broadcast"]);
  for (const platform of ["kick", "youtube"]) expect(() => oauth.scopesForPurpose(platform, "predictions")).toThrow();
});
test("owner connect route requests predictions only for the explicit purpose", async () => {
  const app = express(); app.use(express.json()); app.use(buildPlatformIntegrationsRouter({ integrations: service, auth: (req, _res, next) => { req.auth = { source: "clerk", userId: OWNER }; next(); } })); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code } }));
  const response = await request(app).post("/me/integrations/twitch/connect").send({ purpose: "predictions" }).expect(200);
  const authorize = new URL(response.body.authorizeUrl); expect(authorize.searchParams.get("scope").split(" ")).toEqual(scopes);
  const pending = await service.vault.consumeOauthState(authorize.searchParams.get("state"), "twitch"); expect(pending).toMatchObject({ userId: OWNER, purpose: "predictions", requiredScopes: scopes });
  await request(app).post("/me/integrations/kick/connect").send({ purpose: "predictions" }).expect(400);
  expect(providerFetch).not.toHaveBeenCalled();
});
test("reconnecting predictions preserves a same-account explicitly granted broadcast scope", async () => {
  scopes = oauth.scopesForPurpose("twitch", "predictions", oauth.STREAMING_SCOPES.twitch); await connect({ streamingConsent: true }, oauth.STREAMING_SCOPES.twitch);
  await complete(); const row = await service.vault.getConnection(OWNER, "twitch");
  expect(row.metadata).toMatchObject({ streamingConsent: true, predictionsConsent: true }); expect(row.scopes).toContain("channel:manage:broadcast");
  expect(providerFetch).not.toHaveBeenCalled(); expect(JSON.stringify(await service.statuses(OWNER))).not.toMatch(/mock-access|mock-new-access|mock-refresh/);
});
test("first prediction consent does not silently enable title/marker streaming controls", async () => {
  await complete(); const row = await service.vault.getConnection(OWNER, "twitch"); expect(row.metadata).toMatchObject({ streamingConsent: false, predictionsConsent: true });
  expect(row.scopes).not.toContain("channel:manage:broadcast");
});
test.each([true, false])("reverse reconnect order preserves prediction consent only on the same broadcaster: %j", async sameAccount => {
  await connect({ predictionsConsent: true });
  scopes = [...oauth.STREAMING_SCOPES.twitch, "channel:manage:predictions"]; if (!sameAccount) identity = "99";
  const flow = await service.begin(OWNER, "twitch", { purpose: "streaming" });
  expect(new URL(flow.authorizeUrl).searchParams.get("scope").split(" ")).toEqual(scopes);
  await service.complete("twitch", { state: new URL(flow.authorizeUrl).searchParams.get("state"), code: "disposable-code" });
  const row = await service.vault.getConnection(OWNER, "twitch"); expect(row.metadata).toMatchObject({ streamingConsent: true, predictionsConsent: sameAccount });
});
test("unconsented prediction scope is not silently re-requested for stream controls", async () => {
  await connect({}, [...oauth.STREAMING_SCOPES.twitch, "channel:manage:predictions"]);
  const flow = await service.begin(OWNER, "twitch", { purpose: "streaming" });
  expect(new URL(flow.authorizeUrl).searchParams.get("scope").split(" ")).toEqual(oauth.STREAMING_SCOPES.twitch);
});
test("account switches do not carry another broadcaster's streaming consent", async () => {
  await connect({ streamingConsent: true }, oauth.STREAMING_SCOPES.twitch); scopes = oauth.scopesForPurpose("twitch", "predictions", oauth.STREAMING_SCOPES.twitch); identity = "99";
  await complete(); const row = await service.vault.getConnection(OWNER, "twitch"); expect(row.platformUserId).toBe("99"); expect(row.metadata).toMatchObject({ streamingConsent: false, predictionsConsent: true });
});
test("missing required incremental scopes never replace the connection", async () => {
  await connect({ streamingConsent: true }, oauth.STREAMING_SCOPES.twitch); const before = await service.vault.getConnectionRevision(OWNER, "twitch");
  scopes = oauth.TWITCH_SCOPES; await expect(complete()).rejects.toMatchObject({ status: 403 }); expect(await service.vault.getConnectionRevision(OWNER, "twitch")).toBe(before);
});
test.each(["consent", "scope"])("a raw grant without prediction %s cannot enter the callback", async denied => {
  await connect(denied === "consent" ? {} : { predictionsConsent: true }, denied === "scope" ? oauth.TWITCH_SCOPES : scopes);
  const callback = jest.fn(); await expect(service.withTwitchAutomationGrant(OWNER, { predictions: true }, callback)).rejects.toMatchObject({ status: 403 }); expect(callback).not.toHaveBeenCalled();
});
test("prediction-only grants use distributed leases without granting unrelated streaming writes", async () => {
  await connect(); let release; const held = new Promise(resolve => { release = resolve; }); let entered; const started = new Promise(resolve => { entered = resolve; });
  const first = service.withTwitchAutomationGrant(OWNER, { predictions: true }, async grant => { await grant.assertCurrent(); entered(); await held; return "done"; }); await started;
  const peer = new PlatformIntegrationsService(db, { config: configuration, overlayTokens: { list: async () => [] }, oauth: hooks, fetchImpl: providerFetch, now: () => now });
  await expect(peer.withTwitchAutomationGrant(OWNER, { predictions: true }, async () => "must-not-enter")).rejects.toMatchObject({ status: 409, code: "streaming_account_busy" });
  release(); expect(await first).toBe("done"); await expect(service.withStreamingGrant(OWNER, "twitch", async () => {})).rejects.toMatchObject({ status: 403 });
});
test("base read-only eligibility checks still acquire a provider lease without write consent", async () => {
  scopes = oauth.TWITCH_SCOPES; await connect({}, scopes);
  const read = await service.withTwitchAutomationGrant(OWNER, {}, async grant => { await grant.assertCurrent(); return grant.platformUserId; }); expect(read).toBe("42"); expect(providerFetch).not.toHaveBeenCalled();
});
test("legacy unleased refreshes cannot overwrite a predictions-enabled connection", async () => {
  await connect(); const row = await service.vault.getConnection(OWNER, "twitch");
  expect(await service.vault.updateTokens(OWNER, "twitch", { accessToken: "stale-worker" }, row.connectionRevision)).toBe(false);
  expect((await service.vault.getConnection(OWNER, "twitch")).accessToken).toBe("mock-access");
});
test("callback authorization failures are not replayed after provider work begins", async () => {
  await connect(); const callback = jest.fn(async () => { throw Object.assign(new Error("Synthetic provider rejection"), { status: 401 }); });
  await expect(service.withTwitchAutomationGrant(OWNER, { predictions: true }, callback)).rejects.toMatchObject({ status: 401 }); expect(callback).toHaveBeenCalledTimes(1);
  expect((await db.platformConnections.findOne({ userId: OWNER })).streamingLease).toBeUndefined();
});
