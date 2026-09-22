// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect, ensureIndexes } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { buildAuth } = require("../src/middleware/auth");
const { buildSiteStatsRouter } = require("../src/routes/siteStats");
const { SiteStatsService } = require("../src/services/siteStats");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "valid-clerk-token") return { sub: "clerk_test_account" };
    throw new Error("invalid");
  }),
}));

describe("public site statistics with persisted Mongo data", () => {
  let mongo;
  let db;
  let service;
  let now;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "site_stats" });
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all([db.adminEvents.deleteMany({}), db.deviceTokens.deleteMany({}), db.sitePresence.deleteMany({})]);
    now = Date.now();
    service = new SiteStatsService(db, { secret: Buffer.alloc(32, 7), now: () => now, cacheMs: 0 });
  });

  test("counts retained downloads and only recent unrevoked agents", async () => {
    await db.adminEvents.insertMany([
      { type: "agent_download", createdAt: new Date(0), payload: { privateEmail: "private@example.com" } },
      { type: "agent_download", createdAt: new Date(now) },
      { type: "user_signup", createdAt: new Date(now) },
    ]);
    await db.deviceTokens.insertMany([
      { tokenHash: "online", lastSeenAt: new Date(now - 60_000), revokedAt: null },
      { tokenHash: "boundary", lastSeenAt: new Date(now - 180_000) },
      { tokenHash: "stale", lastSeenAt: new Date(now - 180_001), revokedAt: null },
      { tokenHash: "revoked", lastSeenAt: new Date(now), revokedAt: new Date(now) },
      { tokenHash: "future", lastSeenAt: new Date(now + 1), revokedAt: null },
      { tokenHash: "unseen", revokedAt: null },
    ]);
    expect(await service.counts()).toEqual({
      agentDownloads: 2, activeAgents: 2, activeUsers: 0,
      generatedAt: new Date(now).toISOString(), activityWindowSeconds: 180,
    });
  });

  test("deduplicates browser tabs and signed-in accounts, replacing anonymous identity on login/logout", async () => {
    const browserA = await service.recordPresence();
    await service.recordPresence(browserA.visitorToken);
    const browserB = await service.recordPresence();
    expect((await service.counts()).activeUsers).toBe(2);
    await service.recordPresence(browserA.visitorToken, "account-1");
    await service.recordPresence(browserB.visitorToken, "account-1");
    expect((await service.counts()).activeUsers).toBe(1);
    expect(await db.sitePresence.countDocuments({})).toBe(2);
    await service.recordPresence(browserA.visitorToken);
    expect((await service.counts()).activeUsers).toBe(2);
    const row = await db.sitePresence.findOne({});
    expect(Object.keys(row).sort()).toEqual(["_id", "expiresAt", "identityKey", "lastSeenAt"]);
    expect(JSON.stringify(row)).not.toMatch(/account-1|visitorToken/);
  });

  test("drops inactive visitors at expiry even before the Mongo TTL sweep", async () => {
    await service.recordPresence();
    now += 179_999;
    expect((await service.counts()).activeUsers).toBe(1);
    now += 1;
    expect((await service.counts()).activeUsers).toBe(0);
    expect(await db.sitePresence.countDocuments({})).toBe(1);
  });

  test("token tampering cannot choose or impersonate a visitor identity", async () => {
    const { visitorToken } = await service.recordPresence();
    const tampered = visitorToken.slice(0, -1) + (visitorToken.endsWith("a") ? "b" : "a");
    expect(service.parseVisitorToken(tampered)).toBeNull();
    await expect(service.recordPresence(tampered)).rejects.toMatchObject({ status: 400, code: "invalid_presence_token" });
    now += 24 * 60 * 60 * 1000 + 180_000;
    await expect(service.recordPresence(visitorToken)).rejects.toMatchObject({ status: 400 });
  });

  test("daily signature renewal preserves browser identity and does not double-count", async () => {
    const initial = await service.recordPresence();
    const initialId = service.parseVisitorToken(initial.visitorToken);
    now += 24 * 60 * 60 * 1000 - 60_000;
    const renewed = await service.recordPresence(initial.visitorToken);
    expect(renewed.visitorToken).not.toBe(initial.visitorToken);
    expect(service.parseVisitorToken(renewed.visitorToken)).toBe(initialId);
    expect(await db.sitePresence.countDocuments({})).toBe(1);
    expect((await service.counts()).activeUsers).toBe(1);
  });

  test("idempotent production indexes include presence TTL and active-agent access path", async () => {
    await ensureIndexes(db);
    const indexes = await db.sitePresence.listIndexes().toArray();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      expect.objectContaining({ key: { lastSeenAt: -1, identityKey: 1 } }),
    ]));
    expect(await db.deviceTokens.listIndexes().toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { revokedAt: 1, lastSeenAt: -1 } }),
    ]));
  });

  function routerApp() {
    const app = express();
    const auth = buildAuth({
      secretKey: "test-secret", getDeviceToken: async () => ({ userId: "agent-owner" }),
      ensureUser: async () => ({ userId: "internal-user" }),
    });
    app.use("/v1", buildSiteStatsRouter({ siteStats: service, auth }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || "server_error" } }));
    return app;
  }

  test("public HTTP response exposes only aggregates and anonymous writes work without auth", async () => {
    const app = routerApp();
    const heartbeat = await request(app).post("/v1/site/presence").send({ clerkUserId: "forged-user" });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.visitorToken).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.\d{13}\.[A-Za-z0-9_-]{43}$/);
    const result = await request(app).get("/v1/site/stats");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(result.body).sort()).toEqual(["activeAgents", "activeUsers", "activityWindowSeconds", "agentDownloads", "generatedAt"]);
    expect(result.body.activeUsers).toBe(1);
    expect((await db.sitePresence.findOne({})).identityKey).toBe((await db.sitePresence.findOne({}))._id);
  });

  test("verified Clerk accounts dedupe; forged and device credentials cannot record browser presence", async () => {
    const app = routerApp();
    for (let i = 0; i < 2; i += 1) {
      const response = await request(app).post("/v1/site/presence").set("Authorization", "Bearer valid-clerk-token").send({});
      expect(response.status).toBe(200);
    }
    expect((await service.counts()).activeUsers).toBe(1);
    expect((await request(app).post("/v1/site/presence").set("Authorization", "Bearer forged.jwt.token").send({})).status).toBe(401);
    expect((await request(app).post("/v1/site/presence").set("Authorization", `Bearer ${"x".repeat(43)}`).send({})).status).toBe(403);
    expect(await db.sitePresence.countDocuments({})).toBe(2);
  });

  test("presence rejects malformed and oversized bodies, and limits repeated writes per signed token", async () => {
    const app = routerApp();
    expect((await request(app).post("/v1/site/presence").send({ visitorToken: 10 })).status).toBe(400);
    expect((await request(app).post("/v1/site/presence").send({ visitorToken: "x".repeat(2000) })).status).toBe(413);
    const { visitorToken } = await service.recordPresence();
    for (let i = 0; i < 12; i += 1) {
      expect((await request(app).post("/v1/site/presence").send({ visitorToken })).status).toBe(200);
    }
    expect((await request(app).post("/v1/site/presence").send({ visitorToken })).status).toBe(429);
    const another = await service.recordPresence();
    expect((await request(app).post("/v1/site/presence").send(another)).status).toBe(200);
  });

  test("public site routes mount ahead of account auth and use independent rate budgets", async () => {
    const { app } = buildApp({ db, logger: pino({ level: "silent" }), config: {
      nodeEnv: "test", clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 7),
      corsAllowedOrigins: [], rateLimitPerMinute: 1, pythonAnalyzerDir: "C:/__missing__",
    } });
    expect((await request(app).get("/v1/health")).status).toBe(200);
    expect((await request(app).get("/v1/health")).status).toBe(429);
    expect((await request(app).get("/v1/site/stats")).status).toBe(200);
    expect((await request(app).post("/v1/site/presence").send({})).status).toBe(200);
    expect((await request(app).get("/v1/site/stats")).status).toBe(200);
  });
});

test("failed sources return null, never fabricated zero; successful sources remain available", async () => {
  const db = {
    adminEvents: { countDocuments: async () => 0 },
    deviceTokens: { countDocuments: async () => { throw new Error("offline"); } },
    sitePresence: { aggregate: () => ({ toArray: async () => { throw new Error("offline"); } }) },
  };
  expect(await new SiteStatsService(db, { secret: "test" }).counts()).toMatchObject({ agentDownloads: 0, activeAgents: null, activeUsers: null });
});

test("concurrent reads coalesce and cache expires after ten seconds", async () => {
  let now = Date.now();
  const countDocuments = jest.fn(async () => 7);
  const service = new SiteStatsService({
    adminEvents: { countDocuments }, deviceTokens: { countDocuments },
    sitePresence: { aggregate: () => ({ toArray: async () => [] }) },
  }, { secret: "test", now: () => now });
  await Promise.all([service.counts(), service.counts(), service.counts()]);
  expect(countDocuments).toHaveBeenCalledTimes(2);
  now += 9999;
  await service.counts();
  expect(countDocuments).toHaveBeenCalledTimes(2);
  now += 1;
  await service.counts();
  expect(countDocuments).toHaveBeenCalledTimes(4);
});
