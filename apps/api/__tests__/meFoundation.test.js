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
    const tokenHash = crypto.randomBytes(32).toString("hex");
    await db.deviceTokens.insertOne({
      tokenHash,
      userId: userDoc.userId,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
    });

    const res = await withAuth(request(app).get("/v1/me"));
    expect(res.status).toBe(200);
    expect(res.body.agentPaired).toBe(true);
    expect(res.body.agentVersion).toBeNull();

    // Now record a heartbeat — the latest agent's version should appear.
    await db.deviceTokens.updateOne(
      { tokenHash },
      { $set: { agentVersion: "1.2.3" } },
    );
    const after = await withAuth(request(app).get("/v1/me"));
    expect(after.body.agentVersion).toBe("1.2.3");
    expect(after.body.agentPaired).toBe(true);
    // The onboarding checklist derives "agent online" from this.
    expect(typeof after.body.agentLastSeenAt).toBe("string");

    // Cleanup so the other tests start from a clean device-tokens slate.
    await db.deviceTokens.deleteOne({ tokenHash });
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
