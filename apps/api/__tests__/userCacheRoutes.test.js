// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache } = require("../src/middleware/userCache");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const ROUTES = [["timeseries", "/timeseries"], ["dayHourHeatmap", "/timeseries/day-hour"],
  ["lengthBuckets", "/length-buckets"], ["activityCalendar", "/activity-calendar"],
  ["momentum", "/momentum"], ["mapTrend", "/timeseries/maps"]];
function fixture(enabled = true, legacy = false) {
  const rows = new Map([ ["a", { userId: "a", clerkUserId: "clerk-a", dataRev: 0 }], ["b", { userId: "b", dataRev: 0 }] ]);
  let deleted = false, revoked = false;
  const users = { findOne: jest.fn(async ({ userId }) => rows.get(userId)),
    findOneAndUpdate: jest.fn(async ({ userId }) => { const row = rows.get(userId); if (!row) return null; row.dataRev += 1; return row; }) };
  const revisions = new UserRevision(users, { enabled, isDeleted: async () => deleted });
  const cache = new UserCache(revisions, { enabled }); const aggregations = {};
  for (const method of [...ROUTES.map(([name]) => name), "summary", "matchupTimeseries", "mmrProgression", "oppMmrBuckets", "randomSummary", "explorer"]) {
    aggregations[method] = jest.fn(async (owner, ...input) => ({ owner, method, input, points: [{ date: new Date(0), missing: null }] }));
  }
  const app = express();
  app.use(buildAggregationsRouter({ aggregations, userCache: legacy ? undefined : cache,
    auth: (req, res, next) => {
      if (!req.headers.authorization || revoked) { res.status(401).json({ error: { code: "unauthorized" } }); return; }
      req.auth = { userId: req.headers.authorization === "Bearer b" ? "b" : "a", source: "device" }; next();
    } }));
  app.use((error, req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code || error.message } }));
  return { app, users, rows, cache, revisions, aggregations, setDeleted: () => { deleted = true; }, revoke: () => { revoked = true; } };
}
const get = (app, path, owner = "a") => request(app).get(path).set("authorization", `Bearer ${owner}`);
test.each(ROUTES)("%s caches an unchanged DTO and always returns private 200", async (method, path) => {
  const f = fixture(); const first = await get(f.app, path); const second = await get(f.app, path).set("If-None-Match", "*");
  expect(second.status).toBe(200); expect(second.body).toEqual(first.body);
  expect(second.headers["cache-control"]).toBe("private, no-store"); expect(second.headers.etag).toBeUndefined();
  expect(f.aggregations[method]).toHaveBeenCalledTimes(1);
});
test("off is byte/header/status-identical to the old router and makes zero revision commands", async () => {
  const old = fixture(false, true), off = fixture(false);
  for (const [, path] of ROUTES) {
    const a = await get(old.app, path), b = await get(off.app, path);
    expect([b.status, b.text, b.headers["cache-control"], b.headers.etag, b.headers["content-type"]])
      .toEqual([a.status, a.text, a.headers["cache-control"], a.headers.etag, a.headers["content-type"]]);
  }
  expect(off.users.findOne).not.toHaveBeenCalled(); expect(off.users.findOneAndUpdate).not.toHaveBeenCalled();
  expect(off.cache.completed.size + off.cache.pending.size + off.cache.queue.length + off.cache.bytes).toBe(0);
});
test("existing auth/revocation and fresh owner/deletion checks precede every retained hit", async () => {
  const f = fixture(); await get(f.app, "/timeseries");
  expect((await request(f.app).get("/timeseries")).status).toBe(401);
  f.revoke(); expect((await get(f.app, "/timeseries")).status).toBe(401);
  const gone = fixture(); await get(gone.app, "/timeseries"); gone.rows.delete("a");
  expect((await get(gone.app, "/timeseries")).status).toBe(401);
  const marker = fixture(); await get(marker.app, "/timeseries"); marker.setDeleted();
  expect((await get(marker.app, "/timeseries")).status).toBe(401);
  const fenced = fixture(); await get(fenced.app, "/timeseries"); fenced.rows.get("a")._gdprMutation = { kind: "restore" };
  const busy = await get(fenced.app, "/timeseries"); expect(busy.status).toBe(503); expect(busy.headers["retry-after"]).toBe("1");
});
test("all current filter/option variants and authenticated owners remain isolated", async () => {
  const f = fixture(); const variants = ["accounts=1-S2-1-1", "since=2020-01-01", "until=2025-01-01", "patch_era=after",
    "race=Z", "opp_race=P", "map=ancient", "map_exact=%5B%22Ancient%20Cistern%20LE%22%5D", "mmr_min=3000", "mmr_max=4000", "opp_strategy=Pool",
    "build=Hatch", "leak=Supply%20Blocked", "macro_min=10", "macro_max=80", "min_minutes=5", "max_minutes=10",
    "exclude_too_short=true", "regions=EU", "map_pool=ladder", "game_size=team", "group_by_race_played=true", "interval=week", "tz=Europe%2FBerlin"];
  await get(f.app, "/timeseries"); for (const query of variants) expect((await get(f.app, `/timeseries?${query}`)).status).toBe(200);
  await get(f.app, "/timeseries", "b"); expect(f.aggregations.timeseries).toHaveBeenCalledTimes(variants.length + 2);
  expect((await get(f.app, "/timeseries?map_exact=")).status).toBe(400);
  await get(f.app, "/momentum?session_gap_minutes=15"); await get(f.app, "/momentum?session_gap_minutes=90");
  expect(f.aggregations.momentum).toHaveBeenCalledTimes(2);
});
test("a committed or unknown mutation forces new aggregation without socket emission", async () => {
  const f = fixture(); await get(f.app, "/timeseries"); await f.revisions.run("a", async () => true);
  await get(f.app, "/timeseries"); const error = new Error("lost write ack");
  await expect(f.revisions.run("a", async () => { throw error; })).rejects.toBe(error);
  await get(f.app, "/timeseries"); expect(f.aggregations.timeseries).toHaveBeenCalledTimes(3);
});
test.each(["/summary", "/timeseries/matchups", "/timeseries/mmr", "/opp-mmr-buckets", "/random-summary", "/trends/explorer/periods"])("%s never enters the cache allowlist", async (path) => {
  const f = fixture(); await get(f.app, path); await get(f.app, path);
  expect(f.users.findOne).not.toHaveBeenCalled(); expect(f.cache.completed.size).toBe(0);
});
test("an owner erased during computation cannot receive the delayed answer", async () => {
  const f = fixture(); let finish; let started;
  const began = new Promise((resolve) => { started = resolve; });
  f.aggregations.timeseries.mockImplementation(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  const response = get(f.app, "/timeseries").then((result) => result); await began;
  f.rows.delete("a"); f.revisions.forget("a"); finish({ private: "erased" });
  expect((await response).status).toBe(401); expect(f.cache.completed.size).toBe(0);
});
