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
