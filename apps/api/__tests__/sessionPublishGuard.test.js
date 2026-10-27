"use strict";
const express = require("express");
const request = require("supertest");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache } = require("../src/middleware/userCache");
function deferred() {
  /** @type {()=>void} */ let resolve = () => {};
  /** @type {Promise<void>} */ const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
/** @param {boolean} enabled */
function fixture(enabled, work = jest.fn(async () => ({ privateValue: "current" }))) {
  // UserCache's snapshot path consumes only this collection read in the unit test.
  /** @type {Pick<import('mongodb').Collection,'findOne'>} */
  const users = { findOne: jest.fn().mockResolvedValue({ userId: "a", clerkUserId: "clerk-a", dataRev: 0 }) };
  const revisions = new UserRevision(/** @type {import('mongodb').Collection} */ (users), { enabled }), cache = new UserCache(revisions, { enabled });
  const app = express(); let guards = 0;
  app.get("/read", async (req, res, next) => {
    try { await cache.send(req, res, "a", "momentum", {}, { gap: 90, generation: 1 }, work, () => {
      guards++; if (req.get("x-retired") === "yes") throw Object.assign(new Error("session_policy_changed"), { status: 409 });
    }); } catch (error) { next(error); }
  });
  /** @type {import('express').ErrorRequestHandler} */
  const onError = (error, _req, res, _next) => { res.status(error.status || 500).json({ error: error.message }); };
  app.use(onError);
  return { app, cache, work, guards: () => guards };
}
/** @param {InstanceType<typeof UserCache>} cache @param {number} count */
async function admitted(cache, count) {
  for (let i = 0; i < 200; i++) { if (cache.waiting === count) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Expected subscribers were not admitted");
}
test.each([false, true])("publication guard runs before any private response with cache%s", async enabled => {
  const f = fixture(enabled);
  expect((await request(f.app).get("/read")).body).toEqual({ privateValue: "current" });
  const stopped = await request(f.app).get("/read").set("x-retired", "yes");
  expect(stopped.status).toBe(409); expect(stopped.body).toEqual({ error: "session_policy_changed" });
  expect(stopped.text).not.toContain("privateValue"); expect(f.guards()).toBe(2);
  if (enabled) expect(f.work).toHaveBeenCalledTimes(1); // the second request was a warm hit
});
test("joined subscribers retain separate synchronous guards and normal lease cleanup", async () => {
  const hold = deferred(), f = fixture(true, jest.fn(async () => { await hold.promise; return { privateValue: "current" }; }));
  const fresh = request(f.app).get("/read").then(response => response);
  const retired = request(f.app).get("/read").set("x-retired", "yes").then(response => response);
  try { await admitted(f.cache, 2); } finally { hold.resolve(); }
  const [ok, stopped] = await Promise.all([fresh, retired]);
  expect(ok.status).toBe(200); expect(ok.body).toEqual({ privateValue: "current" });
  expect(stopped.status).toBe(409); expect(stopped.body).toEqual({ error: "session_policy_changed" });
  expect(f.work).toHaveBeenCalledTimes(1); expect(f.guards()).toBe(2); expect(f.cache.waiting).toBe(0);
});

test("an admitted retained hit still publishes its private empty304 after its own guard", async () => {
  const f = fixture(true), first = await request(f.app).get("/read");
  expect(first.status).toBe(200); expect(first.headers.etag).toMatch(/^W\/"uc1-[0-9a-f]{64}"$/);
  const same = await request(f.app).get("/read").set("If-None-Match", first.headers.etag);
  expect(same.status).toBe(304); expect(same.text).toBe("");
  expect(same.headers.etag).toBe(first.headers.etag);
  expect(same.headers["cache-control"]).toBe("private, no-cache");
  expect(same.headers["content-type"]).toBeUndefined(); expect(same.headers["content-length"]).toBeUndefined();
  expect(f.guards()).toBe(2); expect(f.work).toHaveBeenCalledTimes(1); expect(f.cache.responses).toBe(0);
});

test("a matching retained validator cannot skip a retired subscriber's publication guard", async () => {
  const f = fixture(true), first = await request(f.app).get("/read");
  const stopped = await request(f.app).get("/read").set("If-None-Match", first.headers.etag).set("x-retired", "yes");
  expect(stopped.status).toBe(409); expect(stopped.body).toEqual({ error: "session_policy_changed" });
  expect(stopped.text).not.toContain("privateValue"); expect(f.guards()).toBe(2);
  expect(f.work).toHaveBeenCalledTimes(1); expect(f.cache.responses).toBe(0);
  expect([...f.cache.completed.values()].every(entry => entry.refs === 0)).toBe(true);
});

test("one completed task independently guards a fresh200, current304 and retired304 subscriber", async () => {
  const f = fixture(true), first = await request(f.app).get("/read"), hold = deferred();
  // Retire only the retained entry, so recomputing identical bytes uses the
  // identical current typed key/tag and all three requests join one new task.
  f.cache.invalidateForUser("a");
  f.work.mockImplementationOnce(async () => { await hold.promise; return { privateValue: "current" }; });
  const full = request(f.app).get("/read").then(response => response);
  const same = request(f.app).get("/read").set("If-None-Match", first.headers.etag).then(response => response);
  const retired = request(f.app).get("/read").set("If-None-Match", first.headers.etag).set("x-retired", "yes").then(response => response);
  try { await admitted(f.cache, 3); } finally { hold.resolve(); }
  const [ok, empty, stopped] = await Promise.all([full, same, retired]);
  expect(ok.status).toBe(200); expect(ok.body).toEqual({ privateValue: "current" });
  expect(ok.headers.etag).toBe(first.headers.etag);
  expect(empty.status).toBe(304); expect(empty.text).toBe(""); expect(empty.headers.etag).toBe(first.headers.etag);
  expect(empty.headers["content-type"]).toBeUndefined(); expect(empty.headers["content-length"]).toBeUndefined();
  expect(stopped.status).toBe(409); expect(stopped.body).toEqual({ error: "session_policy_changed" });
  expect(stopped.text).not.toContain("privateValue"); expect(f.guards()).toBe(4); expect(f.work).toHaveBeenCalledTimes(2);
  expect(f.cache.waiting).toBe(0); expect(f.cache.responses).toBe(0);
  expect([...f.cache.completed.values()].every(entry => entry.refs === 0)).toBe(true);
});

test("uncached oversized packets keep the publication guard and cannot turn wildcard validators into304", async () => {
  const f = fixture(true); f.cache.limits.entryBytes = 1;
  const full = await request(f.app).get("/read").set("If-None-Match", "*");
  expect(full.status).toBe(200); expect(full.body).toEqual({ privateValue: "current" });
  expect(full.headers.etag).toBeUndefined(); expect(full.headers["cache-control"]).toBe("private, no-store");
  const stopped = await request(f.app).get("/read").set("If-None-Match", "*").set("x-retired", "yes");
  expect(stopped.status).toBe(409); expect(stopped.body).toEqual({ error: "session_policy_changed" });
  expect(stopped.text).not.toContain("privateValue"); expect(f.guards()).toBe(2);
  expect(f.work).toHaveBeenCalledTimes(2); expect(f.cache.completed.size).toBe(0); expect(f.cache.responses).toBe(0);
});

test("OFF preserves Express conditional handling after the guard and rejects a retired wildcard request", async () => {
  const f = fixture(false);
  const native = await request(f.app).get("/read").set("If-None-Match", "*");
  expect(native.status).toBe(304); expect(native.text).toBe("");
  const stopped = await request(f.app).get("/read").set("If-None-Match", "*").set("x-retired", "yes");
  expect(stopped.status).toBe(409); expect(stopped.body).toEqual({ error: "session_policy_changed" });
  expect(stopped.text).not.toContain("privateValue"); expect(f.guards()).toBe(2); expect(f.work).toHaveBeenCalledTimes(2);
  expect(f.cache.completed.size + f.cache.pending.size + f.cache.queue.length + f.cache.bytes).toBe(0);
});
