// @ts-nocheck
"use strict";

/**
 * Coverage for the user -> admin messaging feature (POST /v1/messages):
 *   - A signed-in user's report is persisted as a ``user_message``
 *     admin event with server-attached identity (userId / clerkUserId /
 *     account email), and shows up unread in the admin feed + counts.
 *   - Identity fields in the request body are ignored (never trusted).
 *   - Subject / message are required and length-capped.
 *   - Unauthenticated callers get 401.
 *   - The per-user rate limit returns 429 past the window cap.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "admin-token") return { sub: "clerk_admin" };
    if (token === "user-token") return { sub: "clerk_regular_user" };
    throw new Error("invalid");
  }),
}));

function baseConfig(overrides = {}) {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_user_messages",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    clerkWebhookSecret: "whsec_" + Buffer.from("msg-test").toString("base64"),
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: ["clerk_admin"],
    gameDetailsStore: "mongo",
    r2: null,
    // High enough that functional tests never trip the per-user cap.
    maxUserMessagesPerWindow: 5000,
    ...overrides,
  };
}

describe("user -> admin messaging", () => {
  let mongo;
  let db;
  let app;
  let services;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: baseConfig().mongoDb });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: baseConfig(),
    });
    app = built.app;
    services = built.services;
    await services.users.ensureFromClerk("clerk_admin");
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.adminEvents.deleteMany({});
    await db.users.deleteMany({ clerkUserId: { $ne: "clerk_admin" } });
  });

  const asUser = (req) => req.set("authorization", "Bearer user-token");
  const asAdmin = (req) => req.set("authorization", "Bearer admin-token");

  test("a signed-in user's message is recorded with server identity", async () => {
    await services.users.upsertFromWebhook(
      "clerk_regular_user",
      "reporter@example.com",
    );

    const res = await asUser(request(app).post("/v1/messages")).send({
      subject: "Macro chart won't load",
      message: "The macro breakdown spins forever on Old Republic LE.",
      // These must be ignored — identity is taken from auth, not body.
      userId: "HACKER",
      email: "evil@example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.eventId).toBe("string");

    const msg = await db.adminEvents.findOne({ type: "user_message" });
    expect(msg).toBeTruthy();
    expect(msg.payload.subject).toBe("Macro chart won't load");
    expect(msg.payload.message).toContain("spins forever");
    expect(msg.payload.clerkUserId).toBe("clerk_regular_user");
    expect(msg.payload.email).toBe("reporter@example.com");
    expect(msg.payload.userId).not.toBe("HACKER");
    expect(msg.readAt).toBeNull();
  });

  test("the message shows up unread in the admin feed + counts", async () => {
    await asUser(request(app).post("/v1/messages")).send({
      subject: "Subject here",
      message: "Body here",
    });

    const feed = await asAdmin(
      request(app).get("/v1/admin/events?type=user_message"),
    );
    expect(feed.status).toBe(200);
    expect(feed.body.items).toHaveLength(1);
    expect(feed.body.items[0].type).toBe("user_message");

    const counts = await asAdmin(request(app).get("/v1/admin/events/counts"));
    // One signup event (first-touch from the user's first authed call)
    // plus the message — both unread.
    expect(counts.body.unreadCount).toBeGreaterThanOrEqual(1);
  });

  test("subject and message are required", async () => {
    const noSubject = await asUser(request(app).post("/v1/messages")).send({
      subject: "   ",
      message: "has body",
    });
    expect(noSubject.status).toBe(400);
    expect(noSubject.body.error.code).toBe("bad_request");

    const noMessage = await asUser(request(app).post("/v1/messages")).send({
      subject: "has subject",
      message: "",
    });
    expect(noMessage.status).toBe(400);
  });

  test("oversized subject / message are rejected", async () => {
    const bigSubject = await asUser(request(app).post("/v1/messages")).send({
      subject: "x".repeat(141),
      message: "ok",
    });
    expect(bigSubject.status).toBe(400);

    const bigMessage = await asUser(request(app).post("/v1/messages")).send({
      subject: "ok",
      message: "y".repeat(4001),
    });
    expect(bigMessage.status).toBe(400);
  });

  test("unauthenticated callers are rejected", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .send({ subject: "hi", message: "there" });
    expect(res.status).toBe(401);
    const count = await db.adminEvents.countDocuments({ type: "user_message" });
    expect(count).toBe(0);
  });

  test("per-user rate limit returns 429 past the window cap", async () => {
    // Dedicated app instance with a tiny cap so the limit is
    // deterministic and isolated from the functional tests above.
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: baseConfig({ maxUserMessagesPerWindow: 2 }),
    });
    const limitedApp = built.app;

    const send = () =>
      asUser(request(limitedApp).post("/v1/messages")).send({
        subject: "spam check",
        message: "body",
      });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("rate_limited");
  });
});
