// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { AggregationsService } = require("../src/services/aggregations");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const { buildAdminRouter } = require("../src/routes/admin");
const { parseExplorerOptions, trendsExplorer, VIEWS } = require("../src/services/trendsExplorer");
const { extractDetailSummary } = require("../src/services/trendsExplorerDetail");

const A = "1-S2-1-100", B = "2-S2-1-200";
function game(userId, id, minute, extra = {}) {
  return { userId, gameId: id, myToonHandle: userId === "a" ? A : B,
    date: new Date(Date.UTC(2026, 8, 1, 12, minute)),
    durationSec: 600, result: "Victory", myRace: "Protoss", myLadderRace: "Protoss",
    myMmr: 4100, myMmrSource: "replay", isLadderGame: true, playerCount: 2, matchFormat: "1v1",
    map: "Arena", myBuild: "Expand",
    opponent: { race: "Zerg", displayName: "Opponent", toonHandle: "1-S2-1-999", mmr: 4200, mmrSource: "replay" }, ...extra };
}

describe("Trends explorer authorization, real Mongo filters and drilldowns", () => {
  let mongo, client, db, personal, global, app;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    const database = client.db("explorer");
    db = { db: database, games: database.collection("games"), gameDetails: database.collection("game_details"),
      users: database.collection("users"), opponents: database.collection("opponents"), pulseAccounts: database.collection("pulse_accounts") };
    await db.gameDetails.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    for (const collection of [db.games, db.gameDetails, db.users, db.pulseAccounts]) await collection.deleteMany({});
    personal = new AggregationsService(db);
    global = new AdminGlobalTrendsService({ db });
    const auth = (req, res, next) => {
      if (!req.headers.authorization) return res.sendStatus(401);
      req.auth = { userId: req.headers.authorization, clerkUserId: req.headers.authorization };
      next();
    };
    app = express();
    app.use("/v1", buildAdminRouter({ adminGlobalTrends: global, auth, isAdmin: (req) => req.auth.userId === "admin" }));
    app.use("/v1", buildAggregationsRouter({ aggregations: personal, auth }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await db.games.insertMany([
      game("a", "a1", 0), game("a", "a2", 12, { result: "Defeat", map: "Other" }),
      game("a", "a3", 28), game("b", "b1", 8, { myRace: "Terran", myLadderRace: "Terran", myMmr: 5100 }),
      game("copy", "a1", 0, { myToonHandle: A }),
      game("a", "resumed", 40, { isResumedFromReplay: true }),
    ]);
    const summary = extractDetailSummary({ buildLog: ["[03:00] Stalker"], macroBreakdown: {
      bases: [{ name: "Nexus", unit_id: 1, born_time: 0, died_time: 1000 },
        { name: "Nexus", unit_id: 2, born_time: 150, died_time: 1000 }, { name: "Nexus", unit_id: 3, born_time: 300, died_time: 1000 }],
      stats_events: [{ time: 480, food_workers: 60, army_value: 4000 }],
      opp_stats_events: [{ time: 480, food_workers: 50, army_value: 3500 }],
    } });
    for (const userId of ["a", "b", "copy"]) {
      await db.gameDetails.insertOne({ userId, gameId: userId === "b" ? "b1" : "a1", trendsExplorerDetail: summary,
        // A source fact from another user's same game ID must never join.
        buildLog: ["large irrelevant raw data"], mapPlayback: { irrelevant: true } });
    }
  });

  const query = { a_since: "2026-09-01", a_until: "2026-09-01", b_since: "2026-08-01", b_until: "2026-08-31", a_min: 4000, a_max: 5000, b_min: 5000, b_max: 6000 };
  test.each([...VIEWS])("%s has independently authorized personal/global endpoints", async (view) => {
    await request(app).get(`/v1/trends/explorer/${view}`).expect(401);
    await request(app).get(`/v1/admin/global-trends/trends/explorer/${view}`).set("Authorization", "a").expect(403);
    const own = await request(app).get(`/v1/trends/explorer/${view}`).query(query).set("Authorization", "a").expect(200);
    expect(own.body.totalGames).toBe(3);
    expect(own.body.rows.every((row) => !row.gameKeys)).toBe(true);
    expect(own.body.breakdown.every((row) => !row.gameKeys)).toBe(true);
    expect(own.headers["cache-control"]).toBe("private, no-store");
    const all = await request(app).get(`/v1/admin/global-trends/trends/explorer/${view}`).query(query).set("Authorization", "admin").expect(200);
    expect(all.body.totalGames).toBe(4);
  });

  test("global player/race exclusions and empty include selection apply to every new view", async () => {
    for (const view of VIEWS) {
      const opts = parseExplorerOptions(view, query);
      expect((await global.run("explorer", { excluded_players: B }, opts)).totalGames).toBe(3);
      expect((await global.run("explorer", { excluded_races: "P" }, opts)).totalGames).toBe(1);
      expect((await global.run("explorer", { player_selection: "include", included_players: "" }, opts)).totalGames).toBe(0);
    }
  });

  test("drilldowns preserve user/filter scope and exactly match the selected row", async () => {
    const opts = parseExplorerOptions("mmr-gap", {});
    const response = await personal.explorer("a", { map: "Arena" }, opts);
    expect(response.eligibleGames).toBe(2);
    const games = await personal.explorer("a", { map: "Arena" }, { ...opts, games: true, segment: response.rows[0].key, limit: 1 });
    expect(games).toMatchObject({ total: response.rows[0].games, limit: 1, offset: 0 });
    expect(games.games[0]).toMatchObject({ id: "a3", playerId: A });
    expect(games.games[0].userId).toBeUndefined();
    const next = await personal.explorer("a", { map: "Arena" }, { ...opts, games: true, segment: response.rows[0].key, limit: 1, offset: 1 });
    expect(next.games[0].id).toBe("a1");
  });

  test("filtered-out games establish actual previous game for breaks and rematches", async () => {
    const opts = parseExplorerOptions("breaks", { after: "loss" });
    const response = await personal.explorer("a", { map: "Arena" }, opts);
    expect(response.totalGames).toBe(2);
    expect(response.rows.find((r) => r.key === "5-15").games).toBe(1);
    const rematches = await personal.explorer("a", { map: "Arena" }, parseExplorerOptions("rematches", { after: "loss" }));
    expect(rematches.rows.find((r) => r.key === "third").games).toBe(1);
    expect(rematches.eligibleGames).toBe(1);
  });

  test("global race exclusions cannot hide active intervening games from break history", async () => {
    await db.games.deleteMany({});
    await db.games.insertMany([
      game("a", "prior-p", 0),
      game("a", "intervening-t", 12, { myRace: "Terran", myLadderRace: "Terran", result: "Defeat" }),
      game("a", "current-p", 24),
      game("a", "next-p", 36),
      game("b", "other-p", 5),
    ]);
    const options = parseExplorerOptions("breaks", {});
    const cohort = { excluded_races: "T", included_players: A, player_selection: "include" };
    const result = await global.run("explorer", cohort, options);
    expect(result.totalGames).toBe(3);
    expect(result.eligibleGames).toBe(1);
    expect(result.rows.find((r) => r.key === "2-5").games).toBe(1);
    expect(result.rows.find((r) => r.key === "5-15").games).toBe(0);
    const drilldown = await global.run("explorer", cohort, { ...options, games: true, segment: "2-5" });
    expect(drilldown.games.map((g) => g.id)).toEqual(["next-p"]);
    const personalResult = await personal.explorer("a", { race: "P" }, options);
    expect(personalResult.rows).toEqual(result.rows);
    // Similarly named query input cannot enable the private adapter hint.
    const forged = await global.run("explorer", { ...cohort, trendsExplorerSequenceHistory: "true" }, parseExplorerOptions("periods", query));
    expect(forged.totalGames).toBe(3);
  });

  test("comparison dates override only outer date filter and retain map filter", async () => {
    const response = await personal.explorer("a", { since: new Date("2027-01-01"), map: "Arena" }, parseExplorerOptions("periods", query));
    expect(response).toMatchObject({ totalGames: 2, eligibleGames: 2 });
    expect(response.rows[0].games).toBe(2);
    expect(response.rows[1].games).toBe(0);
  });

  test("replay summaries join by BOTH uploader and game identity", async () => {
    await db.gameDetails.deleteMany({ userId: "a" });
    const result = await personal.explorer("a", {}, parseExplorerOptions("execution", {}));
    expect(result).toMatchObject({ totalGames: 3, eligibleGames: 0 });
  });

  test("period drilldowns recover the same historical ratings as MMR difference for only the requested page", async () => {
    await db.games.updateOne({ userId: "a", gameId: "a1" }, { $set: {
      myMmrSource: "unavailable", "opponent.mmr": 6000, "opponent.mmrSource": "pulse",
    } });
    await db.gameDetails.updateOne({ userId: "a", gameId: "a1" }, { $set: {
      "trendsExplorerDetail.ratings": { myMmr: 4050, opponentMmr: 4150 },
    } });
    await db.gameDetails.updateOne({ userId: "copy", gameId: "a1" }, { $set: {
      "trendsExplorerDetail.ratings": { myMmr: 7000, opponentMmr: 7500 },
    } });
    const gapOptions = parseExplorerOptions("mmr-gap", {});
    const gap = await personal.explorer("a", {}, gapOptions);
    const gapGames = await personal.explorer("a", {}, { ...gapOptions, games: true, segment: gap.rows[0].key });
    expect(gapGames.games.find((g) => g.id === "a1")).toMatchObject({ myMmr: 4050, opponentMmr: 4150 });
    const options = parseExplorerOptions("periods", { ...query, a_since: "2026-08-01", a_until: "2026-08-31", b_since: "2026-09-01", b_until: "2026-09-01" });
    const aggregate = jest.spyOn(db.games, "aggregate");
    const result = await personal.explorer("a", {}, { ...options, games: true, segment: "b", offset: 2, limit: 1 });
    expect(result).toMatchObject({ total: 3, offset: 2, limit: 1,
      games: [{ id: "a1", myMmr: 4050, opponentMmr: 4150 }] });
    const lookups = aggregate.mock.calls.filter(([pipeline]) => pipeline.some((stage) => stage.$lookup?.from === "game_details"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0][0][0].$match).toMatchObject({ userId: "a", $and: [{ $or: [{ userId: "a", gameId: "a1" }] }] });
    expect(lookups[0][0].find((stage) => stage.$lookup).$lookup.pipeline[1].$project).toEqual({ _id: 0, "trendsExplorerDetail.ratings": 1 });
    aggregate.mockRestore();
  });

  test("global period drilldowns recover ratings from the canonical uploader and retain cohort restrictions", async () => {
    await db.games.deleteOne({ userId: "copy", gameId: "a1" });
    await db.games.updateOne({ userId: "a", gameId: "a1" }, { $set: { "opponent.mmr": 6000, "opponent.mmrSource": "pulse" } });
    await db.gameDetails.updateOne({ userId: "a", gameId: "a1" }, { $set: { "trendsExplorerDetail.ratings": { myMmr: 4100, opponentMmr: 4250 } } });
    await db.gameDetails.updateOne({ userId: "copy", gameId: "a1" }, { $set: { "trendsExplorerDetail.ratings": { myMmr: 7000, opponentMmr: 7500 } } });
    const opts = parseExplorerOptions("periods", query);
    const result = await global.run("explorer", { excluded_players: B }, { ...opts, games: true, segment: "a", offset: 2, limit: 1 });
    expect(result).toMatchObject({ total: 3, games: [{ id: "a1", playerId: A, myMmr: 4100, opponentMmr: 4250 }] });
  });

  test("period drilldowns keep unknown ratings absent and skip rating joins for pages already carrying replay proof", async () => {
    const options = parseExplorerOptions("periods", query);
    const aggregate = jest.spyOn(db.games, "aggregate");
    await personal.explorer("a", {}, { ...options, games: true, segment: "a", limit: 1 });
    expect(aggregate.mock.calls.some(([pipeline]) => pipeline.some((stage) => stage.$lookup?.from === "game_details"))).toBe(false);
    aggregate.mockRestore();
    await db.games.updateOne({ userId: "a", gameId: "a3" }, { $set: { "opponent.mmr": 6000, "opponent.mmrSource": "pulse" } });
    const missing = await personal.explorer("a", {}, { ...options, games: true, segment: "a", limit: 1 });
    expect(missing.games[0]).toMatchObject({ id: "a3", opponentMmr: null });
  });

  test("explicit account comparisons cannot reach another user's history", async () => {
    const result = await personal.explorer("a", {}, parseExplorerOptions("groups", { group_mode: "players", a_players: A, b_players: B }));
    expect(result.rows.map((r) => r.games)).toEqual([3, 0]);
    expect(result.options.players.map((p) => p.id)).toEqual([A]);
  });

  test("partial summaries keep polling until the active source branch is prepared", async () => {
    await db.gameDetails.updateOne({ userId: "a", gameId: "a1" }, { $set: { trendsExplorerDetail: { version: 1, ratings: {} } } });
    for (const view of ["execution", "leads"]) {
      const result = await personal.explorer("a", {}, parseExplorerOptions(view, {}));
      expect(result.preparation.pendingGames).toBe(1);
      expect(result.eligibleGames).toBe(0);
    }
  });

  test.each(["mmr-gap", "execution", "leads"])("batched %s matches correlated source joins exactly, including preparation coverage and catalogues", async (view) => {
    await db.gameDetails.insertOne({ userId: "a", gameId: "a2", trendsExplorerDetail: { version: 1, ratings: {} } });
    const fallback = new AggregationsService({ games: db.games });
    const options = parseExplorerOptions(view, { milestone: "first:Stalker", metric: "army", weight: "players" });
    const expected = await fallback.explorer("a", {}, options);
    const actual = await personal.explorer("a", {}, options);
    expect(actual).toEqual(expected);
  });

  test("compact detail reads batch authorized source pairs without an all-history correlated lookup", async () => {
    const source = Array.from({ length: 2001 }, (_, index) => game("batch-user", `batch-${index}`, index));
    await db.games.insertMany(source);
    const facts = { version: 1, ratings: { myMmr: 4100, opponentMmr: 4200 } };
    await db.gameDetails.insertMany(source.map((row) => ({ userId: row.userId, gameId: row.gameId, trendsExplorerDetail: facts })));
    const detailReads = jest.spyOn(db.gameDetails, "aggregate");
    // Simulate an upload crossing the admission boundary after its size probe.
    const gameReads = jest.spyOn(db.games, "aggregate").mockImplementationOnce(() => ({ toArray: async () => [{ games: 0 }] }));
    const result = await personal.explorer("batch-user", {}, parseExplorerOptions("mmr-gap", {}));
    expect(result.totalGames).toBe(2001);
    expect(result.eligibleGames).toBe(2001);
    expect(detailReads.mock.calls).toHaveLength(2);
    for (const [pipeline, options] of detailReads.mock.calls) {
      expect(pipeline[0].$match.userId).toBe("batch-user");
      expect(pipeline[0].$match.gameId.$in.length).toBeLessThanOrEqual(2000);
      expect(pipeline[0].$match.gameId.$in.every((id) => id.startsWith("batch-"))).toBe(true);
      expect(pipeline[1].$project).not.toHaveProperty("buildLog");
      expect(pipeline[1].$project).not.toHaveProperty("trendsExplorerDetail.build");
      expect(pipeline.at(-1).$limit).toBe(pipeline[0].$match.gameId.$in.length);
      expect(options.batchSize).toBe(2000);
    }
    const sourceReads = gameReads.mock.calls.filter(([pipeline]) => pipeline.some((stage) => stage.$project));
    expect(sourceReads).toHaveLength(2);
    expect(sourceReads[0][0]).toContainEqual({ $limit: 2001 });
    expect(sourceReads[1][0].some((stage) => stage.$limit)).toBe(false);
    expect(gameReads.mock.calls.some(([pipeline]) => pipeline.some((stage) => stage.$lookup))).toBe(false);
    detailReads.mockRestore();
    gameReads.mockRestore();
  });

  test("a filtered personal history finishes while a large global analysis is waiting on its source query", async () => {
    await db.games.insertMany(Array.from({ length: 2001 }, (_, index) => game("a", `old-${index}`, index, { map: "Archived" })));
    let release, started;
    const blocked = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    const heavy = trendsExplorer({ games: { aggregate: () => ({ toArray: async () => {
      started(); await blocked; return [];
    } }) } }, "global", {}, parseExplorerOptions("leads", {}));
    await entered;
    try {
      const result = await personal.explorer("a", { map: "Arena" }, parseExplorerOptions("leads", {}));
      expect(result.totalGames).toBe(2);
    } finally { release(); await heavy; }
  });

  test("compact batches overlap at most two reads and retain complete totals, preparation coverage, and milestone options", async () => {
    const source = Array.from({ length: 4002 }, (_, index) => game("parallel-user", `parallel-${index}`, index));
    await db.games.insertMany(source);
    await db.gameDetails.insertMany(source.slice(0, 4001).map((row, index) => ({
      userId: row.userId, gameId: row.gameId,
      trendsExplorerDetail: index === 4000 ? { version: 1, ratings: {} } : {
        version: 1, build: { available: true, milestones: [
          { id: "first:Stalker", sec: 180 },
          { id: index < 2000 ? "first:Zealot" : "first:Marine", sec: 200 },
        ] },
      },
    })));
    await db.gameDetails.insertOne({ userId: "other", gameId: "parallel-4001", trendsExplorerDetail: {
      version: 1, build: { available: true, milestones: [{ id: "first:Stalker", sec: 100 }] },
    } });
    const original = db.gameDetails.aggregate.bind(db.gameDetails);
    let release, started;
    const held = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    let active = 0, maximum = 0, calls = 0;
    const reads = jest.spyOn(db.gameDetails, "aggregate").mockImplementation((pipeline, options) => ({ toArray: async () => {
      const number = ++calls;
      maximum = Math.max(maximum, ++active);
      if (calls === 2) started();
      try {
        if (number <= 2) await held;
        return await original(pipeline, options).toArray();
      } finally { active -= 1; }
    } }));
    const options = parseExplorerOptions("execution", { milestone: "first:Stalker" });
    const pending = personal.explorer("parallel-user", {}, options);
    try {
      await entered;
      expect(calls).toBe(2);
      expect(active).toBe(2);
      release();
      const result = await pending;
      expect(maximum).toBe(2);
      expect(calls).toBe(3);
      expect(result).toMatchObject({ totalGames: 4002, eligibleGames: 4000, preparation: { pendingGames: 1 } });
      expect(result.options.milestones.map((row) => row.id)).toEqual(expect.arrayContaining(["first:Stalker", "first:Zealot", "first:Marine"]));
      for (const [pipeline, cursor] of reads.mock.calls) {
        expect(pipeline[0].$match.userId).toBe("parallel-user");
        expect(pipeline[0].$match.gameId.$in.length).toBeLessThanOrEqual(2000);
        expect(cursor.batchSize).toBe(2000);
      }
      const segment = result.rows[0];
      const page = await personal.explorer("parallel-user", {}, { ...options, games: true, segment: segment.key, limit: 20 });
      expect(page.total).toBe(segment.games);
      expect(page.games).toHaveLength(20);
    } finally { release(); await pending; reads.mockRestore(); }
  });

  test("a failed compact batch drains its in-flight sibling and stops assigning further work", async () => {
    await db.games.insertMany(Array.from({ length: 4002 }, (_, index) => game("failure-user", `failure-${index}`, index)));
    let rejectFirst, releaseSecond, started;
    const first = new Promise((_resolve, reject) => { rejectFirst = reject; });
    const second = new Promise((resolve) => { releaseSecond = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    let calls = 0, settled = false;
    const reads = jest.spyOn(db.gameDetails, "aggregate").mockImplementation(() => ({ toArray: async () => {
      const number = ++calls;
      if (number === 2) started();
      return number === 1 ? first : second;
    } }));
    const expected = new Error("metadata read failed");
    const pending = personal.explorer("failure-user", {}, parseExplorerOptions("leads", {}))
      .then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
    try {
      await entered;
      rejectFirst(expected);
      await new Promise(setImmediate);
      expect(settled).toBe(false);
      expect(calls).toBe(2);
      releaseSecond([]);
      expect(await pending).toBe(expected);
      expect(calls).toBe(2);
    } finally { rejectFirst(expected); releaseSecond([]); await pending; reads.mockRestore(); }
  });

  test("sequence admission counts intervening history even when the selected personal games are few", async () => {
    await db.games.insertMany(Array.from({ length: 2001 }, (_, index) => game("a", `old-${index}`, index, { map: "Archived" })));
    let release, started;
    const blocked = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    const heavy = trendsExplorer({ games: { aggregate: () => ({ toArray: async () => {
      started(); await blocked; return [];
    } }) } }, "global", {}, parseExplorerOptions("leads", {}));
    await entered;
    const originalAggregate = db.games.aggregate.bind(db.games);
    let counted;
    const probe = new Promise((resolve) => { counted = resolve; });
    const reads = jest.spyOn(db.games, "aggregate").mockImplementation((pipeline, options) => {
      if (pipeline.at(-1).$count) return { toArray: async () => {
        const result = await originalAggregate(pipeline, options).toArray();
        counted(); return result;
      } };
      return originalAggregate(pipeline, options);
    });
    const personalResult = personal.explorer("a", { map: "Arena" }, parseExplorerOptions("breaks", {}));
    try {
      await probe;
      await new Promise(setImmediate);
      expect(reads.mock.calls).toHaveLength(1);
      expect(reads.mock.calls[0][0][0].$match).not.toHaveProperty("map");
    } finally { release(); await heavy; reads.mockRestore(); }
    expect((await personalResult).totalGames).toBe(2);
  });

  test.each([{ a_since: "2026-02-30" }, { a_since: "2026-10-01", a_until: "2026-09-01" },
    { group_mode: "arbitrary" }, { a_min: "5000", a_max: "4000" }, { limit: "100000" }, { milestone: { $ne: null } }])("invalid controls fail closed: %j", async (bad) => {
    await request(app).get("/v1/trends/explorer/groups").query(bad).set("Authorization", "a").expect(400);
  });
});
