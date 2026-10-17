// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "connection-admin") return { sub: "clerk_connection_admin" };
    if (token === "connection-user") return { sub: "clerk_connection_user" };
    throw new Error("invalid");
  }),
}));

describe("verified agent connection notifications", () => {
  let mongo;
  let db;
  let app;
  let services;
  let userId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_agent_connections",
    clerkSecretKey: "sk_test",
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: ["clerk_connection_admin"],
    gameDetailsStore: "mongo",
    r2: null,
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
    services = built.services;
    await services.users.ensureFromClerk("clerk_connection_admin");
    const user = await services.users.ensureFromClerk("clerk_connection_user");
    userId = user.userId;
  });

  beforeEach(async () => {
    await Promise.all([
      db.adminEvents.deleteMany({}),
      db.deviceTokens.deleteMany({}),
      db.devicePairings.deleteMany({}),
      db.users.updateOne({ userId }, { $set: { email: "installed@example.com" } }),
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (services) services.adminEvents.io = null;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function asUser(req) {
    return req.set("authorization", "Bearer connection-user");
  }

  function asAdmin(req) {
    return req.set("authorization", "Bearer connection-admin");
  }

  async function pairAgent() {
    const started = await request(app).post("/v1/device-pairings/start");
    expect(started.status).toBe(200);
    const claimed = await asUser(request(app).post("/v1/device-pairings/claim"))
      .send({ code: started.body.code });
    expect(claimed.status).toBe(204);
    const polled = await request(app).get(`/v1/device-pairings/${started.body.code}`);
    expect(polled.status).toBe(200);
    expect(polled.body.status).toBe("ready");
    const device = await db.deviceTokens.findOne({ userId, pairingCode: started.body.code });
    return { token: polled.body.deviceToken, device, code: started.body.code };
  }

  function heartbeat(token, body = {}) {
    return request(app)
      .post("/v1/devices/heartbeat")
      .set("authorization", `Bearer ${token}`)
      .send({ version: "0.16.10", os: "Windows", ...body });
  }

  function connectionEvents() {
    return db.adminEvents.find({ type: "agent_connected" }).toArray();
  }

  test("pairing alone does not claim that an agent has checked in", async () => {
    await pairAgent();
    expect(await connectionEvents()).toHaveLength(0);
  });

  test("the first heartbeat stores no personal identity and decorates the feed from trusted users", async () => {
    const { token, device, code } = await pairAgent();
    const installedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.deviceTokens.updateOne({ _id: device._id }, { $set: { createdAt: installedAt } });

    const response = await heartbeat(token, {
      hostname: "private-gaming-pc",
      userId: "spoofed-user",
      clerkUserId: "spoofed-clerk",
      email: "spoofed@example.com",
      deviceId: "spoofed-device",
    });
    expect(response.status).toBe(200);
    const [event] = await connectionEvents();
    expect(event).toMatchObject({
      type: "agent_connected",
      ingestionKey: `agent_connected:${device._id}`,
      createdAt: installedAt,
      readAt: null,
      payload: {
        userId,
        clerkUserId: null,
        email: null,
        deviceId: String(device._id),
        platform: "windows",
        version: "0.16.10",
        source: "heartbeat",
      },
    });
    const serialized = JSON.stringify(event);
    for (const secret of [token, device.tokenHash, code, "private-gaming-pc", "spoofed", "installed@example.com", "clerk_connection_user"])
      expect(serialized).not.toContain(secret);

    const feed = await asAdmin(request(app).get("/v1/admin/events?type=agent_connected"));
    expect(feed.status).toBe(200);
    expect(feed.body.items[0].payload).toMatchObject({
      userId,
      clerkUserId: "clerk_connection_user",
      email: "installed@example.com",
      deviceId: String(device._id),
    });
  });

  test("concurrent and later heartbeats emit one event and broadcast per device", async () => {
    const first = await pairAgent();
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    services.adminEvents.io = { to };

    const results = await Promise.all(Array.from({ length: 6 }, () => heartbeat(first.token)));
    expect(results.every((result) => result.status === 200)).toBe(true);
    await heartbeat(first.token, { version: "0.16.11" });
    const [event] = await connectionEvents();
    expect(await connectionEvents()).toHaveLength(1);
    expect(event.payload.version).toBe("0.16.10");
    expect(to).toHaveBeenCalledWith("admin");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("admin:event", expect.objectContaining({
      eventId: event.eventId,
      payload: expect.objectContaining({
        userId,
        clerkUserId: "clerk_connection_user",
        email: "installed@example.com",
      }),
    }));

    const second = await pairAgent();
    expect((await heartbeat(second.token)).status).toBe(200);
    expect(await connectionEvents()).toHaveLength(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  test("a failed notification insert leaves heartbeat successful and retries next time", async () => {
    const { token, device } = await pairAgent();
    const originalCreatedAt = device.createdAt;
    const emit = jest.fn();
    services.adminEvents.io = { to: jest.fn(() => ({ emit })) };
    jest.spyOn(db.adminEvents, "insertOne").mockRejectedValueOnce(new Error("temporary mongo failure"));

    expect((await heartbeat(token)).status).toBe(200);
    expect(await connectionEvents()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect((await heartbeat(token)).status).toBe(200);
    const events = await connectionEvents();
    expect(events).toHaveLength(1);
    expect(events[0].createdAt).toEqual(originalCreatedAt);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test("browser credentials and revoked devices cannot create a connection event", async () => {
    const browser = await asUser(request(app).post("/v1/devices/heartbeat"))
      .send({ os: "Windows", version: "0.16.10" });
    expect(browser.status).toBe(403);
    const { token, device } = await pairAgent();
    await db.deviceTokens.updateOne({ _id: device._id }, { $set: { revokedAt: new Date() } });
    expect((await heartbeat(token)).status).toBe(401);
    expect(await connectionEvents()).toHaveLength(0);
  });

  test.each([
    ["wInDoWs", "windows"],
    ["Darwin", "macos"],
    ["LINUX", "linux"],
    ["unrecognized", "unknown"],
  ])("normalizes agent OS %s to %s", async (os, platform) => {
    const { token } = await pairAgent();
    expect((await heartbeat(token, { os })).status).toBe(200);
    const [event] = await connectionEvents();
    expect(event.payload.platform).toBe(platform);
  });

  test("admin filtering and read-time email hydration include recovered connections", async () => {
    await db.users.updateOne({ userId }, { $set: { email: null } });
    const { token } = await pairAgent();
    await heartbeat(token);
    const [stored] = await connectionEvents();
    expect(stored.payload.email).toBeNull();
    await db.users.updateOne({ userId }, { $set: { email: "resolved@example.com" } });
    await request(app).post("/v1/agent/download-event").send({ platform: "windows" });

    const feed = await asAdmin(request(app).get("/v1/admin/events?type=agent_connected"));
    expect(feed.status).toBe(200);
    expect(feed.body.items).toHaveLength(1);
    expect(feed.body.items[0]).toMatchObject({
      eventId: stored.eventId,
      type: "agent_connected",
      payload: { email: "resolved@example.com" },
    });
    expect((await db.adminEvents.findOne({ eventId: stored.eventId })).payload.email).toBeNull();

    await db.adminEvents.updateOne({ eventId: stored.eventId }, {
      $set: { anonymizedAt: new Date(), "payload.email": null, "payload.clerkUserId": null },
    });
    const anonymizedFeed = await asAdmin(request(app).get("/v1/admin/events?type=agent_connected"));
    expect(anonymizedFeed.body.items[0].payload.email).toBeNull();
  });

  test("verified connections do not inflate website download counters", async () => {
    await request(app).post("/v1/agent/download-event").send({ platform: "windows" });
    const before = await asAdmin(request(app).get("/v1/admin/events/counts"));
    expect(before.body.totalDownloads).toBe(1);
    const { token } = await pairAgent();
    await heartbeat(token);
    const after = await asAdmin(request(app).get("/v1/admin/events/counts"));
    expect(after.status).toBe(200);
    expect(after.body.totalDownloads).toBe(1);
    expect(after.body.downloadsToday).toBe(before.body.downloadsToday);
    expect(after.body.downloadsByPlatform).toEqual(before.body.downloadsByPlatform);
    expect(await db.adminEvents.countDocuments({ type: "agent_download" })).toBe(1);
    expect(await connectionEvents()).toHaveLength(1);
  });

  test("an in-flight connection cannot persist identity after its user and device are deleted", async () => {
    const { token } = await pairAgent();
    const user = await db.users.findOne({ userId });
    const emit = jest.fn();
    services.adminEvents.io = { to: jest.fn(() => ({ emit })) };

    let releaseInsert;
    let reachedInsert;
    const insertionGate = new Promise((resolve) => { releaseInsert = resolve; });
    const insertionReached = new Promise((resolve) => { reachedInsert = resolve; });
    const insert = db.adminEvents.insertOne.bind(db.adminEvents);
    jest.spyOn(db.adminEvents, "insertOne").mockImplementation(async (doc, ...args) => {
      if (doc.type === "agent_connected") {
        reachedInsert();
        await insertionGate;
      }
      return insert(doc, ...args);
    });

    const pendingHeartbeat = heartbeat(token).then((response) => response);
    try {
      await insertionReached;
      await db.deviceTokens.deleteMany({ userId });
      await db.users.deleteOne({ userId });
      releaseInsert();
      expect((await pendingHeartbeat).status).toBe(200);

      const [stored] = await connectionEvents();
      expect(stored.payload).toMatchObject({ userId, email: null, clerkUserId: null });
      expect(JSON.stringify(stored)).not.toContain("installed@example.com");
      expect(JSON.stringify(stored)).not.toContain("clerk_connection_user");
      const feed = await asAdmin(request(app).get("/v1/admin/events?type=agent_connected"));
      expect(feed.body.items[0].payload).toMatchObject({ email: null, clerkUserId: null });
      // A missing account must also prevent personal identity from reaching
      // a live admin tab when the delayed event is finally broadcast.
      expect(JSON.stringify(emit.mock.calls)).not.toContain("installed@example.com");
      expect(JSON.stringify(emit.mock.calls)).not.toContain("clerk_connection_user");
    } finally {
      releaseInsert();
      await pendingHeartbeat;
      await db.users.replaceOne({ userId }, user, { upsert: true });
    }
  });
});
