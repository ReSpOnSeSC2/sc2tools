// @ts-nocheck
"use strict";

const { EventEmitter } = require("events");
const express = require("express");
const supertest = require("supertest");
const { ObjectId } = require("mongodb");
const { buildOrderExportHandler, buildBuildOrderExportRouter } = require("../src/routes/buildOrderExport");
const { accountExportHandler } = require("../src/routes/accountExport");
const { BuildOrderExportService } = require("../src/services/buildOrderExport");
const { prepareBuildOrderRequest } = require("../src/services/buildOrderExportPolicy");
const { loadConfig } = require("../src/config/loader");
const { redactSearchQuery, isSearchQueryUrl, requestCarriesSearchQuery, REPLAY_SEARCH_COMMENT } = require("../src/middleware/searchQueryPrivacy");
const { sanitiseRequestUrl } = require("../src/middleware/requestLogging");

const tick = () => new Promise(resolve => setImmediate(resolve));
function request(query = {}, owner = "A") { return Object.assign(new EventEmitter(), { query, auth: { userId: owner }, aborted: false }); }
function response() {
  const res = Object.assign(new EventEmitter(), { headers: {}, chunks: [], statusCode: 200, destroyed: false, writableEnded: false, headersSent: false,
    vary(name) { this.headers.vary = name; },
    setHeader(key, value) { this.headers[key] = value; }, removeHeader(key) { delete this.headers[key]; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.end(); },
    write(chunk) { this.headersSent = true; this.chunks.push(String(chunk)); return true; },
    end() { this.ended = true; this.writableEnded = true; this.emit("finish"); },
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  res.on("error", () => {}); return res;
}
function makeService(rows = [], pepper = Buffer.alloc(32, 0x33)) {
  const users = { findOneAndUpdate: jest.fn(async () => ({ _id: "A" })) };
  const cursors = [];
  const games = { find: jest.fn((_filter, options) => {
    const cursor = { sort: () => cursor, limit: () => cursor, batchSize: () => cursor, close: jest.fn(async () => {}),
      async *[Symbol.asyncIterator]() { for (const row of rows) { options.signal.throwIfAborted(); yield row; } } };
    cursors.push(cursor); return cursor;
  }) };
  const gameDetails = { findMany: jest.fn(async (_owner, ids) => new Map([[ids[0], { buildLog: ["[0:01] Worker"], oppBuildLog: [] }]])) };
  const service = new BuildOrderExportService({ games, users }, { gameDetails, pepper });
  return { service, users, games, cursors, gameDetails };
}
const game = () => ({ _id: new ObjectId(), gameId: "one", date: new Date("2026-01-01") });

test("actual loadConfig Buffer pepper admits both real routes and caller mutation cannot retarget signing", async () => {
  const config = loadConfig({ NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1:27017/synthetic-not-connected",
    CLERK_SECRET_KEY: "sk_test_synthetic", SERVER_PEPPER_HEX: "44".repeat(32) });
  expect(Buffer.isBuffer(config.serverPepper)).toBe(true); expect(config.serverPepper).toHaveLength(32);
  const original = Buffer.from(config.serverPepper);
  const { service, users, games } = makeService([game()], config.serverPepper);
  config.serverPepper.fill(0xee);
  const app = express(); app.use("/v1", buildBuildOrderExportRouter({ buildOrderExport: service,
    auth: (req, _res, next) => { req.auth = { userId: "A" }; next(); } }));
  const csv = await supertest(app).get("/v1/export/build-orders.csv");
  expect(csv.status).toBe(200); expect(csv.text).toBe("\uFEFFgameId,side,time,supply,name\r\none,me,1,,Worker\r\n");
  const ndjson = await supertest(app).get("/v1/export/build-orders.ndjson");
  expect(ndjson.status).toBe(200);
  const rows = ndjson.text.trim().split("\n").map(JSON.parse);
  expect(rows[1]).toEqual({ gameId: "one", side: "me", time: 1, supply: null, name: "Worker" });
  expect(rows.at(-1)).toEqual({ type: "complete", games: 1, events: 1, continuation: null });
  expect(users.findOneAndUpdate).toHaveBeenCalledTimes(2); expect(games.find).toHaveBeenCalledTimes(2);
  const position = game(), token = service.request("A", {}, "ndjson").next(position);
  expect(prepareBuildOrderRequest("A", { continuation_token: token }, "ndjson", original).position.id).toEqual(position._id);
  expect(() => prepareBuildOrderRequest("A", { continuation_token: token }, "ndjson", config.serverPepper)).toThrow("invalid_export_cursor");
});

test.each([undefined, "synthetic-string", Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32)])("malformed production pepper fails closed before reads: %#", pepper => {
  expect(() => new BuildOrderExportService({ games: {}, users: {} }, { gameDetails: {}, pepper })).toThrow("export_unavailable");
});

test("authenticated route formats produce private five-field streams and require auth", async () => {
  const { service } = makeService([game()]);
  const app = express(); app.use("/v1", buildBuildOrderExportRouter({ buildOrderExport: service, auth: (req, _res, next) => { req.auth = { userId: "A" }; next(); } }));
  const ndjson = await supertest(app).get("/v1/export/build-orders.ndjson");
  expect(ndjson.status).toBe(200); expect(ndjson.headers["cache-control"]).toBe("private, no-store");
  expect(ndjson.headers["content-disposition"]).toMatch(/sc2tools-build-orders-\d+\.ndjson/);
  expect(ndjson.text.trim().split("\n").map(JSON.parse)).toEqual([
    { type: "metadata", format: "sc2tools-build-order-export", version: 1, fields: ["gameId", "side", "time", "supply", "name"], games: 1 },
    { gameId: "one", side: "me", time: 1, supply: null, name: "Worker" },
    { type: "complete", games: 1, events: 1, continuation: null },
  ]);
  const csv = await supertest(app).get("/v1/export/build-orders.csv");
  expect(csv.text).toBe("\uFEFFgameId,side,time,supply,name\r\none,me,1,,Worker\r\n");
  const denied = response(); await buildOrderExportHandler(service, "csv")(request({}, null), denied);
  expect(denied.statusCode).toBe(401);
});

test("new NDJSON route sends exact supply only to the supported Accept profile; CSV includes it by default", async () => {
  const { service, gameDetails } = makeService([game()]);
  gameDetails.findMany.mockResolvedValue(new Map([["one", {
    buildLog: ["[0:01] Worker"], oppBuildLog: ["[0:01] Opponent worker"], buildLogSupply: [13.5],
  }]]));
  const app = express(); app.use("/v1", buildBuildOrderExportRouter({ buildOrderExport: service,
    auth: (req, _res, next) => { req.auth = { userId: "A" }; next(); } }));
  for (const accept of [undefined, "application/x-ndjson", "application/x-ndjson; profile=unknown"]) {
    const req = supertest(app).get("/v1/export/build-orders.ndjson");
    if (accept) req.set("Accept", accept);
    const legacy = await req.expect(200);
    expect(legacy.headers.vary).toContain("Accept");
    expect(legacy.text.trim().split("\n").map(JSON.parse).slice(1, -1).map(row => row.supply)).toEqual([null, null]);
  }
  const exact = await supertest(app).get("/v1/export/build-orders.ndjson")
    .set("Accept", "application/x-ndjson; profile=exact-supply").expect(200);
  expect(exact.headers.vary).toContain("Accept");
  expect(exact.text.trim().split("\n").map(JSON.parse).slice(1, -1).map(row => row.supply)).toEqual([13.5, null]);
  const csv = await supertest(app).get("/v1/export/build-orders.csv").expect(200);
  expect(csv.text).toBe("\uFEFFgameId,side,time,supply,name\r\none,me,1,13.5,Worker\r\none,opponent,1,,Opponent worker\r\n");
});

test("invalid filters and foreign/tampered/expired cursors do not charge or read", async () => {
  const { service, users, games, gameDetails } = makeService();
  const token = service.request("A", {}, "ndjson").next(game());
  for (const [owner, query] of [["B", { continuation_token: token }], ["A", { continuation_token: token + "x" }], ["A", { search: {} }], ["A", { map_exact: "[]" }]]) {
    const res = response(); await buildOrderExportHandler(service, "ndjson")(request(query, owner), res);
    expect(res.statusCode).toBe(400); expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(JSON.stringify(res.body)).not.toContain(token);
  }
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 24 * 60 * 60 * 1000 + 1000;
    const res = response(); await buildOrderExportHandler(service, "ndjson")(request({ continuation_token: token }), res);
    expect(res.statusCode).toBe(410); expect(res.body).toEqual({ error: { code: "export_cursor_expired" } });
  } finally { Date.now = originalNow; }
  expect(users.findOneAndUpdate).not.toHaveBeenCalled(); expect(games.find).not.toHaveBeenCalled(); expect(gameDetails.findMany).not.toHaveBeenCalled();
});

test("build backpressure shares the exact account-export slot across handlers and owners", async () => {
  const first = makeService([game()]), other = makeService(), req = request(), res = response();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const write = res.write; res.write = function(chunk) { write.call(this, chunk); entered(); return false; };
  const work = buildOrderExportHandler(first.service, "ndjson")(req, res);
  const gdpr = { export: jest.fn(async () => ({ userId: "B" })), exportStream: jest.fn() };
  try {
    await Promise.race([started, work.then(() => { throw Error("stream did not enter backpressure"); })]);
    req.auth = { userId: "B" };
    const account = response(); await accountExportHandler(gdpr)(request({}, "B"), account, jest.fn());
    expect(account.body).toEqual({ error: { code: "export_busy" } }); expect(gdpr.export).not.toHaveBeenCalled();
    const rejected = response(); await buildOrderExportHandler(other.service, "csv")(request({}, "C"), rejected);
    expect(rejected.statusCode).toBe(503); expect(other.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(other.games.find).not.toHaveBeenCalled();
    expect(first.gameDetails.findMany).not.toHaveBeenCalled();
    res.write = write; res.emit("drain"); await work;
    expect(first.gameDetails.findMany.mock.calls[0][0]).toBe("A");
    expect(res.chunks.join("")).toContain('"type":"complete"');
  } finally { res.destroy(); res.emit("drain"); await work; }
});

test("closed held account JSON work keeps B uncharged, and old terminal callbacks cannot free a later B lease", async () => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const gdpr = { export: jest.fn(() => { entered(); return new Promise(resolve => { release = resolve; }); }) };
  const old = response(), oldWork = accountExportHandler(gdpr)(request(), old, jest.fn());
  const other = makeService(); let nextWork, nextResponse;
  try {
    await Promise.race([started, oldWork.then(() => { throw Error("JSON did not enter actual work"); })]);
    const late = ["finish", "close", "error"].flatMap(name => old.listeners(name).map(callback => [name, callback]));
    old.destroy();
    const denied = response(); await buildOrderExportHandler(other.service, "ndjson")(request({}, "B"), denied);
    expect(denied.statusCode).toBe(503); expect(other.users.findOneAndUpdate).not.toHaveBeenCalled();
    release({ private: "late JSON must be dropped" }); await oldWork; expect(old.body).toBeUndefined();
    nextResponse = response(); let ready;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    const write = nextResponse.write; nextResponse.write = function(chunk) { write.call(this, chunk); ready(); return false; };
    nextWork = buildOrderExportHandler(other.service, "ndjson")(request({}, "B"), nextResponse);
    await Promise.race([readyPromise, nextWork.then(() => { throw Error("B did not start actual stream"); })]);
    for (const [name, callback] of late) callback(name === "error" ? Error("late private error") : undefined);
    const third = makeService(), thirdResponse = response();
    await buildOrderExportHandler(third.service, "csv")(request({}, "C"), thirdResponse);
    expect(thirdResponse.body).toEqual({ error: { code: "export_busy" } }); expect(third.users.findOneAndUpdate).not.toHaveBeenCalled();
    nextResponse.write = write; nextResponse.emit("drain"); await nextWork;
  } finally { release?.({}); old.destroy(); await oldWork; nextResponse?.destroy(); nextResponse?.emit("drain"); await nextWork; }
});

test.each(["close", "finish", "error"])("B retains the shared slot during held metadata cleanup after %s", async terminal => {
  const first = makeService([game()]), second = makeService();
  let cleanup, releaseRead, entered, releaseCleanup, readSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const cleaning = new Promise(resolve => { cleanup = resolve; });
  first.games.find = jest.fn((_match, opts) => {
    readSignal = opts.signal;
    const cursor = { sort: () => cursor, limit: () => cursor, batchSize: () => cursor,
      async *[Symbol.asyncIterator]() { entered(); await new Promise(resolve => { releaseRead = resolve; }); opts.signal.throwIfAborted(); yield game(); },
      close: jest.fn(() => { cleanup(); return new Promise(resolve => { releaseCleanup = resolve; }); }),
    }; return cursor;
  });
  const res = response(), work = buildOrderExportHandler(first.service, "ndjson")(request(), res);
  try {
    await Promise.race([started, work.then(() => { throw Error("metadata read did not start"); })]);
    res.emit(terminal, terminal === "error" ? Error("private transport URL") : undefined);
    expect(readSignal.aborted).toBe(true);
    releaseRead(); await Promise.race([cleaning, work.then(() => { throw Error("cleanup was not awaited"); })]);
    const rejected = response(); await buildOrderExportHandler(second.service, "csv")(request({}, "B"), rejected);
    expect(rejected.body).toEqual({ error: { code: "export_busy" } }); expect(second.users.findOneAndUpdate).not.toHaveBeenCalled();
    releaseCleanup(); await work;
    expect(res.chunks.join("")).not.toContain('"type":"complete"'); expect(res.ended).not.toBe(true);
    const fresh = response(); await buildOrderExportHandler(second.service, "csv")(request({}, "B"), fresh);
    expect(fresh.statusCode).toBe(200); expect(fresh.ended).toBe(true);
  } finally { res.destroy(); releaseRead?.(); releaseCleanup?.(); await work; }
});

test("an admitted quota command settles after disconnect without retry, metadata, writes or early release", async () => {
  const first = makeService(), other = makeService(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  first.users.findOneAndUpdate.mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const res = response(), work = buildOrderExportHandler(first.service, "csv")(request(), res);
  try {
    await Promise.race([started, work.then(() => { throw Error("quota was not entered"); })]);
    res.destroy();
    const busy = response(); await buildOrderExportHandler(other.service, "csv")(request({}, "B"), busy);
    expect(busy.statusCode).toBe(503); expect(other.users.findOneAndUpdate).not.toHaveBeenCalled();
    release({ _id: "charged" }); await work;
    expect(first.users.findOneAndUpdate).toHaveBeenCalledTimes(1); expect(first.games.find).not.toHaveBeenCalled(); expect(res.chunks).toEqual([]);
  } finally { res.destroy(); release?.({ _id: "charged" }); await work; }
});

test("closed B detail work retains the same slot until all four actual readers settle", async () => {
  const first = makeService(Array.from({ length: 4 }, game)), other = makeService();
  const controls = []; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  first.gameDetails.findMany.mockImplementation((_owner, ids, opts) => new Promise(resolve => {
    controls.push({ signal: opts.signal, release: () => resolve(new Map([[ids[0], { buildLog: [], oppBuildLog: [] }]])) });
    if (controls.length === 4) entered();
  }));
  const res = response(), work = buildOrderExportHandler(first.service, "ndjson")(request(), res);
  try {
    await Promise.race([started, work.then(() => { throw Error("four owned readers did not enter"); })]);
    res.destroy(); expect(controls.every(control => control.signal.aborted)).toBe(true);
    controls.slice(0, 3).forEach(control => control.release()); await tick();
    const busy = response(); await buildOrderExportHandler(other.service, "csv")(request({}, "B"), busy);
    expect(busy.body).toEqual({ error: { code: "export_busy" } }); expect(other.users.findOneAndUpdate).not.toHaveBeenCalled();
    controls[3].release(); await work;
    expect(res.chunks.join("")).not.toContain('"type":"complete"');
    const fresh = response(); await buildOrderExportHandler(other.service, "csv")(request({}, "B"), fresh);
    expect(fresh.statusCode).toBe(200); expect(fresh.ended).toBe(true);
  } finally { res.destroy(); controls.forEach(control => control.release()); await work; }
});

test("quota denial and unknown acknowledgement expose fixed errors without admitting metadata", async () => {
  for (const outcome of ["denied", "unknown-ack"]) {
    const { service, users, games } = makeService();
    users.findOneAndUpdate.mockImplementation(async () => { if (outcome === "unknown-ack") throw Error("mongodb://private:secret@host"); return null; });
    const res = response(); await buildOrderExportHandler(service, "ndjson")(request(), res);
    expect(res.statusCode).toBe(outcome === "denied" ? 429 : 503);
    expect(res.body).toEqual({ error: { code: outcome === "denied" ? "export_rate_limited" : "export_unavailable" } });
    expect(res.headers["content-disposition"]).toBeUndefined(); expect(games.find).not.toHaveBeenCalled();
    expect(users.findOneAndUpdate).toHaveBeenCalledTimes(1); expect(JSON.stringify(res)).not.toContain("mongodb://");
    if (outcome === "denied") expect(res.headers["retry-after"]).toBe("3600");
  }
});

test.each(["csv", "ndjson"])("late detail failure cannot end a successful %s stream or leak the provider error", async format => {
  const { service, gameDetails } = makeService([game()]);
  gameDetails.findMany.mockRejectedValue(Error("https://private-storage/token=secret"));
  const res = response(); await buildOrderExportHandler(service, format)(request(), res);
  expect(res.destroyed).toBe(true); expect(res.ended).not.toBe(true);
  expect(res.chunks.join("")).not.toMatch(/complete|private-storage|token=secret/);
});

test("both search routes redact repeated/bracketed query values and register telemetry and Mongo comments", async () => {
  for (const format of ["csv", "ndjson"]) {
    const path = `/v1/export/build-orders.${format}`;
    const url = new URL(`${path}?search=secret&search[]=secret2&[search]=secret3&continuation_token=signed-private`, "https://request.invalid");
    expect(redactSearchQuery(url)).toBe(true); expect(url.search).not.toMatch(/secret[23]?/);
    expect(isSearchQueryUrl(`${path}?search=secret`)).toBe(true);
    expect(requestCarriesSearchQuery(path, { "search[0]": "secret" })).toBe(true);
    expect(sanitiseRequestUrl(`${path}?search=secret&continuation_token=signed-private`)).not.toMatch(/secret|signed-private/);
    const { service, games } = makeService();
    const res = response(); await buildOrderExportHandler(service, format)(request({ search: "secret" }), res);
    expect(games.find.mock.calls[0][1].comment).toBe(REPLAY_SEARCH_COMMENT);
  }
});
