// @ts-nocheck
"use strict";

const { EventEmitter } = require("events");
const { accountExportHandler } = require("../src/routes/accountExport");
const { accountExportStream } = require("../src/services/accountExportStream");

function request(query = {}, owner = "A") {
  return Object.assign(new EventEmitter(), { query, auth: { userId: owner }, aborted: false });
}
function response() {
  // A real ServerResponse emits finish after end, and error has a transport
  // listener even when export listeners are gone. Tests may hold finish apart.
  const res = Object.assign(new EventEmitter(), {
    headers: {}, chunks: [], statusCode: 200, destroyed: false, headersSent: false, writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    removeHeader(name) { delete this.headers[name]; },
    status(code) { this.statusCode = code; return this; },
    write(chunk) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); return true; },
    json(data) { this.body = data; this.end(); },
    end() { this.ended = true; this.writableEnded = true; this.emit("finish"); },
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  res.on("error", () => {});
  return res;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const decoded = res => res.chunks.map(chunk => JSON.parse(chunk));

test("default and explicit JSON retain legacy shape and never admit NDJSON work", async () => {
  const archive = { userId: "A", exportedAt: "stamp", user: null, data: { games: [] } };
  const gdpr = { export: jest.fn(async () => archive), exportStream: jest.fn() };
  for (const query of [{}, { format: "json" }]) {
    const res = response(), next = jest.fn(); await accountExportHandler(gdpr)(request(query), res, next);
    expect(res.body).toBe(archive); expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/sc2tools-export-\d+\.json/);
    expect(res.headers["cache-control"]).toBe("private, no-store"); expect(next).not.toHaveBeenCalled();
  }
  expect(gdpr.exportStream).not.toHaveBeenCalled();
});

test.each([
  { format: ["ndjson", "json"] }, { format: {} }, { format: "backup" },
  { format: "ndjson", details: ["1"] }, { format: "ndjson", details: "yes" }, { details: "1" },
])("invalid export options do not admit any data reads: %j", async query => {
  const gdpr = { export: jest.fn(), exportStream: jest.fn() }, res = response();
  await accountExportHandler(gdpr)(request(query), res, jest.fn());
  expect(res.statusCode).toBe(400); expect(res.body).toEqual({ error: { code: "invalid_export_options" } });
  expect(gdpr.export).not.toHaveBeenCalled(); expect(gdpr.exportStream).not.toHaveBeenCalled();
});

test("actual output bytes have distinct metadata/complete and NDJSON attachment privacy headers", async () => {
  const gdpr = { exportStream: (owner, options) => accountExportStream(emptyDb(), null, owner, options) };
  const res = response(); await accountExportHandler(gdpr)(request({ format: "ndjson", details: "0" }), res, jest.fn());
  const bytes = Buffer.concat(res.chunks).toString("utf8");
  expect(bytes.endsWith("\n")).toBe(true);
  expect(decoded(res)).toEqual([
    expect.objectContaining({ type: "metadata", format: "sc2tools-account-export", version: 1, userId: "A", details: false }),
    { type: "user", row: null }, { type: "complete", counts: {} },
  ]);
  expect(res.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
  expect(res.headers["content-disposition"]).toMatch(/sc2tools-account-export-\d+\.ndjson/);
  expect(res.headers["cache-control"]).toBe("private, no-store"); expect(res.ended).toBe(true);
});

function emptyDb() {
  return { users: { find: () => ({ close: async () => {}, async *[Symbol.asyncIterator]() {} }) } };
}

test("backpressure prevents next row admission; response close returns iterator and removes listeners", async () => {
  const req = request({ format: "ndjson" }), res = response();
  let reads = 0, closed = 0, capturedSignal;
  const gdpr = { async *exportStream(_owner, options) {
    capturedSignal = options.signal;
    try { reads += 1; yield Buffer.from('{"type":"metadata"}\n'); reads += 1; yield Buffer.from('{"type":"complete"}\n'); }
    finally { closed += 1; }
  } };
  res.write = function (chunk) { this.headersSent = true; this.chunks.push(chunk); return false; };
  const work = accountExportHandler(gdpr)(req, res, jest.fn()); await tick();
  expect(reads).toBe(1); expect(closed).toBe(0); expect(res.listenerCount("drain")).toBe(1);
  res.destroy(); await work;
  expect(reads).toBe(1); expect(closed).toBe(1); expect(capturedSignal.aborted).toBe(true);
  expect(decoded(res)).toEqual([{ type: "metadata" }]);
  expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("drain")).toBe(0); expect(res.listenerCount("close")).toBe(0);
});

test("drain resumes only one next chunk and complete is not written before capacity", async () => {
  const req = request({ format: "ndjson" }), res = response(); let reads = 0;
  const gdpr = { async *exportStream() { reads++; yield Buffer.from('{"type":"metadata"}\n'); reads++; yield Buffer.from('{"type":"complete"}\n'); } };
  const original = res.write; res.write = function (chunk) { original.call(this, chunk); return this.chunks.length > 1; };
  const work = accountExportHandler(gdpr)(req, res, jest.fn()); await tick();
  expect(reads).toBe(1); expect(res.ended).not.toBe(true);
  res.emit("drain"); await work;
  expect(reads).toBe(2); expect(decoded(res).at(-1)).toEqual({ type: "complete" }); expect(res.ended).toBe(true);
});

test("captured owner remains A across held next while mutable request authentication becomes B", async () => {
  const req = request({ format: "ndjson" }), res = response(); let release, signal;
  const held = new Promise(resolve => { release = resolve; });
  const queries = [], cursor = { close: jest.fn(async () => {}), async *[Symbol.asyncIterator]() { await held; yield { userId: "A", value: "owned-A" }; } };
  const db = { games: { find: (query, options) => { queries.push(query); signal = options.signal; return cursor; } }, ...emptyDb() };
  const work = accountExportHandler({ exportStream: (owner, options) => accountExportStream(db, null, owner, options) })(req, res, jest.fn());
  await tick(); req.auth.userId = "B"; release(); await work;
  expect(queries).toEqual([{ userId: "A" }]);
  expect(decoded(res).filter(row => row.type === "record")).toEqual([{ type: "record", collection: "games", row: { userId: "A", value: "owned-A" } }]);
  expect(cursor.close).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(true);
});

test.each(["aborted", "close"])("%s interrupts held DB next, awaits cursor cleanup and emits no success", async event => {
  const req = request({ format: "ndjson" }), res = response(); let signal, releaseCleanup;
  const cleanupHeld = new Promise(resolve => { releaseCleanup = resolve; });
  const cursor = { close: jest.fn(() => cleanupHeld), async *[Symbol.asyncIterator]() {
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("private-auth/bucket")), { once: true }));
  } };
  const db = { games: { find: (_query, options) => { signal = options.signal; return cursor; } }, ...emptyDb() };
  let settled = false;
  const work = accountExportHandler({ exportStream: (owner, options) => accountExportStream(db, null, owner, options) })(req, res, jest.fn()).then(() => { settled = true; });
  await tick(); if (event === "close") res.destroy(); else { req.aborted = true; req.emit("aborted"); res.destroy(); }
  await tick(); expect(cursor.close).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
  releaseCleanup(); await work;
  expect(signal.aborted).toBe(true); expect(decoded(res).some(row => row.type === "complete")).toBe(false);
  expect(Buffer.concat(res.chunks).toString()).not.toContain("private-auth"); expect(res.body).toBeUndefined();
});

test("started stream failure closes with no private error, success trailer or next error middleware", async () => {
  const res = response(), next = jest.fn();
  const gdpr = { async *exportStream() { yield Buffer.from('{"type":"metadata"}\n'); throw Error("https://private-bucket?token=secret"); } };
  await accountExportHandler(gdpr)(request({ format: "ndjson" }), res, next);
  expect(res.destroyed).toBe(true); expect(decoded(res)).toEqual([{ type: "metadata" }]);
  expect(next).not.toHaveBeenCalled(); expect(res.body).toBeUndefined();
});

test("close while an actual game row waits for drain admits no detail read or second game", async () => {
  const req = request({ format: "ndjson", details: "1" }), res = response(); let reads = 0;
  const cursor = { close: jest.fn(async () => {}), async *[Symbol.asyncIterator]() {
    reads++; yield { gameId: "one" }; reads++; yield { gameId: "two" };
  } };
  const details = { findMany: jest.fn() }, db = { games: { find: () => cursor }, ...emptyDb() };
  const original = res.write;
  res.write = function (chunk) { original.call(this, chunk); return JSON.parse(chunk).type !== "record"; };
  const work = accountExportHandler({ exportStream: (owner, options) => accountExportStream(db, details, owner, options) })(req, res, jest.fn());
  await tick(); expect(reads).toBe(1); expect(details.findMany).not.toHaveBeenCalled();
  res.destroy(); await work;
  expect(details.findMany).not.toHaveBeenCalled(); expect(reads).toBe(1); expect(cursor.close).toHaveBeenCalledTimes(1);
  expect(decoded(res).at(-1)).toMatchObject({ type: "record", collection: "games", row: { gameId: "one" } });
});

test("close cancels and settles actual optional detail read before cursor cleanup and handler return", async () => {
  const req = request({ format: "ndjson", details: "1" }), res = response(); let detailEntered, release, captured;
  const entered = new Promise(resolve => { detailEntered = resolve; });
  const heldCleanup = new Promise(resolve => { release = resolve; });
  const cursor = { close: jest.fn(async () => {}), async *[Symbol.asyncIterator]() { yield { gameId: "one" }; } };
  const details = { findMany: jest.fn(async (_owner, ids, options) => {
    captured = { ids, options };
    detailEntered();
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
    await heldCleanup; options.signal.throwIfAborted();
  }) };
  let settled = false;
  const work = accountExportHandler({ exportStream: (owner, options) => accountExportStream({ games: { find: () => cursor } }, details, owner, options) })(req, res, jest.fn()).then(() => { settled = true; });
  const completed = work.then(() => null, error => error);
  const other = { export: jest.fn(async () => ({ userId: "B", user: null, data: {} })) };
  try {
    expect(await Promise.race([entered.then(() => "entered"), completed.then(() => "settled")])).toBe("entered");
    expect(captured.ids).toEqual(["one"]); expect(captured.options.strict).toBe(true);
    res.destroy(); await tick();
    expect(settled).toBe(false); expect(cursor.close).not.toHaveBeenCalled();
    const blocked = response(); await accountExportHandler(other)(request({}, "B"), blocked, jest.fn());
    expect(blocked.statusCode).toBe(503); expect(blocked.body).toEqual({ error: { code: "export_busy" } });
    expect(other.export).not.toHaveBeenCalled();
  } finally { res.destroy(); release(); await completed; }
  expect(cursor.close).toHaveBeenCalledTimes(1); expect(decoded(res).some(row => row.type === "complete")).toBe(false);
  const fresh = response(); await accountExportHandler(other)(request({}, "B"), fresh, jest.fn());
  expect(fresh.body).toEqual({ userId: "B", user: null, data: {} }); expect(other.export).toHaveBeenCalledTimes(1);
});

test("pre-stream failure has a fixed public error only", async () => {
  const res = response();
  const gdpr = { async *exportStream() { throw Error("private-storage-key/token"); } };
  await accountExportHandler(gdpr)(request({ format: "ndjson" }), res, jest.fn());
  expect(res.statusCode).toBe(503); expect(res.body).toEqual({ error: { code: "export_unavailable" } });
  expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  expect(res.headers["content-disposition"]).toBeUndefined();
});

test("shared slot rejects another handler and owner before reads while output waits for drain", async () => {
  const first = response(), second = response();
  first.write = function (chunk) { this.headersSent = true; this.chunks.push(chunk); return false; };
  const held = accountExportHandler({ async *exportStream() { yield Buffer.from('{"type":"metadata"}\n'); } })(request({ format: "ndjson" }), first, jest.fn());
  const settled = held.then(() => null, error => error);
  const other = { export: jest.fn(async () => ({ userId: "B", data: {} })), exportStream: jest.fn() };
  try {
    await tick(); expect(decoded(first)).toEqual([{ type: "metadata" }]);
    await accountExportHandler(other)(request({}, "B"), second, jest.fn());
    expect(second.statusCode).toBe(503); expect(second.body).toEqual({ error: { code: "export_busy" } });
    expect(second.headers["cache-control"]).toBe("private, no-store");
    expect(other.export).not.toHaveBeenCalled(); expect(other.exportStream).not.toHaveBeenCalled();
  } finally { first.destroy(); await settled; }
});

test("closed export keeps shared slot until actual cursor cleanup settles and fresh output is admitted", async () => {
  const first = response(); let signal, entered, releaseCleanup;
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const cursor = { close: jest.fn(() => cleanup), async *[Symbol.asyncIterator]() {
    entered(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  } };
  const db = { games: { find: (_filter, options) => { signal = options.signal; return cursor; } } };
  const work = accountExportHandler({ exportStream: (owner, options) => accountExportStream(db, null, owner, options) })(request({ format: "ndjson" }), first, jest.fn());
  const settled = work.then(() => ({ done: true }), error => ({ error }));
  const archive = { userId: "B", user: null, data: { games: [] } };
  const other = { export: jest.fn(async () => archive), exportStream: jest.fn() };
  try {
    expect(await Promise.race([started.then(() => "entered"), settled.then(() => "settled")])).toBe("entered");
    first.destroy(); await tick();
    expect(cursor.close).toHaveBeenCalledTimes(1);
    const blocked = response(); await accountExportHandler(other)(request({}, "B"), blocked, jest.fn());
    expect(blocked.statusCode).toBe(503); expect(blocked.body).toEqual({ error: { code: "export_busy" } });
    expect(other.export).not.toHaveBeenCalled(); expect(other.exportStream).not.toHaveBeenCalled();
  } finally { first.destroy(); releaseCleanup(); await settled; }
  expect(decoded(first).some(row => row.type === "complete")).toBe(false);
  const fresh = response(); await accountExportHandler(other)(request({}, "B"), fresh, jest.fn());
  expect(fresh.statusCode).toBe(200); expect(fresh.body).toBe(archive); expect(other.export).toHaveBeenCalledTimes(1);
});

test.each(["finish", "error"])("NDJSON response %s aborts held read without close and retains the slot through actual cleanup", async terminal => {
  const first = response(); let signal, entered, rejectRead, releaseCleanup, closeEvents = 0;
  first.on("close", () => { closeEvents++; });
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const cursor = { close: jest.fn(() => cleanup), async *[Symbol.asyncIterator]() {
    entered();
    try {
      await new Promise((_resolve, reject) => {
        rejectRead = () => reject(Error("aborted"));
        signal.addEventListener("abort", rejectRead, { once: true });
        if (signal.aborted) rejectRead();
      });
    } finally { if (rejectRead) signal.removeEventListener("abort", rejectRead); }
  } };
  const db = { games: { find: (_filter, options) => { signal = options.signal; return cursor; } } };
  const work = accountExportHandler({ exportStream: (owner, options) => accountExportStream(db, null, owner, options) })(request({ format: "ndjson" }), first, jest.fn());
  const settled = work.then(() => ({ done: true }), error => ({ error }));
  const archive = { userId: "B", user: null, data: {} }, other = { export: jest.fn(async () => archive), exportStream: jest.fn() };
  try {
    expect(await Promise.race([started.then(() => "entered"), settled.then(() => "settled")])).toBe("entered");
    first.emit(terminal, Error("synthetic transport terminal")); await tick();
    expect(closeEvents).toBe(0); expect(first.destroyed).toBe(false); expect(signal.aborted).toBe(true);
    expect(cursor.close).toHaveBeenCalledTimes(1);
    const blocked = response(); await accountExportHandler(other)(request({}, "B"), blocked, jest.fn());
    expect(blocked.statusCode).toBe(503); expect(blocked.body).toEqual({ error: { code: "export_busy" } });
    expect(other.export).not.toHaveBeenCalled(); expect(other.exportStream).not.toHaveBeenCalled();
  } finally {
    // Cleanup does not rely on the finish/error cancellation under test.
    rejectRead?.(); releaseCleanup(); first.destroy(); await settled;
  }
  expect(decoded(first).some(row => row.type === "complete")).toBe(false);
  const fresh = response(); await accountExportHandler(other)(request({}, "B"), fresh, jest.fn());
  expect(fresh.statusCode).toBe(200); expect(fresh.body).toBe(archive); expect(other.export).toHaveBeenCalledTimes(1);
});

test("closed JSON keeps actual read slot and discards late account output before allowing a fresh export", async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const first = response(), archive = { userId: "A", user: null, data: { games: [{ private: "owned-data" }] } };
  const work = accountExportHandler({ export: jest.fn(() => pending) })(request(), first, jest.fn());
  const settled = work.then(() => null, error => error);
  const other = { export: jest.fn(async () => archive), exportStream: jest.fn() };
  try {
    first.destroy();
    for (const query of [{}, { format: "ndjson" }]) {
      const blocked = response(); await accountExportHandler(other)(request(query, "B"), blocked, jest.fn());
      expect(blocked.statusCode).toBe(503); expect(blocked.body).toEqual({ error: { code: "export_busy" } });
    }
    expect(other.export).not.toHaveBeenCalled(); expect(other.exportStream).not.toHaveBeenCalled();
  } finally { first.destroy(); release(archive); await settled; }
  expect(first.body).toBeUndefined(); expect(first.chunks).toEqual([]);
  expect(first.headers["content-disposition"]).toBeUndefined();
  const fresh = response(); await accountExportHandler(other)(request({}, "B"), fresh, jest.fn());
  expect(fresh.body).toBe(archive);
});

test.each(["finish", "close", "error"])("settled JSON retains the slot until response %s is actually delivered", async terminal => {
  const archive = { userId: "A", user: null, data: {} }, first = response();
  first.end = function () { this.ended = true; this.writableEnded = true; };
  await accountExportHandler({ export: async () => archive })(request(), first, jest.fn());
  const other = { export: jest.fn(async () => archive) };
  try {
    expect(first.body).toBe(archive);
    const blocked = response(); await accountExportHandler(other)(request({}, "B"), blocked, jest.fn());
    expect(blocked.statusCode).toBe(503); expect(other.export).not.toHaveBeenCalled();
  } finally { first.emit(terminal); first.destroy(); }
  const fresh = response(); await accountExportHandler(other)(request({}, "B"), fresh, jest.fn());
  expect(fresh.body).toBe(archive);
});

test("duplicate old terminal callbacks cannot release a newer owner's actual export", async () => {
  let releaseA, releaseB;
  const pendingA = new Promise(resolve => { releaseA = resolve; }), pendingB = new Promise(resolve => { releaseB = resolve; });
  const archive = { userId: "A", user: null, data: {} }, first = response(), second = response();
  const oldWork = accountExportHandler({ export: () => pendingA })(request(), first, jest.fn());
  const oldSettled = oldWork.then(() => null, error => error);
  const callbacks = ["finish", "close", "error"].map(event => first.listeners(event).at(-1));
  let newSettled = Promise.resolve(null);
  const thirdService = { export: jest.fn(async () => archive), exportStream: jest.fn() };
  try {
    releaseA(archive); await oldSettled;
    newSettled = accountExportHandler({ export: () => pendingB })(request({}, "B"), second, jest.fn()).then(() => null, error => error);
    for (const event of ["finish", "close", "error"]) first.emit(event);
    for (const callback of callbacks) callback(); // Already-dispatched old listeners keep their own lease identity.
    const blocked = response(); await accountExportHandler(thirdService)(request({}, "C"), blocked, jest.fn());
    expect(blocked.statusCode).toBe(503); expect(blocked.body).toEqual({ error: { code: "export_busy" } });
    expect(thirdService.export).not.toHaveBeenCalled(); expect(thirdService.exportStream).not.toHaveBeenCalled();
  } finally {
    first.destroy(); second.destroy(); releaseA(archive); releaseB(archive);
    await Promise.all([oldSettled, newSettled]);
  }
});

test("authentication and options validation consume no slot and precede overload admission", async () => {
  const service = { export: jest.fn(async () => ({ userId: "A", user: null, data: {} })), exportStream: jest.fn() };
  async function rejectedInputs() {
    const unauth = request(); unauth.auth = null;
    const authResponse = response(); await accountExportHandler(service)(unauth, authResponse, jest.fn());
    expect(authResponse.statusCode).toBe(401); expect(authResponse.body).toEqual({ error: { code: "auth_required" } });
    const invalid = response(); await accountExportHandler(service)(request({ format: "backup" }), invalid, jest.fn());
    expect(invalid.statusCode).toBe(400); expect(invalid.body).toEqual({ error: { code: "invalid_export_options" } });
  }
  await rejectedInputs(); expect(service.export).not.toHaveBeenCalled(); expect(service.exportStream).not.toHaveBeenCalled();
  let release; const pending = new Promise(resolve => { release = resolve; });
  const first = response(), held = accountExportHandler({ export: () => pending })(request(), first, jest.fn());
  const settled = held.then(() => null, error => error);
  try { await rejectedInputs(); expect(service.export).not.toHaveBeenCalled(); }
  finally { release({ userId: "A", user: null, data: {} }); await settled; first.destroy(); }
  const fresh = response(); await accountExportHandler(service)(request(), fresh, jest.fn());
  expect(fresh.body).toEqual({ userId: "A", user: null, data: {} }); expect(service.export).toHaveBeenCalledTimes(1);
});
