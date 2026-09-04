// @ts-nocheck
"use strict";

/**
 * Integration tests for POST /v1/me/profile/battletag/detect and the
 * /v1/me/doctor identity check.
 *
 * Full app + mongodb-memory-server like meProfile.test.js. The
 * PulseMmrService captures ``globalThis.fetch`` at construction, so we
 * install the SC2Pulse mock on ``global.fetch`` BEFORE buildApp — no
 * test ever leaves the process.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { sha256 } = require("../src/util/hash");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_a" };
    throw new Error("invalid");
  }),
}));

// Live-captured shapes (2026-06-10). The bare toon term misses — that
// matches the real API, which only resolves the profile-URL forms.
const SEARCH_HIT = [
  {
    members: {
      character: { realm: 1, id: 994428, region: "US", battlenetId: 267727 },
      account: { battleTag: "ReSpOnSe#1872", id: 994428 },
    },
  },
];

const realFetch = global.fetch;
const fetchMock = jest.fn(async (url) => {
  const u = String(url);
  let payload = [];
  if (
    u.includes("/character/search") &&
    u.includes(encodeURIComponent("/profile/1/1/267727"))
  ) {
    payload = SEARCH_HIT;
  }
  return { ok: true, json: async () => payload };
});

describe("/v1/me/profile/battletag/detect", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_btag",
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
    replayFilesStore: "r2",
    r2: {
      endpoint: "http://127.0.0.1:1",
      region: "auto",
      bucket: "test-replays",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
  };

  beforeAll(async () => {
    global.fetch = fetchMock;
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_btag",
    });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer user-a");
  }

  test("no pulse ids → unchanged profile, detected: []", async () => {
    await withAuth(request(app).get("/v1/me")); // ensure user row
    const res = await withAuth(
      request(app).post("/v1/me/profile/battletag/detect"),
    );
    expect(res.status).toBe(200);
    expect(res.body.detected).toEqual([]);
    expect(res.body.battleTag).toBeUndefined();
  });

  test("backfills battleTag + battleTags from a saved toon handle", async () => {
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: ["1-S2-1-267727"], displayName: "ReSpOnSe" })
      .set("content-type", "application/json");
    const res = await withAuth(
      request(app).post("/v1/me/profile/battletag/detect"),
    );
    expect(res.status).toBe(200);
    expect(res.body.detected).toEqual(["ReSpOnSe#1872"]);
    expect(res.body.battleTag).toBe("ReSpOnSe#1872");
    expect(res.body.battleTags).toEqual(["ReSpOnSe#1872"]);

    // Persisted: a plain GET shows the same.
    const got = await withAuth(request(app).get("/v1/me/profile"));
    expect(got.body.battleTag).toBe("ReSpOnSe#1872");
    expect(got.body.battleTags).toEqual(["ReSpOnSe#1872"]);
  });

  test("detection never clobbers a manually-typed battleTag", async () => {
    await withAuth(request(app).put("/v1/me/profile"))
      .send({
        battleTag: "MyTypedTag#9999",
        pulseIds: ["1-S2-1-267727"],
      })
      .set("content-type", "application/json");
    const res = await withAuth(
      request(app).post("/v1/me/profile/battletag/detect"),
    );
    expect(res.body.battleTag).toBe("MyTypedTag#9999");
    // …but the detected tag still lands in the list, manual first.
    expect(res.body.battleTags).toEqual([
      "MyTypedTag#9999",
      "ReSpOnSe#1872",
    ]);
  });

  test("doctor: no nag when displayName or pulse ids exist", async () => {
    // Profile currently has battleTag + pulseIds from the test above;
    // strip it back to pulse ids only.
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: ["1-S2-1-267727"] })
      .set("content-type", "application/json");
    const res = await withAuth(request(app).get("/v1/me/doctor"));
    expect(res.status).toBe(200);
    const ids = res.body.warnings.map((w) => w.id);
    expect(ids).not.toContain("no_profile");
  });

  test("doctor: still nags when no identity signal at all", async () => {
    await withAuth(request(app).put("/v1/me/profile"))
      .send({ pulseIds: [] })
      .set("content-type", "application/json");
    const res = await withAuth(request(app).get("/v1/me/doctor"));
    const ids = res.body.warnings.map((w) => w.id);
    expect(ids).toContain("no_profile");
    expect(res.body.warnings.find((w) => w.id === "no_agent")).toMatchObject({
      severity: "warn",
      message:
        "The latest SC2 Tools Agent needs to be turned on or installed.",
      cta: { label: "Install latest agent", href: "/download" },
    });
  });

  test("replay archive status drives the update-and-resync doctor warning", async () => {
    const me = await withAuth(request(app).get("/v1/me"));
    const userId = me.body.userId;
    await db.games.insertMany([
      {
        userId,
        gameId: "archive-complete",
        date: new Date("2026-08-01T00:00:00Z"),
        replayFile: { storedAt: new Date("2026-08-02T00:00:00Z") },
      },
      {
        userId,
        gameId: "archive-missing",
        date: new Date("2026-08-01T01:00:00Z"),
      },
    ]);

    const status = await withAuth(
      request(app).get("/v1/me/replay-archive-status"),
    );
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      totalGames: 2,
      archivedGames: 1,
      missingGames: 1,
      archiveComplete: false,
      enabled: true,
      backfillVersion: 0,
      resyncRequestedAt: null,
      requiresResync: true,
    });

    const doctor = await withAuth(request(app).get("/v1/me/doctor"));
    const warning = doctor.body.warnings.find(
      (item) => item.id === "replay_archive_incomplete",
    );
    expect(warning).toMatchObject({
      severity: "warn",
      cta: { label: "Update agent", href: "/download" },
    });
    expect(warning.message).toMatch(/latest desktop agent/i);
    expect(warning.message).toMatch(/click Re-sync once/i);
    expect(warning.message).toMatch(/files already deleted locally/i);

    // The latest desktop build marks the one-time full local scan when the
    // user starts it. One replay is intentionally still absent: this models
    // a historical file deleted from the PC, which can never be archived.
    // That partial archive must remain honestly counted without nagging the
    // user to repeat an impossible re-sync forever.
    const deviceToken = "a".repeat(43);
    await db.deviceTokens.insertOne({
      tokenHash: sha256(deviceToken),
      userId,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
    });
    const marked = await request(app)
      .post("/v1/me/replay-archive-resync")
      .set("authorization", `Bearer ${deviceToken}`)
      .send({ agentVersion: "0.15.0" });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({
      ok: true,
      version: 1,
      agentVersion: "0.15.0",
    });

    const partial = await withAuth(
      request(app).get("/v1/me/replay-archive-status"),
    );
    expect(partial.body).toMatchObject({
      totalGames: 2,
      archivedGames: 1,
      missingGames: 1,
      archiveComplete: false,
      enabled: true,
      backfillVersion: 1,
      requiresResync: false,
    });
    expect(partial.body.resyncRequestedAt).toEqual(expect.any(String));

    const afterResyncDoctor = await withAuth(
      request(app).get("/v1/me/doctor"),
    );
    expect(
      afterResyncDoctor.body.warnings.map((item) => item.id),
    ).not.toContain("replay_archive_incomplete");

    await db.games.deleteMany({ userId });
    await db.deviceTokens.deleteMany({ userId });
    await db.users.updateOne(
      { userId },
      { $unset: { "preferences.replayArchive": "" } },
    );
  });
});
