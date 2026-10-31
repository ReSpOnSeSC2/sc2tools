// @ts-nocheck
"use strict";
// The quarantine end runs the app's real invalidator: one full local retirement that clears TrendsRequests joins and
// owner revisions, so a session-policy lease taken before the end no longer verifies (the one-time 409 the guard
// documents), while chart responses admitted afterwards are retained again.
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { startChartCacheQuarantine } = require("../src/middleware/userCacheGuard");
const { createBackupStore } = require("./helpers/userBackupsStore");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "owner-a") return { sub: "clerk-a" };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({ users: { getUser: jest.fn() } })),
}));

let mongo, db, app, services;
const config = { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "cache_guard_app",
  clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 5), corsAllowedOrigins: [], rateLimitPerMinute: 5000,
  pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [], userCacheEnabled: true };
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "cache_guard_app" });
  ({ app, services } = buildApp({ db, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { deleteUser: async () => {} }, config }));
  await db.users.insertOne({ userId: "a", clerkUserId: "clerk-a", dataRev: 0 });
});
afterAll(async () => { await services.customBuilds.stopReclassifications(); await db.close(); await mongo.stop(); });

test("the first request after the quarantine runs the app's full retirement once and retires earlier session-policy leases", async () => {
  let now = Date.now(); services.userCache.now = () => now;
  startChartCacheQuarantine(services.userCache, undefined, 1000);
  const get = tag => request(app).get("/v1/summary").set("Authorization", "Bearer owner-a").set("If-None-Match", tag);
  expect((await get('W/"none"')).headers["cache-control"]).toBe("private, no-store");
  const lease = services.sessionPolicy.lease("a"), joins = services.aggregations.trendsRequests.pending;
  expect(() => services.sessionPolicy.assertCurrent(lease)).not.toThrow();
  joins.set("sentinel-join", { subs: new Set() });
  now += 1000;
  const first = await get('W/"none"');
  expect(first.headers["cache-control"]).toBe("private, no-cache"); expect(joins.has("sentinel-join")).toBe(false);
  expect(() => services.sessionPolicy.assertCurrent(lease)).toThrow(expect.objectContaining({ status: 409, code: "session_policy_changed" }));
  const fresh = services.sessionPolicy.lease("a");
  expect((await get(first.headers.etag)).status).toBe(304);
  expect(() => services.sessionPolicy.assertCurrent(fresh)).not.toThrow();
});
