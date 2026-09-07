// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { PlayerIdentitiesService } = require("../src/services/playerIdentities");
const { PlayerChannelsService } = require("../src/services/playerChannels");
const { buildPlayerIdentitiesRouter } = require("../src/routes/playerIdentities");
const { GdprService, PURGE_ONLY_COLLECTIONS } = require("../src/services/gdpr");

const SOURCE = "1-S2-1-111";
const TARGET = "1-S2-1-222";
const OTHER = "2-S2-1-333";
const reason = "The same distinctive opening appears in these replays.";

describe("reviewed global player identities", () => {
  let mongo, db, service, app;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    db = await connect({ uri: mongo.getUri(), dbName: "identity_test" });
  }, 60_000);
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.opponents, db.games, db.playerIdentities, db.playerIdentitySubmissions, db.playerIdentityDirectory, db.pulseAccounts, db.pulseCharacterLinks, db.playerChannels].map((col) => col.deleteMany({})));
    await db.opponents.insertMany([
      { userId: "alice", pulseId: SOURCE, displayNameSample: "IIIIllll", race: "T", pulseCharacterId: "11", lastSeen: new Date() },
      { userId: "bob", pulseId: SOURCE, displayNameSample: "IIIIllll", race: "T", pulseCharacterId: "11", lastSeen: new Date() },
      { userId: "admin", pulseId: SOURCE, displayNameSample: "IIIIllll", race: "T", pulseCharacterId: "11", lastSeen: new Date() },
      { userId: "bob", pulseId: TARGET, displayNameSample: "RealPlayer", race: "T", pulseCharacterId: "22", lastSeen: new Date() },
      { userId: "bob", pulseId: OTHER, displayNameSample: "RealPlayer", race: "P", lastSeen: new Date() },
    ]);
    await db.games.insertMany([
      { userId: "alice", gameId: "a-replay", date: new Date(), opponent: { pulseId: SOURCE, displayName: "IIIIllll" }, map: "Real replay map", replayFile: { storedAt: new Date() } },
      { userId: "bob", gameId: "private-bob", opponent: { pulseId: SOURCE } },
      { userId: "admin", gameId: "admin-replay", opponent: { pulseId: SOURCE } },
      { userId: "alice", gameId: "other-opponent", opponent: { pulseId: TARGET } },
    ]);
    service = new PlayerIdentitiesService(db);
    app = express(); app.use(express.json());
    app.use("/v1", buildPlayerIdentitiesRouter({ playerIdentities: service, auth: (req, res, next) => { if (!req.headers["x-user"]) return res.sendStatus(401); req.auth = { userId: req.headers["x-user"] }; next(); }, isAdmin: (req) => req.auth?.userId === "admin" }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { message: err.message } }));
  });

  async function submit(userId = "alice", target = TARGET) {
    return service.submit(userId, SOURCE, { targetKey: `toon:${target}`, reason });
  }

  test("submission stays private until approved; admins receive only the submitter's exact replay evidence", async () => {
    const context = await submit();
    expect(context.submission.status).toBe("pending");
    expect(context.submission.evidenceCount).toBe(1);
    expect(context.submission.submitterUserId).toBeUndefined();
    expect(await service.resolveMany([{ toonHandle: SOURCE }])).toEqual([null]);
    const bob = await service.context("bob", SOURCE, false);
    expect(bob.submission).toBeNull();
    const detail = await service.detail(context.submission.id);
    expect(detail.evidence.map((g) => g.gameId)).toEqual(["a-replay"]);
    expect(detail.evidence[0].hasReplay).toBe(true);
    await service.review(context.submission.id, "admin", { decision: "approved", revision: 1, reviewNote: "Confirmed using the replay evidence." });
    const identities = await service.resolveMany([{ toonHandle: SOURCE }, { toonHandle: TARGET }, { toonHandle: OTHER }]);
    expect(identities[0].displayName).toBe("RealPlayer");
    expect(identities[0].groupKey).toBe(identities[1].groupKey);
    expect(identities[2]).toBeNull();
    expect((await service.context("bob", SOURCE, false)).confirmed.displayName).toBe("RealPlayer");
    expect((await db.games.findOne({ gameId: "a-replay" })).opponent.pulseId).toBe(SOURCE);
  });

  test("admin can directly confirm, correct, remove, and reconnect with revision protection", async () => {
    let context = await service.confirm("admin", SOURCE, { targetKey: `toon:${TARGET}`, reason, revision: 0 });
    expect(context.isAdmin).toBe(true);
    expect(context.confirmed.target.toonHandle).toBe(TARGET);
    await expect(service.confirm("admin", SOURCE, { targetKey: `toon:${OTHER}`, reason, revision: 0 })).rejects.toMatchObject({ status: 409 });
    context = await service.confirm("admin", SOURCE, { targetKey: `toon:${OTHER}`, reason, revision: 1 });
    expect(context.confirmed.target.toonHandle).toBe(OTHER);
    context = await service.confirm("admin", SOURCE, { reason, revision: 2 }, true);
    expect(context.confirmed).toBeNull(); expect(context.revision).toBe(3);
    context = await service.confirm("admin", SOURCE, { targetKey: `toon:${TARGET}`, reason, revision: 3 });
    expect(context.confirmed.revision).toBe(4);
    expect(await db.playerIdentitySubmissions.countDocuments({ direct: true })).toBe(4);
  });

  test("concurrent approvals do not overwrite each other and older suggestions cannot undo corrections", async () => {
    const a = await submit(); const b = await submit("bob", OTHER);
    const outcomes = await Promise.allSettled([a, b].map((ctx) => service.review(ctx.submission.id, "admin", { decision: "approved", revision: 1, reviewNote: "Reviewed the attached replays." })));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((result) => result.status === "rejected").reason.status).toBe(409);
    expect(await db.playerIdentitySubmissions.countDocuments({ status: "pending" })).toBe(1);
  });

  test("reject, explain and resubmit; evidence never includes future uploads", async () => {
    const ctx = await submit();
    await db.games.insertOne({ userId: "alice", gameId: "later", opponent: { pulseId: SOURCE } });
    expect((await service.detail(ctx.submission.id)).evidence.map((g) => g.gameId)).toEqual(["a-replay"]);
    await service.review(ctx.submission.id, "admin", { decision: "rejected", revision: 1, reviewNote: "The timing evidence does not match." });
    expect(await service.resolveMany([{ toonHandle: SOURCE }])).toEqual([null]);
    await expect(service.submit("alice", SOURCE, { targetKey: `toon:${TARGET}`, reason, submissionRevision: 1 })).rejects.toMatchObject({ status: 409 });
    const updated = await service.submit("alice", SOURCE, { targetKey: `toon:${TARGET}`, reason, submissionRevision: 2 });
    expect(updated.submission.status).toBe("pending"); expect(updated.submission.evidenceCount).toBe(2);
  });

  test("authenticated access and admin mutation gates are enforced by the API", async () => {
    await request(app).get("/v1/player-identities/search?q=real").expect(401);
    await request(app).get("/v1/admin/player-identities").set("x-user", "alice").expect(403);
    await request(app).put(`/v1/opponents/${SOURCE}/confirmed-identity`).set("x-user", "alice").send({ targetKey: `toon:${TARGET}`, reason, revision: 0 }).expect(403);
    await request(app).get(`/v1/opponents/${TARGET}/identity-submissions`).set("x-user", "alice").expect(404);
    const result = await request(app).get(`/v1/opponents/${SOURCE}/identity-submissions`).set("x-user", "admin").expect(200);
    expect(result.body.isAdmin).toBe(true); expect(result.headers["cache-control"]).toContain("no-store");
    await expect(service.submit("alice", SOURCE, { targetKey: "toon:1-S2-1-999", reason })).rejects.toMatchObject({ status: 400 });
    await expect(service.submit("alice", SOURCE, { targetKey: `toon:${SOURCE}`, reason })).rejects.toMatchObject({ status: 400 });
  });

  test("search is case-insensitive, paginated, disambiguated by stable IDs, and includes non-Pulse players", async () => {
    for (let i = 1; i <= 25; i++) await service.directory.record({ toonHandle: `2-S2-1-${1000 + i}`, displayName: `SearchPlayer${i}` });
    const first = await service.directory.search("search");
    expect(first.items).toHaveLength(20); expect(first.nextCursor).toBeTruthy();
    const second = await service.directory.search("search", first.nextCursor);
    expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((p) => p.key)).size).toBe(25);
    const real = await service.directory.search("REAL");
    expect(real.items).toHaveLength(2);
    expect(real.items.find((p) => p.toonHandle === OTHER).pulseCharacterId).toBeNull();
    expect((await service.directory.search(OTHER)).items[0].toonHandle).toBe(OTHER);
  });

  test("verified new Pulse profiles can be selected, and arbitrary URLs never reach the network", async () => {
    service.fetchImpl = jest.fn(async () => ({ ok: true, text: async () => JSON.stringify([{ members: { character: { id: 99, name: "NewPlayer", region: "EU", realm: 1, battlenetId: 999 }, account: { id: 77 } } }]) }));
    await expect(service.importPulse("https://evil.test/sc2/?type=character&id=99")).rejects.toMatchObject({ status: 400 });
    await expect(service.importPulse("https://sc2pulse.nephest.com/sc2/?type=account&id=99")).rejects.toMatchObject({ status: 400 });
    expect(service.fetchImpl).not.toHaveBeenCalled();
    const result = await service.importPulse("https://sc2pulse.nephest.com/sc2/?type=character&id=99&m=1#player-stats-mmr");
    expect(result.player.displayName).toBe("NewPlayer"); expect(result.player.toonHandle).toBe("2-S2-1-999");
    const ctx = await service.confirm("admin", SOURCE, { targetKey: result.player.key, reason, revision: 0 });
    expect(ctx.confirmed.displayName).toBe("NewPlayer");
    expect(ctx.confirmed.groupKey).toBe("acct:77");
  });

  test("approved aliases inherit channels without altering replay identities", async () => {
    const channels = new PlayerChannelsService(db, { seeds: [] }); channels.playerIdentities = service;
    await channels.saveAdmin({ displayName: "RealPlayer", toonHandles: [TARGET], channels: { twitch: "https://www.twitch.tv/realplayer" } }, "admin");
    await service.confirm("admin", SOURCE, { targetKey: `toon:${TARGET}`, reason, revision: 0 });
    const response = await channels.resolve([{ toonHandle: SOURCE }]);
    expect(response.players[0].toonHandle).toBe(SOURCE);
    expect(response.players[0].channels.twitch).toBe("https://www.twitch.tv/realplayer");
  });

  test("conflicting saved source identities cannot publish a false CID alias", async () => {
    await db.pulseCharacterLinks.insertOne({ pulseCharacterId: "11", toonHandle: "1-S2-1-9999", accountId: "55" });
    await expect(service.confirm("admin", SOURCE, { targetKey: `toon:${TARGET}`, reason, revision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await db.playerIdentities.countDocuments({ active: true })).toBe(0);
  });

  test("directory refresh preserves known metadata and its checkpoint across service restarts", async () => {
    await service.directory.ensureFresh();
    await service.directory.record({ toonHandle: TARGET, displayName: "VerifiedName" });
    const known = await service.directory.get(`toon:${TARGET}`);
    expect(known.pulseCharacterId).toBe("22"); expect(known.race).toBe("T");
    const restarted = new PlayerIdentitiesService(db);
    const find = jest.spyOn(db.opponents, "find");
    await restarted.directory.ensureFresh();
    expect(find.mock.calls[0][0].lastSeen.$gte).toBeInstanceOf(Date);
    find.mockRestore();
  });

  test("the review queue is oldest-first and evidence paginates without duplicates", async () => {
    const ctx = await submit();
    const row = await db.playerIdentitySubmissions.findOne({ id: ctx.submission.id });
    await db.playerIdentitySubmissions.insertMany(Array.from({ length: 34 }, (_, i) => ({ ...row, _id: undefined, id: `review-${i}`, userId: `u-${i}`, createdAt: new Date(row.createdAt.getTime() + i + 1) })));
    const first = await service.list({ status: "pending" });
    const second = await service.list({ status: "pending", cursor: first.nextCursor });
    expect(first.items[0].id).toBe(ctx.submission.id);
    expect(first.items).toHaveLength(30); expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((s) => s.id)).size).toBe(35);
    await db.games.insertMany(Array.from({ length: 35 }, (_, i) => ({ userId: "alice", gameId: `more-${i}`, opponent: { pulseId: SOURCE } })));
    const refreshed = await service.submit("alice", SOURCE, { targetKey: `toon:${TARGET}`, reason, submissionRevision: 1 });
    const evidence1 = await service.detail(refreshed.submission.id);
    const evidence2 = await service.detail(refreshed.submission.id, evidence1.nextCursor);
    expect(evidence1.evidence).toHaveLength(30); expect(evidence2.evidence).toHaveLength(6);
    expect(new Set([...evidence1.evidence, ...evidence2.evidence].map((g) => g.gameId)).size).toBe(36);
  });

  test("export includes only the caller's submissions and deletion includes the review records", async () => {
    await submit(); await submit("bob");
    const exported = await new GdprService(db).export("alice");
    expect(exported.data.playerIdentitySubmissions).toHaveLength(1);
    expect(exported.data.playerIdentitySubmissions[0].userId).toBe("alice");
    expect(exported.data.playerIdentitySubmissions[0].evidenceMaxId).toBeUndefined();
    expect(PURGE_ONLY_COLLECTIONS).toContainEqual(["playerIdentitySubmissions", "userId"]);
  });
});
