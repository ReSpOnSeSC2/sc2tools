// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore } = require("../src/services/gameDetailsStore");
const { TrendsExplorerBackfill } = require("../src/services/trendsExplorerBackfill");
const { opponentBuildOrderStamp } = require("../src/services/opponentBuildOrderSummary");

const positive = ["[0:00] Hatchery"];
const input = { gameId: "game", date: "2026-10-01", result: "Victory", myRace: "Protoss", map: "Alpha" };
function barrier() {
  let release, entered;
  return { wait: new Promise((resolve) => { release = resolve; }),
    arrived: new Promise((resolve) => { entered = resolve; }),
    release: () => release(), enter: () => entered() };
}

describe("opponent log facts share the actual Mongo detail write", () => {
  let mongo, db, details, games, compute;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opponent_log_stamps" });
    details = new GameDetailsService(new MongoDetailsStore(db));
    games = new GamesService(db, { gameDetails: details });
    compute = new PerGameComputeService(db, { gameDetails: details, users: db.users });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.games.deleteMany({}), db.gameDetails.deleteMany({}), db.users.deleteMany({})]);
    await db.users.insertOne({ userId: "owner" });
  });
  const source = () => db.gameDetails.findOne({ userId: "owner", gameId: "game" });
  const fact = async () => (await source())?.opponentListDetail?.opponentBuildOrder;

  test("source writes generate facts; uploaded slim metadata and classifier labels cannot forge them", async () => {
    await games.upsert("owner", { ...input, _opponentBuildOrder: { v: 1, available: true },
      opponentListDetail: { v: 1, opponentBuildOrder: { v: 1, available: true } }, opponent: { strategy: "Classifier" } });
    expect(await source()).toBeNull();
    expect(await db.games.findOne({ userId: "owner" })).not.toHaveProperty("_opponentBuildOrder");
    await games.upsert("owner", { ...input, oppBuildLog: positive });
    expect(await fact()).toEqual({ v: 1, available: true });
    await games.upsert("owner", { ...input, buildLog: ["[0:00] Nexus"] });
    expect(await fact()).toEqual({ v: 1, available: true });
    await games.upsert("owner", { ...input, oppBuildLog: [] });
    expect(await fact()).toEqual({ v: 1, available: false });
    expect(await details.findOne("owner", "game")).not.toHaveProperty("opponentListDetail");
  });

  test("failed writes preserve actual prior facts, while stored malformed source becomes explicitly unknown", async () => {
    await games.upsert("owner", { ...input, oppBuildLog: positive });
    const fail = new PerGameComputeService(db, { users: db.users, gameDetails: { upsert: async () => { throw new Error("store unavailable"); } } });
    await expect(fail.writeOpponentBuildOrder("owner", "game", { oppBuildLog: [] })).rejects.toThrow("store unavailable");
    expect(await fact()).toEqual({ v: 1, available: true });
    expect((await source()).oppBuildLog).toEqual(positive);
    await compute.writeOpponentBuildOrder("owner", "game", { oppBuildLog: ["not a build event"] });
    expect(await fact()).toBeNull();
    expect((await source()).oppBuildLog).toEqual(["not a build event"]);
  });

  test("a held ingest acknowledgement cannot replace newer reanalysis facts", async () => {
    await games.upsert("owner", input);
    const gate = barrier();
    const delayed = new GamesService(db, { gameDetails: { upsert: async (...args) => {
      await details.upsert(...args); gate.enter(); await gate.wait;
    } } });
    const pending = delayed.upsert("owner", { ...input, oppBuildLog: positive });
    await gate.arrived;
    try {
      await compute.writeOpponentBuildOrder("owner", "game", { oppBuildLog: [] });
      expect(await fact()).toEqual({ v: 1, available: false });
    } finally { gate.release(); await pending; }
    expect(await fact()).toEqual({ v: 1, available: false });
    expect((await source()).oppBuildLog).toEqual([]);
  });

  test("a held reanalysis acknowledgement cannot replace a newer ingest's actual detail write", async () => {
    await games.upsert("owner", input);
    const gate = barrier(), ingestWritten = barrier();
    const delayed = new PerGameComputeService(db, { users: db.users, gameDetails: { upsert: async (...args) => {
      await details.upsert(...args); gate.enter(); await gate.wait;
    } } });
    const ingest = new GamesService(db, { gameDetails: { upsert: async (...args) => {
      await details.upsert(...args); ingestWritten.enter();
    } } });
    const pending = delayed.writeOpponentBuildOrder("owner", "game", { oppBuildLog: positive });
    await gate.arrived;
    const upload = ingest.upsert("owner", { ...input, oppBuildLog: [] });
    await ingestWritten.arrived;
    try { expect(await fact()).toEqual({ v: 1, available: false }); }
    finally { gate.release(); await Promise.all([pending, upload]); }
    expect(await fact()).toEqual({ v: 1, available: false });
    expect((await source()).oppBuildLog).toEqual([]);
  });

  test("overlapping ingest acknowledgements do not republish facts outside their atomic source writes", async () => {
    const gate = barrier();
    const delayed = new GamesService(db, { gameDetails: { upsert: async (...args) => {
      await details.upsert(...args); gate.enter(); await gate.wait;
    } } });
    const pending = delayed.upsert("owner", { ...input, oppBuildLog: positive });
    await gate.arrived;
    try { await games.upsert("owner", { ...input, oppBuildLog: [] }); }
    finally { gate.release(); await pending; }
    expect(await fact()).toEqual({ v: 1, available: false });
    expect((await source()).oppBuildLog).toEqual([]);
  });

  test("the existing Trends backfill and unrelated partial writes preserve opponent source facts", async () => {
    await details.upsert("owner", "game", new Date(), { oppBuildLog: positive });
    const backfill = new TrendsExplorerBackfill({ db, gameDetails: details });
    try { expect(await backfill.runBatch()).toMatchObject({ updated: 1 }); }
    finally { await backfill.stop(); }
    expect(await fact()).toEqual({ v: 1, available: true });
    await details.upsert("owner", "game", new Date(), { apmCurve: { has_data: false }, macroBreakdown: {} });
    expect(await fact()).toEqual({ v: 1, available: true });
  });

  test.each(["_deleted", "_deletionPending"])("%s prevents ingest and reanalysis before changing details", async (flag) => {
    await db.games.insertOne({ ...input, userId: "owner", [flag]: true });
    await expect(games.upsert("owner", { ...input, oppBuildLog: positive })).rejects.toHaveProperty("code", "game_deleted");
    await expect(compute.writeOpponentBuildOrder("owner", "game", { oppBuildLog: positive })).rejects.toThrow();
    expect(await source()).toBeNull();
  });

  test("missing, noise-only, malformed and oversized logs never claim recorded coverage", () => {
    for (const source of [undefined, null, {}, [1], ["[0:00] SprayDecal"], ["[0:99] Hatchery"], ["x".repeat(257)], Array(5001).fill("[0:00] Probe")]) {
      expect(opponentBuildOrderStamp(source)).toBeNull();
    }
    expect(opponentBuildOrderStamp([])).toEqual({ v: 1, available: false });
    expect(opponentBuildOrderStamp(positive)).toEqual({ v: 1, available: true });
  });
});
