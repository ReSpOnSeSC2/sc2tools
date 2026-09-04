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
    // polluting feed-count assertions. ensureFromClerk awaits this
    // one-time notification write before resolving.
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

  function asAdmin(req) {
    return req.set("authorization", "Bearer admin-token");
  }

  test("first-touch ensureFromClerk persists its signup before resolving", async () => {
    await services.users.ensureFromClerk("clerk_new_one");
    const events = await db.adminEvents.find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user_signup");
    expect(events[0].payload.clerkUserId).toBe("clerk_new_one");
    expect(events[0].payload.email).toBeNull();
    expect(events[0].payload.source).toBe("first_touch");
  });

  test("user.created converges email onto one first-touch event", async () => {
    await services.users.ensureFromClerk("clerk_race");
    const before = await db.adminEvents.findOne({
      "payload.clerkUserId": "clerk_race",
    });
    const readAt = new Date("2026-09-04T12:00:00.000Z");
    await db.adminEvents.updateOne(
      { eventId: before.eventId },
      { $set: { readAt } },
    );
    await services.users.upsertFromWebhook(
      "clerk_race",
      "race@example.com",
      { eventType: "user.created" },
    );
    const events = await db.adminEvents.find({
      "payload.clerkUserId": "clerk_race",
    }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].payload.email).toBe("race@example.com");
    expect(events[0].payload.source).toBe("first_touch");
    expect(events[0].eventId).toBe(before.eventId);
    expect(events[0].createdAt).toEqual(before.createdAt);
    expect(events[0].readAt).toEqual(readAt);
  });

  test("concurrent first-touch and user.created converge to one emailed event", async () => {
    await Promise.all([
      services.users.ensureFromClerk("clerk_concurrent"),
      services.users.upsertFromWebhook(
        "clerk_concurrent",
        "concurrent@example.com",
        { eventType: "user.created" },
      ),
    ]);
    const events = await db.adminEvents.find({
      "payload.clerkUserId": "clerk_concurrent",
    }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].payload.email).toBe("concurrent@example.com");
  });

  test("setEmail fill-only enriches and broadcasts an existing signup", async () => {
    await services.users.ensureFromClerk("clerk_lazy_email");
    const before = await db.adminEvents.findOne({
      "payload.clerkUserId": "clerk_lazy_email",
    });
    const readAt = new Date("2026-09-04T13:00:00.000Z");
    await db.adminEvents.updateOne(
      { eventId: before.eventId },
      { $set: { readAt }, $unset: { "payload.email": "" } },
    );

    const emit = jest.fn();
    const oldIo = services.adminEvents.io;
    services.adminEvents.io = {
      to: jest.fn((room) => {
        expect(room).toBe("admin");
        return { emit };
      }),
    };
    try {
      await services.users.setEmail(
        before.payload.userId,
        "lazy@example.com",
      );
      const after = await db.adminEvents.findOne({ eventId: before.eventId });
      expect(after.payload.email).toBe("lazy@example.com");
      expect(after.payload.source).toBe("first_touch");
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.readAt).toEqual(readAt);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        "admin:event",
        expect.objectContaining({
          eventId: before.eventId,
          payload: expect.objectContaining({ email: "lazy@example.com" }),
        }),
      );

      emit.mockClear();
      await services.users.setEmail(
        before.payload.userId,
        "newer@example.com",
      );
      const unchanged = await db.adminEvents.findOne({ eventId: before.eventId });
      expect(unchanged.payload.email).toBe("lazy@example.com");
      expect(emit).not.toHaveBeenCalled();
    } finally {
      services.adminEvents.io = oldIo;
    }
  });

  test("email enrichment skips anonymized signup events", async () => {
    await services.users.ensureFromClerk("clerk_anonymized");
    const signup = await db.adminEvents.findOne({
      "payload.clerkUserId": "clerk_anonymized",
    });
    await db.adminEvents.updateOne(
      { eventId: signup.eventId },
      { $set: { anonymizedAt: new Date() } },
    );
    const emit = jest.fn();
    const oldIo = services.adminEvents.io;
    services.adminEvents.io = { to: jest.fn(() => ({ emit })) };
    try {
      await services.users.setEmail(
        signup.payload.userId,
        "private@example.com",
      );
      const after = await db.adminEvents.findOne({ eventId: signup.eventId });
      expect(after.payload.email).toBeNull();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      services.adminEvents.io = oldIo;
    }
  });

  test("email enrichment treats an empty legacy value as missing", async () => {
    await services.users.ensureFromClerk("clerk_empty_email");
    const signup = await db.adminEvents.findOne({
      "payload.clerkUserId": "clerk_empty_email",
    });
    await db.adminEvents.updateOne(
      { eventId: signup.eventId },
      { $set: { "payload.email": "" } },
    );
    await services.users.setEmail(
      signup.payload.userId,
      "filled-empty@example.com",
    );
    const after = await db.adminEvents.findOne({ eventId: signup.eventId });
    expect(after.payload.email).toBe("filled-empty@example.com");
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

  test("Clerk user.updated enriches but never creates a signup", async () => {
    await db.users.insertOne({
      userId: "u_existing_updated",
      clerkUserId: "clerk_existing_updated",
      email: "old@example.com",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const payload = JSON.stringify({
      type: "user.updated",
      data: {
        id: "clerk_existing_updated",
        primaryEmailAddressId: "em_updated",
        emailAddresses: [
          { id: "em_updated", emailAddress: "updated@example.com" },
        ],
      },
    });
    const res = await sendWebhook(payload);
    expect(res.status).toBe(200);
    expect(
      await db.adminEvents.countDocuments({
        "payload.clerkUserId": "clerk_existing_updated",
      }),
    ).toBe(0);
    const user = await db.users.findOne({
      clerkUserId: "clerk_existing_updated",
    });
    expect(user.email).toBe("updated@example.com");
  });

  test("Clerk user.updated fills an existing first-touch signup", async () => {
    await services.users.ensureFromClerk("clerk_updated_signup");
    const payload = JSON.stringify({
      type: "user.updated",
      data: {
        id: "clerk_updated_signup",
        primaryEmailAddressId: "em_fill",
        emailAddresses: [
          { id: "em_fill", emailAddress: "fill@example.com" },
        ],
      },
    });
    const res = await sendWebhook(payload);
    expect(res.status).toBe(200);
    const events = await db.adminEvents.find({
      "payload.clerkUserId": "clerk_updated_signup",
    }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].payload.email).toBe("fill@example.com");
    expect(events[0].payload.source).toBe("first_touch");
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

  test("download-event reports a failed notification write", async () => {
    const record = jest
      .spyOn(services.adminEvents, "record")
      .mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/v1/agent/download-event")
      .send({ platform: "windows", version: "0.3.11" });

    expect(res.status).toBe(503);
    expect(record).toHaveBeenCalledWith(
      "agent_download",
      expect.objectContaining({
        platform: "windows",
        version: "0.3.11",
      }),
    );
    record.mockRestore();
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

  test("admin list batch-hydrates legacy signup emails without rewriting events", async () => {
    await db.users.insertMany([
      {
        userId: "u_legacy_email",
        clerkUserId: "clerk_legacy_email",
        email: "legacy@example.com",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      },
      {
        userId: "u_legacy_empty",
        clerkUserId: "clerk_legacy_empty",
        email: "legacy-empty@example.com",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      },
    ]);
    const legacy = await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_legacy_email",
      userId: "u_legacy_email",
      source: "first_touch",
    });
    const empty = await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_legacy_empty",
      userId: "u_legacy_empty",
      source: "first_touch",
    });
    await db.adminEvents.updateOne(
      { eventId: empty.eventId },
      { $set: { "payload.email": "" } },
    );

    const res = await asAdmin(
      request(app).get("/v1/admin/events?type=user_signup"),
    );
    expect(res.status).toBe(200);
    const hydrated = res.body.items.find((e) => e.eventId === legacy.eventId);
    const emptyRow = res.body.items.find((e) => e.eventId === empty.eventId);
    expect(hydrated.payload.email).toBe("legacy@example.com");
    expect(emptyRow.payload.email).toBe("legacy-empty@example.com");

    // Read-time hydration is deliberately response-only. Durable history
    // remains unchanged.
    const stored = await db.adminEvents.findOne({ eventId: legacy.eventId });
    expect(stored.payload.email).toBeNull();
    const storedEmpty = await db.adminEvents.findOne({ eventId: empty.eventId });
    expect(storedEmpty.payload.email).toBe("");
  });

  test("admin list never hydrates an anonymized signup", async () => {
    await db.users.insertOne({
      userId: "u_legacy_anonymized",
      clerkUserId: "clerk_legacy_anonymized",
      email: "must-not-return@example.com",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    const event = await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_legacy_anonymized",
      userId: "u_legacy_anonymized",
      source: "first_touch",
    });
    await db.adminEvents.updateOne(
      { eventId: event.eventId },
      { $set: { anonymizedAt: new Date() } },
    );

    const result = await services.adminEvents.list({ type: "user_signup" });
    const row = result.items.find((item) => item.eventId === event.eventId);
    expect(row.payload.email).toBeNull();
  });

  test("admin list keeps original rows when optional email hydration fails", async () => {
    const event = await services.adminEvents.record("user_signup", {
      clerkUserId: "clerk_hydration_failure",
      userId: "u_hydration_failure",
      source: "first_touch",
    });
    const warn = jest.fn();
    const oldLogger = services.adminEvents.logger;
    const find = jest
      .spyOn(db.users, "find")
      .mockImplementationOnce(() => {
        throw new Error("users unavailable");
      });
    services.adminEvents.logger = { warn };
    try {
      const result = await services.adminEvents.list({ type: "user_signup" });
      const row = result.items.find((item) => item.eventId === event.eventId);
      expect(row.payload.email).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "admin_signup_email_hydration_failed",
      );
    } finally {
      find.mockRestore();
      services.adminEvents.logger = oldLogger;
    }
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
