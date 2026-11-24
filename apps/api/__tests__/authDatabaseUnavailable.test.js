// @ts-nocheck
"use strict";

// The desktop agent treats repeated 401s as a revoked device token and
// unpairs. A database failure while checking a token must therefore answer
// 503 + Retry-After, and only a real verdict (unknown, revoked or invalid
// token, deleted account) may answer 401.

jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn() }));
const express = require("express");
const request = require("supertest");
const pino = require("pino");
const {
  MongoClient, MongoNetworkTimeoutError, MongoServerError, MongoServerSelectionError,
} = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { verifyToken } = require("@clerk/backend");
const { buildAuth } = require("../src/middleware/auth");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { safePrivateSearchError } = require("../src/middleware/privateSearchBoundary");
const { safeReplayDownloadBatchError } = require("../src/middleware/replayDownloadBatchBoundary");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { sha256 } = require("../src/util/hash");

// Device-token shaped bearers: 43 base64url characters, no dots.
const liveToken = "Q".repeat(43);
const revokedToken = "R".repeat(43);
const unknownToken = "S".repeat(43);
const clerkJwt = "synthetic.session.jwt";

/** The real auth middleware and error handler, with the error log captured. */
function harness(deps) {
  const logs = [];
  const app = express();
  app.get("/probe", buildAuth({
    secretKey: "synthetic",
    getDeviceToken: async () => null,
    ensureUser: async () => ({ userId: "clerk-owner" }),
    ...deps,
  }), (req, res) => res.json(req.auth));
  app.use(buildErrorHandler(pino({ level: "info" }, { write: (line) => logs.push(String(line)) })));
  return { app, logs };
}

/** @param {any} app @param {string} bearer */
function probe(app, bearer) {
  return request(app).get("/probe").set("Authorization", `Bearer ${bearer}`);
}

/** @param {any} response */
function expectUnavailable(response) {
  expect(response.status).toBe(503);
  expect(response.headers["retry-after"]).toBe("5");
  expect(response.body.error.code).toBe("auth_unavailable");
}

/** @param {any} response @param {string} code */
function expectRejected(response, code) {
  expect(response.status).toBe(401);
  expect(response.headers["retry-after"]).toBeUndefined();
  expect(response.body.error.code).toBe(code);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Clerk rejects anything that is not one of its session JWTs, device tokens included.
  verifyToken.mockRejectedValue(Object.assign(new Error("Invalid JWT form"), { reason: "token-invalid" }));
});

describe("device tokens checked against a real database", () => {
  let mongo, client, pairings, stopped = false;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    // Fail fast once the server is gone instead of the driver's 30 s default.
    client = new MongoClient(mongo.getUri(), { serverSelectionTimeoutMS: 500 });
    await client.connect();
    const deviceTokens = client.db("auth-database-unavailable").collection("deviceTokens");
    const lastSeenAt = new Date();
    await deviceTokens.insertMany([
      { userId: "owner", tokenHash: sha256(liveToken), revokedAt: null, lastSeenAt },
      { userId: "owner", tokenHash: sha256(revokedToken), revokedAt: lastSeenAt, lastSeenAt },
    ]);
    pairings = new DevicePairingsService({ deviceTokens });
  });

  afterAll(async () => {
    await client?.close();
    if (!stopped) await mongo?.stop();
  });

  test("live passes, revoked and unknown get 401, and a stopped database gets 503", async () => {
    const { app, logs } = harness({ getDeviceToken: (hash) => pairings.findTokenByHash(hash) });

    const live = await probe(app, liveToken);
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ userId: "owner", source: "device", tokenHash: sha256(liveToken) });
    expectRejected(await probe(app, revokedToken), "auth_failed");
    expectRejected(await probe(app, unknownToken), "auth_failed");

    await mongo.stop();
    stopped = true;
    logs.length = 0;
    const down = await probe(app, liveToken);
    expectUnavailable(down);
    expect(verifyToken).toHaveBeenCalledTimes(2); // Only the two rejected tokens reached Clerk.

    const log = logs.join("\n");
    expect(log).toMatch(/"status":503/);
    expect(log).toMatch(/"cause":\{"type":"Mongo\w+Error"/);
    expect(log).not.toContain(liveToken);
    expect(log).not.toContain(sha256(liveToken));
  });
});

describe("a device-token lookup that throws", () => {
  test.each([
    ["server selection timeout", () => new MongoServerSelectionError(
      "Server selection timed out after 30000 ms connecting to db-7.internal:27017", { type: "Unknown", servers: new Map() })],
    ["network timeout", () => new MongoNetworkTimeoutError("connection 4 to db-7.internal:27017 timed out")],
    ["server time limit", () => new MongoServerError({
      message: "operation exceeded time limit on db-7.internal:27017", code: 50, codeName: "MaxTimeMSExpired",
    })],
    ["unexpected failure", () => new Error("lookup failed on db-7.internal:27017")],
  ])("%s answers 503 with Retry-After, never 401", async (_label, failure) => {
    const thrown = failure();
    const getDeviceToken = jest.fn(async () => { throw thrown; });
    const { app, logs } = harness({ getDeviceToken });

    expectUnavailable(await probe(app, liveToken));
    expect(getDeviceToken).toHaveBeenCalledWith(sha256(liveToken));
    expect(verifyToken).not.toHaveBeenCalled();

    // The log keeps the failure's kind but never its message, the token or its hash.
    const log = logs.join("\n");
    expect(log).toContain(`"cause":{"type":"${thrown.name}"`);
    expect(log).not.toContain("db-7.internal");
    expect(log).not.toContain(liveToken);
    expect(log).not.toContain(sha256(liveToken));
  });

  test("an account-deleted verdict from the lookup stays 401", async () => {
    const getDeviceToken = async () => { throw Object.assign(new Error("account_deleted"), { status: 401, code: "account_deleted" }); };
    expectRejected(await probe(harness({ getDeviceToken }).app, liveToken), "account_deleted");
  });
});

describe("Clerk sign-ins", () => {
  beforeEach(() => { verifyToken.mockResolvedValue({ sub: "user_synthetic" }); });

  test("a database failure while resolving the user answers 503", async () => {
    const ensureUser = jest.fn(async () => { throw new MongoNetworkTimeoutError("connection 9 to db-7.internal:27017 timed out"); });
    const { app, logs } = harness({ ensureUser });
    expectUnavailable(await probe(app, clerkJwt));
    expect(ensureUser).toHaveBeenCalledWith("user_synthetic");
    expect(logs.join("\n")).not.toContain(clerkJwt);
  });

  test("a deleted account and a rejected JWT stay 401", async () => {
    const ensureUser = async () => { throw Object.assign(new Error("account_deleted"), { status: 401, code: "account_deleted" }); };
    expectRejected(await probe(harness({ ensureUser }).app, clerkJwt), "account_deleted");
    verifyToken.mockRejectedValue(new Error("JWT signature is invalid."));
    expectRejected(await probe(harness({}).app, clerkJwt), "auth_failed");
  });

  test("a valid sign-in still authenticates", async () => {
    const response = await probe(harness({}).app, clerkJwt);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "clerk-owner", clerkUserId: "user_synthetic", source: "clerk" });
  });
});

test("route-private error boundaries keep auth_unavailable a 503", () => {
  const failure = Object.assign(new Error("auth_unavailable"), { status: 503, code: "auth_unavailable" });
  expect(safePrivateSearchError(failure)).toMatchObject({ status: 503, code: "auth_unavailable" });
  expect(safeReplayDownloadBatchError(failure)).toMatchObject({ status: 503, code: "auth_unavailable" });
});
