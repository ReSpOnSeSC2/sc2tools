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
const { DevicePairingsService } = require("../src/services/devicePairings");
const { sha256 } = require("../src/util/hash");

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
    jest.restoreAllMocks();
    await Promise.all([db.deviceTokens.deleteMany({}), db.devicePairings.deleteMany({})]);
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

  test("preview requires authentication, never claims automatically, and exposes only bounded device metadata", async () => {
    const ip = "203.0.113.20";
    const started = await request(app).post("/v1/device-pairings/start").set("X-Forwarded-For", ip).send({
      hostname: " \u0000GAMING-PC\n\u202e ", os: " Windows 11\u0085 ", version: "v0.20.0",
      startIpHash: "spoofed", userId: "spoofed",
    });
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(["code", "expiresAt"]);
    const row = await db.devicePairings.findOne({ code: started.body.code });
    expect(row.startIpHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.startIpHash).not.toBe(ip);
    expect(JSON.stringify(row)).not.toContain(ip);
    expect(JSON.stringify(row)).not.toContain("spoofed");
    const url = `/v1/device-pairings/${started.body.code}/preview`;
    expect((await request(app).get(url)).status).toBe(401);
    const preview = await withAuth(request(app).get(url)).set("X-Forwarded-For", ip);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ sameNetwork: true, device: {
      deviceId: String(row.deviceId), hostname: "GAMING-PC", os: "Windows 11", version: "v0.20.0",
    } });
    expect(JSON.stringify(preview.body)).not.toContain(row.startIpHash);
    expect(JSON.stringify(preview.body)).not.toContain(ip);
    const untouched = await db.devicePairings.findOne({ code: started.body.code });
    expect(untouched.userId).toBeNull(); expect(untouched.claimedAt).toBeNull();
    expect(await db.deviceTokens.countDocuments({})).toBe(0);
  });

  test("metadata is optional, capped and ignores non-string values", async () => {
    const started = await request(app).post("/v1/device-pairings/start").send({ hostname: "x".repeat(100), os: {}, version: "v".repeat(100) });
    const preview = await withAuth(request(app).get(`/v1/device-pairings/${started.body.code}/preview`));
    expect(preview.body.device).toMatchObject({ hostname: "x".repeat(64), os: "", version: "v".repeat(40) });
    const empty = await request(app).post("/v1/device-pairings/start");
    const emptyPreview = await withAuth(request(app).get(`/v1/device-pairings/${empty.body.code}/preview`));
    expect(emptyPreview.body.device).toMatchObject({ hostname: "", os: "", version: "" });
  });

  test("a new process salt cannot report a same-network match for an older code", async () => {
    const ip = "203.0.113.22";
    const first = new DevicePairingsService(db, { ipSalt: "first-process" });
    const restarted = new DevicePairingsService(db, { ipSalt: "new-process" });
    const { code } = await first.start(null, ip);
    const row = await db.devicePairings.findOne({ code });
    expect(row.startIpHash).toBe(sha256(`first-process\0${ip}`));
    expect(row.startIpHash).not.toBe(sha256(ip));
    expect((await first.preview(code, ip)).sameNetwork).toBe(true);
    expect((await restarted.preview(code, ip)).sameNetwork).toBe(false);
    expect((await first.preview(code)).sameNetwork).toBe(false);
  });

  test("pre-deploy pairing codes without reserved metadata still claim and correlate", async () => {
    const row = { code: "123456", createdAt: new Date(), expiresAt: new Date(Date.now() + 600000), userId: null, claimedAt: null, consumedAt: null };
    const { insertedId } = await db.devicePairings.insertOne(row);
    const service = new DevicePairingsService(db);
    const info = await service.claim(await userIdFor(TEST_CLERK_USER_ID), row.code, "203.0.113.1");
    expect(info).toEqual({ sameNetwork: false, device: { deviceId: String(insertedId), hostname: "", os: "", version: "" } });
    expect((await service.poll(row.code)).status).toBe("ready");
    expect((await db.deviceTokens.findOne({ _id: insertedId })).lastSeenAt).toBeNull();
  });

  test("a confirmed token insertion failure leaves the code retryable", async () => {
    const service = new DevicePairingsService(db);
    const { code } = await service.start();
    const claimed = await service.claim(await userIdFor(TEST_CLERK_USER_ID), code);
    jest.spyOn(db.deviceTokens, "insertOne").mockRejectedValueOnce(new Error("insert failed"));
    await expect(service.poll(code)).rejects.toThrow("insert failed");
    expect((await db.devicePairings.findOne({ code })).consumedAt).toBeNull();
    expect((await service.poll(code)).status).toBe("ready");
    const [device] = await service.listDevices(await userIdFor(TEST_CLERK_USER_ID));
    expect(device.deviceId).toBe(claimed.device.deviceId);
    expect(await db.deviceTokens.countDocuments({})).toBe(1);
  });

  test("a lost insert acknowledgement never reopens or duplicates an already-issued token", async () => {
    const service = new DevicePairingsService(db);
    const { code } = await service.start();
    await service.claim(await userIdFor(TEST_CLERK_USER_ID), code);
    const insert = db.deviceTokens.insertOne.bind(db.deviceTokens);
    jest.spyOn(db.deviceTokens, "insertOne").mockImplementationOnce(async (document) => { await insert(document); throw new Error("acknowledgement lost"); });
    await expect(service.poll(code)).rejects.toThrow("acknowledgement lost");
    expect((await db.devicePairings.findOne({ code })).consumedAt).toBeInstanceOf(Date);
    expect(await service.poll(code)).toEqual({ status: "expired" });
    expect(await db.deviceTokens.countDocuments({})).toBe(1);
  });

  test.each([["203.0.113.21", true], ["198.51.100.21", false]])("claim network hint for %s is %s without leaking the address or hash", async (claimIp, sameNetwork) => {
    const startIp = "203.0.113.21";
    const started = await request(app).post("/v1/device-pairings/start").set("X-Forwarded-For", startIp).send({ hostname: "DESKTOP-7Q", os: "Windows 11", version: "0.20.0" });
    const row = await db.devicePairings.findOne({ code: started.body.code });
    const claimed = await withAuth(request(app).post("/v1/device-pairings/claim")).set("X-Forwarded-For", claimIp).send({ code: started.body.code });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toEqual({ sameNetwork, device: { deviceId: String(row.deviceId), hostname: "DESKTOP-7Q", os: "Windows 11", version: "0.20.0" } });
    for (const secret of [startIp, claimIp, row.startIpHash]) expect(JSON.stringify(claimed.body)).not.toContain(secret);
    expect(await db.deviceTokens.countDocuments({})).toBe(0);
  });

  test("claimed, missing and expired codes have readable distinct error codes", async () => {
    const started = await request(app).post("/v1/device-pairings/start");
    const claim = () => withAuth(request(app).post("/v1/device-pairings/claim")).send({ code: started.body.code });
    expect((await claim()).status).toBe(200);
    const repeated = await claim();
    expect(repeated.status).toBe(409); expect(repeated.body.error.code).toBe("pairing_already_claimed");
    const preview = await withAuth(request(app).get(`/v1/device-pairings/${started.body.code}/preview`));
    expect(preview.status).toBe(409); expect(preview.body.error.code).toBe("pairing_already_claimed");
    await db.devicePairings.updateOne({ code: started.body.code }, { $set: { expiresAt: new Date(0) } });
    const expired = await claim();
    expect(expired.status).toBe(404); expect(expired.body.error.code).toBe("pairing_not_found");
    const missing = await withAuth(request(app).post("/v1/device-pairings/claim")).send({ code: "000000" });
    expect(missing.status).toBe(404); expect(missing.body.error.code).toBe("pairing_not_found");
    const invalid = await withAuth(request(app).post("/v1/device-pairings/claim")).send({ code: "123 456" });
    expect(invalid.status).toBe(400);
  });

  test("concurrent claimants bind one owner and cannot replace it", async () => {
    const started = await request(app).post("/v1/device-pairings/start");
    const results = await Promise.all([TEST_TOKEN, OTHER_TOKEN].map((token) => withAuth(request(app).post("/v1/device-pairings/claim"), token).send({ code: started.body.code })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const owner = await userIdFor(results[0].status === 200 ? TEST_CLERK_USER_ID : OTHER_CLERK_USER_ID);
    expect((await db.devicePairings.findOne({ code: started.body.code })).userId).toBe(owner);
  });

  test("concurrent agent polls issue one token and its first heartbeat matches the web's reserved device id", async () => {
    const started = await request(app).post("/v1/device-pairings/start").send({ hostname: "PAIRING-PC", os: "Windows", version: "0.20.0" });
    const url = `/v1/device-pairings/${started.body.code}`;
    expect((await request(app).get(url)).body).toEqual({ status: "pending" });
    const claimed = await withAuth(request(app).post("/v1/device-pairings/claim")).send({ code: started.body.code });
    const results = await Promise.all(Array.from({ length: 8 }, () => request(app).get(url)));
    const ready = results.filter((result) => result.status === 200);
    expect(ready).toHaveLength(1);
    expect(results.filter((result) => result.status === 202).every((result) => result.body.status === "expired")).toBe(true);
    expect(await db.deviceTokens.countDocuments({})).toBe(1);
    const token = ready[0].body.deviceToken;
    const row = await db.deviceTokens.findOne({ _id: (await db.devicePairings.findOne({ code: started.body.code })).deviceId });
    expect(row.tokenHash).not.toBe(token); expect(row.lastSeenAt).toBeNull();
    const waiting = await withAuth(request(app).get("/v1/devices"));
    expect(waiting.body.items[0]).toMatchObject({ deviceId: claimed.body.device.deviceId, lastSeenAt: null, hostname: "PAIRING-PC" });
    const heartbeat = await request(app).post("/v1/devices/heartbeat").set("authorization", `Bearer ${token}`).send({ hostname: "CONNECTED-PC", version: "0.20.1", os: "Windows" });
    expect(heartbeat.status).toBe(200);
    const connected = await withAuth(request(app).get("/v1/devices"));
    expect(connected.body.items[0]).toMatchObject({ deviceId: claimed.body.device.deviceId, hostname: "CONNECTED-PC", agentVersion: "0.20.1" });
    expect(connected.body.items[0].lastSeenAt).toEqual(expect.any(String));
    expect(connected.body.items[0].pairingCode).toBeUndefined();
    expect(JSON.stringify(connected.body)).not.toContain(token);
    expect(JSON.stringify(connected.body)).not.toContain(row.tokenHash);
    expect((await request(app).get(url)).body).toEqual({ status: "expired" });
  });

  test("device lists allow only documented display fields", async () => {
    const userId = await userIdFor(TEST_CLERK_USER_ID);
    await insertToken(userId, { hostname: "Public name", startIpHash: "private-ip-hash", ip: "203.0.113.99", pairingCode: "123456", internalSecret: "private-value" });
    const list = await withAuth(request(app).get("/v1/devices"));
    expect(Object.keys(list.body.items[0]).sort()).toEqual(["createdAt", "deviceId", "hostname", "lastSeenAt", "userId"]);
  });

  test("label editing is owner-scoped, trimmed, clearable and limited to forty characters", async () => {
    const userId = await userIdFor(TEST_CLERK_USER_ID);
    const { deviceId } = await insertToken(userId);
    const edit = (label, token = TEST_TOKEN) => withAuth(request(app).patch(`/v1/devices/${deviceId}`), token).send({ label });
    expect((await edit("  My gaming PC  ")).status).toBe(204);
    expect((await db.deviceTokens.findOne({ userId })).label).toBe("My gaming PC");
    expect((await edit("Another account", OTHER_TOKEN)).status).toBe(404);
    expect((await edit("x".repeat(40))).status).toBe(204);
    for (const label of ["x".repeat(41), null, 7, "bad\nlabel"]) expect((await edit(label)).status).toBe(400);
    expect((await db.deviceTokens.findOne({ userId })).label).toBe("x".repeat(40));
    expect((await edit("  ")).status).toBe(204);
    expect((await db.deviceTokens.findOne({ userId })).label).toBe("");
    await db.deviceTokens.updateOne({ userId }, { $set: { revokedAt: new Date() } });
    expect((await edit("Already revoked")).status).toBe(404);
    expect((await withAuth(request(app).patch("/v1/devices/not-an-id")).send({ label: "Valid" })).status).toBe(404);
    expect((await request(app).patch(`/v1/devices/${deviceId}`).send({ label: "No auth" })).status).toBe(401);
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
