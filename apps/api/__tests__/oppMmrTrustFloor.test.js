// @ts-nocheck
"use strict";
// The opponent-MMR pair keys a retained body by the UTC day's trust floor and computes with exactly that floor, while
// the flag-off path passes no floor and keeps the continuous one, so its responses stay byte-identical.
const express = require("express");
const request = require("supertest");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache } = require("../src/middleware/userCache");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const { oppMmrTrustFloor, oppMmrTrustDayFloor, oppMmrBuckets, oppMmrBucketGames, OPP_MMR_TRUST_MAX_AGE_DAYS } = require("../src/services/trendsOppMmr");

const DAY = 86400000, NOON = Date.UTC(2026, 9, 30, 12), MIDNIGHT = Date.UTC(2026, 9, 30), HORIZON = OPP_MMR_TRUST_MAX_AGE_DAYS * DAY;
afterEach(() => jest.restoreAllMocks());

test("the day floor is one horizon back from the start of the UTC day; the continuous floor is unchanged", () => {
  for (const now of [MIDNIGHT, NOON, MIDNIGHT + DAY - 1]) expect(oppMmrTrustDayFloor(now).getTime()).toBe(MIDNIGHT - HORIZON);
  expect(oppMmrTrustDayFloor(MIDNIGHT + DAY).getTime()).toBe(MIDNIGHT + DAY - HORIZON);
  expect(oppMmrTrustDayFloor(MIDNIGHT - 1).getTime()).toBe(MIDNIGHT - DAY - HORIZON);
  expect(oppMmrTrustFloor(NOON).getTime()).toBe(NOON - HORIZON);
});

function deps(rows = [{ buckets: [], unknown: [] }]) {
  const pipelines = [];
  return { pipelines, gamesMatchStage: () => ({ userId: "a" }), bucketSwitch: () => "win",
    games: { aggregate: jest.fn(pipeline => { pipelines.push(pipeline); return { toArray: async () => rows }; }) } };
}
const floorsIn = pipeline => [...JSON.stringify(pipeline).matchAll(/"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/g)].map(match => match[1]);

test("a keyed floor drives the histogram, its width probe and the drilldown; without a valid one the continuous floor does", async () => {
  const keyed = new Date(Date.UTC(2025, 0, 2)).toISOString();
  for (const call of [d => oppMmrBuckets(d, "a", {}, { bucketWidth: "auto", trustFloor: keyed }),
    d => oppMmrBucketGames(d, "a", {}, { lo: 4000, hi: 4100, trustFloor: keyed })]) {
    const d = deps(); await call(d);
    expect(d.pipelines.length).toBeGreaterThan(0);
    for (const pipeline of d.pipelines) expect(new Set(floorsIn(pipeline))).toEqual(new Set([keyed]));
  }
  jest.spyOn(Date, "now").mockReturnValue(NOON);
  for (const trustFloor of [undefined, "not a date", 42]) {
    const d = deps(); await oppMmrBuckets(d, "a", {}, { bucketWidth: 100, trustFloor });
    expect(new Set(floorsIn(d.pipelines[0]))).toEqual(new Set([oppMmrTrustFloor(NOON).toISOString()]));
  }
});

function fixture(enabled = true) {
  const users = { findOne: jest.fn(async () => ({ userId: "a", dataRev: 0 })), findOneAndUpdate: jest.fn() };
  const revisions = new UserRevision(users, { enabled }), cache = new UserCache(revisions, { enabled });
  const aggregations = { oppMmrBuckets: jest.fn(async (_owner, _filters, opts) => ({ width: opts.bucketWidth ?? null, rows: 1 })),
    oppMmrBucketGames: jest.fn(async (_owner, _filters, opts) => ({ lo: opts.lo, hi: opts.hi, games: [] })) };
  const app = express();
  app.use(buildAggregationsRouter({ aggregations, streak: {}, macroReport: {}, userCache: cache,
    auth: (req, _res, next) => { req.auth = { userId: "a", source: "device" }; next(); } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || error.message }));
  return { app, cache, aggregations, send: jest.spyOn(cache, "send") };
}
const ROUTES = [
  ["/opp-mmr-buckets?bucket_width=100", "oppMmrBuckets", { bucketWidth: 100 }],
  ["/opp-mmr-buckets/games?lo=4000&hi=4100", "oppMmrBucketGames", { lo: 4000, hi: 4100 }],
];

test.each(ROUTES)("%s keys the cached body by the day's floor, and the service computes with that same options object", async (path, kind, base) => {
  // Five minutes before UTC midnight, so the next day starts well inside the 600 s entry lifetime.
  const f = fixture(); let now = MIDNIGHT + DAY - 300000; jest.spyOn(Date, "now").mockImplementation(() => now);
  const first = await request(f.app).get(path).set("If-None-Match", 'W/"none"');
  expect(first.status).toBe(200); expect(first.headers["cache-control"]).toBe("private, no-cache");
  expect(f.send.mock.calls[0].slice(2, 5)).toEqual(["a", kind, expect.any(Object)]);
  expect(f.send.mock.calls[0][5]).toEqual({ ...base, trustFloor: oppMmrTrustDayFloor(now).toISOString() });
  expect(f.aggregations[kind].mock.calls[0][2]).toBe(f.send.mock.calls[0][5]);
  now = MIDNIGHT + DAY - 1;
  expect((await request(f.app).get(path).set("If-None-Match", first.headers.etag)).status).toBe(304);
  now = MIDNIGHT + DAY;
  const nextDay = await request(f.app).get(path).set("If-None-Match", first.headers.etag);
  expect(nextDay.status).toBe(200); expect(f.aggregations[kind]).toHaveBeenCalledTimes(2);
  expect(f.aggregations[kind].mock.calls[1][2].trustFloor).toBe(oppMmrTrustDayFloor(MIDNIGHT + DAY).toISOString());
});

test.each(ROUTES)("%s with the cache off passes no floor and answers plain JSON", async (path, kind, base) => {
  const f = fixture(false);
  const response = await request(f.app).get(path);
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBeUndefined();
  expect(f.aggregations[kind].mock.calls[0][2]).toStrictEqual(base);
});
