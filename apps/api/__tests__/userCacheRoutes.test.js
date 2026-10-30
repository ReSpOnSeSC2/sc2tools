// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { UserRevision } = require("../src/util/userRevision");
const { UserCache } = require("../src/middleware/userCache");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const ROUTES = [["timeseries", "/timeseries"], ["dayHourHeatmap", "/timeseries/day-hour"],
  ["lengthBuckets", "/length-buckets"], ["activityCalendar", "/activity-calendar"],
  ["momentum", "/momentum"], ["mapTrend", "/timeseries/maps"],
  ["summary", "/summary"], ["macroSummary", "/macro/summary"],
  ["mmrProgression", "/timeseries/mmr"], ["myBuildMixOverTime", "/timeseries/my-builds"],
  ["oppStrategyMixOverTime", "/timeseries/opp-strategies"]];
// Owner-game kinds served by their own services rather than AggregationsService.
const PLAIN = [["streak", "/streak"], ["macroReport", "/macro/report"]];
// Net-MMR kinds, whose routes pass exactly the service's options.
const NET = [["netMmrByMatchup", "/mmr-by-matchup"], ["netMmrByOpponent", "/mmr-by-matchup/opponents"]];
function fixture(enabled = true, legacy = false) {
  const rows = new Map([ ["a", { userId: "a", clerkUserId: "clerk-a", dataRev: 0 }], ["b", { userId: "b", dataRev: 0 }] ]);
  let deleted = false, revoked = false;
  const users = { findOne: jest.fn(async ({ userId }) => rows.get(userId)),
    findOneAndUpdate: jest.fn(async ({ userId }) => { const row = rows.get(userId); if (!row) return null; row.dataRev += 1; return row; }) };
  const revisions = new UserRevision(users, { enabled, isDeleted: async () => deleted });
  const cache = new UserCache(revisions, { enabled }); const aggregations = {};
  for (const method of [...ROUTES.map(([name]) => name), ...PLAIN.map(([name]) => name), "matchups", "maps", "mapMatchups", "buildVsStrategy",
    "matchupTimeseries", "oppMmrBuckets", "randomSummary", "explorer", "distinctMaps", "netMmrByMatchup", "netMmrByOpponent", "gamesList"]) {
    aggregations[method] = jest.fn(async (owner, ...input) => ({ owner, method, input, points: [{ date: new Date(0), missing: null }] }));
  }
  aggregations.resolveMomentumPolicy = async (_owner, gap) => ({ sessionGapMinutes: gap ?? 90, sessionPolicyGeneration: 0, lease: null });
  aggregations.assertSessionPolicy = () => {};
  const app = express();
  const streak = { current: (...input) => aggregations.streak(...input) };
  const macroReport = { report: (...input) => aggregations.macroReport(...input) };
  app.use(buildAggregationsRouter({ aggregations, streak, macroReport, userCache: legacy ? undefined : cache,
    auth: (req, res, next) => {
      if (!req.headers.authorization || revoked) { res.status(401).json({ error: { code: "unauthorized" } }); return; }
      req.auth = { userId: req.headers.authorization === "Bearer b" ? "b" : "a", source: "device" }; next();
    } }));
  app.use((error, req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code || error.message } }));
  return { app, users, rows, cache, revisions, aggregations, setDeleted: () => { deleted = true; }, revoke: () => { revoked = true; } };
}
const get = (app, path, owner = "a") => request(app).get(path).set("authorization", `Bearer ${owner}`);
test.each([...ROUTES, ...PLAIN, ...NET])("%s preserves200 DTOs and conditionally returns private empty304", async (method, path) => {
  const f = fixture(); const first = await get(f.app, path); const second = await get(f.app, path);
  expect(second.status).toBe(200); expect(second.body).toEqual(first.body);
  expect(second.headers["cache-control"]).toBe("private, no-cache"); expect(second.headers.etag).toMatch(/^W\/"uc1-[0-9a-f]{64}"$/);
  const reads = f.users.findOne.mock.calls.length;
  const same = await get(f.app, path).set("If-None-Match", second.headers.etag);
  expect(same.status).toBe(304); expect(same.text).toBe(""); expect(same.headers.etag).toBe(second.headers.etag);
  expect(same.headers["content-length"]).toBeUndefined(); expect(same.headers["content-type"]).toBeUndefined();
  expect(same.headers.vary).toContain("Authorization"); expect(f.users.findOne.mock.calls.length).toBe(reads + 1);
  expect(f.aggregations[method]).toHaveBeenCalledTimes(1);
});
test("off is byte/header/status-identical to the old router and makes zero revision commands", async () => {
  const old = fixture(false, true), off = fixture(false);
  for (const [, path] of [...ROUTES, ...PLAIN, ...NET]) {
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
test.each(["/matchups", "/maps", "/maps/matchups", "/build-vs-strategy", "/timeseries/matchups", "/opp-mmr-buckets", "/random-summary",
  "/trends/explorer/periods", "/games-list", "/maps/diagnostic"])("%s without captured dependencies or explicit coverage never enters retention", async (path) => {
  const f = fixture(); expect((await get(f.app, path)).status).toBe(200); expect((await get(f.app, path)).status).toBe(200);
  expect(f.users.findOne).not.toHaveBeenCalled(); expect(f.cache.completed.size).toBe(0);
});
test("each non-dependent covered kind keeps its own retained body in one cache", async () => {
  const f = fixture();
  for (const [method, path] of [...ROUTES, ...PLAIN, ...NET]) expect([path, (await get(f.app, path)).body.method]).toEqual([path, method]);
  expect(f.cache.completed.size).toBe(ROUTES.length + PLAIN.length + NET.length);
});

test.each([...ROUTES.slice(6), ...PLAIN, ...NET])("%s isolates filters and owners and retires committed/unknown results", async (method, path) => {
  const f = fixture();
  const first = await get(f.app, path), tag = first.headers.etag;
  for (const [query, owner] of [["?race=Z", "a"], ["", "b"]]) {
    const other = await get(f.app, path + query, owner).set("If-None-Match", tag);
    expect(other.status).toBe(200); expect(other.headers.etag).not.toBe(tag);
  }
  await f.revisions.run("a", async () => true);
  const changed = await get(f.app, path).set("If-None-Match", tag);
  expect(changed.status).toBe(200); expect(changed.headers.etag).not.toBe(tag);
  await expect(f.revisions.run("a", async () => { throw new Error("unknown write"); })).rejects.toThrow("unknown write");
  expect((await get(f.app, path).set("If-None-Match", changed.headers.etag)).status).toBe(200);
  expect(f.aggregations[method]).toHaveBeenCalledTimes(5);
});

test.each([
  ["netMmrByMatchup", "/mmr-by-matchup", ["", "?group_by=matchup", "?tz=Europe%2FBerlin", "?group_by=matchup&tz=Europe%2FBerlin"]],
  ["netMmrByOpponent", "/mmr-by-matchup/opponents", ["", "?opp_race=Z", "?oppRace=T", "?my_race=P", "?search=abc", "?min_pairs=3",
    "?sort=net", "?sort=net&order=asc", "?limit=10", "?offset=5"]],
])("%s keys every route option and passes the same options to the service", async (method, path, queries) => {
  const f = fixture();
  for (const query of queries) {
    expect((await get(f.app, path + query)).status).toBe(200); expect((await get(f.app, path + query)).status).toBe(200);
  }
  expect(f.aggregations[method]).toHaveBeenCalledTimes(queries.length);
  const options = f.aggregations[method].mock.calls.map(([, , opts]) => JSON.stringify(opts));
  expect(new Set(options).size).toBe(queries.length);
});

test.each(ROUTES.slice(8))("%s keys every chart option after route normalization", async (method, path) => {
  const f = fixture();
  for (const query of ["?interval=day", "?interval=month", "?interval=month&tz=Europe%2FBerlin"]) {
    expect((await get(f.app, path + query)).status).toBe(200);
    expect((await get(f.app, path + query)).status).toBe(200);
  }
  expect(f.aggregations[method]).toHaveBeenCalledTimes(3);
});
test("an owner erased during computation cannot receive the delayed answer", async () => {
  const f = fixture(); let finish; let started;
  const began = new Promise((resolve) => { started = resolve; });
  f.aggregations.timeseries.mockImplementation(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  const response = get(f.app, "/timeseries").then((result) => result); await began;
  f.rows.delete("a"); f.revisions.forget("a"); finish({ private: "erased" });
  expect((await response).status).toBe(401); expect(f.cache.completed.size).toBe(0);
});

test("validators cannot substitute another owner, filter, committed revision or unknown write", async () => {
  const f = fixture(); const first = await get(f.app, "/timeseries"), tag = first.headers.etag;
  for (const [path, owner] of [["/timeseries", "b"], ["/timeseries?map=other", "a"]]) {
    const other = await get(f.app, path, owner).set("If-None-Match", tag);
    expect(other.status).toBe(200); expect(other.headers.etag).not.toBe(tag);
  }
  await f.revisions.run("a", async () => true);
  const changed = await get(f.app, "/timeseries").set("If-None-Match", tag);
  expect(changed.status).toBe(200); expect(changed.headers.etag).not.toBe(tag);
  await expect(f.revisions.run("a", async () => { throw new Error("unknown ack"); })).rejects.toThrow("unknown ack");
  const uncertain = await get(f.app, "/timeseries").set("If-None-Match", changed.headers.etag);
  expect(uncertain.status).toBe(200);
});

test("conditional headers do not bypass revocation, deletion or GDPR fences", async () => {
  for (const mode of ["revoked", "deleted", "fenced"]) {
    const f = fixture(), first = await get(f.app, "/timeseries");
    if (mode === "revoked") f.revoke();
    if (mode === "deleted") f.setDeleted();
    if (mode === "fenced") f.rows.get("a")._gdprMutation = { kind: "restore" };
    const blocked = await get(f.app, "/timeseries").set("If-None-Match", first.headers.etag);
    expect(blocked.status).toBe(mode === "fenced" ? 503 : 401); expect(blocked.status).not.toBe(304);
  }
});

test("cache OFF preserves legacy conditional status/body/header behavior too", async () => {
  const old = fixture(false, true), off = fixture(false);
  const a = await get(old.app, "/timeseries"), b = await get(off.app, "/timeseries");
  const ac = await get(old.app, "/timeseries").set("If-None-Match", a.headers.etag);
  const bc = await get(off.app, "/timeseries").set("If-None-Match", b.headers.etag);
  expect([bc.status, bc.text, bc.headers.etag, bc.headers["cache-control"]])
    .toEqual([ac.status, ac.text, ac.headers.etag, ac.headers["cache-control"]]);
  expect(off.users.findOne).not.toHaveBeenCalled();
});
