// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AdminUsersService, CSV_COLUMNS } = require("../src/services/adminUsers");
const { AdminService } = require("../src/services/admin");
const { AdminEventsService } = require("../src/services/adminEvents");
const { parseUsersQuery, buildAdminUsersRouter } = require("../src/routes/adminUsers");
const express = require("express");
const request = require("supertest");

const now = new Date("2026-10-25T12:00:00Z"), day = 86400000;
describe("Admin Users matched pages and private exports", () => {
  let mongo, db, service;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "admin_users_polish" });
    service = new AdminUsersService(db, { now: () => now, adminIds: () => ["env-admin"] });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.users, db.games, db.opponents, db.deviceTokens, db.adminEvents].map(c => c.deleteMany({})));
    await db.users.insertMany([
      { userId: "alpha", clerkUserId: "env-admin", email: "a+one@example.test", createdAt: new Date(+now - 7 * day), lastSeenAt: new Date(+now - day) },
      { userId: "beta", clerkUserId: "b", email: "b@example.test", role: "admin", createdAt: new Date(+now - 20 * day), lastSeenAt: new Date(+now - 2 * day) },
      { userId: "gamma", clerkUserId: "g", createdAt: new Date(+now - day), lastSeenAt: null },
      { userId: "zero", clerkUserId: "z", createdAt: new Date(+now - 30 * day) },
    ]);
    await db.games.insertMany([...["alpha", "alpha", "alpha", "beta", "beta", "gamma", "orphan"].map((userId, i) => ({ userId, gameId: String(i), date: new Date(+now - (10 - i) * day), result: i % 2 ? "Defeat" : "Victory", map: "Map", opponent: { pulseId: "p", displayName: "Opponent" } }))]);
    await db.opponents.insertMany([{ userId: "beta", pulseId: "p1" }, { userId: "beta", pulseId: "p2" }, { userId: "gamma", pulseId: "p1" }]);
    await db.deviceTokens.insertMany([
      { userId: "alpha", lastSeenAt: new Date(+now - 15 * day), revokedAt: now },
      { userId: "beta", lastSeenAt: new Date(+now - 20 * day) },
      { userId: "beta", lastSeenAt: new Date(+now - day) },
      { userId: "gamma", lastSeenAt: null },
    ].map((row, i) => ({ ...row, tokenHash: `fixture-${i}` })));
  });

  test.each(["lastActivity", "createdAt", "games", "opponents", "agentLastSeen"].flatMap(sort => ["asc", "desc"].map(order => [sort, order])))("%s %s pages have stable total and retain zero-game users", async (sort, order) => {
    const full = await service.list({ sort, order });
    const pages = await Promise.all([1, 2].map(page => service.list({ sort, order, page, limit: 2 })));
    expect(pages.map(p => p.total)).toEqual([4, 4]);
    expect(pages.flatMap(p => p.items.map(r => r.userId))).toEqual(full.items.map(r => r.userId));
    expect(new Set(full.items.map(r => r.userId))).toEqual(new Set(["alpha", "beta", "gamma", "zero"]));
    expect(full.items.find(r => r.userId === "alpha")).toMatchObject({ gameCount: 3, opponentCount: 0, isAdmin: true, hasAgent: true });
    expect(full.items.find(r => r.userId === "beta")).toMatchObject({ gameCount: 2, opponentCount: 2, isAdmin: true });
    expect(full.items.find(r => r.userId === "zero").lastActivity).toEqual(new Date(+now - 30 * day));
    expect(full.items[0]).not.toHaveProperty("storageEstimateBytes");
    const values = full.items.map(r => sort === "games" ? r.gameCount : sort === "opponents" ? r.opponentCount : sort === "agentLastSeen" ? +(r.agentLastSeenAt || 0) : sort === "createdAt" ? +r.createdAt : +(r.lastActivity || (r.userId === "zero" ? new Date(+now - 30 * day) : 0)));
    expect(values).toEqual([...values].sort((a, b) => order === "asc" ? a - b : b - a));
  });
  test.each([["signed_up_7d", ["alpha", "gamma"]], ["agent_inactive_14d", ["alpha"]], ["admins", ["alpha", "beta"]], ["with_games", ["alpha", "beta", "gamma"]], ["no_games", ["zero"]], ["with_agent", ["alpha", "beta", "gamma"]]])("%s shares exact count and row predicates", async (filter, expected) => {
    const page = await service.list({ filter, sort: "games", order: "asc", limit: 1 });
    const all = await service.list({ filter });
    expect(page.total).toBe(expected.length);
    expect(all.items.map(r => r.userId).sort()).toEqual(expected);
  });
  test("literal search, strict inactivity boundary, and legacy cursor", async () => {
    expect((await service.list({ search: "a+one" })).items.map(r => r.userId)).toEqual(["alpha"]);
    await db.deviceTokens.updateOne({ userId: "alpha" }, { $set: { lastSeenAt: new Date(+now - 14 * day) } });
    expect((await service.list({ filter: "agent_inactive_14d" })).total).toBe(0);
    const first = await service.list({ limit: 1 });
    const next = await service.list({ before: first.nextBefore, limit: 1 });
    expect(next.items[0].userId).not.toBe(first.items[0].userId);
  });
  test("CSV uses shared formula/RFC4180 escaping and explicit private columns", async () => {
    await db.users.insertOne({ userId: "=SUM(1,2)", clerkUserId: "+cmd", email: 'quoted,"email"\n@example.test', createdAt: now });
    const prepared = await service.prepareCsv({ search: "=SUM" });
    let csv = ""; for await (const chunk of prepared.stream) csv += chunk;
    expect(csv).toContain(`\uFEFF${CSV_COLUMNS.join(",")}\r\n`);
    expect(csv).toContain('"\'=SUM(1,2)",\'+cmd,"quoted,""email""\n@example.test"');
    expect(csv).toContain(",0,0,false,,false\r\n");
    expect(prepared).toMatchObject({ total: 1, truncated: false });
  });
  test("stream caps actual matching results at 10000 without materializing export rows", async () => {
    await db.users.deleteMany({});
    await db.users.insertMany(Array.from({ length: 10001 }, (_, i) => ({ userId: `cap-${String(i).padStart(5, "0")}`, createdAt: now, clerkUserId: `cap-clerk-${i}` })));
    const prepared = await service.prepareCsv(); let lines = 0;
    for await (const _chunk of prepared.stream) lines++;
    expect(prepared).toMatchObject({ total: 10001, truncated: true }); expect(lines).toBe(10001);
  }, 30000);
  test("detail includes only five newest lightweight games", async () => {
    const admin = new AdminService({ db, gdpr: {}, adminIds: () => ["env-admin"] });
    await db.games.insertMany(Array.from({ length: 6 }, (_, i) => ({ userId: "alpha", gameId: `new-${i}`, date: new Date(+now + i), result: "Tie", map: "Recent", opponent: { displayName: "Rival", pulseId: "p" }, secret: "never" })));
    const detail = await admin.userDetail("alpha");
    expect(detail.isAdmin).toBe(true); expect(detail.recentGames.map(g => g.gameId)).toEqual(["new-5", "new-4", "new-3", "new-2", "new-1"]);
    expect(detail.recentGames[0]).toEqual({ gameId: "new-5", date: new Date(+now + 5), result: "Tie", map: "Recent", opponent: { name: "Rival", pulseId: "p" } });
  });
  test("user activity excludes other owners and retained anonymized identities before page limit", async () => {
    const events = new AdminEventsService({ db });
    await db.adminEvents.insertMany([
      { eventId: "mine", type: "user_signup", createdAt: now, payload: { userId: "alpha" } },
      { eventId: "other", type: "user_signup", createdAt: now, payload: { userId: "beta" } },
      { eventId: "anonymized", type: "user_signup", createdAt: now, anonymizedAt: now, payload: { userId: "alpha" } },
    ]);
    const rows = await events.list({ userId: "alpha", limit: 1 });
    expect(rows.items.map(e => e.eventId)).toEqual(["mine"]);
    expect(rows.items[0].payload.email).toBe("a+one@example.test");
    expect((await db.adminEvents.findOne({ eventId: "mine" })).payload.email).toBeUndefined();
  });
  test("export route streams attachment, audits counts only, and admits once per admin/minute", async () => {
    const audit = jest.fn(), app = express();
    app.use((req, _res, next) => { req.auth = { userId: "admin" }; next(); });
    app.use(buildAdminUsersRouter({ admin: { listUsers: opts => service.list(opts), prepareUsersCsv: opts => service.prepareCsv(opts) }, adminAudit: { audit } }));
    const response = await request(app).get("/admin/users/export.csv?q=a%2Bone&filter=admins");
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="sc2tools-users-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(response.text).toContain("a+one@example.test"); expect(response.headers["x-export-truncated"]).toBe("false");
    expect(audit.mock.calls[0].slice(1)).toEqual(["users.export", null, { rows: 1, truncated: false }]);
    expect((await request(app).get("/admin/users/export.csv")).status).toBe(429);
  });
});

test.each([{ page: "0" }, { page: ["1", "2"] }, { sort: "role" }, { filter: "unknown" }, { before: "bad" }, { before: now.toISOString(), sort: "games" }, { q: ["alpha"] }, { order: ["asc"] }, { q: "a", search: "b" }])("invalid query cannot silently broaden directory: %j", query => {
  expect(() => parseUsersQuery(query)).toThrow();
});
