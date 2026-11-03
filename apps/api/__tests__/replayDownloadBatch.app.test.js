// @ts-nocheck
"use strict";
const request = require("supertest"), pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { BODY_BYTES } = require("../src/middleware/replayDownloadBatchBoundary");
const sentry = require("../src/util/sentry");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async token => {
  if (token === "synthetic-owner-token") return { sub: "synthetic-clerk-owner" };
  throw new Error("private-token-detail");
}) }));
let mongo, db;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "replay-batch-app" }); });
afterAll(async () => { await db?.close(); await mongo?.stop(); });
afterEach(() => jest.restoreAllMocks());
function fixture(rate = 5000, level = "error") {
  const logs = [];
  const { app, services } = buildApp({ db, logger: pino({ level }, { write: line => logs.push(String(line)) }),
    pulseMmr: new PulseMmrService({ fetchImpl: async () => { throw new Error("network_disabled_in_tests"); } }),
    config: { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "replay-batch-app",
      clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: ["https://sc2tools.com"],
      rateLimitPerMinute: rate, agentReleaseAdminToken: "synthetic", pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [],
      gameDetailsStore: "mongo", replayFilesStore: "r2", r2: { endpoint: "https://fixture.r2.invalid", region: "auto", bucket: "mock-private",
        accessKeyId: "mock-access", secretAccessKey: "mock-secret", replayPrefix: "raw/v1" } } });
  const prepare = jest.spyOn(services.replayFiles, "prepareDownloadBatch").mockResolvedValue({ format: "fixture", items: [] });
  return { app, prepare, logs, services };
}
const authorized = operation => operation.set("authorization", "Bearer synthetic-owner-token");
const ignoredQuery = "?url=" + encodeURIComponent("https://ignored.invalid/object?signature=private-query-sentinel");
function expectPrivateLogUrl(logs) {
  const requests = logs.map(line => JSON.parse(line)).filter(row => row.req);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(row => row.req.url === "/v1/replays/download-batch")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain("private-query-sentinel");
}

test.each([
  ["malformed", 400, "invalid_replay_download_batch"], ["oversized", 413, "replay_download_body_too_large"],
  ["encoding", 415, "replay_download_unsupported_media_type"], ["charset", 415, "replay_download_unsupported_media_type"],
])("actual app chain makes %s parser failures private before logging/SDK handling", async (mode, status, code) => {
  const { app, prepare, logs } = fixture(5000, "info"), capture = jest.spyOn(sentry, "captureException");
  let operation = authorized(request(app).post("/v1/replays/download-batch" + ignoredQuery)).set("content-type", "application/json");
  let body = '{"gameIds":["private-parser-sentinel"]}';
  if (mode === "malformed") body = body.slice(0, -1);
  if (mode === "oversized") body = JSON.stringify({ gameIds: ["private-parser-sentinel" + "x".repeat(BODY_BYTES)] });
  if (mode === "encoding") operation = operation.set("content-encoding", "unsupported-fixture-encoding");
  if (mode === "charset") operation = operation.set("content-type", "application/json; charset=iso-8859-1");
  const response = await operation.send(body);
  expect(response.status).toBe(status); expect(response.body).toEqual({ error: { code } });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.text + JSON.stringify(logs)).not.toContain("private-parser-sentinel");
  expectPrivateLogUrl(logs);
  expect(prepare).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
});

test.each([undefined, "private-bad-token"])("actual auth failures preserve no-store and fixed error fields", async token => {
  const { app, prepare, logs } = fixture(5000, "info");
  let operation = request(app).post("/V1/Replays/Download-Batch/" + ignoredQuery);
  if (token) operation = operation.set("authorization", `Bearer ${token}`);
  const response = await operation.send({ gameIds: ["private-auth-selection"] });
  expect(response.status).toBe(401); expect(response.body).toEqual({ error: { code: token ? "auth_failed" : "missing_token" } });
  expect(response.headers["cache-control"]).toBe("private, no-store"); expect(prepare).not.toHaveBeenCalled();
  expect(response.text + JSON.stringify(logs)).not.toMatch(/private-auth-selection|private-bad-token|private-token-detail/);
  expectPrivateLogUrl(logs);
});

test("actual wrapped auth rejects invalid selections without storage reads/signing/quota or _dataMutations leases", async () => {
  // Established fixture, before spies: first-touch signup has its own existing authentication lease.
  await db.users.deleteMany({ clerkUserId: "synthetic-clerk-owner" });
  await db.users.insertOne({ userId: "11111111-2222-4333-8444-555555555555", clerkUserId: "synthetic-clerk-owner", createdAt: new Date(), lastSeenAt: new Date() });
  const { app, prepare } = fixture(), writes = jest.spyOn(db.users, "updateOne"), reads = jest.spyOn(db.games, "findOne");
  const response = await authorized(request(app).post("/v1/replays/download-batch")).send({ gameIds: ["one", " one "] });
  expect(response.status).toBe(400); expect(prepare).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
  expect(JSON.stringify(writes.mock.calls)).not.toContain("_dataMutations");
  // This proves no download/write-admission lease for an established owner; signup behavior is separate.
  const user = await db.users.findOne({ clerkUserId: "synthetic-clerk-owner" });
  expect(user).not.toBeNull(); expect(user._dataMutations).toBeUndefined();
});

test("rate limiting before parsing retains the batch private no-store policy and does not echo the body", async () => {
  const { app, prepare, logs } = fixture(1, "info");
  const first = await authorized(request(app).post("/v1/replays/download-batch" + ignoredQuery)).send({ gameIds: ["one"] });
  expect(first.status).toBe(200);
  const response = await authorized(request(app).post("/v1/replays/download-batch" + ignoredQuery)).send({ gameIds: ["private-rate-sentinel"] });
  expect(response.status).toBe(429); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(prepare).toHaveBeenCalledTimes(1); expect(response.text + JSON.stringify(logs)).not.toContain("private-rate-sentinel");
  expectPrivateLogUrl(logs);
});

test("factored app integration preserves actual build-order service dependencies and both export routes", async () => {
  const { app, services } = fixture();
  expect(services.buildOrderExport.gameDetails).toBe(services.gameDetails);
  const csv = await authorized(request(app).get("/v1/export/build-orders.csv"));
  expect(csv.status).toBe(200); expect(csv.text).toContain("gameId,side,time,supply,name"); expect(csv.headers["x-export-has-more"]).toBe("false");
  const ndjson = await authorized(request(app).get("/v1/export/build-orders.ndjson"));
  expect(ndjson.status).toBe(200);
  const lines = ndjson.text.trim().split("\n").map(line => JSON.parse(line));
  expect(lines[0]).toMatchObject({ type: "metadata", format: "sc2tools-build-order-export", version: 1, games: 0 });
  expect(lines.at(-1)).toMatchObject({ type: "complete", games: 0, events: 0, continuation: null });
});
