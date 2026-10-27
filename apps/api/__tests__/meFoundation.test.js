// @ts-nocheck
"use strict";

/**
 * Coverage for the Settings → Foundation card backing fields:
 *   - GET /v1/me returns email + agentVersion + agentPaired so the SPA
 *     never has to hard-code "—".
 *   - Email is backfilled from Clerk on first read (lazy fallback) and
 *     cached so subsequent requests don't re-hit the Clerk API.
 *   - The Clerk webhook (POST /v1/webhooks/clerk) verifies the Svix
 *     signature, upserts user.created/updated emails, and rejects
 *     missing/invalid signatures.
 */

const crypto = require("crypto");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

const TEST_TOKEN = "user-foundation";
const TEST_CLERK_USER_ID = "clerk_user_foundation";

// Shared mock state — tests can flip these per scenario.
const mockClerkState = {
  email: "first@example.com",
  emailCalls: 0,
};

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-foundation") return { sub: TEST_CLERK_USER_ID };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({
    users: {
      getUser: jest.fn(async (clerkUserId) => {
        mockClerkState.emailCalls += 1;
        return {
          id: clerkUserId,
          primaryEmailAddressId: "email_1",
          emailAddresses: [
            { id: "email_1", emailAddress: mockClerkState.email },
          ],
        };
      }),
    },
  })),
}));

const WEBHOOK_SECRET = "whsec_" + Buffer.from("super-secret-test").toString("base64");

describe("Settings Foundation backing API", () => {
  let mongo;
  let db;
  let app;
  let users;
  let pairings;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_foundation",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    clerkWebhookSecret: WEBHOOK_SECRET,
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
      dbName: "sc2tools_test_foundation",
    });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
    users = built.services.users;
    pairings = built.services.pairings;
  });

  afterEach(() => {
    mockClerkState.email = "first@example.com";
    mockClerkState.emailCalls = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", `Bearer ${TEST_TOKEN}`);
  }

  test("GET /v1/me lazily backfills email from Clerk and caches it", async () => {
    const first = await withAuth(request(app).get("/v1/me"));
    expect(first.status).toBe(200);
    expect(first.body.email).toBe("first@example.com");
    expect(first.body.agentPaired).toBe(false);
    expect(first.body.agentVersion).toBeNull();
    expect(mockClerkState.emailCalls).toBe(1);

    // Email should now be cached on the user doc.
    const userDoc = await db.users.findOne({ clerkUserId: TEST_CLERK_USER_ID });
    expect(userDoc.email).toBe("first@example.com");

    // Second request should not hit Clerk again.
    const second = await withAuth(request(app).get("/v1/me"));
    expect(second.status).toBe(200);
    expect(second.body.email).toBe("first@example.com");
    expect(mockClerkState.emailCalls).toBe(1);
  });

  test("GET /v1/me reflects a paired agent without a heartbeat as paired+null", async () => {
    const userDoc = await db.users.findOne({ clerkUserId: TEST_CLERK_USER_ID });
    const { code } = await pairings.start();
    await pairings.claim(userDoc.userId, code);
    const issued = await pairings.poll(code);
    const tokenHash = crypto.createHash("sha256").update(issued.deviceToken).digest("hex");

    const res = await withAuth(request(app).get("/v1/me"));
    expect(res.status).toBe(200);
    expect(res.body.agentPaired).toBe(true);
    expect(res.body.agentVersion).toBeNull();

    // Now record a heartbeat — the latest agent's version should appear.
    await pairings.recordHeartbeat(userDoc.userId, tokenHash, { version: "1.2.3" });
    const after = await withAuth(request(app).get("/v1/me"));
    expect(after.body.agentVersion).toBe("1.2.3");
    expect(after.body.agentPaired).toBe(true);
    // The onboarding checklist derives "agent online" from this.
    expect(typeof after.body.agentLastSeenAt).toBe("string");

    // Revoke so later Foundation reads start with no active devices.
    await pairings.revoke(userDoc.userId, tokenHash);
  });

  test("GET /v1/me carries onboarding prefs + the active import job", async () => {
    // Defaults: no job, empty onboarding prefs, no last-seen.
    const before = await withAuth(request(app).get("/v1/me"));
    expect(before.body.activeImportJob).toBeNull();
    expect(before.body.onboarding).toEqual({});
    expect(before.body.agentLastSeenAt).toBeNull();

    // Dismissal persists through the standard preferences route (the
    // "onboarding" type is allowlisted).
    const put = await withAuth(
      request(app)
        .put("/v1/me/preferences/onboarding")
        .send({ dismissedAt: "2026-06-09T00:00:00.000Z" }),
    );
    expect(put.status).toBe(200);

    // A running import job surfaces serialised on /v1/me.
    const userDoc = await db.users.findOne({ clerkUserId: TEST_CLERK_USER_ID });
    await db.importJobs.insertOne({
      userId: userDoc.userId,
      kind: "backfill",
      status: "running",
      total: 420,
      completed: 69,
      errors: 1,
      startedAt: new Date(),
    });

    const res = await withAuth(request(app).get("/v1/me"));
    expect(res.body.onboarding.dismissedAt).toBe("2026-06-09T00:00:00.000Z");
    expect(res.body.activeImportJob).toMatchObject({
      kind: "backfill",
      status: "running",
      total: 420,
      completed: 69,
      errors: 1,
    });
    expect(typeof res.body.activeImportJob.jobId).toBe("string");

    await db.importJobs.deleteMany({ userId: userDoc.userId });
  });

  test("onboarding goals merge with concurrent checklist updates and existing fields", async () => {
    await withAuth(request(app).put("/v1/me/preferences/onboarding")
      .send({ downloadStartedAt: "2026-06-09T01:00:00.000Z", futureField: "$literal-data" }));
    const results = await Promise.all([
      withAuth(request(app).put("/v1/me/preferences/onboarding").send({ goals: ["improve", "stream"] })),
      withAuth(request(app).put("/v1/me/preferences/onboarding").send({ dismissedAt: null })),
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    const result = await withAuth(request(app).get("/v1/me/preferences/onboarding"));
    expect(result.body).toMatchObject({ goals: ["improve", "stream"], dismissedAt: null,
      downloadStartedAt: "2026-06-09T01:00:00.000Z", futureField: "$literal-data" });
    const invalid = await withAuth(request(app).put("/v1/me/preferences/onboarding").send({ goals: ["unknown"] }));
    expect(invalid.status).toBe(400);
    expect((await withAuth(request(app).get("/v1/me/preferences/onboarding"))).body.goals).toEqual(["improve", "stream"]);
  });

  test("activation is authenticated, private and exposes only flags and narrow onboarding metadata", async () => {
    expect((await request(app).get("/v1/me/activation")).status).toBe(401);
    const response = await withAuth(request(app).get("/v1/me/activation"));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Object.keys(response.body).sort()).toEqual(["identity", "firstGameViewed", "customBuild", "checkIn",
      "overlayLive", "chatOn", "goals", "levelUpDismissedAt"].sort());
    for (const flag of ["identity", "firstGameViewed", "customBuild", "checkIn", "overlayLive", "chatOn"]) {
      expect(typeof response.body[flag]).toBe("boolean");
    }
  });

  test("level-up dismissal merges independently and cannot forge the server-only view marker", async () => {
    const dismissedAt = "2026-10-26T12:00:00.000Z";
    await withAuth(request(app).put("/v1/me/preferences/onboarding").send({
      goals: ["improve", "stream"], dismissedAt: null, futureField: "$literal-data",
    }));
    const saved = await withAuth(request(app).put("/v1/me/preferences/onboarding").send({ levelUpDismissedAt: dismissedAt }));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ goals: ["improve", "stream"], dismissedAt: null,
      levelUpDismissedAt: dismissedAt, futureField: "$literal-data" });
    for (const value of [false, 1, "junk", "2026-02-30T12:00:00.000Z"]) {
      const invalid = await withAuth(request(app).put("/v1/me/preferences/onboarding").send({ levelUpDismissedAt: value }));
      expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe("invalid_level_up_dismissed_at");
    }
    const forged = await withAuth(request(app).put("/v1/me/preferences/onboarding").send({ firstGameViewedAt: dismissedAt }));
    expect(forged.status).toBe(400); expect(forged.body.error.code).toBe("readonly_onboarding_field");
    expect((await withAuth(request(app).get("/v1/me/preferences/onboarding"))).body).toMatchObject({
      levelUpDismissedAt: dismissedAt, dismissedAt: null, goals: ["improve", "stream"], futureField: "$literal-data",
    });
  });

  test("first-game marker validates its body, ownership and live-game state before stamping once", async () => {
    await withAuth(request(app).get("/v1/me/activation"));
    const owner = await db.users.findOne({ clerkUserId: TEST_CLERK_USER_ID });
    const gameId = `activation-${crypto.randomUUID()}`;
    await db.games.insertMany([
      { userId: owner.userId, gameId, date: new Date() },
      { userId: "foreign", gameId: `${gameId}-foreign`, date: new Date() },
      { userId: owner.userId, gameId: `${gameId}-deleted`, _deleted: true, date: new Date() },
    ]);
    try {
      expect((await request(app).put("/v1/me/activation/first-game").send({ gameId })).status).toBe(401);
      for (const body of [{}, { gameId: "" }, { gameId: "bad\nkey" }, { gameId: "x".repeat(1025) }, { gameId, extra: true }]) {
        const invalid = await withAuth(request(app).put("/v1/me/activation/first-game").send(body));
        expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe("invalid_game_id");
      }
      for (const unavailable of [`${gameId}-foreign`, `${gameId}-deleted`, `${gameId}-absent`]) {
        expect((await withAuth(request(app).put("/v1/me/activation/first-game").send({ gameId: unavailable }))).status).toBe(404);
      }
      const first = await withAuth(request(app).put("/v1/me/activation/first-game").send({ gameId }));
      expect(first.status).toBe(200); expect(first.body).toEqual({ firstGameViewed: true });
      expect(first.headers["cache-control"]).toBe("private, no-store");
      const stamp = (await db.users.findOne({ userId: owner.userId })).preferences.onboarding.firstGameViewedAt;
      expect(Number.isFinite(new Date(stamp).getTime())).toBe(true);
      expect((await withAuth(request(app).put("/v1/me/activation/first-game").send({ gameId }))).status).toBe(200);
      expect((await db.users.findOne({ userId: owner.userId })).preferences.onboarding.firstGameViewedAt).toBe(stamp);
      expect((await withAuth(request(app).get("/v1/me/activation"))).body.firstGameViewed).toBe(true);
    } finally { await db.games.deleteMany({ gameId: { $in: [gameId, `${gameId}-foreign`, `${gameId}-deleted`] } }); }
  });

  const at = "2026-10-26T12:00:00.000Z";
  let tourOwner;

  function registerTourHttpValidationTests() {
    test("HTTP accepts bounded version patches, preserves siblings, and makes onboarding private", async () => {
      expect((await request(app).put("/v1/me/preferences/onboarding").send({ toursDone: { today: 1 } })).status).toBe(401);
      const first = await withAuth(request(app).put("/v1/me/preferences/onboarding").send({ toursDone: { today: 1 } }));
      expect(first.status).toBe(200); expect(first.headers["cache-control"]).toBe("private, no-store");
      const next = await withAuth(request(app).put("/v1/me/preferences/onboarding")
        .send({ toursDone: { game: 1, overlay: 1000 }, futureObject: { $literal: "$still-data" } }));
      expect(next.status).toBe(200);
      expect(next.body.toursDone).toEqual({ today: 1, game: 1, overlay: 1000 });
      expect(next.body.futureObject).toEqual({ $literal: "$still-data" });
      const empty = await withAuth(request(app).put("/v1/me/preferences/onboarding").send({ toursDone: {} }));
      expect(empty.status).toBe(200); expect(empty.body).toEqual(next.body);
      const read = await withAuth(request(app).get("/v1/me/preferences/onboarding"));
      expect(read.headers["cache-control"]).toBe("private, no-store"); expect(read.body).toEqual(empty.body);
    });

    test("HTTP rejects malformed tour maps without partially applying other onboarding fields", async () => {
      const before = (await withAuth(request(app).get("/v1/me/preferences/onboarding"))).body;
      const invalid = [null, [], false, "today", 1, { today: 0 }, { today: -1 }, { today: 1.5 },
        { today: "1" }, { today: true }, { today: null }, { today: {} }, { today: 1001 },
        { unknown: 1 }, { "today.nested": 1 }, { $where: 1 }, { constructor: 1 }, { prototype: 1 },
        JSON.parse('{"__proto__":1}')];
      for (const toursDone of invalid) {
        const response = await withAuth(request(app).put("/v1/me/preferences/onboarding")
          .send({ toursDone, futureField: "must-not-commit" }));
        expect(response.status).toBe(400); expect(response.body.error.code).toBe("invalid_onboarding_tours_done");
      }
      expect((await withAuth(request(app).get("/v1/me/preferences/onboarding"))).body).toEqual(before);
    });

    test("tour patches retain existing readonly marker, goals and dismissal validation", async () => {
      const before = (await withAuth(request(app).get("/v1/me/preferences/onboarding"))).body;
      for (const [patch, code] of [[{ firstGameViewedAt: at }, "readonly_onboarding_field"],
        [{ goals: ["unknown"] }, "invalid_onboarding_goals"],
        [{ levelUpDismissedAt: "junk" }, "invalid_level_up_dismissed_at"]]) {
        const response = await withAuth(request(app).put("/v1/me/preferences/onboarding")
          .send({ toursDone: { today: 2 }, ...patch }));
        expect(response.status).toBe(400); expect(response.body.error.code).toBe(code);
      }
      expect((await withAuth(request(app).get("/v1/me/preferences/onboarding"))).body).toEqual(before);
    });

  }

  function registerTourAtomicVersionPersistenceTests() {
    test("real Mongo atomically retains concurrent tours, literal fields and independent onboarding patches", async () => {
      await db.users.insertOne({ userId: `${tourOwner}-other`, preferences: { onboarding: { toursDone: { today: 7 } } } });
      const answers = await Promise.all([
        users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: 2 }, futureObject: { $literal: "$data" } }),
        users.updatePreferences(tourOwner, "onboarding", { toursDone: { game: 1 } }),
        users.updatePreferences(tourOwner, "onboarding", { toursDone: { overlay: 1 }, levelUpDismissedAt: at }),
        users.updatePreferences(tourOwner, "onboarding", { goals: ["stream"], whatsNewSeenVersion: "$version-data" }),
      ]);
      expect(answers[0].toursDone.today).toBe(2); expect(answers[1].toursDone.game).toBe(1);
      const row = await db.users.findOne({ userId: tourOwner });
      expect(row.preferences).toEqual({ misc: { keep: true }, onboarding: { goals: ["stream"], dismissedAt: null,
        firstGameViewedAt: at, futureField: "$literal-data", futureObject: { $literal: "$data" },
        toursDone: { today: 2, game: 1, overlay: 1 }, levelUpDismissedAt: at, whatsNewSeenVersion: "$version-data" } });
      expect((await db.users.findOne({ userId: `${tourOwner}-other` })).preferences.onboarding.toursDone).toEqual({ today: 7 });
    });

    test("older tour versions cannot roll back a concurrent newer version and empty patches do not reset", async () => {
      const empty = await users.updatePreferences(tourOwner, "onboarding", { toursDone: {} });
      expect(empty).not.toHaveProperty("toursDone");
      await Promise.all([2, 1, 4, 3].map(version => users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: version } })));
      const older = await users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: 1, game: 1 } });
      expect(older.toursDone).toEqual({ today: 4, game: 1 });
      expect((await users.updatePreferences(tourOwner, "onboarding", { toursDone: {} })).toursDone).toEqual(older.toursDone);
    });

    test("malformed stored maps and versions cannot break a valid tour patch or masquerade as completion", async () => {
      for (const stored of [null, [], false, "legacy", { today: "2", game: 2, overlay: 1.5, unknown: 8 },
        { today: { version: 3 } }, { today: 1001, game: -1 }]) {
        await db.users.updateOne({ userId: tourOwner }, { $set: { "preferences.onboarding.toursDone": stored } });
        const answer = await users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: 1 } });
        expect(answer.toursDone).toEqual(stored?.game === 2 ? { game: 2, today: 1 } : { today: 1 });
        expect(answer.firstGameViewedAt).toBe(at); expect(answer.futureField).toBe("$literal-data");
      }
    });

  }

  function registerTourOwnerFenceAckTests() {
    test("tour ACK is projected from the one guarded write with no later preferences read", async () => {
      const write = jest.spyOn(db.users, "findOneAndUpdate"), read = jest.spyOn(db.users, "findOne");
      const answer = await users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: 1 } });
      expect(answer).toMatchObject({ toursDone: { today: 1 }, firstGameViewedAt: at, futureField: "$literal-data" });
      expect(answer).not.toHaveProperty("userId"); expect(answer).not.toHaveProperty("_id");
      expect(read).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith({ userId: tourOwner, _gdprMutation: { $exists: false } },
        expect.any(Array), expect.objectContaining({ upsert: false, returnDocument: "after",
          projection: { _id: 0, "preferences.onboarding": 1 }, maxTimeMS: 1500 }));
    });

    test.each(["missing", "fenced"])("%s owners reject tour writes instead of acknowledging or recreating them", async state => {
      if (state === "missing") await db.users.deleteOne({ userId: tourOwner });
      else await db.users.updateOne({ userId: tourOwner }, { $set: { _gdprMutation: { operation: "erase" } } });
      await expect(users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: 1 } }))
        .rejects.toMatchObject({ status: 409, code: "gdpr_operation_busy" });
      const row = await db.users.findOne({ userId: tourOwner });
      if (state === "missing") expect(row).toBeNull();
      else { expect(row._gdprMutation).toEqual({ operation: "erase" }); expect(row.preferences.onboarding).not.toHaveProperty("toursDone"); }
    });

    test.each(["deleted", "fenced"])("a held tour write cannot survive an owner becoming %s", async state => {
      let entered, release;
      const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
      const original = db.users.findOneAndUpdate.bind(db.users);
      const spy = jest.spyOn(db.users, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
        entered(); await held; return original(...args);
      });
      const pending = users.updatePreferences(tourOwner, "onboarding", { toursDone: { today: 1 } });
      try {
        await waiting;
        if (state === "deleted") await db.users.deleteOne({ userId: tourOwner });
        else await db.users.updateOne({ userId: tourOwner }, { $set: { _gdprMutation: { operation: "erase" } } });
        release(); await expect(pending).rejects.toMatchObject({ status: 409, code: "gdpr_operation_busy" });
        const row = await db.users.findOne({ userId: tourOwner });
        if (state === "deleted") expect(row).toBeNull();
        else expect(row.preferences.onboarding).not.toHaveProperty("toursDone");
      } finally { release(); await pending.catch(() => {}); spy.mockRestore(); }
    });
  }

  describe("versioned guided-tour onboarding preferences", () => {
    beforeEach(async () => {
      tourOwner = `tour-${crypto.randomUUID()}`;
      await db.users.insertOne({ userId: tourOwner, clerkUserId: `clerk-${tourOwner}`,
        preferences: { misc: { keep: true }, onboarding: { goals: ["improve"], dismissedAt: null,
          firstGameViewedAt: at, futureField: "$literal-data" } } });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await db.users.deleteMany({ userId: { $in: [tourOwner, `${tourOwner}-other`] } });
    });

    registerTourHttpValidationTests();
    registerTourAtomicVersionPersistenceTests();
    registerTourOwnerFenceAckTests();
  });
  describe("POST /v1/webhooks/clerk", () => {
    test("rejects requests without svix headers", async () => {
      const res = await request(app)
        .post("/v1/webhooks/clerk")
        .send({ type: "user.created", data: { id: "x" } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("missing_svix_headers");
    });

    test("rejects an invalid signature", async () => {
      const id = "msg_123";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await request(app)
        .post("/v1/webhooks/clerk")
        .set("svix-id", id)
        .set("svix-timestamp", timestamp)
        .set("svix-signature", "v1,bm90LXJlYWxseS1hLXNpZ25hdHVyZQ==")
        .set("content-type", "application/json")
        .send({ type: "user.created", data: { id: "x" } });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_signature");
    });

    test("upserts email on user.updated when signature matches", async () => {
      const payload = {
        type: "user.updated",
        data: {
          id: "clerk_user_webhook",
          primaryEmailAddressId: "ea_1",
          emailAddresses: [
            { id: "ea_1", emailAddress: "fresh@example.com" },
          ],
        },
      };
      const body = JSON.stringify(payload);
      const id = "msg_abc";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSvix(WEBHOOK_SECRET, id, timestamp, body);

      const res = await request(app)
        .post("/v1/webhooks/clerk")
        .set("svix-id", id)
        .set("svix-timestamp", timestamp)
        .set("svix-signature", `v1,${signature}`)
        .set("content-type", "application/json")
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const doc = await db.users.findOne({ clerkUserId: "clerk_user_webhook" });
      expect(doc).toBeTruthy();
      expect(doc.email).toBe("fresh@example.com");
      expect(doc.userId).toBeTruthy();
    });

    test("ignores non-user events with a 200 to stop Clerk retrying", async () => {
      const payload = { type: "session.created", data: { id: "sess_1" } };
      const body = JSON.stringify(payload);
      const id = "msg_skip";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSvix(WEBHOOK_SECRET, id, timestamp, body);

      const res = await request(app)
        .post("/v1/webhooks/clerk")
        .set("svix-id", id)
        .set("svix-timestamp", timestamp)
        .set("svix-signature", `v1,${signature}`)
        .set("content-type", "application/json")
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe("session.created");
    });
  });
});

/**
 * Email-allowlist admin grant — the deterministic, operator-controlled
 * way to mint an admin (SC2TOOLS_ADMIN_EMAILS). A signed-in user whose
 * verified Clerk email matches (case-insensitively) is promoted on their
 * next /v1/me, the role is persisted, and they stay admin thereafter.
 */
describe("Email-allowlist admin (SC2TOOLS_ADMIN_EMAILS)", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_admin_email",
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
    adminUserIds: [],
    // Already lower-cased, mirroring how the loader normalises it.
    adminEmails: ["admin@example.com"],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_admin_email",
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  // Rebuild per test so the in-memory admin allowlist (which a grant
  // mutates) starts empty each time — otherwise a promotion in one test
  // would leak into the next via the reused Clerk user id.
  beforeEach(async () => {
    await db.users.deleteMany({});
    app = buildApp({ db, logger: pino({ level: "silent" }), config }).app;
  });

  afterEach(() => {
    mockClerkState.email = "first@example.com";
    mockClerkState.emailCalls = 0;
  });

  function withAuth(req) {
    return req.set("authorization", `Bearer ${TEST_TOKEN}`);
  }

  test("promotes a user whose email is on the allowlist (case-insensitive) and persists it", async () => {
    // Mixed-case email proves the match folds case.
    mockClerkState.email = "Admin@Example.com";

    const res = await withAuth(request(app).get("/v1/me"));
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);

    // Role persisted on the user doc with the allowlist provenance.
    const doc = await db.users.findOne({ clerkUserId: TEST_CLERK_USER_ID });
    expect(doc.role).toBe("admin");
    expect(doc.roleGrantedBy).toBe("email_allowlist");

    // Still admin on a later request — now via the live allowlist /
    // persisted role, not a re-grant.
    const again = await withAuth(request(app).get("/v1/me"));
    expect(again.body.isAdmin).toBe(true);

    // And the gated /v1/admin surface now accepts them.
    const admin = await withAuth(request(app).get("/v1/admin/health"));
    expect(admin.status).toBe(200);
  });

  test("a non-allowlisted email is NOT promoted", async () => {
    await db.users.deleteMany({});
    mockClerkState.email = "someone-else@example.com";

    const res = await withAuth(request(app).get("/v1/me"));
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);

    const doc = await db.users.findOne({ clerkUserId: TEST_CLERK_USER_ID });
    expect(doc.role).toBeUndefined();
  });
});

/**
 * Sign a request body with the same scheme buildClerkWebhookRouter
 * verifies — `${svix-id}.${svix-timestamp}.${rawBody}` HMAC'd with the
 * decoded secret.
 */
function signSvix(secret, id, timestamp, body) {
  const stripped = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(stripped, "base64");
  return crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
}
