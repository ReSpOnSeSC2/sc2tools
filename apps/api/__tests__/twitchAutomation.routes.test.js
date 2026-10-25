// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server"), { MongoClient } = require("mongodb");
const { UsersService } = require("../src/services/users");
const { TwitchAutomationService } = require("../src/services/twitchAutomation");
const { TwitchAutomationStatus } = require("../src/services/twitchAutomationStatus");
const { TwitchAutomationReceipts } = require("../src/services/twitchAutomationReceipts");
const { buildTwitchAutomationRouter } = require("../src/routes/twitchAutomation");
const { buildMeRouter } = require("../src/routes/me");
const { GdprService, GDPR_CLASSIFICATION } = require("../src/services/gdpr");
const { COLLECTIONS } = require("../src/config/constants");
let mongo, client, database, db, users, automation, status, integrations, provider, tokens, connection, app;
const grant = { platformUserId: "42", connectionRevision: "private-revision", accessToken: "private-secret", assertCurrent: async () => {} };
const key = "Synthetic rival|Synthetic owner|1792929600000";
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); database = client.db("twitch_routes"); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  db = { db: database, users: database.collection("users"), games: database.collection("games"), twitchAutomationReceipts: database.collection("receipts") };
  await db.games.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  await db.users.deleteMany({}); await db.twitchAutomationReceipts.deleteMany({}); await db.users.insertMany([{ userId: "owner-A" }, { userId: "owner-B" }]);
  users = new UsersService(db); const receipts = new TwitchAutomationReceipts({ collection: db.twitchAutomationReceipts }); await receipts.ensureIndexes();
  connection = { platform: "twitch", configured: true, connected: true, ready: true, platformUserId: "42", scopes: ["channel:manage:predictions", "channel:manage:broadcast"], predictionsConsent: true, streamingConsent: true };
  integrations = { statuses: jest.fn(async () => ({ platforms: [connection] })), withTwitchAutomationGrant: jest.fn(async (_owner, _permission, work) => work(grant)), isConfigured: () => true };
  provider = { broadcaster: jest.fn(async () => ({ eligible: true })), isLive: jest.fn(async () => true), endPrediction: jest.fn(async (_grant, _id, state) => ({ status: state })) };
  automation = new TwitchAutomationService({ users, usersCollection: db.users, integrations, receipts, provider });
  status = new TwitchAutomationStatus({ automation, broker: { currentGameKey: () => key } });
  tokens = { resolve: jest.fn(async token => token === "owned" ? { userId: "owner-A" } : token === "foreign" ? { userId: "owner-B" } : null), withWrite: jest.fn(async (_token, callback) => callback()) };
  const auth = (req, _res, next) => { req.auth = { source: req.headers["x-source"] || "clerk", userId: req.headers["x-owner"] || "owner-A" }; next(); };
  app = express(); app.use(express.json()); app.use("/v1", buildMeRouter({ users, auth })); app.use("/v1", buildTwitchAutomationRouter({ auth, automation, status, tokens }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code, message: error.message } }));
});
async function active(owner = "owner-A") {
  await automation.deps.receipts.reserve(owner, key, { accountId: "42", connectionRevision: "private-revision", opponentKey: "hashed-opponent", prediction: "pending", marker: "disabled" });
  const ticket = await automation.deps.receipts.claim(owner, key, "prediction", "pending", "creating");
  await automation.deps.receipts.finish(ticket, "active", { predictionId: "private-provider-id", winId: "private-win", lossId: "private-loss" });
}

test("strict owner preference Save defaults off, keeps other types and cannot enable the server gate", async () => {
  const initial = await request(app).get("/v1/me/preferences/twitchAutomation"); expect(initial.body).toMatchObject({ predictionsEnabled: false, markersEnabled: false, windowSec: 120 }); expect(initial.headers["cache-control"]).toBe("private, no-store");
  await request(app).put("/v1/me/preferences/misc").send({ keep: "saved" }).expect(200);
  await request(app).put("/v1/me/preferences/twitchAutomation").send({ predictionsEnabled: true, markersEnabled: true, windowSec: 30 }).expect(200);
  expect((await db.users.findOne({ userId: "owner-A" })).preferences.misc).toEqual({ keep: "saved" }); expect((await db.users.findOne({ userId: "owner-B" })).preferences).toBeUndefined();
  await request(app).put("/v1/me/preferences/twitchAutomation").set("x-source", "device").send({ predictionsEnabled: true }).expect(403);
  expect(automation.deps.enabled).toBeUndefined(); expect(provider.isLive).not.toHaveBeenCalled();
});
test.each([{ predictionsEnabled: "true" }, { markersEnabled: 1 }, { windowSec: 301 }, { titleTemplate: "{secret}" }, { accessToken: "forbidden" }])("malformed settings fail before any write: %j", async body => {
  await request(app).put("/v1/me/preferences/twitchAutomation").send(body).expect(400); expect((await db.users.findOne({ userId: "owner-A" })).preferences).toBeUndefined();
});
test("corrupt legacy read sanitizes fields and strips unknown data", async () => {
  await db.users.updateOne({ userId: "owner-A" }, { $set: { "preferences.twitchAutomation": { predictionsEnabled: "true", markersEnabled: true, windowSec: 1, secret: "must-not-expose" } } });
  const response = await request(app).get("/v1/me/preferences/twitchAutomation"); expect(response.body).toMatchObject({ predictionsEnabled: false, markersEnabled: true, windowSec: 120 }); expect(JSON.stringify(response.body)).not.toContain("must-not-expose");
});
test("default-off Settings status is honest, private and performs zero provider operations", async () => {
  const response = await request(app).get("/v1/me/twitch-automation").expect(200);
  expect(response.body).toMatchObject({ serverEnabled: false, reason: "server_not_enabled", rankedQueueSupported: false, capabilityReason: "ranked_status_unavailable", eligible: null });
  expect(response.headers["cache-control"]).toBe("private, no-store"); expect(response.headers.vary).toContain("Authorization"); expect(provider.broadcaster).not.toHaveBeenCalled(); expect(integrations.withTwitchAutomationGrant).not.toHaveBeenCalled();
  await request(app).get("/v1/me/twitch-automation").set("x-source", "device").expect(403);
});
test("enabled mocked Settings verification is cached and Dock reads never poll Twitch", async () => {
  automation.deps.enabled = true;
  const first = await request(app).get("/v1/me/twitch-automation").expect(200); expect(first.body).toMatchObject({ eligible: true, isLive: true, predictionPermission: true, markerPermission: true });
  await request(app).get("/v1/me/twitch-automation").expect(200); const dock = await request(app).get("/v1/multichat/owned/twitch-automation").expect(200);
  expect(provider.broadcaster).toHaveBeenCalledTimes(1); expect(provider.isLive).toHaveBeenCalledTimes(1); expect(dock.body).not.toHaveProperty("preferences"); expect(JSON.stringify(dock.body)).not.toMatch(/private-secret|private-revision|platformUserId|titleTemplate/);
});
test.each([[false, true, "affiliate_or_partner_required"], [true, false, "channel_offline"]])("eligibility/live failures are explicit without provider writes", async (eligible, isLive, reason) => {
  automation.deps.enabled = true; provider.broadcaster.mockResolvedValue({ eligible }); provider.isLive.mockResolvedValue(isLive);
  expect((await request(app).get("/v1/me/twitch-automation")).body.reason).toBe(reason); expect(provider.endPrediction).not.toHaveBeenCalled();
});
test("provider403 is reconnect status and no raw error/body/secret leaves status", async () => {
  automation.deps.enabled = true; provider.broadcaster.mockRejectedValue(Object.assign(new Error("private-secret"), { status: 403 }));
  const response = await request(app).get("/v1/me/twitch-automation"); expect(response.body.reason).toBe("reconnect_required"); expect(JSON.stringify(response.body)).not.toContain("private-secret");
});
test("token cancellation requires exact confirmation, active admission and owner scope", async () => {
  automation.deps.enabled = true; await active();
  await request(app).post("/v1/multichat/owned/twitch-automation").send({ action: "cancel", gameKey: key }).expect(400);
  await request(app).post("/v1/multichat/retired/twitch-automation").send({ action: "cancel", gameKey: key, confirmed: true }).expect(401);
  await request(app).post("/v1/multichat/foreign/twitch-automation").send({ action: "cancel", gameKey: key, confirmed: true }).expect(404);
  const result = await request(app).post("/v1/multichat/owned/twitch-automation").send({ action: "cancel", gameKey: key, confirmed: true }).expect(200);
  expect(result.body.current.prediction).toBe("canceled"); expect(provider.endPrediction).toHaveBeenCalledTimes(1); expect(tokens.withWrite).toHaveBeenCalledWith("owned", expect.any(Function));
});
test("gate-off control never changes a durable intent or calls the provider", async () => {
  await active(); await request(app).post("/v1/multichat/owned/twitch-automation").send({ action: "cancel", gameKey: key, confirmed: true }).expect(503);
  expect((await automation.deps.receipts.read("owner-A", key)).settlement).toBeUndefined(); expect(provider.endPrediction).not.toHaveBeenCalled();
});
test("an expired/replaced token after preflight cannot enter the action callback", async () => {
  automation.deps.enabled = true; await active(); tokens.resolve.mockResolvedValueOnce({ userId: "owner-A" }).mockResolvedValueOnce(null);
  await request(app).post("/v1/multichat/owned/twitch-automation").send({ action: "cancel", gameKey: key, confirmed: true }).expect(401); expect(provider.endPrediction).not.toHaveBeenCalled();
});
test("previous open prediction remains reachable when current rematch is skipped", async () => {
  await active(); status.broker.currentGameKey = () => "new-game";
  await automation.deps.receipts.reserve("owner-A", "new-game", { accountId: "42", connectionRevision: "private-revision", opponentKey: "hashed-opponent", prediction: "skipped", marker: "disabled", reason: "rematch_cooldown" });
  const response = await request(app).get("/v1/multichat/owned/twitch-automation"); expect(response.body.current).toMatchObject({ gameKey: key, prediction: "active" });
});
test("registered provider journal is purge-only; erasure deletes only this owner and snapshots cannot restore it", async () => {
  expect(GDPR_CLASSIFICATION.TWITCH_AUTOMATION_RECEIPTS).toBe("purge_only"); expect(COLLECTIONS.TWITCH_AUTOMATION_RECEIPTS).toBe("twitch_automation_receipts");
  await active(); await active("owner-B");
  const gdpr = new GdprService(db, {});
  // Real erasure over disposable collections; no identity/provider adapters.
  const exported = await gdpr.export("owner-A"); expect(exported.data).not.toHaveProperty("twitchAutomationReceipts");
  await gdpr.deleteAll("owner-A");
  expect(await db.twitchAutomationReceipts.countDocuments({ userId: "owner-A" })).toBe(0); expect(await db.twitchAutomationReceipts.countDocuments({ userId: "owner-B" })).toBe(1);
});
