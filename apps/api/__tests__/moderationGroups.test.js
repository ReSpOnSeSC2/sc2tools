// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { CommunityService } = require("../src/services/community");

describe("moderation decisions settle target groups", () => {
  let mongo;
  let db;
  let service;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "moderation_groups" });
    service = new CommunityService(db);
  });
  beforeEach(async () => { await db.communityReports.deleteMany({}); });
  afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
  const seed = (targetType, targetId, n = 3) => db.communityReports.insertMany(
    Array.from({ length: n }, (_, i) => ({ id: `${targetId}-${i}`, reporterUserId: `u${i}`, targetType, targetId, reason: "spam", createdAt: new Date(i), resolvedAt: null })),
  );

  test.each(["build", "opponent", "review_comment", "review_request"])("one decision clears all open %s reports and preserves other groups", async (type) => {
    if (type.startsWith("review_")) service.registerReportTarget(type, { exists: async () => true, describe: async () => new Map(), restore: jest.fn(), remove: jest.fn(), onReported: jest.fn() });
    await seed(type, "target");
    await seed(type, "other", 1);
    expect(await service.resolveReport("admin", "target-0", { action: "dismiss", note: "Checked context" })).toEqual({ resolved: 3 });
    expect(await db.communityReports.countDocuments({ targetId: "target", resolvedAt: null })).toBe(0);
    expect(await db.communityReports.countDocuments({ targetId: "other", resolvedAt: null })).toBe(1);
    expect((await db.communityReports.findOne({ id: "target-2" })).resolutionNote).toBe("Checked context");
    await expect(service.resolveReport("admin", "target-0", { action: "remove" })).rejects.toMatchObject({ status: 404, code: "report_not_found" });
  });

  test("queue returns oldest capped rows, total, and built-in context", async () => {
    await seed("build", "capped", 101);
    await db.communityBuilds.insertOne({ slug: "capped", title: "Macro build", description: "Expand first" });
    const result = await service.listReports();
    expect(result).toMatchObject({ total: 101, capped: true });
    expect(result.items).toHaveLength(100);
    expect(result.items[0]).toMatchObject({ id: "capped-0", target: { title: "Macro build", snippet: "Expand first" } });
  });

  test("removing an opponent actually suppresses its public profile and clears availability cache", async () => {
    await seed("opponent", "removed-player");
    service.opponentAvailability.set("removed-player", { available: true, expiresAt: Date.now() + 60000 });
    await service.resolveReport("admin", "removed-player-0", { action: "remove" });
    expect(service.opponentAvailability.has("removed-player")).toBe(false);
    expect(await service.aggregateOpponent("removed-player")).toBeNull();
    expect(await service.opponentProfileAvailable("removed-player")).toBe(false);
  });
});
