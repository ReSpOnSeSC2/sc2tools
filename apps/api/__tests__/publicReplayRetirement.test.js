// @ts-nocheck
"use strict";

const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
jest.mock("../src/util/pythonRunner", () => ({
  ...jest.requireActual("../src/util/pythonRunner"),
  pythonAvailable: jest.fn(() => true),
  runPythonNdjson: jest.fn(async () => { throw new Error("retired_preview_dispatched_python"); }),
}));
const pythonRunner = require("../src/util/pythonRunner");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { sha256 } = require("../src/util/hash");
const DEVICE_TOKEN = "local-retirement-fixture-device-token-123456";

describe("retired anonymous replay parser on the actual app", () => {
  let mongo, db, app;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    db = await connect({ uri: mongo.getUri(), dbName: "preview_retirement" });
    ({ app } = buildApp({ db, logger: pino({ level: "silent" }), config: {
      nodeEnv: "test", serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: [],
      rateLimitPerMinute: 1000, adminUserIds: [], pythonExe: null,
      pythonAnalyzerDir: "/tmp/__missing_preview_retirement__",
    } }));
    await db.users.insertOne({ userId: "preview-retirement-owner" });
    await db.deviceTokens.insertOne({ userId: "preview-retirement-owner", tokenHash: sha256(DEVICE_TOKEN), revokedAt: null, lastSeenAt: new Date() });
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await db?.close(); await mongo?.stop(); });

  test("the old upload is404 after ordinary auth and cannot dispatch its parser", async () => {
    const response = await request(app).post("/v1/public/preview-replay")
      .set("authorization", `Bearer ${DEVICE_TOKEN}`)
      .set("content-type", "application/octet-stream").send(Buffer.from([0x4d, 0x50, 0x51, 0x1b, 0, 0]));
    expect(response.status).toBe(404);
    expect(pythonRunner.runPythonNdjson).not.toHaveBeenCalled();
  });
  test("the old parser health is404 while actual API health remains available", async () => {
    expect((await request(app).get("/v1/public/preview-replay/health").set("authorization", `Bearer ${DEVICE_TOKEN}`)).status).toBe(404);
    expect(pythonRunner.runPythonNdjson).not.toHaveBeenCalled();
    const response = await request(app).get("/v1/health");
    expect(response.status).toBe(200); expect(response.body.status).toBe("ok");
    expect(response.body.checks).toEqual({ mongoPing: true, mongoWrite: true });
  });
  test.each([["post", "/v1/public/preview-replay"], ["get", "/v1/public/preview-replay/health"]])("anonymous %s %s keeps the existing unmatched-route auth boundary", async (method, path) => {
    const response = await request(app)[method](path), unknown = await request(app)[method]("/v1/retired-preview-control");
    expect(response.status).toBe(401); expect(unknown.status).toBe(401);
    expect(response.body.error.code).toBe("missing_token");
    expect(response.body.error.code).toBe(unknown.body.error.code);
    expect(pythonRunner.runPythonNdjson).not.toHaveBeenCalled();
  });
});
