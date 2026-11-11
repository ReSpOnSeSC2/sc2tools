// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest"), { EventEmitter } = require("events");
const { buildReplayFilesRouter } = require("../src/routes/replayFiles");
const { downloadBatchHandler } = require("../src/routes/replayDownloadBatch");
const { accountExportHandler } = require("../src/routes/accountExport");
const { buildOrderExportHandler } = require("../src/routes/buildOrderExport");
const { withUserDataWriteFence } = require("../src/middleware/userDataWriteFence");
const { replayDownloadBatchNoStore, buildReplayDownloadBatchJsonParser, replayDownloadBatchErrorBoundary } = require("../src/middleware/replayDownloadBatchBoundary");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function req(owner = "owner-a", body = { gameIds: ["one"] }) { return Object.assign(new EventEmitter(), { body, auth: { userId: owner }, aborted: false, query: {} }); }
function res() {
  const result = Object.assign(new EventEmitter(), { headers: {}, destroyed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, status(code) { this.statusCode = code; return this; },
    vary(name) { this.setHeader("vary", name); },
    json(body) { this.body = body; this.writableEnded = true; this.emit("finish"); },
    destroy() { this.destroyed = true; this.emit("close"); } });
  result.on("error", () => {}); return result;
}
function app(store, users = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) }) {
  const server = express();
  server.use(replayDownloadBatchNoStore, buildReplayDownloadBatchJsonParser(), express.json({ limit: "256kb" }));
  const auth = withUserDataWriteFence((req, _res, next) => { req.auth = { userId: "owner-a", source: "clerk" }; next(); }, users);
  server.use("/v1", buildReplayFilesRouter({ replayFiles: store, auth }));
  server.post("/v1/ordinary-write", auth, (_req, res) => res.json({ ok: true }));
  server.use(replayDownloadBatchErrorBoundary);
  return server;
}

test.each([
  {}, { gameIds: [] }, { gameIds: Array.from({ length: 101 }, () => "one") }, { gameIds: ["one", " one "] },
  { gameIds: ["one"], owner: "other" }, { gameIds: ["https://private.test/signed?signature=secret"] },
  { gameIds: ["\ud800"] }, { gameIds: [1] }, { gameIds: ["one\n"] },
])("invalid raw selection performs no storage/signing/quota/user-data lease IO: %j", async body => {
  const store = { prepareDownloadBatch: jest.fn() }, users = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
  const response = await request(app(store, users)).post("/v1/replays/download-batch").send(body);
  expect(response.status).toBe(400); expect(response.body).toEqual({ error: { code: "invalid_replay_download_batch" } });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(store.prepareDownloadBatch).not.toHaveBeenCalled(); expect(users.updateOne).not.toHaveBeenCalled();
});

test("exact batch POST exemption creates no user-data lease, while unrelated POST still claims and releases one", async () => {
  const users = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
  const store = { prepareDownloadBatch: jest.fn(async () => ({ format: "fixture", items: [] })), prepareUpload: jest.fn(async () => ({ alreadyStored: true })) };
  const server = app(store, users);
  const response = await request(server).post("/V1/Replays/Download-Batch/").send({ gameIds: ["one"] });
  expect(response.status).toBe(200); expect(users.updateOne).not.toHaveBeenCalled();
  expect(store.prepareDownloadBatch).toHaveBeenCalledWith("owner-a", ["one"], { signal: expect.any(AbortSignal) });
  await request(server).post("/v1/ordinary-write").send({}); await tick();
  expect(users.updateOne).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(users.updateOne.mock.calls)).toContain("_dataMutations");
  const upload = await request(server).post("/v1/games/one/replay-upload").send({ filename: "fixture.SC2Replay", sizeBytes: 8, sha256: "a".repeat(64), md5: "AAAAAAAAAAAAAAAAAAAAAA==" });
  expect(upload.status).toBe(200); await tick();
  expect(users.updateOne).toHaveBeenCalledTimes(4); expect(store.prepareUpload).toHaveBeenCalledTimes(1);
});

test("101 unique raw IDs reach no replay storage/signing or user-data admission lease", async () => {
  const store = { prepareDownloadBatch: jest.fn() }, users = { updateOne: jest.fn() };
  const response = await request(app(store, users)).post("/v1/replays/download-batch").send({ gameIds: Array.from({ length: 101 }, (_, index) => `unique-${index}`) });
  expect(response.status).toBe(400); expect(response.body).toEqual({ error: { code: "invalid_replay_download_batch" } });
  expect(store.prepareDownloadBatch).not.toHaveBeenCalled(); expect(users.updateOne).not.toHaveBeenCalled();
});

test("batch busy is shared with account JSON before reads and releases only after work AND response terminal", async () => {
  const held = deferred(), first = res(), before = req(), seen = jest.fn(() => held.promise);
  const work = downloadBatchHandler({ prepareDownloadBatch: seen })(before, first);
  try {
    await tick(); before.auth.userId = "owner-b";
    const gdpr = { export: jest.fn() }, blocked = res();
    await accountExportHandler(gdpr)(req("owner-b"), blocked, jest.fn());
    expect(blocked.body).toEqual({ error: { code: "export_busy" } }); expect(gdpr.export).not.toHaveBeenCalled();
    for (const format of ["csv", "ndjson"]) {
      const builds = { request: jest.fn(() => ({})), prepare: jest.fn() }, buildResponse = res();
      await buildOrderExportHandler(builds, format)(req("owner-b"), buildResponse);
      expect(buildResponse.headers.vary).toBe(format === "ndjson" ? "Accept" : undefined);
      expect(buildResponse.body).toEqual({ error: { code: "export_busy" } }); expect(builds.prepare).not.toHaveBeenCalled();
    }
    expect(seen.mock.calls[0][0]).toBe("owner-a");
    held.resolve({ format: "fixture", items: [] }); await work;
    const fresh = res(); await accountExportHandler({ export: async () => ({ legacy: true }) })(req(), fresh, jest.fn());
    expect(fresh.body).toEqual({ legacy: true });
  } finally { first.destroy(); held.resolve({ items: [] }); await work; }
});

test("closing HTTP never frees the shared lease while an actual batch signer/cleanup is held", async () => {
  const held = deferred(), first = res(), captured = [];
  const batch = { prepareDownloadBatch: jest.fn(async (_owner, _ids, options) => { captured.push(options.signal); await held.promise; return { items: [] }; }) };
  const work = downloadBatchHandler(batch)(req(), first);
  try {
    await tick(); first.destroy(); await tick(); expect(captured[0].aborted).toBe(true);
    const blocked = res(), another = { prepareDownloadBatch: jest.fn() };
    await downloadBatchHandler(another)(req("owner-b"), blocked);
    expect(blocked.body).toEqual({ error: { code: "export_busy" } }); expect(another.prepareDownloadBatch).not.toHaveBeenCalled();
    held.resolve(); await work; expect(first.body).toBeUndefined();
    const fresh = res(); await downloadBatchHandler({ prepareDownloadBatch: async () => ({ fresh: true }) })(req(), fresh);
    expect(fresh.body).toEqual({ fresh: true });
    expect(first.listenerCount("close")).toBe(0);
  } finally { first.destroy(); held.resolve(); await work; }
});

test("an account-held lease makes wrapped-auth batch busy without selection reads or a write lease", async () => {
  const held = deferred(), first = res();
  const work = accountExportHandler({ export: () => held.promise })(req(), first, jest.fn());
  try {
    await tick();
    const users = { updateOne: jest.fn() }, store = { prepareDownloadBatch: jest.fn() };
    const response = await request(app(store, users)).post("/v1/replays/download-batch").send({ gameIds: ["one"] });
    expect(response.status).toBe(503); expect(response.body).toEqual({ error: { code: "export_busy" } });
    expect(users.updateOne).not.toHaveBeenCalled(); expect(store.prepareDownloadBatch).not.toHaveBeenCalled();
  } finally { first.destroy(); held.resolve({}); await work; }
});

test("batch transport/private service failures expose only a fixed response", async () => {
  const store = { prepareDownloadBatch: jest.fn(async () => { throw new Error("private-owner https://private.test?signature=secret"); }) };
  const response = await request(app(store)).post("/v1/replays/download-batch").send({ gameIds: ["one"] });
  expect(response.status).toBe(503); expect(response.body).toEqual({ error: { code: "replay_download_unavailable" } });
  expect(response.text).not.toContain("secret"); expect(response.headers["cache-control"]).toBe("private, no-store");
});

test("work settlement alone cannot release the reservation before HTTP actually terminates", async () => {
  const first = res(); first.json = function (body) { this.body = body; };
  await downloadBatchHandler({ prepareDownloadBatch: async () => ({ items: [] }) })(req(), first);
  try {
    const next = res(), called = jest.fn();
    await downloadBatchHandler({ prepareDownloadBatch: called })(req(), next);
    expect(next.body).toEqual({ error: { code: "export_busy" } }); expect(called).not.toHaveBeenCalled();
  } finally { first.emit("finish"); }
  const fresh = res(); await downloadBatchHandler({ prepareDownloadBatch: async () => ({ available: true }) })(req(), fresh);
  expect(fresh.body).toEqual({ available: true });
});

test("deadline aborts admissions but still waits for an actual non-cancellable signer", async () => {
  jest.useFakeTimers();
  const held = deferred(), first = res(); let signal, settled = false;
  const work = downloadBatchHandler({ prepareDownloadBatch: async (_owner, _ids, options) => { signal = options.signal; await held.promise; return { items: [] }; } })(req(), first).then(() => { settled = true; });
  try {
    jest.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(true); expect(settled).toBe(false); expect(first.body).toBeUndefined();
    const next = res(); await downloadBatchHandler({ prepareDownloadBatch: jest.fn() })(req(), next);
    expect(next.body).toEqual({ error: { code: "export_busy" } });
    held.resolve(); await work;
    expect(first.body).toEqual({ error: { code: "replay_download_unavailable" } });
  } finally { held.resolve(); await work; first.destroy(); jest.useRealTimers(); }
});
