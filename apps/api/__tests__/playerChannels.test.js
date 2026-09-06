// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { PlayerChannelsService, normalizeChannelUrl } = require("../src/services/playerChannels");
const { PulseCharacterLinkService } = require("../src/services/pulseCharacterLinks");
const { buildPlayerChannelsRouter } = require("../src/routes/playerChannels");

const TOON = "1-S2-1-12345";
const TWITCH = "https://www.twitch.tv/exampleplayer";
const YOUTUBE = "https://www.youtube.com/@ExamplePlayer";
const input = (extra = {}) => ({ displayName: "Example Player", pulseCharacterIds: ["123"], toonHandles: [], channels: { twitch: TWITCH }, ...extra });

describe("player channel URL validation", () => {
  test.each([
    ["twitch", "http://twitch.tv/ExamplePlayer/?ref=abc", TWITCH],
    ["youtube", "https://youtube.com/@ExamplePlayer/videos?view=0", YOUTUBE],
    ["youtube", "https://youtube.com/LegacyChannel", "https://www.youtube.com/LegacyChannel"],
    ["youtube", "https://youtube.com/user/ExamplePlayer/featured", "https://www.youtube.com/user/ExamplePlayer"],
  ])("canonicalizes %s channel %s", (platform, value, expected) => expect(normalizeChannelUrl(platform, value)).toBe(expected));

  test.each([
    ["twitch", "https://twitch.tv.evil.test/example"],
    ["twitch", "https://evil.test@twitch.tv/example"],
    ["twitch", "https://twitch.tv:444/example"],
    ["twitch", "https://twitch.tv/videos/123"],
    ["twitch", "https://twitch.tv/directory"],
    ["youtube", "https://youtube.com/watch?v=123"],
    ["youtube", "https://youtube.com/redirect?q=https://evil.test"],
    ["youtube", "https://youtube.com/shorts/abc"],
    ["youtube", "https://youtube.com/@ExamplePlayer/live/abc"],
    ["youtube", "javascript:alert(1)"],
  ])("rejects non-channel URL %s %s", (platform, value) => expect(() => normalizeChannelUrl(platform, value)).toThrow());
});

describe("shared player channels", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "player_channels_test" });
  });
  afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([db.playerChannels.deleteMany({}), db.pulseAccounts.deleteMany({}), db.pulseCharacterLinks.deleteMany({}), db.users.deleteMany({})]);
    service = new PlayerChannelsService(db, { seeds: [] });
  });

  test("admin creation is global and public DTOs never expose ownership or moderation metadata", async () => {
    const { entry } = await service.saveAdmin(input({ toonHandles: [TOON] }), "private-admin-user");
    const result = await service.resolve([{ pulseCharacterId: "123" }, { toonHandle: TOON }]);
    expect(result.players).toEqual([
      { pulseCharacterId: "123", channels: { twitch: TWITCH }, id: entry.id, displayName: "Example Player" },
      { toonHandle: TOON, channels: { twitch: TWITCH }, id: entry.id, displayName: "Example Player" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private-admin-user|updatedBy|reviewedBy|ownerUserId/);
    expect((await db.playerChannels.findOne({ id: entry.id }))._schemaVersion).toBe(1);
  });

  test("pro and account aliases resolve across characters using only public identity caches", async () => {
    await service.saveAdmin(input({ pulseCharacterIds: [], proId: "9" }), "admin");
    await db.pulseCharacterLinks.insertMany([
      { pulseCharacterId: "123", accountId: "12", proId: "9" },
      { pulseCharacterId: "456", accountId: "12", proId: null },
    ]);
    await db.pulseAccounts.insertOne({ toonHandle: TOON, pulseCharacterId: "456" });
    expect((await service.resolve([{ toonHandle: TOON }])).players[0].channels.twitch).toBe(TWITCH);
    await db.playerChannels.deleteMany({});
    await service.saveAdmin(input(), "admin");
    expect((await service.resolve([{ pulseCharacterId: "456" }])).players[0].channels.twitch).toBe(TWITCH);
  });

  test("contradictory known toon and character identities fail closed", async () => {
    await service.saveAdmin(input(), "admin");
    await db.pulseAccounts.insertOne({ toonHandle: TOON, pulseCharacterId: "456" });
    expect((await service.resolve([{ pulseCharacterId: "123", toonHandle: TOON }])).players[0].channels).toEqual({});
  });

  test("never associates a same-name player or name-only request", async () => {
    await service.saveAdmin(input(), "admin");
    expect((await service.resolve([{ pulseCharacterId: "999", displayName: "Example Player" }])).players[0].channels).toEqual({});
    await expect(service.resolve([{ displayName: "Example Player" }])).rejects.toMatchObject({ status: 400 });
  });

  test("admin removals suppress refresh and restart seed import, and edits persist", async () => {
    await service.importRows([input()], "sc2pulse");
    const row = (await service.list()).entries[0];
    await service.saveAdmin(input({ channels: { youtube: YOUTUBE } }), "admin", row.id);
    await service.importRows([input()], "sc2pulse");
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({ youtube: YOUTUBE });
    await service.removeAdmin(row.id, "admin");
    const restarted = new PlayerChannelsService(db, { seeds: [input()] });
    expect((await restarted.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({});
    expect((await restarted.list()).total).toBe(0);
    expect((await restarted.list({ includeRemoved: true })).entries[0].removed).toBe(true);
    await expect(service.saveAdmin(input(), "admin")).rejects.toMatchObject({ status: 409 });
  });

  test("curated YouTube survives refresh while upstream Twitch can change", async () => {
    await service.importRows([input({ proId: "9", channels: { youtube: YOUTUBE, twitch: TWITCH } })], "curated");
    await service.importRows([input({ proId: "9", channels: { youtube: "https://www.youtube.com/@OldChannel", twitch: "https://www.twitch.tv/renamedplayer" } })], "sc2pulse");
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({ youtube: YOUTUBE, twitch: "https://www.twitch.tv/renamedplayer" });
  });

  test("first self submission waits for admin review; subsequent edits preserve approved links", async () => {
    await db.users.insertOne({ userId: "owner", pulseIds: ["123"], displayName: "Owner" });
    const submitted = await service.saveSelf("owner", { channels: { twitch: TWITCH } });
    const entry = submitted.entries[0];
    expect(entry).toMatchObject({ pending: true, editable: true, channels: { twitch: TWITCH } });
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({});
    const approved = await service.saveAdmin(entry, "admin", entry.id);
    expect(approved.entry.pending).toBe(false);
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({ twitch: TWITCH });
    const revised = await service.saveSelf("owner", { channels: { youtube: YOUTUBE } });
    expect(revised.entries[0]).toMatchObject({ pending: true, editable: true, channels: { youtube: YOUTUBE }, approvedChannels: { twitch: TWITCH } });
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({ twitch: TWITCH });
    expect((await service.list({ search: "ExamplePlayer" })).total).toBe(1);
  });

  test("a stale moderation form cannot publish over a newer submission", async () => {
    await db.users.insertOne({ userId: "owner", pulseIds: ["123"], displayName: "Owner" });
    const submitted = await service.saveSelf("owner", { channels: { twitch: TWITCH } });
    const stale = submitted.entries[0];
    await service.saveSelf("owner", { channels: { youtube: YOUTUBE } });
    await expect(service.saveAdmin(stale, "admin", stale.id)).rejects.toMatchObject({ status: 409, code: "player_channels_changed" });
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({});
    const current = (await service.getSelf("owner")).entries[0];
    expect(current.pending).toBe(true);
    expect(current.channels).toEqual({ twitch: null, youtube: YOUTUBE });
  });

  test("adding an unreviewed alias to an approved self entry does not immediately publish it", async () => {
    await db.users.insertOne({ userId: "owner", pulseIds: ["123", "999"], displayName: "Owner" });
    const submitted = await service.saveSelf("owner", { identities: [{ pulseCharacterId: "123" }], channels: { twitch: TWITCH } });
    await service.saveAdmin(submitted.entries[0], "admin", submitted.entries[0].id);
    await service.saveSelf("owner", { channels: { twitch: TWITCH } });
    expect((await service.resolve([{ pulseCharacterId: "999" }])).players[0].channels).toEqual({});
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({ twitch: TWITCH });
  });

  test("pending URLs cannot be read by another user via a copied profile identity", async () => {
    await db.users.insertMany([{ userId: "owner", clerkUserId: "clerk_owner", pulseIds: ["123"] }, { userId: "other", clerkUserId: "clerk_other", pulseIds: ["123"] }]);
    await service.saveSelf("owner", { channels: { twitch: TWITCH } });
    const other = await service.getSelf("other");
    expect(other.entries[0]).toMatchObject({ editable: false, channels: {} });
    await expect(service.saveSelf("other", { channels: { youtube: YOUTUBE } })).rejects.toMatchObject({ status: 409 });
    await expect(service.saveSelf("owner", { identities: [{ pulseCharacterId: "999" }], channels: { twitch: TWITCH } })).rejects.toMatchObject({ status: 403 });
  });

  test("protected imported records cannot be overwritten by changing profile IDs", async () => {
    await service.importRows([input()], "sc2pulse");
    await db.users.insertOne({ userId: "owner", pulseIds: ["123"] });
    await expect(service.saveSelf("owner", { channels: { youtube: YOUTUBE } })).rejects.toMatchObject({ code: "player_channels_managed" });
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels.twitch).toBe(TWITCH);
  });

  test("an owner can withdraw by id after removing every saved profile identity", async () => {
    await db.users.insertOne({ userId: "owner", pulseIds: ["123"] });
    const submitted = await service.saveSelf("owner", { channels: { twitch: TWITCH } });
    await service.saveAdmin(submitted.entries[0], "admin", submitted.entries[0].id);
    await db.users.updateOne({ userId: "owner" }, { $set: { pulseIds: [] } });
    await expect(service.saveSelf("other", { id: submitted.entries[0].id, channels: {} })).rejects.toMatchObject({ status: 404 });
    const withdrawn = await service.saveSelf("owner", { id: submitted.entries[0].id, channels: {} });
    expect(withdrawn.entries[0]).toMatchObject({ pending: false, removed: true });
    expect((await service.resolve([{ pulseCharacterId: "123" }])).players[0].channels).toEqual({});
  });

  test("simultaneous claims cannot create two directory records for one identity", async () => {
    await db.users.insertMany([{ userId: "one", clerkUserId: "clerk_one", pulseIds: ["123"] }, { userId: "two", clerkUserId: "clerk_two", pulseIds: ["123"] }]);
    const attempts = await Promise.allSettled([service.saveSelf("one", { channels: { twitch: TWITCH } }), service.saveSelf("two", { channels: { youtube: YOUTUBE } })]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(await db.playerChannels.countDocuments({})).toBe(1);
  });

  test("numeric profile claims persist verified toon aliases without depending on pulse_accounts", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, text: async () => JSON.stringify([{ members: { character: { id: 123, region: "US", realm: 1, battlenetId: 12345 }, account: { id: 88 }, proId: null } }]) }));
    const pulseLinks = new PulseCharacterLinkService(db.pulseCharacterLinks, { fetchImpl });
    service = new PlayerChannelsService(db, { seeds: [], pulseLinks });
    await db.users.insertOne({ userId: "owner", pulseIds: ["123"] });
    const submitted = await service.saveSelf("owner", { channels: { twitch: TWITCH } });
    await service.saveAdmin(submitted.entries[0], "admin", submitted.entries[0].id);
    await db.pulseCharacterLinks.deleteMany({});
    fetchImpl.mockClear();
    expect((await service.resolve([{ toonHandle: TOON }])).players[0].channels.twitch).toBe(TWITCH);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("game resolution deduplicates players and safely supports reserved game IDs", async () => {
    await service.saveAdmin(input({ toonHandles: [TOON] }), "admin");
    const spy = jest.spyOn(service, "resolve");
    const games = Array.from({ length: 500 }, (_, index) => ({ gameId: index === 0 ? "__proto__" : String(index), myToonHandle: TOON, opponent: { pulseCharacterId: "123", displayName: "Opponent" } }));
    const result = await service.resolveForGames(games);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toHaveLength(2);
    expect(result.channelsByGameId.__proto__).toHaveLength(2);
    expect(result.channelsByGameId["499"]).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/pulseCharacterId|toonHandle|ownerUserId/);
  });

  test("upstream refresh fetches the real revealed-player batch shape before writing", async () => {
    const fetchImpl = jest.fn(async (url) => ({ ok: true, json: async () => url.endsWith("/revealed/players") ? [{ id: 9 }] : [{ proPlayer: { id: 9, nickname: "Example Player" }, links: [{ type: "TWITCH", url: TWITCH }] }] }));
    service = new PlayerChannelsService(db, { seeds: [], fetchImpl });
    expect(await service.importPulse()).toMatchObject({ imported: 1, total: 1 });
    expect(fetchImpl.mock.calls[1][0]).toMatch(/revealed\/player\/9\/full$/);
    fetchImpl.mockImplementation(async () => ({ ok: false }));
    await expect(service.importPulse()).rejects.toMatchObject({ status: 502 });
    expect(await db.playerChannels.countDocuments({})).toBe(1);
  });

  test("route authorization separates public lookup, owner submissions, and administrator writes", async () => {
    await service.saveAdmin(input(), "admin");
    const app = express();
    app.use(express.json());
    const auth = (req, res, next) => { if (!req.headers.authorization) return res.sendStatus(401); req.auth = { userId: req.headers.authorization }; next(); };
    app.use("/v1", buildPlayerChannelsRouter({ playerChannels: service, auth, isAdmin: (req) => req.auth?.userId === "admin" }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code } }));
    const publicResult = await request(app).post("/v1/player-channels/resolve").send({ players: [{ pulseCharacterId: "123" }] }).expect(200);
    expect(publicResult.body.players[0].channels.twitch).toBe(TWITCH);
    await request(app).get("/v1/me/player-channels").expect(401);
    await request(app).get("/v1/admin/player-channels").set("Authorization", "other").expect(403);
    await request(app).post("/v1/admin/player-channels/import-pulse").set("Authorization", "other").expect(403);
    await request(app).get("/v1/admin/player-channels").set("Authorization", "admin").expect(200);
    await request(app).post("/v1/player-channels/resolve").send({ players: Array(201).fill({ pulseCharacterId: "123" }) }).expect(400);
  });
});
