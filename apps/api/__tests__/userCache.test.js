// @ts-nocheck
"use strict";
const { EventEmitter } = require("events");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache, LIMITS } = require("../src/middleware/userCache");
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) { for (let n = 0; n < 100; n += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } throw new Error("fixture did not settle"); }
function setup(limits = {}, enabled = true) {
  let now = 1;
  const users = { findOne: jest.fn(async ({ userId }) => ({ userId, dataRev: 0 })) };
  const revisions = new UserRevision(users, { enabled });
  const cache = new UserCache(revisions, { enabled, limits, now: () => now });
  return { cache, revisions, users, advance: (ms) => { now += ms; } };
}
function request(cache, { owner = "a", filters = {}, options = {}, work = async () => ({ ok: true }), finish = true, headers = {} } = {}) {
  const req = new EventEmitter(); req.method = "GET"; req.headers = headers; req.app = { get: () => undefined };
  const res = new EventEmitter(); res.headers = {}; res.destroyed = false;
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.type = () => res;
  res.vary = (value) => { res.headers.Vary = [res.headers.Vary, value].filter(Boolean).join(", "); return res; };
  res.removeHeader = (key) => { delete res.headers[key]; };
  res.json = (value) => { res.body = JSON.stringify(value); return res; };
  res.end = (body) => { res.body = body; if (finish) res.emit("finish"); return res; };
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  const promise = cache.send(req, res, owner, "timeseries", filters, options, work);
  return { req, res, promise };
}
test("default-off path has no guard, write, queue, cap, bytes or changed JSON", async () => {
  const { cache, users } = setup({}, false); const work = jest.fn(async () => ({ date: new Date(0), value: null }));
  const calls = Array.from({ length: LIMITS.responses + 2 }, () => request(cache, { work }));
  await Promise.all(calls.map((call) => call.promise));
  expect(calls[0].res.body).toBe('{"date":"1970-01-01T00:00:00.000Z","value":null}');
  expect(users.findOne).not.toHaveBeenCalled(); expect(cache.counters.active).toBe(0);
  expect(cache.bytes + cache.reserved + cache.waiting + cache.responses).toBe(0); expect(work).toHaveBeenCalledTimes(calls.length);
});
test("typed filters/options isolate owners, equivalent key order reuses actual work", async () => {
  const { cache } = setup(); const work = jest.fn(async () => ({ points: [{ bucket: new Date(0), mean: null }] }));
  await request(cache, { filters: { since: new Date(0), map: "é" }, options: { tz: "UTC", interval: "day" }, work }).promise;
  await request(cache, { filters: { map: "é", since: new Date(0) }, options: { interval: "day", tz: "UTC" }, work }).promise;
  expect(work).toHaveBeenCalledTimes(1);
  for (const change of [{ owner: "b" }, { filters: { since: "1970-01-01" } }, { options: { interval: "week" } }]) await request(cache, { ...change, work }).promise;
  expect(work).toHaveBeenCalledTimes(4);
});
test("absolute TTL and LRU reclaim exact UTF-8 bytes; 512KiB is a body bound", async () => {
  const { cache, advance } = setup({ entries: 1, ttlMs: 20 });
  const value = { map: "界" }; await request(cache, { work: async () => value }).promise;
  const [key] = [...cache.completed][0];
  expect(cache.bytes).toBe(Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength([...cache.completed.values()][0].etag));
  advance(21); await request(cache, { work: async () => value }).promise;
  expect(cache.stats.expiry).toBe(1);
  await request(cache, { filters: { map: "other" } }).promise; expect(cache.completed.size).toBe(1);
  const edge = setup(); const exact = "x".repeat(LIMITS.entryBytes - 2);
  await request(edge.cache, { work: async () => exact }).promise;
  expect(edge.cache.completed.size).toBe(1);
  await request(edge.cache, { filters: { map: "huge" }, work: async () => `${exact}x` }).promise;
  expect(edge.cache.stats.oversize).toBe(1); expect(edge.cache.completed.size).toBe(1);
});
test("retired slow-response buffers stay charged and new reservations cannot exceed budget", async () => {
  const { cache, revisions } = setup({ bytes: 1800, entryBytes: 1200, keyBytes: 300 });
  const slow = request(cache, { finish: false, work: async () => "x".repeat(1000) }); await slow.promise;
  const bytes = cache.bytes; revisions.retire("a");
  expect(cache.completed.size).toBe(0); expect(cache.bytes).toBe(bytes); expect(cache.counters.pinned_bytes).toBe(bytes);
  await expect(request(cache, { owner: "b" }).promise).rejects.toMatchObject({ status: 503 });
  slow.res.emit("finish"); expect(cache.bytes).toBe(0); expect(cache.counters.pinned_bytes).toBe(0);
});
test("invalidation detaches old joins but retains active computation admission until settle", async () => {
  const { cache, revisions } = setup({ active: 1, ownerActive: 1 }); const gate = deferred();
  const old = request(cache, { work: () => gate.promise }); const oldResult = old.promise.catch((error) => error); await until(() => cache.active === 1);
  revisions.retire("a"); const nextWork = jest.fn(async () => ({ fresh: true })); const next = request(cache, { work: nextWork });
  await until(() => cache.queue.length === 1); expect(cache.active).toBe(1); expect(nextWork).not.toHaveBeenCalled();
  gate.resolve({ stale: true }); expect(await oldResult).toMatchObject({ status: 503, code: "user_cache_changed" }); await next.promise;
  expect(old.res.body).toBeUndefined(); expect(old.res.headers["Retry-After"]).toBe("1"); expect(nextWork).toHaveBeenCalledTimes(1);
  expect(cache.stats.late_fill).toBe(1); expect([...cache.completed.values()].some((entry) => entry.body.toString().includes("stale"))).toBe(false);
});
test("same-key joins are bounded and a cancelled waiter cannot cancel another subscriber", async () => {
  const { cache } = setup({ subscribers: 2 }); const gate = deferred(); const work = jest.fn(() => gate.promise);
  const first = request(cache, { work }); const firstResult = first.promise.catch((error) => error);
  await until(() => work.mock.calls.length === 1);
  const second = request(cache, { work }); await until(() => cache.waiting === 2);
  await expect(request(cache, { work }).promise).rejects.toMatchObject({ status: 503 });
  first.req.emit("aborted"); gate.resolve({ shared: true });
  expect(await firstResult).toMatchObject({ code: "request_aborted" }); await second.promise;
  expect(work).toHaveBeenCalledTimes(1); expect(cache.active + cache.waiting + cache.responses).toBe(0);
});
test("cancelled queued keys cannot accumulate behind hung work", async () => {
  const { cache } = setup({ active: 1, ownerActive: 1, waiting: 2 }); const gate = deferred();
  const running = request(cache, { work: () => gate.promise }); await until(() => cache.active === 1);
  for (let n = 0; n < 8; n += 1) {
    const queued = request(cache, { owner: `owner-${n}` }); const result = queued.promise.catch((error) => error);
    await until(() => cache.queue.length === 1); queued.req.emit("aborted"); await result;
    expect(cache.queue.length).toBe(0); expect(cache.pending.size).toBe(1);
  }
  gate.resolve({}); await running.promise;
});
test("queue deadline and response lease timeout release listeners, pins and slots", async () => {
  const { cache } = setup({ active: 1, ownerActive: 1, queueMs: 20, responseMs: 20 }); const gate = deferred();
  const running = request(cache, { work: () => gate.promise }); await until(() => cache.active === 1);
  const queued = request(cache, { owner: "b" }); await expect(queued.promise).rejects.toMatchObject({ status: 503 });
  gate.resolve({}); await running.promise;
  const slow = request(cache, { finish: false }); await slow.promise;
  await until(() => slow.res.destroyed);
  expect(cache.responses).toBe(0); expect(slow.res.listenerCount("finish") + slow.req.listenerCount("aborted")).toBe(0);
});
test("response cap, waiting cap, owner fairness and invalid limits are explicit", async () => {
  const { cache } = setup({ active: 2, ownerActive: 1, waiting: 3, responses: 3 }); const gate = deferred();
  const a = request(cache, { work: () => gate.promise }); await until(() => cache.active === 1);
  const sameOwner = request(cache, { filters: { map: "second" } });
  const b = request(cache, { owner: "b", work: () => gate.promise }); await until(() => cache.active === 2);
  await expect(request(cache, { owner: "c" }).promise).rejects.toMatchObject({ status: 503 });
  expect(cache.queue.length).toBe(1); gate.resolve({}); await Promise.all([a.promise, b.promise, sameOwner.promise]);
  expect(() => setup({ entries: 0 })).toThrow("user_cache_invalid_limits");
});
test("waiting capacity is independent of the response-lease ceiling", async () => {
  const { cache } = setup({ active: 1, ownerActive: 1, waiting: 2, responses: 8 }); const gate = deferred();
  const first = request(cache, { work: () => gate.promise }); await until(() => cache.active === 1);
  const queued = request(cache, { owner: "b" }); await until(() => cache.waiting === 2);
  await expect(request(cache, { owner: "c" }).promise).rejects.toMatchObject({ status: 503 });
  gate.resolve({}); await Promise.all([first.promise, queued.promise]); expect(cache.waiting).toBe(0);
});
test("a revision that becomes malformed during compute cannot retain that answer", async () => {
  const { cache, users } = setup(); users.findOne.mockResolvedValueOnce({ userId: "a", dataRev: 0 }).mockResolvedValue({ userId: "a", dataRev: "invalid" });
  await request(cache).promise; expect(cache.completed.size).toBe(0); expect(cache.bytes).toBe(0);
});
test("a generation retired during the initial guard publishes nothing and does not start work", async () => {
  const { cache, revisions, users } = setup(); const gate = deferred(); const work = jest.fn(async () => ({ private: "old" }));
  users.findOne.mockReturnValueOnce(gate.promise);
  const old = request(cache, { work }); const outcome = old.promise.catch((error) => error);
  await until(() => users.findOne.mock.calls.length === 1); revisions.retire("a"); gate.resolve({ userId: "a", dataRev: 0 });
  expect(await outcome).toMatchObject({ status: 503, code: "user_cache_changed" });
  expect(work).not.toHaveBeenCalled(); expect(old.res.body).toBeUndefined(); expect(old.res.headers["Retry-After"]).toBe("1");
});
test("retirement between resolved packet delivery and subscriber continuation still publishes no old body", async () => {
  const { cache, revisions } = setup();
  const work = jest.fn(async () => ({ toJSON() { queueMicrotask(() => revisions.retire("a")); return { private: "retired" }; } }));
  const call = request(cache, { work });
  await expect(call.promise).rejects.toMatchObject({ status: 503, code: "user_cache_changed" });
  expect(call.res.body).toBeUndefined(); expect(call.res.headers["Retry-After"]).toBe("1");
  expect(work).toHaveBeenCalledTimes(1); expect(cache.bytes + cache.reserved + cache.responses + cache.active).toBe(0);
});
test.each(["findOne", "identity"])("aborting held %s guards never releases their independent IO permits", async (phase) => {
  const { cache, revisions, users } = setup(); const gate = deferred(), row = { userId: "a", clerkUserId: "clerk-a", dataRev: 0 };
  if (phase === "findOne") users.findOne.mockImplementation(async () => { await gate.promise; return row; });
  else users.findOne.mockResolvedValue(row);
  const identity = jest.fn(async () => { if (phase === "identity") await gate.promise; return false; }); revisions.isDeleted = identity;
  const held = [];
  for (let n = 0; n < 16; n += 1) {
    const call = request(cache); held.push(call.promise.catch((error) => error));
    await until(() => (phase === "findOne" ? users.findOne : identity).mock.calls.length === n + 1);
    call.req.emit("aborted"); expect(cache.responses).toBe(0);
  }
  for (let n = 0; n < 12; n += 1) await expect(request(cache).promise).rejects.toMatchObject({ status: 503, code: "user_cache_guard_busy" });
  expect(users.findOne).toHaveBeenCalledTimes(16); expect(identity).toHaveBeenCalledTimes(phase === "identity" ? 16 : 0);
  expect(revisions.counters.guard_active).toBe(16); expect(revisions.counters.guard_rejected).toBe(12);
  gate.resolve(); await Promise.all(held);
  expect(revisions.counters.guard_active).toBe(0); expect(cache.responses + cache.active + cache.waiting + cache.reserved).toBe(0);
  await request(cache).promise; expect(revisions.counters.guard_active).toBe(0);
});
test("a held post-compute guard keeps its permit after abort and cannot be bypassed by replacement requests", async () => {
  const { cache, revisions, users } = setup(); const gate = deferred(), row = { userId: "a", dataRev: 0 };
  users.findOne.mockResolvedValueOnce(row).mockImplementation(async () => { await gate.promise; return row; });
  const original = request(cache); const held = [original.promise.catch((error) => error)];
  await until(() => users.findOne.mock.calls.length === 2); original.req.emit("aborted");
  expect(cache.active).toBe(1); expect(revisions.counters.guard_active).toBe(1);
  for (let n = 0; n < 15; n += 1) {
    const call = request(cache); held.push(call.promise.catch((error) => error));
    await until(() => users.findOne.mock.calls.length === n + 3); call.req.emit("aborted");
  }
  await expect(request(cache).promise).rejects.toMatchObject({ status: 503, code: "user_cache_guard_busy" });
  expect(users.findOne).toHaveBeenCalledTimes(17); expect(revisions.counters.guard_active).toBe(16);
  gate.resolve(); await Promise.all(held); await until(() => cache.active === 0);
  expect(revisions.counters.guard_active).toBe(0); expect(cache.bytes + cache.reserved + cache.responses + cache.waiting).toBe(0);
  expect(original.res.body).toBeUndefined();
});
test("stable-generation dirty, active and invalid-revision reads can still return bounded fresh bodies", async () => {
  for (const mode of ["dirty", "active", "invalid"]) {
    const { cache, revisions, users } = setup();
    if (mode === "invalid") users.findOne.mockResolvedValue({ userId: "a", dataRev: "legacy" });
    else { const state = revisions.state("a"); state.dirty = mode === "dirty"; state.active = mode === "active" ? 1 : 0; }
    const call = request(cache, { work: async () => ({ fresh: mode }) }); await call.promise;
    expect(call.res.statusCode).toBe(200); expect(call.res.body.toString()).toBe(JSON.stringify({ fresh: mode }));
    expect(cache.completed.size).toBe(0); expect(cache.bytes + cache.reserved + cache.active + cache.responses).toBe(0);
  }
});
test("serialization failure, work rejection and oversized keys retain nothing", async () => {
  const { cache } = setup({ keyBytes: 32 }); const cyclic = {}; cyclic.self = cyclic;
  await expect(request(cache, { work: async () => cyclic }).promise).rejects.toThrow();
  await expect(request(cache, { work: async () => { throw new Error("compute"); } }).promise).rejects.toThrow("compute");
  await request(cache, { filters: { map: "x".repeat(80) } }).promise;
  expect(cache.completed.size).toBe(0); expect(cache.bytes + cache.reserved + cache.active + cache.responses).toBe(0);
});

test("retained validators include owner, full typed key, exact JSON and process identity", async () => {
  const { cache } = setup(); const work = async () => ({ secret: "界" });
  const first = request(cache, { work }); await first.promise;
  const tag = first.res.headers.ETag; expect(tag).toMatch(/^W\/"uc1-[0-9a-f]{64}"$/);
  const hit = request(cache, { work }); await hit.promise; expect(hit.res.headers.ETag).toBe(tag);
  for (const change of [{ owner: "b" }, { options: { interval: "week" } }, { filters: { map: "other" } }]) {
    const other = request(cache, { ...change, work }); await other.promise; expect(other.res.headers.ETag).not.toBe(tag);
  }
  const restarted = request(setup().cache, { work }); await restarted.promise; expect(restarted.res.headers.ETag).not.toBe(tag);
  expect(first.res.headers["Cache-Control"]).toBe("private, no-cache"); expect(first.res.headers.Vary).toBe("Authorization");
});

test("conditional hits finish empty304 leases while unchanged and foreign tags return full200", async () => {
  const { cache, users } = setup(); const work = jest.fn(async () => ({ value: 42 }));
  const first = request(cache, { work }); await first.promise; const tag = first.res.headers.ETag;
  const reads = users.findOne.mock.calls.length;
  const hit = request(cache, { work, headers: { "if-none-match": tag } }); await hit.promise;
  expect(hit.res.statusCode).toBe(304); expect(hit.res.body).toBeUndefined();
  expect(hit.res.headers["Content-Length"]).toBeUndefined(); expect(hit.res.headers["Content-Type"]).toBeUndefined();
  expect(hit.res.headers.ETag).toBe(tag); expect(work).toHaveBeenCalledTimes(1);
  expect(users.findOne.mock.calls.length).toBe(reads + 1);
  const other = request(cache, { work, headers: { "if-none-match": 'W/"foreign"' } }); await other.promise;
  expect(other.res.statusCode).toBe(200); expect(other.res.body.toString()).toBe('{"value":42}');
  expect(cache.responses + cache.reserved + cache.active).toBe(0);
  expect([...cache.completed.values()][0].refs).toBe(0);
});

test.each([
  ["weak", tag => tag, 304], ["strong", tag => tag.slice(2), 304],
  ["list with quoted comma", tag => `"other,tag", ${tag}, W/"last"`, 304],
  ["star", () => "*", 304], ["unknown", () => '"unknown"', 200],
  ["HTTP OWS", tag => ` \t${tag}\t `, 304],
  ["leading NBSP", tag => `\u00a0${tag}`, 200], ["trailing NBSP", tag => `${tag}\u00a0`, 200],
  ["unquoted NEL", tag => `\u0085${tag}`, 200],
  ["quoted obs text", tag => `"\u0085", ${tag}`, 304],
  ["malformed trailing", tag => `${tag},`, 200], ["malformed mixed star", tag => `*, ${tag}`, 200],
  ["invalid control", tag => `"bad\t", ${tag}`, 200],
  ["overlong", tag => `"${"x".repeat(4096)}", ${tag}`, 200],
  ["too many", tag => `${Array.from({ length: 32 }, () => '"x"').join(",")},${tag}`, 200],
])("bounded If-None-Match %s", async (_name, header, status) => {
  const { cache } = setup(); const first = request(cache); await first.promise;
  const call = request(cache, { headers: { "if-none-match": header(first.res.headers.ETag) } }); await call.promise;
  expect(call.res.statusCode).toBe(status); expect(cache.responses).toBe(0);
});

test("joined subscribers choose200 and304 independently from one unchanged computation", async () => {
  const { cache, advance } = setup({ ttlMs: 10 }); const work = jest.fn(async () => ({ same: true }));
  const first = request(cache, { work }); await first.promise; const tag = first.res.headers.ETag;
  advance(11); const gate = deferred(); work.mockImplementationOnce(() => gate.promise);
  const conditional = request(cache, { work, headers: { "if-none-match": tag } });
  await until(() => work.mock.calls.length === 2);
  const plain = request(cache, { work }); await until(() => cache.stats.join === 1);
  gate.resolve({ same: true }); await Promise.all([conditional.promise, plain.promise]);
  expect(conditional.res.statusCode).toBe(304); expect(plain.res.statusCode).toBe(200);
  expect(plain.res.body.toString()).toBe('{"same":true}');
  expect(cache.responses + cache.active + cache.waiting).toBe(0);
});

test("dirty, oversized and generation-retired requests cannot send a reused validator", async () => {
  const { cache, revisions } = setup(); const first = request(cache); await first.promise;
  const tag = first.res.headers.ETag;
  revisions.state("a").dirty = true; cache.invalidateForUser("a");
  const dirty = request(cache, { headers: { "if-none-match": "*" } }); await dirty.promise;
  expect(dirty.res.statusCode).toBe(200); expect(dirty.res.headers.ETag).toBeUndefined();
  expect(dirty.res.headers["Cache-Control"]).toBe("private, no-store");
  revisions.state("a").dirty = false;
  const huge = request(cache, { work: async () => "x".repeat(LIMITS.entryBytes), headers: { "if-none-match": "*" } });
  await huge.promise; expect(huge.res.statusCode).toBe(200); expect(huge.res.headers.ETag).toBeUndefined();
  revisions.retire("a");
  const fresh = request(cache, { headers: { "if-none-match": tag } }); await fresh.promise;
  expect(fresh.res.statusCode).toBe(200); expect(fresh.res.headers.ETag).not.toBe(tag);
});