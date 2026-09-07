// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

describe("HTTP completion log credential isolation", () => {
  let mongo;
  let db;
  let app;
  const lines = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "request_log_sanitization_test" });
    ({ app } = buildApp({
      db,
      logger: pino({ level: "info" }, { write: (line) => lines.push(line) }),
      config: {
        nodeEnv: "test", logLevel: "info", port: 0,
        mongoUri: "", mongoDb: "request_log_sanitization_test",
        clerkSecretKey: "", serverPepper: Buffer.alloc(32, 1),
        corsAllowedOrigins: [], rateLimitPerMinute: 1000,
        agentReleaseAdminToken: "synthetic-admin-config",
        pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__",
      },
    }));
    app.get("/_log-regression/:status", (req, res) => {
      res.set("set-cookie", "session=synthetic-response-cookie");
      res.set("authorization", "synthetic-response-authorization");
      res.set("location", "/callback?token=synthetic-redirect-token");
      res.set("retry-after", "3");
      res.status(Number(req.params.status)).json({ value: "synthetic-response-body" });
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });
  beforeEach(() => { lines.length = 0; });

  test.each([200, 503])("status %s logs bounded request and response diagnostics without raw object graphs", async (status) => {
    const response = await request(app).get(`/_log-regression/${status}?token=synthetic-query-credential`)
      .set("authorization", "Bearer synthetic-request-authorization")
      .set("cookie", "session=synthetic-request-cookie")
      .set("x-admin-token", "synthetic-request-admin-token");
    expect(response.status).toBe(status);
    const records = lines.map((line) => JSON.parse(line));
    const completion = records.find((record) => record.res?.statusCode === status);
    expect(completion).toBeDefined();
    expect(completion.res).toEqual({ statusCode: status, headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": expect.any(String),
      "retry-after": "3",
      "x-request-id": expect.any(String),
    } });
    expect(completion.req.url).toBe(`/_log-regression/${status}?token=%5Bredacted%5D`);
    expect(completion.req.headers.authorization).toBeUndefined();
    expect(completion.res.req).toBeUndefined();
    expect(completion.req.rawHeaders).toBeUndefined();
    const output = lines.join("");
    for (const sentinel of [
      "synthetic-query-credential", "synthetic-request-authorization", "synthetic-request-cookie",
      "synthetic-request-admin-token", "synthetic-response-cookie", "synthetic-response-authorization",
      "synthetic-redirect-token", "synthetic-response-body",
    ]) expect(output).not.toContain(sentinel);
    expect(output).not.toContain("rawHeaders");
  });
});
