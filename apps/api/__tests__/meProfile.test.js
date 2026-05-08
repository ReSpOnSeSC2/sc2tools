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
    // ``detectedPulseIds`` is always emitted (empty when there are no
    // games yet), so the empty-profile shape is decorated even with
    // nothing saved.
    expect(res.body).toEqual({ detectedPulseIds: [] });
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
    // PUT response is the persisted profile — legacy ``pulseId`` is
    // mirrored from ``pulseIds[0]`` so single-string callers see what
    // they sent. The array is decorated alongside.
    expect(put.body).toEqual({ ...payload, pulseIds: ["9876543"] });

    const got = await withAuth(request(app).get("/v1/me/profile"));
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      ...payload,
      pulseIds: ["9876543"],
      detectedPulseIds: [],
    });
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

  test("POST /v1/me/last-mmr stores the sticky MMR + region", async () => {
    const post = await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({
        mmr: 4730,
        capturedAt: "2026-05-07T10:00:00Z",
        region: "NA",
      })
      .set("content-type", "application/json");
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);
    expect(post.body.wrote).toBe(true);

    const got = await withAuth(request(app).get("/v1/me/profile"));
    expect(got.status).toBe(200);
    expect(got.body.lastKnownMmr).toBe(4730);
    expect(got.body.lastKnownMmrAt).toBe("2026-05-07T10:00:00Z");
    expect(got.body.lastKnownMmrRegion).toBe("NA");
  });

  test("POST /v1/me/last-mmr is idempotent when the value hasn't changed", async () => {
    // First push lands the value.
    await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({ mmr: 4730, region: "NA" })
      .set("content-type", "application/json");
    // Second push with the same value should report wrote=false so an
    // operator triaging a hot loop can tell the agent isn't grinding
    // a Mongo write per replay during a backfill.
    const second = await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({ mmr: 4730, region: "NA" })
      .set("content-type", "application/json");
    expect(second.status).toBe(200);
    expect(second.body.wrote).toBe(false);
  });

  test("POST /v1/me/last-mmr rejects out-of-band MMR values", async () => {
    // 7 = the Grandmaster league enum that pre-v0.5.5 leaked into
    // `mmr` and made the overlay paint "7" as a rating. Reject it.
    const tooLow = await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({ mmr: 7 })
      .set("content-type", "application/json");
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error.code).toBe("invalid_mmr");

    const tooHigh = await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({ mmr: 12345 })
      .set("content-type", "application/json");
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.code).toBe("invalid_mmr");

    const notNumber = await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({ mmr: "high" })
      .set("content-type", "application/json");
    expect(notNumber.status).toBe(400);
  });

  test("POST /v1/me/last-mmr can't clobber the user-editable profile fields", async () => {
    // The route accepts only `mmr`/`capturedAt`/`region` — extra
    // fields like `battleTag` must be ignored, not persisted. This
    // protects the streamer's typed-in Settings values from being
    // wiped by an agent ping.
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ battleTag: "PinnedTag#0001", region: "kr" })
      .set("content-type", "application/json");

    await withAuth(request(app).post("/v1/me/last-mmr"))
      .send({ mmr: 4730, battleTag: "EvilTag#9999" })
      .set("content-type", "application/json");

    const got = await withAuth(request(app).get("/v1/me/profile"));
    expect(got.body.battleTag).toBe("PinnedTag#0001");
    expect(got.body.region).toBe("kr");
    expect(got.body.lastKnownMmr).toBe(4730);
  });

  test("POST /v1/me/last-mmr requires auth", async () => {
    const res = await request(app)
      .post("/v1/me/last-mmr")
      .send({ mmr: 4730 })
      .set("content-type", "application/json");
    expect(res.status).toBe(401);
  });

  test("PUT /v1/me/profile rejects out-of-band lastKnownMmr values", async () => {
    // Settings UI doesn't currently expose lastKnownMmr, but the
    // schema validator is the source of truth for what the route
    // accepts. Lock down the bounds so a future client typo can't
    // poison the cache.
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({ lastKnownMmr: 5 })
      .set("content-type", "application/json");
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("invalid_profile");
  });

  // ---- Multi-Pulse-ID support (v0.5.8) ----
  // These tests live at the bottom because they mutate state in ways
  // earlier tests didn't anticipate (the legacy tests assumed a
  // single-string pulseId model). Adding them here keeps the existing
  // ordering-dependent assertions intact while still exercising the
  // new behaviour against a populated user doc.

  test("PUT pulseIds[] persists the full list and mirrors pulseId from it", async () => {
    const payload = {
      battleTag: "MultiTag#0001",
      pulseIds: ["9876543", "1-S2-1-267727", "2-S2-1-555555"],
      region: "us",
    };
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send(payload)
      .set("content-type", "application/json");
    expect(put.status).toBe(200);
    expect(put.body.pulseIds).toEqual([
      "9876543",
      "1-S2-1-267727",
      "2-S2-1-555555",
    ]);
    // Legacy single-string ``pulseId`` is mirrored from the first
    // entry so unmigrated read-paths (the agent's player-handle
    // fallback, the session widget's MMR fallback) keep resolving.
    expect(put.body.pulseId).toBe("9876543");
  });

  test("PUT pulseIds[] dedupes and trims entries", async () => {
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({
        pulseIds: ["  994428  ", "994428", "1-S2-1-1", "  ", "1-S2-1-1"],
      })
      .set("content-type", "application/json");
    expect(put.status).toBe(200);
    expect(put.body.pulseIds).toEqual(["994428", "1-S2-1-1"]);
  });

  test("PUT pulseIds: [] clears both the array and the legacy single field", async () => {
    // Seed something to clear.
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: ["111", "222"] })
      .set("content-type", "application/json");
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: [] })
      .set("content-type", "application/json");
    expect(put.status).toBe(200);
    expect(put.body.pulseId).toBeUndefined();
    expect(put.body.pulseIds).toBeUndefined();
    const doc = await db.users.findOne({ clerkUserId: "clerk_user_a" });
    expect(doc.pulseId).toBeUndefined();
    expect(doc.pulseIds).toBeUndefined();
  });

  test("PUT rejects pulseIds with too many entries", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => String(i + 1));
    const put = await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: tooMany })
      .set("content-type", "application/json");
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("invalid_profile");
  });

  test("GET /v1/me/profile surfaces auto-detected toon handles from games", async () => {
    // Clear any stored pulseIds so detected ones aren't filtered out
    // by the dedup-against-known step in the GET handler.
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: [] })
      .set("content-type", "application/json");
    const userDoc = await db.users.findOne({ clerkUserId: "clerk_user_a" });
    // Insert two games carrying distinct myToonHandles so the GET
    // aggregation has something to surface. The actual ingest path
    // also auto-merges these into pulseIds; here we bypass that to
    // assert the detection-only branch.
    await db.games.insertMany([
      {
        userId: userDoc.userId,
        gameId: "g_aaaaa",
        date: new Date("2026-05-01T00:00:00Z"),
        myToonHandle: "1-S2-1-AAAAAA",
      },
      {
        userId: userDoc.userId,
        gameId: "g_bbbbb",
        date: new Date("2026-05-02T00:00:00Z"),
        myToonHandle: "2-S2-1-BBBBBB",
      },
      {
        // Same handle as game A; should dedupe in the aggregation.
        userId: userDoc.userId,
        gameId: "g_ccccc",
        date: new Date("2026-05-03T00:00:00Z"),
        myToonHandle: "1-S2-1-AAAAAA",
      },
    ]);

    const got = await withAuth(request(app).get("/v1/me/profile"));
    expect(got.status).toBe(200);
    // Sorted by lastSeen DESC, so the more-recent handle is first.
    expect(got.body.detectedPulseIds).toEqual([
      "1-S2-1-AAAAAA",
      "2-S2-1-BBBBBB",
    ]);
  });

  test("POST /v1/me/profile/pulse-ids/detect copies detected toons into the user's list", async () => {
    // Carry over the games inserted by the previous test. Reset the
    // user's stored array so we can observe the merge.
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: [] })
      .set("content-type", "application/json");

    const post = await withAuth(
      request(app).post("/v1/me/profile/pulse-ids/detect"),
    );
    expect(post.status).toBe(200);
    expect(post.body.added).toBe(2);
    expect(post.body.pulseIds).toEqual([
      "1-S2-1-AAAAAA",
      "2-S2-1-BBBBBB",
    ]);

    // Re-running is idempotent — added=0 once everything is merged.
    const second = await withAuth(
      request(app).post("/v1/me/profile/pulse-ids/detect"),
    );
    expect(second.body.added).toBe(0);
  });
});
