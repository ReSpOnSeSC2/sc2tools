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
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await db?.close(); await mongo?.stop(); });

  test("the old upload is404 and cannot dispatch its parser", async () => {
    const response = await request(app).post("/v1/public/preview-replay")
      .set("content-type", "application/octet-stream").send(Buffer.from([0x4d, 0x50, 0x51, 0x1b, 0, 0]));
    expect(response.status).toBe(404);
    expect(pythonRunner.runPythonNdjson).not.toHaveBeenCalled();
  });
  test("the old parser health is404 while actual API health remains available", async () => {
    expect((await request(app).get("/v1/public/preview-replay/health")).status).toBe(404);
    expect(pythonRunner.runPythonNdjson).not.toHaveBeenCalled();
    const response = await request(app).get("/v1/health");
    expect(response.status).toBe(200); expect(response.body.status).toBe("ok");
    expect(response.body.checks).toEqual({ mongoPing: true, mongoWrite: true });
  });
});
