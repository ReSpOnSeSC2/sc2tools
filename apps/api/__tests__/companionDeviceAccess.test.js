// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildAuth } = require("../src/middleware/auth");
const { buildMeLiveRouter } = require("../src/routes/agentLive");
const { buildOpponentsRouter } = require("../src/routes/opponents");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const { OpponentsService } = require("../src/services/opponents");
const { sha256 } = require("../src/util/hash");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async () => { throw new Error("invalid"); }),
}));

describe("paired desktop companion access", () => {
  let mongo;
  let db;
  let app;
  let broker;
  const ownerToken = "owner-device-token-".padEnd(43, "a");
  const otherToken = "other-device-token-".padEnd(43, "b");
  const emptyToken = "empty-device-token-".padEnd(43, "c");
  const pulseId = "1-S2-1-12345";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "companion_device_access" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      db.deviceTokens.deleteMany({}),
      db.opponents.deleteMany({}),
      db.opponentNotes.deleteMany({}),
      db.games.deleteMany({}),
    ]);
    await db.deviceTokens.insertMany([
      { userId: "owner", tokenHash: sha256(ownerToken), revokedAt: null },
      { userId: "other", tokenHash: sha256(otherToken), revokedAt: null },
      { userId: "empty", tokenHash: sha256(emptyToken), revokedAt: null },
    ]);
    const pairings = new DevicePairingsService(db);
    const auth = buildAuth({
      secretKey: "sk_test",
      getDeviceToken: (hash) => pairings.findTokenByHash(hash),
      ensureUser: async () => { throw new Error("unexpected_clerk_auth"); },
    });
    broker = new LiveGameBroker();
    app = express();
    app.use(express.json());
    app.use("/v1", buildMeLiveRouter({ broker, auth }));
    app.use("/v1", buildOpponentsRouter({
      opponents: new OpponentsService(db, Buffer.alloc(32, 1)), auth,
    }));
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({ error: { code: error.code || "internal" } });
    });
  });

  function asOwner(pendingRequest) {
    return pendingRequest.set("authorization", `Bearer ${ownerToken}`);
  }

  async function seedOpponent(userId, opponentId, lastSeen) {
    await db.opponents.insertOne({
      userId, pulseId: opponentId, toonHandle: opponentId,
      displayNameSample: `${userId}-${opponentId}`, race: "Z", gameCount: 1,
      wins: 1, losses: 0, firstSeen: new Date(lastSeen), lastSeen: new Date(lastSeen),
    });
  }

  test("snapshot returns only this device owner's live and post-game state", async () => {
    broker.publish("owner", { phase: "match_started", gameKey: "owner-live" });
    broker.publish("other", { phase: "match_started", gameKey: "other-live" });
    broker.setLatestOverlayLive("owner", { gameId: "owner-replay" });
    broker.setLatestOverlayLive("other", { gameId: "other-replay" });

    const response = await asOwner(request(app).get("/v1/me/live/snapshot?userId=other"));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({
      liveGame: { phase: "match_started", gameKey: "owner-live" },
      overlayLive: { gameId: "owner-replay" },
    });
    const empty = await request(app).get("/v1/me/live/snapshot")
      .set("authorization", `Bearer ${emptyToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ liveGame: null, overlayLive: null });
  });

  test("the directory remains private across paginated device reads", async () => {
    await seedOpponent("owner", pulseId, "2026-10-22T12:00:00Z");
    await seedOpponent("owner", "1-S2-1-12346", "2026-10-21T12:00:00Z");
    await seedOpponent("other", "1-S2-1-99999", "2026-10-23T12:00:00Z");

    const first = await asOwner(request(app).get("/v1/opponents?limit=1&userId=other"));
    expect(first.status).toBe(200);
    expect(first.body.items.map((item) => item.pulseId)).toEqual([pulseId]);
    expect(first.body.nextBefore).toBe("2026-10-22T12:00:00.000Z");
    const second = await asOwner(request(app).get("/v1/opponents")
      .query({ limit: 1, before: first.body.nextBefore }));
    expect(second.status).toBe(200);
    expect(second.body.items.map((item) => item.pulseId)).toEqual(["1-S2-1-12346"]);
    expect(second.body.nextBefore).toBeNull();
  });

  test("device profiles retain scouting and notes while updates stay owner scoped", async () => {
    await seedOpponent("owner", pulseId, "2026-10-22T12:00:00Z");
    await seedOpponent("other", pulseId, "2026-10-22T12:00:00Z");
    await db.games.insertMany(["owner", "other"].map((userId) => ({
      userId, gameId: `${userId}-replay`, date: new Date("2026-10-22T12:00:00Z"),
      myRace: "Protoss", myBuild: `${userId} opening`, result: "Victory",
      map: "Goldenaura LE", durationSec: 600,
      opponent: { pulseId, displayName: "Opponent", race: "Zerg", strategy: "Roach" },
      oppBuildLog: ["[0:30] SpawningPool", "[1:30] RoachWarren"],
    })));
    await db.opponentNotes.insertMany(["owner", "other"].map((userId) => ({
      userId, pulseId, notes: `${userId} private note`, notesReadAloud: false,
    })));

    const profile = await asOwner(request(app).get(`/v1/opponents/${pulseId}`));
    expect(profile.status).toBe(200);
    expect(profile.body.notes).toBe("owner private note");
    expect(profile.body.last5GamesScouting).toHaveLength(1);
    expect(profile.body.last5GamesScouting[0].gameId).toBe("owner-replay");
    expect(profile.body.last5GamesScouting[0].oppBuildOrder).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "RoachWarren", time: 90 }),
    ]));
    const saved = await asOwner(request(app).put(`/v1/opponents/${pulseId}/notes`))
      .send({ notes: "Check the second gas", notesReadAloud: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ notes: "Check the second gas", notesReadAloud: true });
    expect((await db.opponentNotes.findOne({ userId: "other", pulseId })).notes)
      .toBe("other private note");
  });

  test("another user's opponent cannot be read or annotated", async () => {
    await seedOpponent("other", pulseId, "2026-10-22T12:00:00Z");
    const profile = await asOwner(request(app).get(`/v1/opponents/${pulseId}`));
    expect(profile.status).toBe(404);
    const saved = await asOwner(request(app).put(`/v1/opponents/${pulseId}/notes`))
      .send({ notes: "Unauthorized note", notesReadAloud: false });
    expect(saved.status).toBe(404);
    expect(await db.opponentNotes.countDocuments({})).toBe(0);
  });

  test("missing and revoked credentials cannot access any companion endpoint", async () => {
    const paths = ["/v1/me/live/snapshot", "/v1/opponents", `/v1/opponents/${pulseId}`];
    for (const path of paths) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    await db.deviceTokens.updateOne({ tokenHash: sha256(ownerToken) }, {
      $set: { revokedAt: new Date() },
    });
    for (const path of paths) {
      expect((await asOwner(request(app).get(path))).status).toBe(401);
    }
    const saved = await asOwner(request(app).put(`/v1/opponents/${pulseId}/notes`))
      .send({ notes: "Revoked note", notesReadAloud: false });
    expect(saved.status).toBe(401);
  });
});
