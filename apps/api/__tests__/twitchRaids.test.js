// @ts-nocheck
"use strict";

/**
 * The raid finder end to end against a real in-memory database: its gates and
 * the streamer's switch, the receipt written before Twitch is called, the
 * request shapes, what a queued, refused, unconfirmed or cancelled raid is
 * called, history in and out, and the Stream Dock routes.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { TwitchRaidsService, createTwitchRaids } = require("../src/services/twitchRaids");
const { TwitchRaidProvider } = require("../src/services/twitchRaidProvider");
const { TwitchAutomationProvider } = require("../src/services/twitchAutomationProvider");
const { PlatformEventsService } = require("../src/services/platformEvents");
const { buildTwitchAutomationRouter } = require("../src/routes/twitchAutomation");
const { scopesForPurpose } = require("../src/services/platformOauthClients");
const { loadConfig } = require("../src/config/loader");

const OWNER = "owner-1", OTHER = "owner-2", TOKEN = "dock-token", SELF_ID = "42";
const NOW = Date.UTC(2026, 10, 28, 12);
let mongo, client, users, now, fetchMock, grant, link, live, service, app, leased;

const stream = (n, viewers, extra = {}) => ({
  id: `twitch:${n}`, platform: "twitch", channel: `Chan${n}`, title: "", language: "en", viewers,
  startedAt: "2026-11-28T10:00:00Z", url: `https://www.twitch.tv/chan${n}`, broadcasterId: String(1000 + n), ...extra,
});
const ready = () => ({ platform: "twitch", configured: true, connected: true, ready: true, platformUserId: SELF_ID, platformUserName: "me", scopes: ["channel:manage:raids"], raidsConsent: true });
const reply = (status, body) => ({ ok: status < 400, status, headers: new Headers(), body: body === undefined ? null : new Response(JSON.stringify(body)).body });
const history = async () => (await users.findOne({ userId: OWNER })).preferences?.twitchRaids?.history || [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  users = client.db("twitch_raids").collection("users");
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });

function build({ enabled = true } = {}) {
  const integrations = {
    statuses: jest.fn(async () => ({ platforms: link })),
    withTwitchAutomationGrant: jest.fn(async (userId, permissions, callback) => { leased.push(permissions); return callback(grant); }),
  };
  const provider = new TwitchRaidProvider(new TwitchAutomationProvider({ clientId: "client", timeoutMs: 200 }));
  return new TwitchRaidsService({ users, integrations, provider, enabled, now: () => now, liveStreams: { list: jest.fn(async () => live) } });
}

beforeEach(async () => {
  await users.deleteMany({});
  await users.insertMany([{ userId: OWNER }, { userId: OTHER }]);
  now = NOW; leased = [];
  link = [ready(), { platform: "kick", configured: true, connected: false, ready: false, platformUserId: "", platformUserName: "", scopes: [] }];
  live = { fetchedAt: "2026-11-28T11:59:00Z", platforms: { twitch: "ok", kick: "ok" }, streams: [stream(1, 4), stream(2, 300)] };
  fetchMock = jest.fn(async () => reply(200, { data: [{ created_at: "2026-11-28T12:00:00Z", is_mature: false }] }));
  grant = { accessToken: "mock-bearer", platformUserId: SELF_ID, assertCurrent: jest.fn(async () => {}), boundedFetch: (url, init) => fetchMock(url, init) };
  service = build();
  await service.saveSettings(OWNER, { enabled: true });
});

describe("gates", () => {
  test("the server gate starts off and the switch cannot be saved without the permission", async () => {
    const env = { MONGODB_URI: "mongodb://fixture.invalid/test", CLERK_SECRET_KEY: "mock-only", SERVER_PEPPER_HEX: "a".repeat(64) };
    for (const value of [undefined, "", "false", "1", "on"]) expect(loadConfig({ ...env, TWITCH_RAIDS_ENABLED: value }).twitchRaidsEnabled).toBe(false);
    expect(loadConfig({ ...env, TWITCH_RAIDS_ENABLED: "true" }).twitchRaidsEnabled).toBe(true);
    link = [{ ...ready(), raidsConsent: false }];
    await expect(service.saveSettings(OTHER, { enabled: true })).rejects.toMatchObject({ code: "raid_permission_required" });
    expect((await service.settingsView(OTHER)).enabled).toBe(false);
  });
  test("each gate blocks a raid before Twitch is called", async () => {
    const off = build({ enabled: false });
    await expect(off.start(OWNER, "twitch:1")).rejects.toMatchObject({ code: "server_not_enabled" });
    await users.updateOne({ userId: OWNER }, { $set: { "preferences.twitchRaids.enabled": false } });
    await expect(service.start(OWNER, "twitch:1")).rejects.toMatchObject({ code: "switch_off" });
    await users.updateOne({ userId: OWNER }, { $set: { "preferences.twitchRaids.enabled": true } });
    link = [{ ...ready(), scopes: [] }];
    await expect(service.start(OWNER, "twitch:1")).rejects.toMatchObject({ code: "raid_permission_required" });
    link = [{ ...ready(), connected: false }];
    await expect(service.cancel(OWNER)).rejects.toMatchObject({ code: "connect_twitch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("raids use their own connect scope and only for Twitch", () => {
    expect(scopesForPurpose("twitch", "raids")).toContain("channel:manage:raids");
    expect(scopesForPurpose("twitch", "alerts")).not.toContain("channel:manage:raids");
    expect(scopesForPurpose("twitch", "predictions")).not.toContain("channel:manage:raids");
    expect(() => scopesForPurpose("kick", "raids")).toThrow(expect.objectContaining({ code: "oauth_purpose_invalid" }));
  });
});

describe("the Dock view", () => {
  test("the list still shows, ranked, when raids are not available", async () => {
    link = [{ ...ready(), raidsConsent: false }];
    const view = await service.dockView(OWNER);
    expect(view.reason).toBe("raid_permission_required");
    expect(view.candidates.map(row => row.channel)).toEqual(["Chan1", "Chan2"]);
    expect(view.candidates[0]).toMatchObject({ raidable: true, small: true });
  });
  test("the streamer's own channel never appears", async () => {
    live.streams.push(stream(9, 1, { broadcasterId: SELF_ID }));
    expect((await service.dockView(OWNER)).candidates.map(row => row.channel)).not.toContain("Chan9");
  });
});

describe("start", () => {
  test("queues the raid with Twitch's documented request and reports it as queued", async () => {
    const result = await service.start(OWNER, "twitch:1");
    expect(result).toMatchObject({ state: "queued", channel: "Chan1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.twitch.tv/helix/raids?from_broadcaster_id=42&to_broadcaster_id=1001");
    expect(init.method).toBe("POST");
    expect(leased).toEqual([{ raids: true }]);
    expect(await history()).toEqual([expect.objectContaining({ dir: "out", channel: "Chan1", state: "queued", viewers: 4 })]);
  });
  test("the receipt exists before Twitch is asked", async () => {
    let during;
    fetchMock.mockImplementation(async () => { during = await history(); return reply(200, { data: [{ created_at: "x" }] }); });
    await service.start(OWNER, "twitch:1");
    expect(during).toEqual([expect.objectContaining({ state: "pending" })]);
  });
  test("a channel that left the live list is refused", async () => {
    await expect(service.start(OWNER, "twitch:99")).rejects.toMatchObject({ code: "raid_target_offline" });
    await expect(service.start(OWNER, "kick:1")).rejects.toMatchObject({ code: "raid_target_offline" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("you cannot raid your own channel", async () => {
    live.streams.push(stream(9, 1, { broadcasterId: SELF_ID }));
    await expect(service.start(OWNER, "twitch:9")).rejects.toMatchObject({ code: "raid_self" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("a second start while one is queued is refused without calling Twitch", async () => {
    await service.start(OWNER, "twitch:1");
    await expect(service.start(OWNER, "twitch:2")).rejects.toMatchObject({ code: "raid_already_queued" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 4 * 60_000;
    await expect(service.start(OWNER, "twitch:2")).resolves.toMatchObject({ state: "queued" });
  });
  test("Twitch's refusal is shown and recorded as failed", async () => {
    fetchMock.mockResolvedValue(reply(400));
    await expect(service.start(OWNER, "twitch:1")).rejects.toMatchObject({ code: "raid_refused", status: 409 });
    expect(await history()).toEqual([expect.objectContaining({ state: "failed", reason: "twitch_400" })]);
    fetchMock.mockResolvedValue(reply(429));
    await expect(service.start(OWNER, "twitch:2")).rejects.toMatchObject({ code: "provider_rate_limited" });
  });
  test.each([
    ["a server error", () => reply(503)],
    ["a 200 without the receipt", () => reply(200, { data: [] })],
  ])("%s is unconfirmed, and the raid is never sent a second time", async (_name, answer) => {
    fetchMock.mockResolvedValue(answer());
    await expect(service.start(OWNER, "twitch:1")).rejects.toMatchObject({ code: "raid_unconfirmed", status: 502 });
    expect(await history()).toEqual([expect.objectContaining({ state: "unconfirmed" })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test("a cancel while the raid request is still running waits for Twitch's answer", async () => {
    let release;
    fetchMock.mockImplementation(() => new Promise(resolve => { release = () => resolve(reply(200, { data: [{ created_at: "x" }] })); }));
    const first = service.start(OWNER, "twitch:1");
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(service.cancel(OWNER)).rejects.toMatchObject({ code: "raid_busy" });
    release();
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("cancel", () => {
  test("cancels the pending raid and records it as cancelled", async () => {
    await service.start(OWNER, "twitch:1");
    fetchMock.mockResolvedValue(reply(204));
    await expect(service.cancel(OWNER)).resolves.toMatchObject({ state: "canceled", channel: "Chan1" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.twitch.tv/helix/raids?broadcaster_id=42");
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect((await history())[0].state).toBe("canceled");
    expect((await service.dockView(OWNER)).pending).toBeNull();
  });
  test("when Twitch has no raid left the answer says so and the record is closed", async () => {
    await service.start(OWNER, "twitch:1");
    fetchMock.mockResolvedValue(reply(404));
    await expect(service.cancel(OWNER)).rejects.toMatchObject({ code: "raid_not_pending" });
    expect((await history())[0].state).toBe("closed");
  });
  test("an unclear cancel is reported as unconfirmed and leaves the raid queued", async () => {
    await service.start(OWNER, "twitch:1");
    fetchMock.mockResolvedValue(reply(503));
    await expect(service.cancel(OWNER)).rejects.toMatchObject({ code: "cancel_unconfirmed" });
    expect((await history())[0].state).toBe("queued");
  });
});

describe("incoming raids", () => {
  test("a stored Twitch raid event reaches the history only while the switch is on", async () => {
    const collection = client.db("twitch_raids").collection("events");
    await collection.deleteMany({});
    await collection.createIndex({ userId: 1, platform: 1, eventId: 1 }, { unique: true });
    const events = new PlatformEventsService({ platformEvents: collection }, { overlayTokens: { list: async () => [] }, now: () => now });
    const integrations = { events, statuses: async () => ({ platforms: link }), withTwitchAutomationGrant: async (_u, _p, cb) => cb(grant) };
    createTwitchRaids({ db: { users }, config: { twitchRaidsEnabled: true }, integrations, liveStreams: { list: async () => live } });
    const raid = id => ({ platform: "twitch", id, kind: "raid", user: "Raider", detail: "raided with 12 viewers", amount: "12", atMs: now });
    await events.publish(OWNER, raid("a"));
    await events.publish(OWNER, raid("a"));
    await events.publish(OTHER, raid("b"));
    await events.publish(OWNER, { ...raid("c"), kind: "follow" });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await history()).toEqual([expect.objectContaining({ dir: "in", channel: "Raider", viewers: 12, state: "received", at: now })]);
    expect((await users.findOne({ userId: OTHER })).preferences).toBeUndefined();
    expect((await service.dockView(OWNER)).candidates.find(row => row.channel === "Raider")).toBeUndefined();
  });
});

describe("Stream Dock routes", () => {
  beforeEach(() => { app = makeApp(); });
  const makeApp = () => {
    const tokens = { resolve: jest.fn(async token => (token === TOKEN ? { userId: OWNER } : null)), isReplaced: async () => false, withWrite: (_t, work) => work() };
    const router = buildTwitchAutomationRouter({ auth: (req, _res, next) => { req.auth = { userId: OWNER, source: req.get("x-source") || "clerk" }; next(); }, automation: {}, status: {}, tokens, raids: service });
    const instance = express().use(express.json()).use("/v1", router);
    instance.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code, message: error.message } }));
    return instance;
  };
  const post = body => request(app).post(`/v1/multichat/${TOKEN}/raids`).send(body);
  test("an unknown Dock token is refused", async () => {
    await request(app).get("/v1/multichat/wrong/raids").expect(401);
    await request(app).post("/v1/multichat/wrong/raids").send({ action: "cancel", confirmed: true }).expect(401);
  });
  test("a raid needs the confirmation and an exact body", async () => {
    for (const body of [{ action: "start", streamId: "twitch:1" }, { action: "start", streamId: "twitch:1", confirmed: false },
      { action: "start", streamId: "kick:1", confirmed: true }, { action: "start", confirmed: true }, { action: "cancel", streamId: "twitch:1", confirmed: true },
      { action: "start", streamId: "twitch:1", confirmed: true, to: "7" }, { action: "other", confirmed: true }]) {
      await request(makeApp()).post(`/v1/multichat/${TOKEN}/raids`).send(body).expect(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("start answers with the queued result and the refreshed view; Twitch's refusal is shown", async () => {
    const started = await post({ action: "start", streamId: "twitch:1", confirmed: true }).expect(200);
    expect(started.body.result).toMatchObject({ state: "queued", channel: "Chan1" });
    expect(started.body.pending).toMatchObject({ channel: "Chan1" });
    fetchMock.mockResolvedValue(reply(204));
    const canceled = await post({ action: "cancel", confirmed: true }).expect(200);
    expect(canceled.body.result.state).toBe("canceled");
    expect(canceled.body.history[0].state).toBe("canceled");
    now += 4 * 60_000;
    fetchMock.mockResolvedValue(reply(400));
    const refused = await post({ action: "start", streamId: "twitch:2", confirmed: true }).expect(409);
    expect(refused.body.error.code).toBe("raid_refused");
  });
  test("the view carries no provider id and the Settings routes need a signed-in owner", async () => {
    const view = await request(app).get(`/v1/multichat/${TOKEN}/raids`).expect(200);
    expect(view.headers["cache-control"]).toBe("private, no-store");
    expect(JSON.stringify(view.body)).not.toMatch(/broadcasterId|mock-bearer/);
    await request(app).get("/v1/me/twitch-raids").set("x-source", "device").expect(403);
    const saved = await request(app).put("/v1/me/twitch-raids").send({ enabled: false }).expect(200);
    expect(saved.body).toMatchObject({ enabled: false, permission: true });
    await request(app).put("/v1/me/twitch-raids").send({ enabled: "yes" }).expect(400);
  });
});
