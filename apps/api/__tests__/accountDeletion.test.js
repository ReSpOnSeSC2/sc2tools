// @ts-nocheck
"use strict";

const crypto = require("crypto");
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { COLLECTIONS } = require("../src/config/constants");
const { GDPR_CLASSIFICATION } = require("../src/services/gdpr");
const { claimUserDataLease } = require("../src/middleware/userDataWriteFence");
const { TOKEN_COLLECTIONS } = require("../src/services/gdprOwnedData");
const { publicDataRetention } = require("../src/services/dataInventory");
const { createBackupStore } = require("./helpers/userBackupsStore");

jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => {
  if (["owner", "other"].includes(token)) return { sub: `clerk_${token}` };
  throw new Error("invalid");
}) }));
const SECRET = "whsec_" + Buffer.from("erasure-test").toString("base64");

describe("complete account erasure (HTTP + Mongo)", () => {
  let mongo, db, app, services, clerk;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "erasure" });
    clerk = { getEmail: jest.fn(async () => null), deleteUser: jest.fn(async () => {}) };
    ({ app, services } = buildApp({ db, clerkClient: clerk, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }), config: {
      port: 0, nodeEnv: "test", clerkSecretKey: "sk_test", clerkWebhookSecret: SECRET,
      serverPepper: Buffer.alloc(32, 5), corsAllowedOrigins: [], rateLimitPerMinute: 10000,
      agentReleaseAdminToken: "admin", pythonExe: null, pythonAnalyzerDir: "C:/__missing__", adminUserIds: [],
    } }));
  });
  beforeEach(async () => {
    for (const collection of await db.db.collections()) await collection.deleteMany({});
    clerk.deleteUser.mockReset().mockResolvedValue(undefined);
    for (const name of ["owner", "other"]) await db.users.insertOne({ userId: `u_${name}`, clerkUserId: `clerk_${name}`, createdAt: new Date(), lastSeenAt: new Date() });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  const auth = (method, path) => request(app)[method](path).set("authorization", "Bearer owner");
  function webhook(type, id = "clerk_owner") {
    const body = JSON.stringify({ type, data: { id } });
    const msg = crypto.randomUUID(), time = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${msg}.${time}.${body}`).digest("base64");
    return request(app).post("/v1/webhooks/clerk").set("content-type", "application/json").set("svix-id", msg).set("svix-timestamp", time).set("svix-signature", `v1,${sig}`).send(body);
  }
  async function tokenData() {
    await db.overlayTokens.insertMany([
      { userId: "u_owner", token: "old-owner", revokedAt: new Date() }, { userId: "u_owner", token: "active-owner" }, { userId: "u_other", token: "other-token" },
    ]);
    for (const key of TOKEN_COLLECTIONS) {
      await db[key].insertMany(["old-owner", "active-owner", "other-token"].map((token) => ({ token, example: true })));
    }
    await db.multichatStudio.insertMany([{ studioKey: "active-owner" }, { studioKey: "other-token" }]);
    await db.multichatSounds.insertMany([{ userId: "u_owner", soundId: "mine", label: "Sound", data: Buffer.from("private audio"), mime: "audio/wav", size: 13 }, { userId: "u_other", soundId: "theirs" }]);
  }

  test("every collection has an explicit classification, with only known dispositions", () => {
    expect(Object.keys(GDPR_CLASSIFICATION).sort()).toEqual(Object.keys(COLLECTIONS).sort());
    expect(new Set(Object.values(GDPR_CLASSIFICATION))).toEqual(new Set(["user_scoped", "purge_only", "overlay_token_scoped", "global", "ttl_ephemeral"]));
    expect(GDPR_CLASSIFICATION.PENDING_IDENTITY_DELETIONS).toBe("ttl_ephemeral");
  });

  test("purges active/revoked token data and sound bytes before ending the identity, preserves other owners", async () => {
    await tokenData();
    await db.games.insertOne({ userId: "u_owner", gameId: "game-a" });
    await db.communityBuilds.insertOne({ ownerUserId: "u_other", slug: "other-build", upvotes: ["u_owner", "u_other"], downvotes: [], votes: 2 });
    await db.adminEvents.insertOne({ type: "user_message", payload: { userId: "u_owner", clerkUserId: "clerk_owner", email: "private@example.com", subject: "private", message: "secret", context: { diagnostic: true } }, report: { updates: [{ message: "reply" }] } });
    clerk.deleteUser.mockImplementation(async (clerkId) => {
      expect(clerkId).toBe("clerk_owner");
      expect(await db.users.countDocuments({ userId: "u_owner" })).toBe(0);
      expect(await db.games.countDocuments({ userId: "u_owner" })).toBe(0);
      expect(await db.multichatSounds.countDocuments({ userId: "u_owner" })).toBe(0);
      for (const key of TOKEN_COLLECTIONS) expect(await db[key].countDocuments({ token: { $in: ["old-owner", "active-owner"] } })).toBe(0);
    });
    const exported = await auth("get", "/v1/me/export");
    expect(exported.status).toBe(200);
    const sounds = exported.body.data.multichatSounds;
    expect(sounds).toEqual([expect.objectContaining({ soundId: "mine", label: "Sound" })]);
    expect(sounds[0]).not.toHaveProperty("data");
    const result = await auth("delete", "/v1/me");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ deleted: true, identityDeletionPending: false });
    expect(clerk.deleteUser).toHaveBeenCalledTimes(1);
    for (const key of TOKEN_COLLECTIONS) expect(await db[key].countDocuments({ token: "other-token" })).toBe(1);
    expect(await db.multichatStudio.countDocuments({ studioKey: "active-owner" })).toBe(0);
    expect(await db.multichatStudio.countDocuments({ studioKey: "other-token" })).toBe(1);
    expect(await db.multichatSounds.countDocuments({ userId: "u_other" })).toBe(1);
    expect(await db.communityBuilds.findOne({ slug: "other-build" })).toMatchObject({ upvotes: ["u_other"], votes: 1 });
    const report = await db.adminEvents.findOne({ type: "user_message" });
    expect(report.payload).toMatchObject({ userId: null, clerkUserId: null, email: null, subject: "[deleted user]", message: "[deleted user]", context: null });
    expect(report.report.updates).toEqual([]);
    const guard = await services.identityDeletions.lookup("clerk_owner");
    expect(guard).toMatchObject({ state: "complete", expiresAt: expect.any(Date) });
    expect(guard).not.toHaveProperty("clerkUserId"); expect(guard).not.toHaveProperty("userId");
    expect((await auth("get", "/v1/me")).body.error.code).toBe("account_deleted");
    expect(await db.users.countDocuments({ clerkUserId: "clerk_owner" })).toBe(0);
  });

  test("failed identity deletion retries under a single job lock and cannot recreate the account", async () => {
    clerk.deleteUser.mockRejectedValueOnce(new Error("provider down with private data"));
    const result = await auth("delete", "/v1/me");
    expect(result.status).toBe(200); expect(result.body.identityDeletionPending).toBe(true);
    let row = await services.identityDeletions.lookup("clerk_owner");
    expect(row).toMatchObject({ state: "pending", attempts: 1, lastError: "provider_unavailable" });
    expect(row).not.toHaveProperty("expiresAt");
    expect((await auth("get", "/v1/me")).status).toBe(401);
    await db.pendingIdentityDeletions.updateOne({ _id: row._id }, { $set: { nextAttemptAt: new Date(0) } });
    let release;
    clerk.deleteUser.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = services.identityDeletions.sweep();
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    expect(await services.identityDeletions.sweep()).toEqual({ processed: 0, lockHeld: true });
    release(); await first;
    expect(clerk.deleteUser).toHaveBeenCalledTimes(2);
    row = await services.identityDeletions.lookup("clerk_owner"); expect(row.state).toBe("complete");
    expect(await db.users.countDocuments({ userId: "u_owner" })).toBe(0);
  });

  test.each(["api-first", "webhook-first"])("signed webhook and API double fire are idempotent: %s", async (order) => {
    await tokenData();
    if (order === "api-first") expect((await auth("delete", "/v1/me")).status).toBe(200);
    expect((await webhook("user.deleted")).status).toBe(200);
    expect((await webhook("user.deleted")).status).toBe(200);
    expect((await auth("delete", "/v1/me")).status).toBe(401);
    expect((await webhook("user.updated")).body).toEqual({ ignored: "deleted_identity" });
    expect((await webhook("user.created")).body).toEqual({ ignored: "deleted_identity" });
    expect(await db.users.countDocuments({ clerkUserId: "clerk_owner" })).toBe(0);
    expect(await db.overlayTokens.countDocuments({ userId: "u_owner" })).toBe(0);
    expect(await db.multichatSounds.countDocuments({ userId: "u_other" })).toBe(1);
    expect(clerk.deleteUser).toHaveBeenCalledTimes(order === "api-first" ? 1 : 0);
  });

  test("live inventory separates removed threads from retained anonymized comments and never exposes token values", async () => {
    await tokenData();
    await db.reviewRequests.insertMany([{ _id: "mine", userId: "u_owner" }, { _id: "theirs", userId: "u_other" }]);
    await db.reviewComments.insertMany([{ requestId: "mine", authorId: "u_owner" }, { requestId: "mine", authorId: "u_other" }, { requestId: "theirs", authorId: "u_owner" }]);
    expect((await request(app).get("/v1/me/data-inventory")).status).toBe(401);
    const inventory = await auth("get", "/v1/me/data-inventory");
    expect(inventory.status).toBe(200); expect(inventory.headers["cache-control"]).toBe("private, no-store");
    expect(inventory.body).toMatchObject({ removed: { sounds: 1, overlayTokens: 2, streamRows: 11, reviewRequests: 1, reviewThreadComments: 2 }, anonymized: { reviewComments: 1 } });
    expect(JSON.stringify(inventory.body)).not.toMatch(/active-owner|old-owner|other-token|clerk_owner/);
    const result = await auth("delete", "/v1/me"); expect(result.status).toBe(200);
    expect(await db.reviewRequests.findOne({ _id: "mine" })).toBeNull();
    expect(await db.reviewComments.findOne({ requestId: "theirs" })).toMatchObject({ authorId: null, authorDeleted: true });
  });

  test("erasure waits for an admitted user write and a deleted recipient cannot gain a notification", async () => {
    const lease = await claimUserDataLease(db.users, "u_owner");
    const deletion = services.gdpr.deleteAll("u_owner");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(clerk.deleteUser).not.toHaveBeenCalled();
    await db.opponentNotes.insertOne({ userId: "u_owner", note: "last write" });
    await lease.release(); await deletion;
    expect(await db.opponentNotes.countDocuments({ userId: "u_owner" })).toBe(0);
    expect(await services.notifications.notify("u_owner", { kind: "support.reply", title: "late", body: "private", href: "/notifications", eventKey: "late" })).toBeNull();
    expect(await db.notifications.countDocuments({ userId: "u_owner" })).toBe(0);
  });

  test("public retention returns only the configured safe schedule, not provider or account details", async () => {
    const response = await request(app).get("/v1/site/data-retention"); expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false, retention: [], checkedAt: null });
    const safe = await publicDataRetention({ atlasStatus: async () => ({ available: true, stale: false, checkedAt: "2026-10-23", clusterId: "secret", snapshotId: "secret", retention: [{ unit: "days", keep: 7 }, { unit: "bad", keep: 9 }] }) });
    expect(safe).toEqual({ available: true, retention: [{ unit: "days", value: 7 }], checkedAt: "2026-10-23" });
    expect((await publicDataRetention({ atlasStatus: async () => ({ available: true, stale: true, retention: [] }) })).available).toBe(false);
  });

  test("deleted device tokens receive 401 and a late pairing poll cannot recreate a device", async () => {
    const token = "a".repeat(43);
    await db.deviceTokens.insertOne({ userId: "u_owner", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), revokedAt: null });
    expect((await request(app).get("/v1/me/profile").set("authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).delete("/v1/me").set("authorization", `Bearer ${token}`)).status).toBe(403);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
    await services.gdpr.deleteAll("u_owner");
    expect((await request(app).get("/v1/me/profile").set("authorization", `Bearer ${token}`)).status).toBe(401);
    // A poll admitted before erasure may already hold this claimed code in
    // memory. Its user lease must fail, even if the token row was not seen by
    // the original purge. Reproduce that stale-row condition deliberately.
    await db.devicePairings.insertOne({ code: "12345678", userId: "u_owner", consumedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    expect(await services.pairings.poll("12345678")).toEqual({ status: "expired" });
    expect(await db.deviceTokens.countDocuments({ userId: "u_owner" })).toBe(0);
  });

  test("a cached token cannot write Studio state after erasure", async () => {
    await tokenData();
    // Warm the ordinary resolution cache before deletion invalidates it.
    expect((await services.overlayTokens.resolve("active-owner"))?.userId).toBe("u_owner");
    expect((await auth("delete", "/v1/me")).status).toBe(200);
    const result = await request(app).post("/v1/multichat/active-owner/studio").send({ highlight: { text: "late" } });
    expect(result.status).toBe(401);
    expect(await db.multichatStudio.countDocuments({ $or: [{ token: "active-owner" }, { studioKey: "active-owner" }] })).toBe(0);
  });

  test("an in-flight token-authenticated Studio write completes before its data is erased", async () => {
    await tokenData();
    let release, started;
    const admitted = new Promise((resolve) => { started = resolve; });
    const original = services.multichatStudio.update.bind(services.multichatStudio);
    const update = jest.spyOn(services.multichatStudio, "update").mockImplementation(async (token, patch) => {
      started(); await new Promise((resolve) => { release = resolve; }); return original(token, patch);
    });
    try {
      const writing = request(app).post("/v1/multichat/active-owner/studio").send({ highlight: { text: "last write" } }).then((response) => response);
      await admitted;
      const erasing = services.gdpr.deleteAll("u_owner");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(clerk.deleteUser).not.toHaveBeenCalled();
      release(); expect((await writing).status).toBe(200); await erasing;
      expect(await db.multichatStudio.countDocuments({ $or: [{ token: "active-owner" }, { studioKey: "active-owner" }] })).toBe(0);
    } finally { release?.(); update.mockRestore(); }
  });

  test("crash recovery preserves active user leases and one failed purge does not starve other identities", async () => {
    const retry = services.identityDeletions.retryDataPurge;
    const fence = { id: "live-owner-operation", leaseUntil: new Date(Date.now() + 60_000) };
    await db.users.updateOne({ userId: "u_owner" }, { $set: { _gdprMutation: fence } });
    await services.identityDeletions.recordIntent("u_owner", "clerk_owner");
    services.identityDeletions.retryDataPurge = jest.fn(async () => { throw new Error("local store unavailable"); });
    try {
      await services.identityDeletions.sweep();
      expect(services.identityDeletions.retryDataPurge).not.toHaveBeenCalled();
      expect((await db.users.findOne({ userId: "u_owner" }))._gdprMutation).toEqual(fence);
      expect(clerk.deleteUser).not.toHaveBeenCalled();
      // Simulate time passing in this isolated fixture; production code must
      // leave the live lock alone and wait for its lease to expire.
      await db.users.updateOne({ userId: "u_owner" }, { $set: { "_gdprMutation.leaseUntil": new Date(0) } });
      await db.users.deleteOne({ userId: "u_other" });
      await services.identityDeletions.recordIntent("u_other", "clerk_other");
      await services.identityDeletions.activate("clerk_other");
      await services.identityDeletions.sweep();
      expect(clerk.deleteUser).toHaveBeenCalledTimes(1); expect(clerk.deleteUser).toHaveBeenCalledWith("clerk_other");
      expect(await services.identityDeletions.lookup("clerk_owner")).toMatchObject({ state: "purging", lastError: "data_purge_unavailable", nextAttemptAt: expect.any(Date) });
      expect(await db.users.countDocuments({ userId: "u_owner" })).toBe(1);
    } finally { services.identityDeletions.retryDataPurge = retry; }
  });
});
