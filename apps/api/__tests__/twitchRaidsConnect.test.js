// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const express = require("express"), request = require("supertest");
const oauth = require("../src/services/platformOauthClients");
const { PlatformIntegrationsService } = require("../src/services/platformIntegrations");
const { buildPlatformIntegrationsRouter } = require("../src/routes/platformIntegrations");
let mongo, client, db, service, providerFetch, hooks, scopes, identity, now;
const KEY = Buffer.alloc(32, 53), OWNER = "raids-owner";
const configuration = { enabled: true, encryptionKey: KEY, twitch: { clientId: "mock-client", clientSecret: "mock-secret", redirectUri: "https://api.fixture.invalid/v1/integrations/twitch/callback" } };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); const database = client.db("twitch_raids_oauth"); db = { platformConnections: database.collection("connections"), platformOauthStates: database.collection("states"), platformWebhookReceipts: database.collection("receipts"), platformEvents: database.collection("events") }; await db.platformConnections.createIndex({ userId: 1, platform: 1 }, { unique: true }); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(db)) await collection.deleteMany({}); now = Date.UTC(2026, 9, 25, 12); scopes = oauth.scopesForPurpose("twitch", "raids"); identity = "42";
  providerFetch = jest.fn(async () => { throw new Error("Real provider access is forbidden"); });
  hooks = { ...oauth, validateTwitchUserToken: jest.fn(async () => ({ userId: identity, userName: "Synthetic broadcaster", clientId: configuration.twitch.clientId, scopes })),
    exchangeTwitchCode: jest.fn(async () => ({ accessToken: "mock-new-access", refreshToken: "mock-new-refresh", scopes, expiresAt: new Date(now + 3600000) })),
    getTwitchAppToken: jest.fn(async () => "mock-app-token"), reconcileTwitchEventSubscriptions: jest.fn(async () => {}), revokeTwitchToken: jest.fn(async () => {}) };
  service = new PlatformIntegrationsService(db, { config: configuration, overlayTokens: { list: async () => [] }, oauth: hooks, fetchImpl: providerFetch, now: () => now });
});
async function connect(metadata = { raidsConsent: true }, granted = scopes) {
  await service.vault.saveConnection(OWNER, "twitch", { accessToken: "mock-access", refreshToken: "mock-refresh", expiresAt: new Date(now + 3600000), platformUserId: "42", platformUserName: "Synthetic broadcaster", scopes: granted, metadata });
}
const complete = async purpose => { const flow = await service.begin(OWNER, "twitch", { purpose }); const state = new URL(flow.authorizeUrl).searchParams.get("state"); await service.complete("twitch", { state, code: "disposable-code" }); return flow; };

test("the raid permission is its own incremental, Twitch-only connect", async () => {
  expect(oauth.scopesForPurpose("twitch", "raids")).toEqual([...oauth.TWITCH_SCOPES, "channel:manage:raids"]);
  expect(oauth.scopesForPurpose("twitch", "predictions")).not.toContain("channel:manage:raids");
  expect(() => oauth.scopesForPurpose("kick", "raids")).toThrow();
  const flow = await service.begin(OWNER, "twitch", { purpose: "raids" });
  expect(new URL(flow.authorizeUrl).searchParams.get("scope").split(" ")).toEqual(scopes);
});

test("a completed Connect raids stores the raid consent, and only that consent", async () => {
  await complete("raids");
  const row = await service.vault.getConnection(OWNER, "twitch");
  expect(row.metadata).toMatchObject({ raidsConsent: true, predictionsConsent: false, rewardsConsent: false, streamingConsent: false });
  expect(row.scopes).toContain("channel:manage:raids");
  expect(await service.withTwitchAutomationGrant(OWNER, { raids: true }, async grant => grant.platformUserId)).toBe("42");
  const twitch = (await service.statuses(OWNER)).platforms.find(item => item.platform === "twitch");
  expect(twitch).toMatchObject({ raidsConsent: true, connected: true });
  expect(providerFetch).not.toHaveBeenCalled();
});

test.each(["consent", "scope"])("a raw grant without the raid %s cannot enter the callback", async denied => {
  await connect(denied === "consent" ? {} : { raidsConsent: true }, denied === "scope" ? oauth.TWITCH_SCOPES : scopes);
  const callback = jest.fn();
  await expect(service.withTwitchAutomationGrant(OWNER, { raids: true }, callback)).rejects.toMatchObject({ status: 403 });
  expect(callback).not.toHaveBeenCalled();
});

test("another connect keeps a granted raid permission on the same account and never adds an unconsented one", async () => {
  await connect({ raidsConsent: true });
  const kept = await service.begin(OWNER, "twitch", { purpose: "predictions" });
  expect(new URL(kept.authorizeUrl).searchParams.get("scope").split(" ")).toContain("channel:manage:raids");
  await connect({}, scopes);
  const dropped = await service.begin(OWNER, "twitch", { purpose: "predictions" });
  expect(new URL(dropped.authorizeUrl).searchParams.get("scope").split(" ")).not.toContain("channel:manage:raids");
});

test("a raid-only grant takes the distributed lease, so a second process cannot enter", async () => {
  await connect(); let release; const held = new Promise(resolve => { release = resolve; }); let entered; const started = new Promise(resolve => { entered = resolve; });
  const first = service.withTwitchAutomationGrant(OWNER, { raids: true }, async grant => { await grant.assertCurrent(); entered(); await held; return "done"; }); await started;
  const peer = new PlatformIntegrationsService(db, { config: configuration, overlayTokens: { list: async () => [] }, oauth: hooks, fetchImpl: providerFetch, now: () => now });
  await expect(peer.withTwitchAutomationGrant(OWNER, { raids: true }, async () => "must-not-enter")).rejects.toMatchObject({ status: 409, code: "streaming_account_busy" });
  release(); expect(await first).toBe("done");
});
