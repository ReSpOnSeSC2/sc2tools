// @ts-nocheck
"use strict";

const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { naturalSeconds } = require("../src/services/gameContext");
const { MIN_SAMPLE } = require("../src/services/leaguePercentiles");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

let h;
const at = new Date("2026-10-20T12:00:00Z");
const endpoint = (id = "current", who = "owner") => request(h.app).get(`/v1/games/${id}/context`).set("authorization", h.bearer(who));
function game(id, seconds = -1, patch = {}) {
  return { userId: "u_owner", gameId: id, date: new Date(at.getTime() + seconds * 1000),
    myRace: "Protoss", myBuild: null, isLadderGame: true, matchFormat: "1v1", playerCount: 2,
    macroScore: 70, apm: 150, spq: 60, durationSec: 600,
    opponent: { race: "Zerg", leagueId: 4 }, ...patch };
}
function band(n = 100) {
  return { leagueId: 4, league: "Diamond", matchup: "PvZ", n, updatedAt: at,
    metrics: Object.fromEntries(["macroScore", "apm", "spq", "durationSec", "myMmr"].map((key) => [key, { n, deciles: [10,20,30,40,50,60,70,80,90] }])) };
}
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await h.db.games.deleteMany({}); await h.db.gameDetails.deleteMany({});
  await h.db.db.collection("league_percentiles").deleteMany({});
  h.services.gameContext.cache.clear();
  h.services.gameContext.timingCache.clear();
});

test("uses only the latest50 earlier owner ranked1v1s in the same concrete matchup", async () => {
  const before = Array.from({ length: 60 }, (_, i) => game(`prior-${i}`, i - 61, { macroScore: i + 1, apm: 0 }));
  await h.db.games.insertMany([game("current", 0), ...before,
    game("future", 1, { macroScore: 999 }), game("same-date", 0, { macroScore: 999 }),
    game("foreign", -1, { userId: "u_other", macroScore: 999 }),
    game("custom", -1, { isLadderGame: false, macroScore: 999 }),
    game("unknown-ranked", -1, { isLadderGame: null, macroScore: 999 }),
    game("team", -1, { matchFormat: "team", playerCount: 4, macroScore: 999 }),
    game("resumed", -1, { isResumedFromReplay: true, macroScore: 999 }),
    game("other-matchup", -1, { opponent: { race: "Terran" }, macroScore: 999 }),
  ]);
  const aggregate = jest.spyOn(h.db.games, "aggregate");
  const response = await endpoint();
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body).toMatchObject({ matchup: "PvZ", personal: { n: 50, limit: 50,
    metrics: { macroScore: { n: 50 }, apm: { n: 50, median: 0, p25: 0, p75: 0 } } }, league: null });
  expect(response.body.personal.metrics.macroScore.median).toBeGreaterThanOrEqual(35);
  expect(response.body.personal.metrics.macroScore.median).toBeLessThanOrEqual(36);
  const [pipeline, options] = aggregate.mock.calls[0];
  expect(options.hint).toEqual({ userId: 1, date: -1, _id: -1 });
  expect(pipeline.findIndex((step) => step.$limit === 50)).toBeLessThan(pipeline.findIndex((step) => step.$group));
  expect(pipeline[0].$match).toMatchObject({ userId: "u_owner", date: { $lt: at } });
  expect(JSON.stringify(response.body)).not.toMatch(/userId|gameId|buildLog|pulseId/);
});

test("null/missing metrics keep individual n, with no zero invented; legacy two-player 1v1 is supported", async () => {
  const legacy = game("legacy", -2, { apm: null, spq: undefined }); delete legacy.matchFormat;
  await h.db.games.insertMany([game("current", 0), legacy, game("prior", -1, { macroScore: null, durationSec: null })]);
  const body = (await endpoint()).body;
  expect(body.personal.metrics).toMatchObject({ macroScore: { n: 1, median: 70 }, apm: { n: 1, median: 150 },
    spq: { n: 1, median: 60 }, durationSec: { n: 1, median: 600 } });
});

test.each(["mine", "opponent"])("a reanalyzed %s race invalidates the previous matchup cache", async (side) => {
  await h.db.games.insertMany([game("current", 0), game("pvz", -1, { macroScore: 50 }),
    game("new-matchup", -1, { macroScore: 80, ...(side === "mine" ? { myRace: "Terran" } : { opponent: { race: "Terran", leagueId: 4 } }) })]);
  expect((await endpoint()).body).toMatchObject({ matchup: "PvZ", personal: { metrics: { macroScore: { median: 50 } } } });
  await h.db.games.updateOne({ gameId: "current" }, { $set: side === "mine" ? { myRace: "Terran" } : { "opponent.race": "Terran" } });
  expect((await endpoint()).body).toMatchObject({ matchup: side === "mine" ? "TvZ" : "PvT", personal: { metrics: { macroScore: { median: 80 } } } });
});

test("cached league lookup has no corpus aggregate and sparse metric distributions never leave either endpoint", async () => {
  await h.db.games.insertOne(game("current", 0));
  const table = band(); table.metrics.spq = { n: 49, deciles: Array(9).fill(12345) };
  await h.db.db.collection("league_percentiles").insertOne(table);
  const recompute = jest.spyOn(h.services.leaguePercentiles, "recompute");
  const response = await endpoint();
  expect(response.body.league).toMatchObject({ table: { n: 100, league: "Diamond", metrics: { spq: { n: 49, deciles: null } } },
    percentiles: { macroScore: 70, spq: null } });
  expect(JSON.stringify(response.body)).not.toContain("12345");
  const foundation = await request(h.app).get("/v1/benchmarks?leagueId=4&matchup=PvZ").set("authorization", h.bearer("owner"));
  expect(foundation.body.table.metrics.spq).toEqual({ n: 49, deciles: null });
  expect(recompute).not.toHaveBeenCalled();
});

test.each([0, 49])("league bands below50 (%i) leave the personal comparison available", async (n) => {
  await h.db.games.insertMany([game("current", 0), game("prior")]);
  await h.db.db.collection("league_percentiles").insertOne(band(n));
  expect((await endpoint()).body).toMatchObject({ personal: { n: 1 }, league: null });
});

test("the exact50 league floor is served", async () => {
  await h.db.games.insertOne(game("current", 0));
  await h.db.db.collection("league_percentiles").insertOne(band(MIN_SAMPLE));
  expect((await endpoint()).body.league.table.n).toBe(50);
});

test("confirmed check-in chooses its effective custom build timing cohort, not the detected build", async () => {
  const build = { name: "My checked-in expansion", slug: "checked", source: "custom" };
  await h.db.games.insertMany([game("current", 0, { myBuild: "Detected stale label", _customBuildSlug: "detected",
    buildIntent: { status: "confirmed", applied: true, build, detected: { name: "Detected", slug: "detected" }, notes: "secret-notes" } }),
    ...Array.from({ length: 5 }, (_, i) => game(`checked-${i}`, -i-1, { myBuild: build.name, _customBuildSlug: "checked", buildLog: [`[0:00] Nexus`, `[2:0${i}] Nexus`, `[4:00] Nexus`] })),
    ...Array.from({ length: 5 }, (_, i) => game(`detected-${i}`, -i-1, { myBuild: "Detected", _customBuildSlug: "detected", buildLog: ["[9:00] Nexus"] })),
  ]);
  const body = (await endpoint()).body;
  expect(body.personal).toMatchObject({ expansionTimings: { Nexus: 122 }, expansionSample: 5, expansionMinSample: 5, build: build.name });
  expect(JSON.stringify(body)).not.toMatch(/secret-notes|detected|checked-\d/);
});

test("timing sample has a25-game cap, a5-observation floor and projected one-at-a-time modern detail reads", async () => {
  const current = game("current", 0, { myBuild: "Blink" });
  await h.db.games.insertMany([current, ...Array.from({ length: 30 }, (_, i) => game(`prior-${i}`, -i-1, { myBuild: "Blink" }))]);
  const read = jest.spyOn(h.services.gameDetails, "findMany").mockImplementation(async (_owner, ids, opts) => {
    expect(ids).toHaveLength(1); expect(opts).toEqual({ fields: ["buildLog"], concurrency: 1 });
    return new Map([[ids[0], { buildLog: ["[0:00] Nexus", "[2:30] Nexus"] }]]);
  });
  let body = (await endpoint()).body;
  expect(read).toHaveBeenCalledTimes(25);
  expect(body.personal).toMatchObject({ expansionTimings: { Nexus: 150 }, expansionSample: 25, expansionLimit: 25 });
  await endpoint(); expect(read).toHaveBeenCalledTimes(25);
  h.services.gameContext.cache.clear();
  h.services.gameContext.timingCache.clear();
  read.mockImplementation(async (_owner, ids) => new Map([[ids[0], { buildLog: Number(ids[0].split("-")[1]) < 4 ? ["[2:30] Nexus"] : [] }]]));
  body = (await endpoint()).body;
  expect(body.personal.expansionTimings).toEqual({}); expect(body.personal.expansionSample).toBe(4);
});

test("owner lookup defeats a warm cache after delete; foreign/missing/resumed and anonymous games remain private", async () => {
  await h.db.games.insertMany([game("current", 0), game("foreign", 0, { userId: "u_other" }), game("resumed", 0, { isResumedFromReplay: true })]);
  expect((await endpoint()).status).toBe(200);
  expect((await endpoint("foreign")).status).toBe(404);
  expect((await endpoint("missing")).status).toBe(404);
  expect((await endpoint("resumed")).status).toBe(404);
  expect((await request(h.app).get("/v1/games/current/context")).status).toBe(401);
  await h.db.games.deleteMany({ userId: "u_owner" });
  expect((await endpoint()).status).toBe(404);
});

test("neighboring contexts reuse overlapping natural scalars rather than rereading every detail", async () => {
  await h.db.games.insertMany([game("current", 0, { myBuild: "Blink" }), game("later", 1, { myBuild: "Blink" }),
    ...Array.from({ length: 5 }, (_, i) => game(`prior-${i}`, -i-1, { myBuild: "Blink" }))]);
  const read = jest.spyOn(h.services.gameDetails, "findMany").mockImplementation(async (_owner, ids) =>
    new Map([[ids[0], { buildLog: ids[0].startsWith("prior-") ? ["[2:00] Nexus"] : [] }]]));
  expect((await endpoint()).body.personal.expansionTimings).toEqual({ Nexus: 120 });
  expect((await endpoint("later")).body.personal.expansionTimings).toEqual({ Nexus: 120 });
  expect(read).toHaveBeenCalledTimes(6);
});

test("cold context work is bounded, repeated callers coalesce, and a busy response can be retried", async () => {
  await h.db.games.insertMany(Array.from({ length: 5 }, (_, i) => game(`current-${i}`, 0)));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  jest.spyOn(h.services.leaguePercentiles, "lookup").mockImplementation(() => blocked);
  const service = h.services.gameContext;
  const jobs = Array.from({ length: 4 }, (_, i) => service.get("u_owner", `current-${i}`));
  while (service.inflight.size < 4) await new Promise((resolve) => setTimeout(resolve, 5));
  const duplicate = service.get("u_owner", "current-0");
  await expect(service.get("u_owner", "current-4")).rejects.toMatchObject({ status: 503, code: "game_context_busy" });
  release(null);
  const results = await Promise.all([...jobs, duplicate]);
  expect(results[0]).toEqual(results[4]);
  expect(await service.get("u_owner", "current-4")).toMatchObject({ personal: { n: 0 } });
});

test("missing race/date never broadens the cohort and in-flight repeated requests coalesce", async () => {
  await h.db.games.insertOne(game("current", 0, { myRace: "Random" }));
  const aggregate = jest.spyOn(h.db.games, "aggregate");
  const [a,b] = await Promise.all([endpoint(), endpoint()]);
  expect(a.body).toEqual(b.body); expect(a.body).toMatchObject({ matchup: null, personal: { n: 0 }, league: null });
  expect(aggregate).not.toHaveBeenCalled();
});

test.each([["Nexus", ["[0:00] Nexus", "[2:03] Nexus", "[4:00] Nexus"], 123],
  ["Hatchery", ["[0:00] Hatchery", "[1:45] Hatchery"], 105],
  ["CommandCenter", ["[0:00] CommandCenter", "[1:00] OrbitalCommand", "[2:00] CommandCenter"], 120],
  ["Nexus", ["[0:00] Nexus", "[1:99] Nexus", "[1:20] NexusFake"], null]])("natural %s handles starting bases and exact tokens", (token, log, expected) => {
  expect(naturalSeconds(log, token)).toBe(expected);
});
