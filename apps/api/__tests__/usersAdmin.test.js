// @ts-nocheck
"use strict";

/**
 * Admin role plumbing on UsersService:
 *   - ``listDbAdminClerkIds`` reports the Clerk ids of users carrying
 *     role:"admin" (used at boot to re-seed the live allowlist). It is
 *     READ-ONLY — there is no "first signup becomes admin" heuristic.
 *   - ``grantAdmin`` promotes a target user (idempotent, refuses rows
 *     without a Clerk identity), the admin-gated path for adding admins.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");

describe("UsersService.listDbAdminClerkIds", () => {
  let mongo;
  let db;
  let users;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_list_admins",
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

  test("empty when nobody carries the admin role", async () => {
    await db.users.insertOne({
      userId: "u1",
      clerkUserId: "clerk_plain",
      createdAt: new Date(),
    });
    await expect(users.listDbAdminClerkIds()).resolves.toEqual([]);
  });

  test("returns the Clerk ids of every role:admin user", async () => {
    await db.users.insertOne({
      userId: "u1",
      clerkUserId: "clerk_admin_a",
      createdAt: new Date(),
      role: "admin",
    });
    await db.users.insertOne({
      userId: "u2",
      clerkUserId: "clerk_plain",
      createdAt: new Date(),
    });
    await db.users.insertOne({
      userId: "u3",
      clerkUserId: "clerk_admin_b",
      createdAt: new Date(),
      role: "admin",
    });

    const ids = await users.listDbAdminClerkIds();
    expect(ids.sort()).toEqual(["clerk_admin_a", "clerk_admin_b"]);
  });

  test("never auto-promotes — a fresh user is not made admin", async () => {
    await db.users.insertOne({
      userId: "u1",
      clerkUserId: "clerk_first",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await users.listDbAdminClerkIds();
    const doc = await db.users.findOne({ userId: "u1" });
    expect(doc.role).toBeUndefined();
  });

  test("skips admin rows without a Clerk identity", async () => {
    await db.users.insertOne({
      userId: "stub",
      createdAt: new Date(),
      role: "admin",
    });
    await expect(users.listDbAdminClerkIds()).resolves.toEqual([]);
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
