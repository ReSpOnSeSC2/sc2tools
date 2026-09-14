// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore } = require("../src/services/gameDetailsStore");
const { TrendsExplorerBackfill } = require("../src/services/trendsExplorerBackfill");

describe("Trends history materialization", () => {
  let server, client, db, store, details, backfill;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = { gameDetails: client.db("trends_detail_test").collection("game_details") };
    store = new MongoDetailsStore(db);
    details = new GameDetailsService(store);
  });
  beforeEach(async () => {
    await db.gameDetails.deleteMany({});
    backfill = new TrendsExplorerBackfill({ db, gameDetails: details });
  });
  afterEach(() => backfill.stop());
  afterAll(async () => { await client.close(); await server.stop(); });

  const seed = (gameId, userId = "u1") => ({ userId, gameId, date: new Date(), buildLog: ["[2:30] Stalker"], macroBreakdown: {
    stats_events: [{ time: 300, food_workers: 40, army_value: 1200 }],
    opp_stats_events: [{ time: 300, food_workers: 35, army_value: 800 }],
    bases: [], player_stats: { me: { mmr: 4200 }, opponent: { mmr: 4300 } },
    unit_timeline: [{ expensive: true }],
  }, mapPlayback: { expensive: true } });

  test("processes all history in bounded batches with narrow nested projections and resumes after restart", async () => {
    await db.gameDetails.insertMany([seed("a"), seed("b", "u2"), seed("c"), seed("d")]);
    const spy = jest.spyOn(details, "findMany");
    expect(await backfill.runBatch({ batchSize: 2 })).toMatchObject({ scanned: 2, updated: 2, done: false });
    backfill = new TrendsExplorerBackfill({ db, gameDetails: details });
    expect(await backfill.runBatch({ batchSize: 2 })).toMatchObject({ scanned: 2, updated: 2 });
    expect(await backfill.runBatch({ batchSize: 2 })).toMatchObject({ scanned: 0, done: true });
    expect(await backfill.status()).toMatchObject({ total: 4, complete: 4, pending: 0 });
    const saved = await db.gameDetails.findOne({ gameId: "c" });
    expect(saved.trendsExplorerDetail.ratings).toEqual({ myMmr: 4200, opponentMmr: 4300 });
    expect(saved.trendsExplorerDetail.leads.snapshots[0]).toMatchObject({ second: 300, workers: [40, 35] });
    expect(spy.mock.calls.every((call) => !call[2].fields.includes("mapPlayback") && !call[2].fields.includes("macroBreakdown"))).toBe(true);
    spy.mockRestore();
  });

  test("a failed provider read remains pending rather than masquerading as absent source data", async () => {
    await db.gameDetails.insertOne(seed("a"));
    const spy = jest.spyOn(details, "findMany").mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await backfill.runBatch()).toMatchObject({ failed: 1, updated: 0 });
    expect((await db.gameDetails.findOne({ gameId: "a" })).trendsExplorerDetail).toBeUndefined();
    spy.mockRestore();
    expect(await backfill.runBatch()).toMatchObject({ updated: 1 });
  });

  test("prepares newest dates first with stable ID ordering, an indexed scan, and no starvation after failed recent reads", async () => {
    const { ObjectId } = require("mongodb");
    await db.gameDetails.insertMany([
      { ...seed("old"), _id: new ObjectId("000000000000000000000004"), date: new Date("2024-01-01") },
      { ...seed("recent-low"), _id: new ObjectId("000000000000000000000001"), date: new Date("2026-09-14") },
      { ...seed("recent-high"), _id: new ObjectId("000000000000000000000002"), date: new Date("2026-09-14") },
      { ...seed("middle"), _id: new ObjectId("000000000000000000000003"), date: new Date("2025-01-01") },
    ]);
    const read = details.findMany.bind(details);
    const order = [];
    let failRecent = true;
    const spy = jest.spyOn(details, "findMany").mockImplementation(async (...args) => {
      order.push(args[1]);
      if (args[1][0] === "recent-high" && failRecent) {
        failRecent = false;
        throw new Error("temporary provider issue");
      }
      return read(...args);
    });
    for (let index = 0; index < 5; index += 1) await backfill.runBatch({ batchSize: 1 });
    expect(order).toEqual([["recent-high"], ["recent-low"], ["middle"], ["old"], ["recent-high"]]);
    expect(await backfill.runBatch({ batchSize: 1 })).toMatchObject({ done: true });
    const indexes = await db.gameDetails.indexes();
    expect(indexes.some((index) => index.key.date === -1 && index.key._id === -1)).toBe(true);
    spy.mockRestore();
  });

  test("R2 batches retain at most two projected blobs and request one read lane at a time", async () => {
    await db.gameDetails.insertMany([seed("a"), seed("b"), seed("c")]);
    backfill.externalStore = true;
    const spy = jest.spyOn(details, "findMany");
    expect(await backfill.runBatch({ batchSize: 200 })).toMatchObject({ scanned: 2, updated: 2 });
    expect(spy.mock.calls[0][1]).toHaveLength(2);
    expect(spy.mock.calls[0][2].concurrency).toBe(1);
    spy.mockRestore();
  });

  test("stop aborts and awaits an active tick before allowing database shutdown, without scheduling another batch", async () => {
    let release;
    let markStarted;
    let signal;
    const active = new Promise((resolve) => { markStarted = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const spy = jest.spyOn(backfill, "runBatch").mockImplementation(async (options) => {
      signal = options.signal;
      markStarted();
      await barrier;
      return { scanned: 1, updated: 1, failed: 0, conflicts: 0, done: false };
    });
    backfill.start({ initialDelayMs: 0 });
    await active;
    let stopped = false;
    const stopping = backfill.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(backfill.timer).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test("does not overwrite a concurrent fresh upload after reading an older blob", async () => {
    await db.gameDetails.insertOne(seed("a"));
    const read = details.findMany.bind(details);
    const spy = jest.spyOn(details, "findMany").mockImplementation(async (...args) => {
      const old = await read(...args);
      await details.upsert("u1", "a", new Date(), { buildLog: ["[2:45] Stalker"] });
      return old;
    });
    expect(await backfill.runBatch()).toMatchObject({ updated: 0, conflicts: 1 });
    expect((await db.gameDetails.findOne({ gameId: "a" })).trendsExplorerDetail.build.milestones)
      .toContainEqual({ id: "first:Stalker", sec: 165 });
    spy.mockRestore();
    expect(await backfill.runBatch()).toMatchObject({ updated: 1 });
  });

  test("new ingestion and unrelated partial recomputes retain independent compact branches and keep metadata private", async () => {
    const original = seed("a");
    await details.upsert("u1", "a", original.date, original);
    await details.upsert("u1", "a", original.date, { buildLog: ["[3:00] Stalker"], mapPlayback: { replaced: true } });
    await details.upsert("u1", "a", original.date, { apmCurve: { average: 150 } });
    const saved = await db.gameDetails.findOne({ gameId: "a" });
    expect(saved.trendsExplorerDetail.build.milestones).toContainEqual({ id: "first:Stalker", sec: 180 });
    expect(saved.trendsExplorerDetail.ratings.opponentMmr).toBe(4300);
    expect(saved.trendsExplorerDetail.leads.snapshots).toHaveLength(1);
    expect((await details.findOne("u1", "a")).trendsExplorerDetail).toBeUndefined();
    expect((await store.read("u1", "a")).trendsExplorerRevision).toBeUndefined();
    expect(await details.findOne("u1", "a", { fields: ["macroBreakdown.stats_events"] })).toEqual({
      macroBreakdown: { stats_events: original.macroBreakdown.stats_events },
    });
  });
});
