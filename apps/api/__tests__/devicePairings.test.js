// @ts-nocheck
"use strict";

/**
 * Coverage for the Devices page backing API:
 *
 *   - GET /v1/devices returns a stable `deviceId` plus the agent
 *     metadata (hostname, OS, version) the SPA needs to label rows.
 *     Without these fields the user can't tell paired devices apart
 *     and a stolen pairing can't be ejected from the web UI.
 *   - POST /v1/devices/heartbeat persists hostname so the next
 *     listDevices call labels the row.
 *   - DELETE /v1/devices/:deviceId revokes the matching row, but only
 *     when the caller owns it — guessing somebody else's id 404s.
 */

const crypto = require("crypto");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

const TEST_TOKEN = "user-devices";
const TEST_CLERK_USER_ID = "clerk_user_devices";
const OTHER_TOKEN = "user-devices-other";
const OTHER_CLERK_USER_ID = "clerk_user_devices_other";

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-devices") return { sub: "clerk_user_devices" };
    if (token === "user-devices-other") return { sub: "clerk_user_devices_other" };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({
    users: {
      getUser: jest.fn(async (clerkUserId) => ({
        id: clerkUserId,
        primaryEmailAddressId: "email_1",
        emailAddresses: [{ id: "email_1", emailAddress: "x@example.com" }],
      })),
    },
  })),
}));

describe("Devices API", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_devices",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    clerkWebhookSecret: undefined,
    serverPepper: Buffer.alloc(32, 4),
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
      dbName: "sc2tools_test_devices",
    });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
    // Ensure both test users exist before any test runs. /v1/me would
    // do this lazily, but the device tests skip that warm-up route.
    await request(app).get("/v1/me").set("authorization", `Bearer ${TEST_TOKEN}`);
    await request(app).get("/v1/me").set("authorization", `Bearer ${OTHER_TOKEN}`);
  });

  afterEach(async () => {
    await db.deviceTokens.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req, token = TEST_TOKEN) {
    return req.set("authorization", `Bearer ${token}`);
  }

  async function userIdFor(clerkUserId) {
    const row = await db.users.findOne({ clerkUserId });
    return row.userId;
  }

  async function insertToken(userId, fields = {}) {
    const tokenHash = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    const res = await db.deviceTokens.insertOne({
      tokenHash,
      userId,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      ...fields,
    });
    return { tokenHash, deviceId: String(res.insertedId) };
  }

  test("GET /v1/devices exposes deviceId + agent metadata; never the tokenHash", async () => {
    const userId = await userIdFor(TEST_CLERK_USER_ID);
    const { deviceId } = await insertToken(userId, {
      hostname: "battlestation",
      agentOs: "Windows",
      agentVersion: "0.3.1",
    });

    const res = await withAuth(request(app).get("/v1/devices"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.deviceId).toBe(deviceId);
    expect(item.hostname).toBe("battlestation");
    expect(item.agentOs).toBe("Windows");
    expect(item.agentVersion).toBe("0.3.1");
    // The bearer-token hash must never reach the client.
    expect(item.tokenHash).toBeUndefined();
    expect(item._id).toBeUndefined();
  });

  test("POST /v1/devices/heartbeat records hostname so the next list shows it", async () => {
    const userId = await userIdFor(TEST_CLERK_USER_ID);
    const { tokenHash } = await insertToken(userId);
    // Mint a real bearer for the device so the heartbeat passes auth.
    const tokenPlain = crypto.randomBytes(32).toString("hex");
    const tokenPlainHash = crypto
      .createHash("sha256")
      .update(tokenPlain)
      .digest("hex");
    await db.deviceTokens.updateOne(
      { tokenHash },
      { $set: { tokenHash: tokenPlainHash } },
    );

    const hb = await request(app)
      .post("/v1/devices/heartbeat")
      .set("authorization", `Bearer ${tokenPlain}`)
      .send({
        version: "0.4.0",
        os: "Linux",
        osRelease: "6.1.0",
        hostname: "homelab",
      });
    expect(hb.status).toBe(200);

    const list = await withAuth(request(app).get("/v1/devices"));
    expect(list.status).toBe(200);
    const item = list.body.items[0];
    expect(item.hostname).toBe("homelab");
    expect(item.agentOs).toBe("Linux");
    expect(item.agentVersion).toBe("0.4.0");
  });

  test("DELETE /v1/devices/:deviceId unpairs the row and the SPA stops seeing it", async () => {
    const userId = await userIdFor(TEST_CLERK_USER_ID);
    const { deviceId } = await insertToken(userId);

    const del = await withAuth(request(app).delete(`/v1/devices/${deviceId}`));
    expect(del.status).toBe(204);

    const list = await withAuth(request(app).get("/v1/devices"));
    expect(list.body.items).toHaveLength(0);
  });

  test("DELETE /v1/devices/:deviceId 404s when the id belongs to another user", async () => {
    const otherUserId = await userIdFor(OTHER_CLERK_USER_ID);
    const { deviceId } = await insertToken(otherUserId);

    // Caller is TEST_TOKEN (a different user) trying to unpair the
    // other user's device — must be rejected, and the row must remain.
    const del = await withAuth(request(app).delete(`/v1/devices/${deviceId}`));
    expect(del.status).toBe(404);

    const stillThere = await db.deviceTokens.findOne({
      _id: (await db.deviceTokens.findOne({ userId: otherUserId }))._id,
    });
    expect(stillThere.revokedAt).toBeNull();
  });

  test("DELETE /v1/devices/:deviceId 404s on a malformed id (no 500)", async () => {
    const del = await withAuth(request(app).delete("/v1/devices/not-an-id"));
    expect(del.status).toBe(404);
  });
});
