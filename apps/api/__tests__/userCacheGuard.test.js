// @ts-nocheck
"use strict";
// ADR 0072's overlap guard for the default-off chart cache: shutdown-start retirement, admission-time quarantine and the
// startup cohort record. With the flag off, every entry point is a no-op.
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache } = require("../src/middleware/userCache");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const { beginChartCacheShutdown, startChartCacheQuarantine, QUARANTINE_MS, WRITER_SET_VERSION } = require("../src/middleware/userCacheGuard");

async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("fixture did not settle"); }
function fixture(enabled = true) {
  let now = 1000;
  const users = { findOne: jest.fn(async () => ({ userId: "a", dataRev: 0 })), findOneAndUpdate: jest.fn() };
  const revisions = new UserRevision(users, { enabled }), cache = new UserCache(revisions, { enabled, now: () => now });
  const summary = jest.fn(async (_owner, filters) => ({ value: "summary", filters }));
  const app = express();
  app.use(buildAggregationsRouter({ aggregations: { summary }, streak: {}, macroReport: {}, userCache: cache,
    auth: (req, _res, next) => { req.auth = { userId: "a", source: "device" }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || error.message }));
  return { app, cache, revisions, summary, users, advance: ms => { now += ms; } };
}
const get = (f, tag, query = "") => { const req = request(f.app).get(`/summary${query}`); return tag ? req.set("If-None-Match", tag) : req; };
const uncached = res => { expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store"); expect(res.headers.etag).toBeUndefined(); };
afterEach(() => { jest.restoreAllMocks(); delete process.env.RENDER_GIT_COMMIT; });

test("with the flag off, every guard entry point is a no-op", async () => {
  const f = fixture(false), logger = { info: jest.fn() };
  beginChartCacheShutdown(f.cache); startChartCacheQuarantine(f.cache, logger);
  expect([f.cache.closing, f.cache.quarantineUntil, f.cache.quarantineEnded]).toEqual([false, -Infinity, true]);
  expect(logger.info).not.toHaveBeenCalled();
  const res = await get(f);
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBeUndefined(); expect(f.users.findOne).not.toHaveBeenCalled();
});

test("after shutdown starts, no request gets a retained body or a 304, and correct 200s continue", async () => {
  const f = fixture(), first = await get(f);
  expect((await get(f, first.headers.etag)).status).toBe(304);
  beginChartCacheShutdown(f.cache);
  expect(f.cache.completed.size).toBe(0);
  const after = await get(f, first.headers.etag);
  uncached(after); expect(after.body).toEqual(first.body);
  uncached(await get(f)); expect(f.cache.completed.size).toBe(0);
});

test("work that finishes after shutdown starts is answered uncached for its initiator and a joined follower", async () => {
  const f = fixture();
  let release; const held = new Promise(resolve => { release = resolve; });
  f.summary.mockImplementationOnce(async () => { await held; return { value: "late" }; });
  const one = get(f).then(res => res), two = get(f).then(res => res);
  await until(() => f.cache.stats.join === 1);
  beginChartCacheShutdown(f.cache); release();
  for (const res of await Promise.all([one, two])) { uncached(res); expect(res.body).toEqual({ value: "late" }); }
  expect(f.cache.completed.size).toBe(0);
});

test("a body delivered just before shutdown starts is still answered without a validator", async () => {
  const f = fixture(), deliver = f.cache.deliver.bind(f.cache);
  jest.spyOn(f.cache, "deliver").mockImplementation((sub, packet) => { deliver(sub, packet); beginChartCacheShutdown(f.cache); });
  uncached(await get(f));
  expect(f.cache.completed.size).toBe(0);
});

test("during quarantine nothing is retained or refused; the first request after it clears inner state once, then retention resumes", async () => {
  const f = fixture(), inner = jest.fn();
  f.revisions.addInvalidator(inner);
  startChartCacheQuarantine(f.cache, null, 1000);
  for (let i = 0; i < 2; i += 1) uncached(await get(f));
  f.advance(999); uncached(await get(f));
  expect(f.cache.completed.size).toBe(0); expect(inner).not.toHaveBeenCalled(); expect(f.summary).toHaveBeenCalledTimes(3);
  f.advance(1);
  const open = await get(f);
  expect(inner.mock.calls).toEqual([[null]]);
  expect(open.headers["cache-control"]).toBe("private, no-cache"); expect((await get(f, open.headers.etag)).status).toBe(304);
  expect(inner).toHaveBeenCalledTimes(1);
});

test("a request admitted during quarantine is never retained, even when its work ends after quarantine", async () => {
  const f = fixture();
  startChartCacheQuarantine(f.cache, null, 1000);
  let release; const held = new Promise(resolve => { release = resolve; });
  f.summary.mockImplementationOnce(async () => { await held; return { value: "early" }; });
  const early = get(f).then(res => res);
  await until(() => f.summary.mock.calls.length === 1);
  f.advance(1000); release();
  uncached(await early); expect(f.cache.completed.size).toBe(0);
  expect((await get(f)).headers["cache-control"]).toBe("private, no-cache");
});

test("the startup cohort record names only the revision, flag, writer set and quarantine end, and never fails boot", () => {
  const f = fixture(), logger = { info: jest.fn() };
  process.env.RENDER_GIT_COMMIT = "a".repeat(40);
  startChartCacheQuarantine(f.cache, logger);
  expect(logger.info).toHaveBeenCalledTimes(1);
  const [record, message] = logger.info.mock.calls[0];
  expect(message).toBe("chart_cache_cohort_start");
  expect(Object.keys(record).sort()).toEqual(["quarantineEndsAt", "quarantineMs", "sourceRevision", "userCacheEnabled", "writerSetVersion"]);
  expect(record).toMatchObject({ sourceRevision: "a".repeat(40), userCacheEnabled: true, writerSetVersion: WRITER_SET_VERSION, quarantineMs: QUARANTINE_MS });
  expect(f.cache.quarantineUntil).toBe(1000 + QUARANTINE_MS);
  expect(() => startChartCacheQuarantine(fixture().cache, { info: () => { throw new Error("log down"); } })).not.toThrow();
});

test("the server retires the chart cache before shutdown's first await and starts the quarantine at listen", () => {
  const lines = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8").split(/\r?\n/);
  const start = lines.findIndex(line => line.includes('"shutdown_start"'));
  expect(lines[start - 1]).toMatch(/async function shutdown\(/);
  expect(lines[start]).toContain("beginChartCacheShutdown(");
  expect(lines[start].indexOf("beginChartCacheShutdown(")).toBeLessThan(lines[start].indexOf("await") < 0 ? Infinity : lines[start].indexOf("await"));
  expect(lines.find(line => line.includes('"listening"'))).toContain("startChartCacheQuarantine(");
});
