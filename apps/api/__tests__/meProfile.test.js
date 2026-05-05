// @ts-nocheck
"use strict";

/**
 * Integration tests for GET/PUT /v1/me/profile.
 *
 * These exercise the auth + service + validation path together against
 * mongodb-memory-server, matching the rest of the API test suite. The
 * SettingsProfile UI hits these endpoints; the agent does too once paired,
 * so the auth path is covered for both Clerk and device tokens.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_a" };
    throw new Error("invalid");
  }),
}));

describe("/v1/me/profile", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_profile",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 3),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_profile",
    });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer user-a");
  }

  test("GET returns an empty object before any save", async () => {
    // Touch /v1/me first so ensureFromClerk creates the user row.
    await withAuth(request(app).get("/v1/me"));
    const res = await withAuth(request(app).get("/v1/me/profile"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  test("requires auth", async () => {
    const res = await request(app).get("/v1/me/profile");
    expect(res.status).toBe(401);
  });

  test("PUT persists fields and GET reads them back", async () => {
    const payload = {
      battleTag: "ZergRush#1234",
      pulseId: "9876543",
      region: "eu",
      preferredRace: "Zerg",
      displayName: "Zerg Rush",
    };
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send(payload)
      .set("content-type", "application/json");
    expect(put.status).toBe(200);
    expect(put.body).toEqual(payload);

    const got = await withAuth(request(app).get("/v1/me/profile"));
    expect(got.status).toBe(200);
    expect(got.body).toEqual(payload);
  });

  test("schema-versions the underlying users doc", async () => {
    const doc = await db.users.findOne({ clerkUserId: "clerk_user_a" });
    expect(doc).toBeTruthy();
    expect(doc._schemaVersion).toBe(1);
    expect(doc.battleTag).toBe("ZergRush#1234");
  });

  test("PUT trims whitespace and clears empty fields", async () => {
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({
        battleTag: "  Spaced#0001  ",
        pulseId: "",
        region: "",
        preferredRace: "",
        displayName: "",
      })
      .set("content-type", "application/json");
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ battleTag: "Spaced#0001" });

    // The cleared fields are also gone from the underlying doc, not
    // sitting around as empty strings.
    const doc = await db.users.findOne({ clerkUserId: "clerk_user_a" });
    expect(doc.battleTag).toBe("Spaced#0001");
    expect(doc.pulseId).toBeUndefined();
    expect(doc.region).toBeUndefined();
    expect(doc.preferredRace).toBeUndefined();
    expect(doc.displayName).toBeUndefined();
  });

  test("rejects unknown fields", async () => {
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({ battleTag: "OK#0001", evil: "haxx" })
      .set("content-type", "application/json");
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("invalid_profile");
  });

  test("rejects invalid region", async () => {
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({ region: "mars" })
      .set("content-type", "application/json");
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("invalid_profile");
  });

  test("rejects invalid race", async () => {
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({ preferredRace: "Toss" })
      .set("content-type", "application/json");
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("invalid_profile");
  });

  test("agent device token can read its handle from the cloud", async () => {
    // Mint a device token tied to user A's internal userId; auth
    // accepts this as source=device (43-char base64url, no dots).
    const userDoc = await db.users.findOne({ clerkUserId: "clerk_user_a" });
    const rawDeviceToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm0123";
    const tokenHash = require("../src/util/hash").sha256(rawDeviceToken);
    await db.deviceTokens.insertOne({
      tokenHash,
      userId: userDoc.userId,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
    });

    // Re-set a battleTag the agent should see.
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ battleTag: "AgentReads#0001", region: "us" })
      .set("content-type", "application/json");

    const res = await request(app)
      .get("/v1/me/profile")
      .set("authorization", `Bearer ${rawDeviceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.battleTag).toBe("AgentReads#0001");
    expect(res.body.region).toBe("us");
  });
});
