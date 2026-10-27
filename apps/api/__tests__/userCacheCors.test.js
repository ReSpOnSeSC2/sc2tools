// @ts-nocheck
"use strict";
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "etag-test") return { sub: "clerk_etag" };
    throw new Error("invalid");
  }),
  createClerkClient: jest.fn(() => ({ users: { getUser: jest.fn() } })),
}));

describe("actual app CORS conditional chart responses", () => {
  let mongo, db, app;
  const origin = "https://sc2tools.com";
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "etag_cors" });
    await db.users.insertOne({ userId: "etag-owner", clerkUserId: "clerk_etag", dataRev: 0 });
    app = buildApp({ db, logger: pino({ level: "silent" }), config: {
      port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "etag_cors",
      clerkSecretKey: "sk_test", clerkJwtIssuer: undefined, clerkJwtAudience: undefined,
      serverPepper: Buffer.alloc(32, 4), corsAllowedOrigins: [origin], rateLimitPerMinute: 5000,
      agentReleaseAdminToken: "admin", pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__",
      adminUserIds: [], userCacheEnabled: true,
    } }).app;
  });
  afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });

  test("preflight accepts Authorization/If-None-Match and readable private200/304 expose ETag", async () => {
    const pre = await request(app).options("/v1/timeseries").set("Origin", origin)
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization,if-none-match");
    expect(pre.status).toBe(204); expect(pre.headers["access-control-allow-origin"]).toBe(origin);
    expect(pre.headers["access-control-allow-headers"].toLowerCase()).toContain("if-none-match");
    const first = await request(app).get("/v1/timeseries").set("Origin", origin).set("Authorization", "Bearer etag-test");
    expect(first.status).toBe(200); expect(first.headers.etag).toMatch(/^W\/"uc1-[0-9a-f]{64}"$/);
    expect(first.headers["access-control-expose-headers"].split(",").map(value => value.trim())).toContain("ETag");
    const same = await request(app).get("/v1/timeseries").set("Origin", origin)
      .set("Authorization", "Bearer etag-test").set("If-None-Match", first.headers.etag);
    expect(same.status).toBe(304); expect(same.text).toBe("");
    expect(same.headers.etag).toBe(first.headers.etag);
    expect(same.headers["access-control-allow-origin"]).toBe(origin);
    expect(same.headers["access-control-expose-headers"]).toContain("ETag");
    expect(same.headers.vary).toContain("Origin"); expect(same.headers.vary).toContain("Authorization");
  });

  test("a validator grants neither authentication nor a new CORS origin", async () => {
    const unauth = await request(app).get("/v1/timeseries").set("Origin", origin).set("If-None-Match", "*");
    expect(unauth.status).toBe(401);
    const denied = await request(app).get("/v1/timeseries").set("Origin", "https://unapproved.invalid")
      .set("Authorization", "Bearer etag-test").set("If-None-Match", "*");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
