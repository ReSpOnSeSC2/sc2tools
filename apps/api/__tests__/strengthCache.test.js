// @ts-nocheck
"use strict";
const { EventEmitter } = require("node:events");
const { UserCache } = require("../src/middleware/userCache");
const { UserRevision } = require("../src/util/userRevision");
const { MmrExpectationService } = require("../src/services/mmrExpectation");
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("fixture did not settle"); }
function fixture() {
  const users = { findOne: jest.fn(async () => ({ userId: "a", dataRev: 0 })) };
  const revisions = new UserRevision(users, { enabled: true });
  const cache = new UserCache(revisions, { enabled: true, limits: { active: 1 } });
  const model = new MmrExpectationService({ games: {}, db: { collection: () => ({ findOne: async () => null }) } });
  return { users, cache, model };
}
function invoke(cache, dependency, work = async () => ({ complete: true }), guard = () => {}) {
  const req = new EventEmitter(); req.method = "GET"; req.headers = {}; req.app = { get: () => undefined };
  const res = new EventEmitter(); res.destroyed = false; res.headers = {};
  res.status = code => { res.statusCode = code; return res; };
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.vary = () => res; res.removeHeader = key => { delete res.headers[key]; };
  res.end = body => { res.body = body; res.emit("finish"); return res; };
  res.json = value => { res.body = JSON.stringify(value); return res; };
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  const promise = cache.send(req, res, "a", "maps", {}, {}, work, guard, dependency);
  return { req, res, promise };
}

test("a retained hit cannot publish after the final synchronous guard retires its curve", async () => {
  const { cache, model } = fixture(), snapshot = await model.snapshot(), work = jest.fn(async () => ({ value: "old" }));
  const first = invoke(cache, snapshot.dependency, work); await first.promise;
  const hit = invoke(cache, snapshot.dependency, work, () => model.snapshots.retire());
  hit.req.headers["if-none-match"] = first.res.headers.ETag;
  await expect(hit.promise).rejects.toMatchObject({ status: 503, code: "user_cache_changed" });
  expect(hit.res.body).toBeUndefined(); expect(work).toHaveBeenCalledTimes(1); expect(cache.responses).toBe(0);
  expect(hit.res.statusCode).not.toBe(304);
});

test("newly computed body remains original200/no-store if its proof retires at final publication", async () => {
  const { cache, model } = fixture(), snapshot = await model.snapshot();
  const answer = invoke(cache, snapshot.dependency, async () => ({ value: "snapshot" }), () => model.snapshots.retire());
  await answer.promise; expect(answer.res.statusCode).toBe(200);
  expect(answer.res.headers["Cache-Control"]).toBe("private, no-store"); expect(answer.res.headers.ETag).toBeUndefined();
  expect(cache.completed.size + cache.bytes + cache.responses).toBe(0);
});

test.each([null, { keyPart: "x".repeat(4097), expiresAt: 1000, isCurrent: () => true }, { keyPart: "x", expiresAt: Infinity, isCurrent: () => true }, { keyPart: "x", expiresAt: 1000, isCurrent: () => { throw new Error("unavailable"); } }])("unsupported proof bypasses retention under the existing admission", async proof => {
  const { cache } = fixture(), work = jest.fn(async () => ({ baseline: true }));
  const answer = invoke(cache, proof, work); await answer.promise;
  expect(answer.res.headers["Cache-Control"]).toBe("private, no-store");
  expect(JSON.parse(answer.res.body)).toEqual({ baseline: true }); expect(work).toHaveBeenCalledTimes(1);
  expect(cache.completed.size + cache.active + cache.reserved).toBe(0);
});

test("abort/retirement never releases actual work permits or starts hidden replacement work", async () => {
  const { cache, model } = fixture(), snapshot = await model.snapshot(), gate = deferred();
  const old = invoke(cache, snapshot.dependency, () => gate.promise), stopped = old.promise.catch(error => error);
  await until(() => cache.active === 1 && cache.reserved > 4096); old.req.emit("aborted");
  expect(await stopped).toMatchObject({ code: "request_aborted" }); expect(cache.active).toBe(1);
  model.snapshots.retire(); const nextWork = jest.fn(async () => ({ next: true }));
  const next = invoke(cache, null, nextWork); await until(() => cache.queue.length === 1);
  expect(nextWork).not.toHaveBeenCalled(); gate.resolve({ old: true }); await next.promise;
  expect(nextWork).toHaveBeenCalledTimes(1); expect(cache.active + cache.reserved + cache.responses + cache.waiting).toBe(0);
});

test("held dependency captures remain bounded after every response aborts", async () => {
  const { cache, model, users } = fixture(), snapshot = await model.snapshot(), gate = deferred();
  const capture = jest.fn(() => gate.promise), work = jest.fn(async () => ({ unexpected: true }));
  const requests = Array.from({ length: cache.limits.responses }, () => invoke(cache, capture, work));
  await until(() => cache.preparing === cache.limits.responses);
  for (const call of requests) call.req.emit("aborted");
  expect(cache.responses).toBe(0); expect(cache.preparing).toBe(64);
  await expect(invoke(cache, capture, work).promise).rejects.toMatchObject({ status: 503, code: "user_cache_busy" });
  expect(capture).toHaveBeenCalledTimes(64); expect(work).not.toHaveBeenCalled(); expect(users.findOne).not.toHaveBeenCalled();
  gate.resolve(snapshot.dependency); await Promise.all(requests.map(call => call.promise));
  expect(cache.preparing + cache.active + cache.reserved + cache.responses).toBe(0);
  expect(work).not.toHaveBeenCalled(); expect(users.findOne).not.toHaveBeenCalled();
  await invoke(cache, snapshot.dependency).promise; expect(cache.completed.size).toBe(1);
});
