// @ts-nocheck
"use strict";

/**
 * Browser replay backup readiness over HTTP:
 *   - GET /v1/admin/health → runtime.replayFilesBrowserUpload
 *   - GET /v1/me/replay-archive-status → browserUploadReady (existing
 *     fields unchanged)
 *
 * Real ``mongodb-memory-server`` + the full ``buildApp`` pipeline, as in
 * admin.test.js. MOCKS (labelled): Clerk token verification, the R2
 * control plane (``S3Client.prototype.send``) and R2's preflight answer
 * (``global.fetch``). No network is used.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} = require("@aws-sdk/client-s3");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "admin-token") return { sub: "clerk_admin" };
    if (token === "user-token") return { sub: "clerk_regular_user" };
    throw new Error("invalid");
  }),
}));

const ORIGIN = "https://sc2tools.com";
const GOOD_PREFLIGHT = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "PUT",
  "access-control-allow-headers": "content-type,cache-control,content-md5,x-amz-meta-sha256",
};

function baseConfig(dbName, overrides) {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: dbName,
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [ORIGIN],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: ["clerk_admin"],
    gameDetailsStore: "mongo",
    r2: null,
    ...overrides,
  };
}

const R2_CONFIG = {
  replayFilesStore: "r2",
  r2: {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "private-replays",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    replayPrefix: "raw-replays/v1",
  },
};

let mongo;
let db;
const realFetch = global.fetch;
/** MOCK R2 bucket CORS configuration (null = none). */
let bucketRules;

function build(overrides) {
  return buildApp({
    db,
    logger: pino({ level: "silent" }),
    config: baseConfig("sc2tools_test_browser_cors", overrides),
    pulseMmr: new PulseMmrService({
      fetchImpl: async () => {
        throw new Error("network_disabled_in_tests");
      },
    }),
  });
}

/** MOCK R2 control plane: GetBucketCors / PutBucketCors over ``bucketRules``. */
async function mockR2Send(command) {
  if (command instanceof GetBucketCorsCommand) {
    if (bucketRules === null) {
      throw Object.assign(new Error("none"), {
        name: "NoSuchCORSConfiguration",
        $metadata: { httpStatusCode: 404 },
      });
    }
    return { CORSRules: bucketRules };
  }
  if (command instanceof PutBucketCorsCommand) {
    bucketRules = command.input.CORSConfiguration.CORSRules;
    return {};
  }
  throw new Error(`unexpected command ${command.constructor.name}`);
}

const asAdmin = (req) => req.set("authorization", "Bearer admin-token");
const asUser = (req) => req.set("authorization", "Bearer user-token");

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_browser_cors" });
});

beforeEach(() => {
  bucketRules = null;
  jest.spyOn(S3Client.prototype, "send").mockImplementation(mockR2Send);
  // MOCK R2 preflight answer (a browser-valid one unless a test overrides it).
  global.fetch = jest.fn(async () => new Response(null, { status: 200, headers: GOOD_PREFLIGHT }));
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = realFetch;
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

describe("browser replay backup readiness: store off / not yet checked", () => {
  test("replay store off → disabled status and browserUploadReady false", async () => {
    const { app } = build({ replayFilesStore: "disabled" });
    const health = await asAdmin(request(app).get("/v1/admin/health"));
    expect(health.status).toBe(200);
    expect(health.body.runtime.replayFilesStore).toBe("disabled");
    expect(health.body.runtime.replayFilesBrowserUpload).toEqual({ status: "disabled", checkedAt: null });

    const status = await asUser(request(app).get("/v1/me/replay-archive-status"));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: false, browserUploadReady: false });
  });

  test("before the boot check nothing is ready and no R2 call is made", async () => {
    const { app } = build(R2_CONFIG);
    const health = await asAdmin(request(app).get("/v1/admin/health"));
    expect(health.body.runtime.replayFilesBrowserUpload).toEqual({ status: "unknown", checkedAt: null });
    const status = await asUser(request(app).get("/v1/me/replay-archive-status"));
    expect(status.body.browserUploadReady).toBe(false);
    expect(S3Client.prototype.send).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("browser replay backup readiness: after a check", () => {
  test("verified: ready on both routes, existing fields unchanged", async () => {
    const { app, services } = build(R2_CONFIG);
    await services.browserUploadCors.refresh();

    const health = await asAdmin(request(app).get("/v1/admin/health"));
    expect(health.body.runtime.replayFilesStore).toBe("r2");
    expect(health.body.runtime.replayFilesBrowserUpload).toMatchObject({
      status: "ready",
      checkedAt: expect.any(String),
      configuredAt: expect.any(String),
    });

    const status = await asUser(request(app).get("/v1/me/replay-archive-status"));
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      totalGames: 0,
      archivedGames: 0,
      missingGames: 0,
      archiveComplete: true,
      enabled: true,
      backfillVersion: 0,
      resyncRequestedAt: null,
      requiresResync: false,
      browserUploadReady: true,
    });
  });

  test("a refused preflight → missing_cors and browserUploadReady false", async () => {
    global.fetch = jest.fn(async () => new Response(null, { status: 403 }));
    const { app, services } = build({ ...R2_CONFIG, r2BrowserCorsAuto: false });
    await services.browserUploadCors.refresh();

    const health = await asAdmin(request(app).get("/v1/admin/health"));
    expect(health.body.runtime.replayFilesBrowserUpload).toMatchObject({ status: "missing_cors" });
    expect(bucketRules).toBeNull();
    const status = await asUser(request(app).get("/v1/me/replay-archive-status"));
    expect(status.body).toMatchObject({ enabled: true, browserUploadReady: false });
  });
});
