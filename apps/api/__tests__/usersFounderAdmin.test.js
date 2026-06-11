// @ts-nocheck
"use strict";

/**
 * Founder auto-admin bootstrap (``UsersService.ensureFounderAdmin``):
 *   - Empty collection → no grant, returns [].
 *   - Users exist, none admin → the EARLIEST-created user with a
 *     Clerk identity is promoted (role:"admin" persisted on the doc)
 *     and their Clerk ID is returned.
 *   - Webhook stubs / rows without a clerkUserId are never promoted.
 *   - Idempotent: a second call returns the same admin without
 *     promoting anyone else.
 *   - A pre-existing admin (e.g. granted by hand in Mongo) suppresses
 *     the founder promotion and is returned instead.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");

describe("UsersService.ensureFounderAdmin", () => {
  let mongo;
  let db;
  let users;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_founder_admin",
    });
    users = new UsersService(db);
  });

  afterAll(async () => {
    if (db && db.client) await db.client.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.users.deleteMany({});
  });

  async function seedUser({ clerkUserId, userId, createdAt }) {
    await db.users.insertOne({
      userId,
      clerkUserId,
      createdAt,
      lastSeenAt: createdAt,
    });
  }

  test("empty collection grants nothing", async () => {
    await expect(users.ensureFounderAdmin()).resolves.toEqual([]);
  });

  test("promotes the earliest-created user and persists the role", async () => {
    await seedUser({
      clerkUserId: "clerk_second",
      userId: "u2",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    await seedUser({
      clerkUserId: "clerk_founder",
      userId: "u1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const granted = await users.ensureFounderAdmin();
    expect(granted).toEqual(["clerk_founder"]);

    const doc = await db.users.findOne({ userId: "u1" });
    expect(doc.role).toBe("admin");
    expect(doc.roleGrantedBy).toBe("founder_bootstrap");
    expect(doc.roleGrantedAt).toBeInstanceOf(Date);

    // The later signup stays a plain user.
    const other = await db.users.findOne({ userId: "u2" });
    expect(other.role).toBeUndefined();
  });

  test("skips rows without a Clerk identity (webhook stubs)", async () => {
    // Stub row predates the founder but has no Clerk ID — useless as
    // an admin because they can never authenticate.
    await db.users.insertOne({
      userId: "stub",
      createdAt: new Date("2025-12-01T00:00:00Z"),
    });
    await seedUser({
      clerkUserId: "clerk_founder",
      userId: "u1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    await expect(users.ensureFounderAdmin()).resolves.toEqual([
      "clerk_founder",
    ]);
  });

  test("idempotent — second call returns the same admin, no double grant", async () => {
    await seedUser({
      clerkUserId: "clerk_founder",
      userId: "u1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedUser({
      clerkUserId: "clerk_second",
      userId: "u2",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });

    await expect(users.ensureFounderAdmin()).resolves.toEqual([
      "clerk_founder",
    ]);
    await expect(users.ensureFounderAdmin()).resolves.toEqual([
      "clerk_founder",
    ]);

    const admins = await db.users.find({ role: "admin" }).toArray();
    expect(admins).toHaveLength(1);
    expect(admins[0].userId).toBe("u1");
  });

  test("existing admin suppresses founder promotion", async () => {
    await seedUser({
      clerkUserId: "clerk_founder",
      userId: "u1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.users.insertOne({
      userId: "u3",
      clerkUserId: "clerk_hand_granted",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      role: "admin",
    });

    await expect(users.ensureFounderAdmin()).resolves.toEqual([
      "clerk_hand_granted",
    ]);
    const founderDoc = await db.users.findOne({ userId: "u1" });
    expect(founderDoc.role).toBeUndefined();
  });
});

describe("UsersService founder auto-promotion on authed path", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_founder_live",
    });
  });

  afterAll(async () => {
    if (db && db.client) await db.client.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.users.deleteMany({});
  });

  test("first user to sign up is promoted and pushed into the live allowlist", async () => {
    const allowlist = new Set();
    const users = new UsersService(db, {
      onFounderPromoted: (ids) => ids.forEach((id) => allowlist.add(id)),
    });

    // First-ever sign-in: brand-new account created AND promoted.
    const founder = await users.ensureFromClerk("clerk_founder");
    expect(allowlist.has("clerk_founder")).toBe(true);

    const doc = await db.users.findOne({ userId: founder.userId });
    expect(doc.role).toBe("admin");
    expect(doc.roleGrantedBy).toBe("founder_bootstrap");

    // A later sign-up is NOT promoted — there's already an admin.
    const second = await users.ensureFromClerk("clerk_second");
    expect(allowlist.has("clerk_second")).toBe(false);
    const secondDoc = await db.users.findOne({ userId: second.userId });
    expect(secondDoc.role).toBeUndefined();
  });

  test("an account that signed up before boot is promoted on its next authed request", async () => {
    // Simulate a user row that predates the process (no role yet, and
    // the boot-time bootstrap never ran for them).
    await db.users.insertOne({
      userId: "pre-existing",
      clerkUserId: "clerk_founder",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    });

    const allowlist = new Set();
    const users = new UsersService(db, {
      onFounderPromoted: (ids) => ids.forEach((id) => allowlist.add(id)),
    });

    // Their next authed request resolves the existing row and promotes.
    await users.ensureFromClerk("clerk_founder");
    expect(allowlist.has("clerk_founder")).toBe(true);
    const doc = await db.users.findOne({ userId: "pre-existing" });
    expect(doc.role).toBe("admin");
  });

  test("does NOT auto-promote when admins are already configured (env var)", async () => {
    const allowlist = new Set(["clerk_env_admin"]);
    const users = new UsersService(db, {
      onFounderPromoted: (ids) => ids.forEach((id) => allowlist.add(id)),
      hasConfiguredAdmins: () => allowlist.size > 0,
    });

    const first = await users.ensureFromClerk("clerk_first_user");
    // The operator's explicit allowlist stands — no surprise DB admin.
    expect(allowlist.has("clerk_first_user")).toBe(false);
    const doc = await db.users.findOne({ userId: first.userId });
    expect(doc.role).toBeUndefined();
  });

  test("latches off once resolved — no repeated promotion churn", async () => {
    const promotions = [];
    const users = new UsersService(db, {
      onFounderPromoted: (ids) => promotions.push(ids),
    });

    await users.ensureFromClerk("clerk_founder");
    await users.ensureFromClerk("clerk_founder");
    await users.ensureFromClerk("clerk_founder");

    // The callback fires exactly once — when the founder is first known.
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toEqual(["clerk_founder"]);
  });
});

describe("UsersService.grantAdmin", () => {
  let mongo;
  let db;
  let users;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_grant_admin",
    });
    users = new UsersService(db);
  });

  afterAll(async () => {
    if (db && db.client) await db.client.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.users.deleteMany({});
  });

  test("promotes a target user and records who granted it", async () => {
    await db.users.insertOne({
      userId: "target",
      clerkUserId: "clerk_target",
      createdAt: new Date(),
    });

    const res = await users.grantAdmin("target", "clerk_admin");
    expect(res).toEqual({ userId: "target", clerkUserId: "clerk_target" });

    const doc = await db.users.findOne({ userId: "target" });
    expect(doc.role).toBe("admin");
    expect(doc.roleGrantedBy).toBe("clerk_admin");
    expect(doc.roleGrantedAt).toBeInstanceOf(Date);
  });

  test("idempotent — re-granting still returns the Clerk id, no error", async () => {
    await db.users.insertOne({
      userId: "target",
      clerkUserId: "clerk_target",
      createdAt: new Date(),
      role: "admin",
      roleGrantedBy: "clerk_first",
    });

    const res = await users.grantAdmin("target", "clerk_second");
    expect(res).toEqual({ userId: "target", clerkUserId: "clerk_target" });
    // Original granter is preserved — re-grant is a no-op write.
    const doc = await db.users.findOne({ userId: "target" });
    expect(doc.roleGrantedBy).toBe("clerk_first");
  });

  test("refuses unknown users and users without a Clerk identity", async () => {
    await expect(users.grantAdmin("missing", "clerk_admin")).resolves.toBeNull();

    await db.users.insertOne({
      userId: "stub",
      createdAt: new Date(),
    });
    await expect(users.grantAdmin("stub", "clerk_admin")).resolves.toBeNull();
    const stub = await db.users.findOne({ userId: "stub" });
    expect(stub.role).toBeUndefined();
  });
});
