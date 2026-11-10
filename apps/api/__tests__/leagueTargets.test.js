// @ts-nocheck
"use strict";

/**
 * Next-league targets, API side:
 *   1. league_timing_percentiles is built from guide_samples only, keyed by
 *      (era, opponent league, matchup), with the k = 50 sample floor, the
 *      distinct-player floor, the per-player cap and a per-timing floor;
 *      no pseudonymous key reaches the output collection;
 *   2. personal timings use only the caller's own samples, in one era;
 *   3. the personal side (/v1/benchmarks/targets) picks the most played
 *      matchup, medians the last 20 games and pairs net MMR like Trends;
 *   4. the HTTP contract, the drilldown filters and the league prefs.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const {
  LeagueTimingPercentilesService,
  COLLECTION_NAME,
  sampleTiming,
} = require("../src/services/leagueTimingPercentiles");
const { LeagueTargetsService, netMmrPerGame } = require("../src/services/leagueTargets");
const { buildBenchmarksRouter } = require("../src/routes/benchmarks");
const { parseFilters, gamesMatchStage } = require("../src/util/parseQuery");
const { sanitizeLeagueTargets } = require("../src/util/leagueTargetsPreferences");

const MASTER = 5;
const DIAMOND = 4;
const PLATINUM = 3;

let mongo;
let db;
let timings;
let n = 0;

/** One stored guide sample (the shape services/guideSamples.js writes). */
function sample(user, overrides = {}, milestones = {}) {
  n += 1;
  return {
    userHash: `user-hash-${user}`, gameHash: `game-${n}`, buildKey: "PvZ - Stargate", matchup: "PvZ", era: "after",
    eraRule: 2, leagueBand: MASTER, mmrBand: 4500, result: "Victory", map: "Alcyone LE", durationSec: 700,
    playedOn: new Date(Date.UTC(2026, 9, 1 + (n % 28))), createdAt: new Date(),
    milestones: { "Nexus#2": 80 + (n % 21), "Nexus#3": 200 + (n % 31), WarpGateResearch: 300, Charge: 290, Stargate: 260, ...milestones },
    ...overrides,
  };
}

/** ``count`` samples spread across ``users`` players. */
function band(count, users, overrides = {}, milestones = {}) {
  return Array.from({ length: count }, (_, i) => sample(i % users, overrides, milestones));
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  db = await connect({ uri: mongo.getUri(), dbName: "league_targets_test" });
  timings = new LeagueTimingPercentilesService(db, { logger: null });
});

afterAll(async () => {
  await db?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all([db.guideSamples.deleteMany({}), db.games.deleteMany({}), db.db.collection(COLLECTION_NAME).deleteMany({})]);
});

describe("league timing percentiles", () => {
  test("serves only bands above the k = 50 and distinct-player floors, per era", async () => {
    await db.guideSamples.insertMany([
      ...band(60, 6),
      ...band(49, 7, { leagueBand: DIAMOND }),
      // One prolific player: capped at 50 samples and still one player.
      ...band(70, 1, { leagueBand: PLATINUM }),
      ...band(55, 5, { era: "before" }),
      // Stored under era rule 1: never trusted until relabelled.
      ...band(60, 6, { leagueBand: 2, eraRule: 1 }),
    ]);
    await timings.recompute();
    const rows = await db.db.collection(COLLECTION_NAME).find({}).toArray();
    expect(rows.map((r) => `${r.era}:${r.leagueId}`).sort()).toEqual(["after:3", "after:4", "after:5", "before:5"]);
    expect(rows.find((r) => r.leagueId === PLATINUM)).toMatchObject({ n: 50, users: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/user-hash|userHash|game-\d/);

    const master = await timings.lookup({ leagueId: MASTER, matchup: "pvz" });
    expect(master).toMatchObject({ era: "after", league: "Master", matchup: "PvZ", n: 60 });
    expect(master.timings.natural.deciles).toHaveLength(9);
    expect(master.timings.natural.deciles[4]).toBeGreaterThanOrEqual(85);
    expect(master.timings.natural.deciles[4]).toBeLessThanOrEqual(95);
    expect(await timings.lookup({ leagueId: DIAMOND, matchup: "PvZ" })).toBeNull();
    expect(await timings.lookup({ leagueId: PLATINUM, matchup: "PvZ" })).toBeNull();
    expect(await timings.lookup({ leagueId: 2, matchup: "PvZ" })).toBeNull();
    expect((await timings.lookup({ leagueId: MASTER, matchup: "PvZ", era: "before" })).n).toBe(55);
    expect(await timings.lookup({ leagueId: MASTER, matchup: "PvZ", era: "sometime" })).toBeNull();
  });

  test("timings take the earliest tracked step and keep a per-timing floor", async () => {
    // 60 samples, but only 40 reached any key tech building.
    await db.guideSamples.insertMany([
      ...band(40, 8, {}, { TwilightCouncil: 250 }),
      ...band(20, 4, {}, { Stargate: undefined }),
    ].map((row) => {
      if (row.milestones.Stargate === undefined) delete row.milestones.Stargate;
      return row;
    }));
    await timings.recompute();
    const master = await timings.lookup({ leagueId: MASTER, matchup: "PvZ" });
    expect(master.timings.keyTech.n).toBe(40);
    expect(master.timings.keyTech.deciles).toBeNull();
    // Charge (290) finished before Warpgate (300): the first upgrade is 290.
    expect(master.timings.firstUpgrade.deciles).toEqual(Array(9).fill(290));
    expect(sampleTiming({ matchup: "PvZ", milestones: { Stargate: 260, TwilightCouncil: 250 } }, "keyTech")).toBe(250);
    expect(sampleTiming({ matchup: "ZvT", milestones: { "Hatchery#2": 40, Lair: 260 } }, "natural")).toBe(40);
    expect(sampleTiming({ matchup: "ZvT", milestones: {} }, "keyTech")).toBeNull();
  });

  test("a recompute drops bands the corpus no longer produces", async () => {
    await db.guideSamples.insertMany(band(60, 6));
    await timings.recompute();
    await db.guideSamples.deleteMany({});
    await timings.recompute();
    expect(await db.db.collection(COLLECTION_NAME).countDocuments({})).toBe(0);
  });

  test("personal medians use the caller's own samples in their latest era", async () => {
    await db.guideSamples.insertMany([
      sample("me", { playedOn: new Date("2026-10-20") }, { "Nexus#2": 90 }),
      sample("me", { playedOn: new Date("2026-10-21") }, { "Nexus#2": 100 }),
      sample("me", { playedOn: new Date("2026-10-22") }, { "Nexus#2": 110 }),
      sample("me", { playedOn: new Date("2026-06-30"), era: "before" }, { "Nexus#2": 160 }),
      sample("someone", { playedOn: new Date("2026-10-23") }, { "Nexus#2": 10 }),
    ]);
    const mine = await timings.personal("user-hash-me", "PvZ");
    expect(mine).toMatchObject({ era: "after", n: 3, timings: { natural: { n: 3, median: 100 } } });
    expect((await timings.personal("user-hash-none", "PvZ")).timings.natural).toEqual({ n: 0, median: null });
  });
});

describe("personal targets", () => {
  const OWNER = "targets-owner";
  let seq = 0;
  function game(overrides = {}) {
    seq += 1;
    return {
      userId: OWNER, gameId: `t-${seq}`, date: new Date(Date.UTC(2026, 10, 1, 0, seq)), result: "Victory",
      myRace: "Protoss", opponent: { race: "Zerg" }, isLadderGame: true, matchFormat: "1v1", playerCount: 2,
      spq: 70, macroScore: 60, apm: 150, durationSec: 600, myToonHandle: "1-S2-1-111", ...overrides,
    };
  }

  test("picks the most played matchup, medians the last 20 games and reads replay MMR", async () => {
    await db.games.insertMany([
      ...Array.from({ length: 25 }, (_, i) => game({ spq: 50 + i })),
      ...Array.from({ length: 3 }, () => game({ opponent: { race: "Terran" } })),
      game({ isLadderGame: false, spq: 1 }),
      game({ myMmr: 4100, myMmrSource: "pulse", opponent: { race: "Terran" } }),
      game({ myMmr: 4050, myMmrSource: "replay", opponent: { race: "Terran" } }),
      game({ userId: "someone-else", myMmr: 6000, myMmrSource: "replay" }),
    ].map((row, i) => ({ ...row, date: new Date(Date.UTC(2026, 10, 1, 0, i)) })));
    const svc = new LeagueTargetsService(db, { timings, userHash: (id) => `user-hash-${id}` });
    const out = await svc.personal(OWNER, null);
    expect(out.matchup).toBe("PvZ");
    expect(out.matchups[0]).toEqual({ matchup: "PvZ", games: 25 });
    // The newest 20 PvZ games carry spq 55..74: median 64.5.
    expect(out.sample).toEqual({ n: 20, limit: 20 });
    expect(out.medians.spq).toEqual({ n: 20, median: 64.5 });
    // The pulse-sourced rating is ignored; the replay one is current.
    expect(out.mmr).toMatchObject({ current: 4050, region: "NA" });
    expect((await svc.personal(OWNER, "PvT")).sample.n).toBe(5);
  });

  test("net MMR per game follows the Trends pairing rules", () => {
    const rows = [
      { myToonHandle: "1-S2-1-1", myRace: "Protoss", myMmr: 4010, myMmrSource: "replay", result: "Victory" },
      { myToonHandle: "1-S2-1-1", myRace: "Protoss", myMmr: 4026, myMmrSource: "replay", result: "Defeat" },
      { myToonHandle: "1-S2-1-1", myRace: "Protoss", myMmr: 4000, myMmrSource: "replay", result: "Victory" },
      // Sign mismatch (a loss that "gained") and an outlier swing are skipped.
      { myToonHandle: "1-S2-1-1", myRace: "Protoss", myMmr: 3990, myMmrSource: "replay", result: "Defeat" },
      { myToonHandle: "1-S2-1-1", myRace: "Protoss", myMmr: 3700, myMmrSource: "replay", result: "Victory" },
      // Another account never joins the chain.
      { myToonHandle: "2-S2-1-9", myRace: "Protoss", myMmr: 5000, myMmrSource: "replay", result: "Victory" },
    ];
    // Newest first: pairs (oldest→newest) 3700→3990 (outlier), 3990→4000
    // (a loss that gained: skipped), 4000→4026 (+26 win), 4026→4010 (-16 loss).
    expect(netMmrPerGame(rows)).toEqual({ pairs: 2, games: 4, perGame: 5, window: 30 });
    expect(netMmrPerGame([])).toMatchObject({ pairs: 0, perGame: null });
  });
});

describe("HTTP contract, drill filters and preferences", () => {
  function app(deps) {
    const server = express();
    server.use("/v1", buildBenchmarksRouter({
      leaguePercentiles: { lookup: async () => null },
      ...deps,
      auth: (req, res, next) => { req.auth = { userId: "owner" }; next(); },
    }));
    return server;
  }

  test("timings: 400 for bad params, 404 below the floor, the table above it", async () => {
    await db.guideSamples.insertMany(band(60, 6));
    await timings.recompute();
    const server = app({ leagueTimings: timings });
    await request(server).get("/v1/benchmarks/timings?leagueId=9&matchup=PvZ").expect(400);
    await request(server).get("/v1/benchmarks/timings?leagueId=5&matchup=PvZ&era=later").expect(400);
    expect((await request(server).get("/v1/benchmarks/timings?leagueId=4&matchup=PvZ").expect(404)).body.error.code).toBe("not_enough_data");
    const ok = await request(server).get("/v1/benchmarks/timings?leagueId=5&matchup=PvZ").expect(200);
    expect(ok.body.table).toMatchObject({ league: "Master", matchup: "PvZ", era: "after" });
  });

  test("targets are private and validate the matchup", async () => {
    const personal = jest.fn(async () => ({ matchup: "PvZ" }));
    const server = app({ leagueTargets: { personal } });
    const res = await request(server).get("/v1/benchmarks/targets?matchup=PvZ").expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(personal).toHaveBeenCalledWith("owner", "PvZ");
    await request(server).get("/v1/benchmarks/targets?matchup=Pv").expect(400);
  });

  test("sq_max / apm_max are exclusive ceilings for the Targets drilldowns", () => {
    const filters = parseFilters({ sq_max: "72", apm_max: "0" });
    expect(filters).toEqual({ sqMax: 72 });
    expect(gamesMatchStage("u", filters).spq).toEqual({ $lt: 72 });
    expect(gamesMatchStage("u", parseFilters({ apm_max: "180" })).apm).toEqual({ $lt: 180 });
  });

  test("league target preferences fail soft on read and strictly on write", () => {
    expect(sanitizeLeagueTargets({ targetLeague: 5, targetMmr: 4600 }, true))
      .toEqual({ leagueOverride: null, targetLeague: 5, targetMmr: 4600 });
    expect(sanitizeLeagueTargets({ leagueOverride: 9 })).toEqual({ leagueOverride: null, targetLeague: null, targetMmr: null });
    expect(() => sanitizeLeagueTargets({ leagueOverride: 9 }, true)).toThrow("invalid_league_targets");
    expect(() => sanitizeLeagueTargets({ extra: 1 }, true)).toThrow("invalid_league_targets");
    expect(() => sanitizeLeagueTargets([], true)).toThrow("invalid_league_targets");
  });
});
