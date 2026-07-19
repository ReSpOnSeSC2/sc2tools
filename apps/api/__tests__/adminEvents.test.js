// @ts-nocheck
"use strict";

/**
 * Coverage for the admin notification feed:
 *   - First-touch ensureFromClerk fires a ``user_signup`` event.
 *   - The Clerk webhook fires a ``user_signup`` event.
 *   - A second sighting of the same Clerk user produces ONE feed
 *     entry (unique partial index dedupe).
 *   - POST /v1/agent/download-event records an ``agent_download``
 *     event with the platform/version payload and masks the client IP.
 *   - GET /v1/admin/events lists newest-first.
 *   - GET /v1/admin/events/counts reflects totals + 24h/7d windows
 *     and the unread count.
 *   - POST /v1/admin/events/mark-read flips readAt for all unread.
 */

const crypto = require("crypto");
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

const WEBHOOK_SECRET = "whsec_" + Buffer.from("events-test-secret").toString("base64");

describe("admin notification events", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_events",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    clerkWebhookSecret: WEBHOOK_SECRET,
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: ["clerk_admin"],
    gameDetailsStore: "mongo",
    r2: null,
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
    services = built.services;
    // Bootstrap the admin's user row once so per-test asAdmin calls
    // don't keep firing a signup event for the harness admin and
    // polluting feed-count assertions. The signup event insert is
    // fire-and-forget inside ensureFromClerk — WAIT for it to land
    // before any beforeEach cleanup runs, or it can materialize after
    // the wipe and pollute the first test's count (a race that app-
    // boot scheduling changes can expose).
    await services.users.ensureFromClerk("clerk_admin");
    for (let i = 0; i < 100; i += 1) {
      if ((await db.adminEvents.countDocuments({})) > 0) break;
      await sleep(10);
    }
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.adminEvents.deleteMany({});
    await db.users.deleteMany({ clerkUserId: { $ne: "clerk_admin" } });
  });

  function asAdmin(req) {
    return req.set("authorization", "Bearer admin-token");
  }

  test("first-touch ensureFromClerk fires a user_signup event", async () => {
    await services.users.ensureFromClerk("clerk_new_one");
    // Promise inside _recordSignup is fire-and-forget; let it settle.
    await flushMicroTasks();
    const events = await db.adminEvents.find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user_signup");
    expect(events[0].payload.clerkUserId).toBe("clerk_new_one");
    expect(events[0].payload.source).toBe("first_touch");
  });

  test("duplicate webhook + first-touch race produces ONE event row", async () => {
    await services.users.ensureFromClerk("clerk_race");
    await services.users.upsertFromWebhook(
      "clerk_race",
      "race@example.com",
    );
    await flushMicroTasks();
    const events = await db.adminEvents.find({
      "payload.clerkUserId": "clerk_race",
    }).toArray();
    expect(events).toHaveLength(1);
  });

  test("Clerk webhook signup is recorded on user.created", async () => {
    const payload = JSON.stringify({
      type: "user.created",
      data: {
        id: "clerk_via_webhook",
        primaryEmailAddressId: "em_1",
        emailAddresses: [
          { id: "em_1", emailAddress: "wh@example.com" },
        ],
      },
    });
    const res = await sendWebhook(payload);
    expect(res.status).toBe(200);
    await flushMicroTasks();
    const events = await db.adminEvents.find({
      "payload.clerkUserId": "clerk_via_webhook",
    }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user_signup");
    expect(events[0].payload.email).toBe("wh@example.com");
    expect(events[0].payload.source).toBe("clerk_webhook");
  });

  test("download-event endpoint records and masks ip", async () => {
    const res = await request(app)
      .post("/v1/agent/download-event")
      .set("x-forwarded-for", "203.0.113.42")
      .send({ platform: "windows", version: "0.3.11", channel: "stable" });
    expect(res.status).toBe(204);
    await flushMicroTasks();
    const events = await db.adminEvents.find({
      type: "agent_download",
    }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].payload.platform).toBe("windows");
    expect(events[0].payload.version).toBe("0.3.11");
    // IP is masked to /24 — full address must NOT survive.
    expect(events[0].payload.ip).toBe("203.0.113.0/24");
  });

  test("download-event records the edge-provided country header", async () => {
    const res = await request(app)
      .post("/v1/agent/download-event")
      .set("cf-ipcountry", "US")
      .send({ platform: "windows", version: "0.3.11", channel: "stable" });
    expect(res.status).toBe(204);
    await flushMicroTasks();
    const ev = await db.adminEvents.findOne({ type: "agent_download" });
    expect(ev.payload.country).toBe("US");
  });

  test("download-event rejects malformed platform to 'unknown'", async () => {
    const res = await request(app)
      .post("/v1/agent/download-event")
      .send({ platform: "weirdos", version: "0.3.11" });
    expect(res.status).toBe(204);
    await flushMicroTasks();
    const ev = await db.adminEvents.findOne({ type: "agent_download" });
    expect(ev.payload.platform).toBe("unknown");
  });

  test("admin events list returns newest first", async () => {
    await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_a",
      userId: "u-a",
      source: "first_touch",
    });
    await sleep(8);
    await services.adminEvents.record("agent_download", {
      platform: "macos",
      version: "0.4.0",
    });
    const res = await asAdmin(request(app).get("/v1/admin/events"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].type).toBe("agent_download");
    expect(res.body.items[1].type).toBe("user_signup");
  });

  test("counts reflect totals + range windows + unread", async () => {
    // One signup (this week), one download (today), no users seeded.
    await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_count",
      userId: "u-count",
      source: "first_touch",
    });
    await services.adminEvents.record("agent_download", {
      platform: "windows",
      version: "0.3.11",
    });
    await services.adminEvents.record("agent_download", {
      platform: "linux",
      version: "0.3.11",
    });

    const res = await asAdmin(request(app).get("/v1/admin/events/counts"));
    expect(res.status).toBe(200);
    expect(res.body.totalSignupsTracked).toBe(1);
    expect(res.body.signupsToday).toBe(1);
    expect(res.body.signupsThisWeek).toBe(1);
    expect(res.body.totalDownloads).toBe(2);
    expect(res.body.downloadsToday).toBe(2);
    expect(res.body.downloadsByPlatform.windows).toBe(1);
    expect(res.body.downloadsByPlatform.linux).toBe(1);
    expect(res.body.downloadsByPlatform.macos).toBe(0);
    expect(res.body.unreadCount).toBe(3);
  });

  test("mark-read flips every unread event", async () => {
    await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_read",
      userId: "u-read",
      source: "first_touch",
    });
    await services.adminEvents.record("agent_download", {
      platform: "windows",
      version: "0.3.11",
    });
    const res = await asAdmin(
      request(app).post("/v1/admin/events/mark-read"),
    );
    expect(res.status).toBe(200);
    expect(res.body.markedRead).toBe(2);
    const stillUnread = await db.adminEvents.countDocuments({ readAt: null });
    expect(stillUnread).toBe(0);
    // Counts now reflect zero unread.
    const counts = await asAdmin(
      request(app).get("/v1/admin/events/counts"),
    );
    expect(counts.body.unreadCount).toBe(0);
  });

  function sendWebhook(payload) {
    const id = "msg_test_" + crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
    const sig = crypto
      .createHmac("sha256", key)
      .update(`${id}.${timestamp}.${payload}`)
      .digest("base64");
    return request(app)
      .post("/v1/webhooks/clerk")
      .set("svix-id", id)
      .set("svix-timestamp", timestamp)
      .set("svix-signature", `v1,${sig}`)
      .set("content-type", "application/json")
      .send(payload);
  }
});

function flushMicroTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
