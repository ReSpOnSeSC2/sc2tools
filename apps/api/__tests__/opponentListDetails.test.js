// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { buildOpponentsRouter } = require("../src/routes/opponents");
const { listDetailsPipeline } = require("../src/services/opponentListDetails");
const { gamesMatchStage } = require("../src/util/parseQuery");
const { BSON } = require("mongodb");

const USER = "summary-owner";
const PULSE = "one";
const ACCOUNT = "1-S2-1-10";
const stamp = (available) => ({ v: 1, available });
function game(gameId, patch = {}) {
  return { userId: USER, gameId, date: new Date("2026-10-01"), result: "Victory", myRace: "Protoss",
    map: "Alpha LE", durationSec: 600, macroScore: 80, myBuild: "Recorded build", myToonHandle: ACCOUNT,
    opponent: { pulseId: PULSE, displayName: "Recorded opponent", race: "Terran", strategy: "Recorded opener" },
    ...patch };
}

describe("opt-in opponent list scalar details", () => {
  let mongo, db, service, app;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opponent_list_details" });
    service = new OpponentsService(db, "test-only", { gameDetails: {
      store: { kind: "mongo" }, findMany: () => { throw new Error("must not hydrate"); },
    } });
    app = express();
    app.use(buildOpponentsRouter({ opponents: service, auth: (req, res, next) => {
      if (!req.headers["x-user"]) return res.sendStatus(401);
      req.auth = { userId: req.headers["x-user"] }; next();
    } }));
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({}), db.gameDetails.deleteMany({})]);
    await db.opponents.insertMany([PULSE, "two"].map((pulseId, i) => ({ userId: USER, pulseId,
      displayNameSample: pulseId, wins: 1, losses: 0, gameCount: 1,
      firstSeen: new Date("2026-01-01"), lastSeen: new Date(i ? "2026-09-01" : "2026-10-03") })));
    await db.games.insertMany([
      game("a", { _opponentBuildOrder: stamp(false), replayFile: { sizeBytes: 512, storedAt: new Date(), key: "PRIVATE_KEY", sha256: "PRIVATE_SHA" },
        top3Leaks: [{ name: "Supply block", detail: "PRIVATE_DETAIL" }],
        buildIntent: { status: "confirmed", applied: true, build: { name: "Planned" }, detected: { name: "Detected" }, notes: "PRIVATE_NOTE",
          opponent: { status: "confirmed", applied: true, build: { name: "Corrected" }, detected: { name: "Opp detected" } } } }),
      game("b", { durationSec: 900, macroScore: 40 }),
      game("old-log", { date: new Date("2026-09-01"), durationSec: 300, macroScore: null, _opponentBuildOrder: stamp(true) }),
      game("other", { durationSec: 1200, macroScore: 100, opponent: { pulseId: "two" }, _opponentBuildOrder: stamp(false) }),
    ]);
    await db.gameDetails.insertMany([["a", false], ["old-log", true], ["other", false]].map(([gameId, available]) => ({
      userId: USER, gameId, opponentListDetail: { v: 1, opponentBuildOrder: stamp(available) },
      oppBuildLog: ["PRIVATE_LOG"], mapPlayback: { PRIVATE_PLAYBACK: true },
    })));
  });
  const load = (query = "") => request(app).get(`/opponents${query}`).set("x-user", USER);

  test("ordinary clients neither receive summaries nor add summary work; opt-in replaces one existing batch", async () => {
    const aggregate = jest.spyOn(db.games, "aggregate");
    const plain = await load();
    expect(plain.status).toBe(200);
    expect(plain.body.items[0]).not.toHaveProperty("latestGame");
    expect(JSON.stringify(aggregate.mock.calls)).not.toMatch(/_listLatest|_listCandidates|_listDurationSum|_listMacroSum/);
    const reads = aggregate.mock.calls.length;
    aggregate.mockClear();
    const detailed = await load("?listDetails=1");
    expect(detailed.body).toEqual(expect.objectContaining({ items: expect.any(Array) }));
    expect(detailed.status).toBe(200);
    expect(aggregate).toHaveBeenCalledTimes(reads - 1);
    expect(detailed.headers["cache-control"]).toBe("private, no-store");
    expect(aggregate.mock.calls.find(([pipeline]) => JSON.stringify(pipeline).includes('"_listLatest"'))[1]).toEqual({ maxTimeMS: 5000, timeoutMS: 5000 });
    expect(detailed.body.items[0]).toHaveProperty("latestGame.gameId", "a");
    aggregate.mockRestore();
  });

  test("listDetails keeps both recorded races when the same account switches from Zerg to Protoss", async () => {
    await db.games.deleteMany({});
    await db.opponents.updateOne({ userId: USER, pulseId: PULSE }, { $set: { race: "Zerg" } });
    await db.games.insertMany([
      game("new-protoss", { date: new Date("2026-10-29"), opponent: { pulseId: PULSE, displayName: "Ali", race: "Protoss" } }),
      game("old-zerg", { date: new Date("2026-10-01"), opponent: { pulseId: PULSE, displayName: "Ali", race: "Zerg" } }),
    ]);

    const response = await load("?listDetails=1");

    expect(response.status).toBe(200);
    expect(response.body.items.find(row => row.pulseId === PULSE)).toMatchObject({
      race: "P", races: ["P", "Z"], latestGame: { gameId: "new-protoss" },
    });
    expect((await db.opponents.findOne({ userId: USER, pulseId: PULSE })).race).toBe("Zerg");
  });

  test.each(["?listDetails=true", "?listDetails=0", "?listDetails=1&listDetails=1", "?listDetails[x]=1"])("strict opt-in ignores %s", async (query) => {
    expect((await load(query)).body.items[0]).not.toHaveProperty("latestGame");
  });

  test("latest tie, independent log date, weighted sums and minimal replay metadata are honest", async () => {
    const { items } = (await load("?listDetails=1&limit=1")).body;
    const row = items[0];
    expect(row.latestGame).toMatchObject({ gameId: "a", date: "2026-10-01T00:00:00.000Z", map: "Alpha LE",
      myBuild: "Recorded build", oppStrategy: "Recorded opener", buildPlanned: true, detectedBuild: "Detected",
      oppStrategyPlanned: true, detectedOppStrategy: "Opp detected", replayAvailable: true, replaySizeBytes: 512,
      top3Leaks: ["Supply block"] });
    expect(row.duration).toEqual({ sumSec: 1800, samples: 3, averageSec: 600 });
    expect(row.macro).toEqual({ sum: 120, samples: 2, average: 60 });
    expect(row.latestOppBuildOrder).toEqual({ gameId: "old-log", date: "2026-09-01T00:00:00.000Z" });
    expect(row.opponentBuildOrderAvailability).toBe("unknown");
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE_|_list|buildIntent|replayFile/);
    const two = (await load("?listDetails=1")).body.items.find((item) => item.pulseId === "two");
    expect((row.duration.sumSec + two.duration.sumSec) / (row.duration.samples + two.duration.samples)).toBe(750);
    expect(two).toMatchObject({ latestOppBuildOrder: null, opponentBuildOrderAvailability: "known" });
  });

  test("same indexed owner/filter/account cohort excludes hidden, deleted, pending and resumed contributions", async () => {
    await db.games.insertMany([
      ...["excluded", "_deleted", "_deletionPending", "isResumedFromReplay"].map((flag) => game(flag, { [flag]: true, date: new Date("2026-10-20") })),
      game("foreign", { userId: "someone-else", date: new Date("2026-10-20") }),
      game("other-account", { myToonHandle: "1-S2-1-20", date: new Date("2026-10-20") }),
      game("other-map", { map: "Beta LE", date: new Date("2026-10-20") }),
      game("other-result", { result: "Defeat", date: new Date("2026-10-20") }),
    ]);
    const response = await load(`?listDetails=1&accounts=${ACCOUNT}&map=Alpha&since=2026-09-15&until=2026-10-02`);
    expect(response.status).toBe(200);
    const row = response.body.items.find((item) => item.pulseId === PULSE);
    expect(row.gameCount).toBe(2);
    expect(row.latestGame.gameId).toBe("a");
    expect(row.duration).toEqual({ sumSec: 1500, samples: 2, averageSec: 750 });
    expect(row.latestOppBuildOrder).toBeNull();
    expect(row.opponentBuildOrderAvailability).toBe("unknown");
  });

  test("account and exact-map filters select latest labels and logs from their cohort", async () => {
    await db.games.insertMany([
      game("excluded-account", { myToonHandle: "1-S2-1-20", date: new Date("2026-10-20"), _opponentBuildOrder: stamp(true) }),
      game("excluded-map", { map: "Alpha LE II", date: new Date("2026-10-20"), _opponentBuildOrder: stamp(true) }),
    ]);
    const query = `?listDetails=1&accounts=${ACCOUNT}&map_exact=${encodeURIComponent(JSON.stringify(["Alpha LE"]))}`;
    const row = (await load(query)).body.items.find((item) => item.pulseId === PULSE);
    expect(row.latestGame.gameId).toBe("a");
    expect(row.duration.samples).toBe(3);
    expect(row.latestOppBuildOrder.gameId).toBe("old-log");
  });

  test.each(["excluded", "_deleted", "_deletionPending", "isResumedFromReplay"])("unfiltered summaries exclude %s without a date guard", async (flag) => {
    await db.games.insertOne(game("hidden-future", { [flag]: true, date: new Date("2026-10-20"), durationSec: 8000, macroScore: 100,
      _opponentBuildOrder: stamp(true) }));
    await db.games.insertOne(game("foreign-future", { userId: "another-owner", date: new Date("2026-10-20"), durationSec: 8000 }));
    const row = (await load("?listDetails=1")).body.items[0];
    expect(row.latestGame.gameId).toBe("a");
    expect(row.duration).toEqual({ sumSec: 1800, samples: 3, averageSec: 600 });
    expect(row.latestOppBuildOrder.gameId).toBe("old-log");
  });

  test("legacy ISO dates follow actual date order; invalid or unsupported IDs cannot hide a valid latest game", async () => {
    await db.games.insertMany([game("iso", { date: "2026-10-21T00:00:00.000Z", _opponentBuildOrder: stamp(true) }),
      game(123, { date: new Date("2026-10-23"), _opponentBuildOrder: stamp(true) }),
      game("bad\nidentifier", { date: new Date("2026-10-22"), _opponentBuildOrder: stamp(true) })]);
    await db.gameDetails.insertOne({ userId: USER, gameId: "iso", opponentListDetail: { v: 1, opponentBuildOrder: stamp(true) } });
    const row = (await load("?listDetails=1")).body.items[0];
    expect(row.latestGame).toMatchObject({ gameId: "iso", date: "2026-10-21T00:00:00.000Z" });
    expect(row.latestOppBuildOrder).toEqual({ gameId: "iso", date: "2026-10-21T00:00:00.000Z" });
  });

  test("own/opponent race filters scope summaries even though current identity overlays remain global", async () => {
    await db.games.insertMany([
      game("other-own-race", { myRace: "Zerg", date: new Date("2026-10-20"), _opponentBuildOrder: stamp(true) }),
      game("other-opp-race", { date: new Date("2026-10-21"), _opponentBuildOrder: stamp(true), opponent: { pulseId: PULSE, race: "Zerg" } }),
    ]);
    const row = (await load("?listDetails=1&race=P&opp_race=T")).body.items.find((item) => item.pulseId === PULSE);
    expect(row.latestGame.gameId).toBe("a");
    expect(row.duration).toEqual({ sumSec: 1800, samples: 3, averageSec: 600 });
    expect(row.latestOppBuildOrder.gameId).toBe("old-log");
  });

  test("opaque padded game IDs remain exact in links and metadata identity", async () => {
    const gameId = " padded game ";
    await db.games.insertOne(game(gameId, { date: new Date("2026-10-22") }));
    await db.gameDetails.insertOne({ userId: USER, gameId, opponentListDetail: { v: 1, opponentBuildOrder: stamp(true) } });
    const row = (await load("?listDetails=1")).body.items[0];
    expect(row.latestGame.gameId).toBe(gameId);
    expect(row.latestOppBuildOrder.gameId).toBe(gameId);
    expect(await db.games.findOne({ userId: USER, gameId: gameId.trim() })).toBeNull();
  });

  test("null, malformed and out-of-range measurements are absent samples; zero is real", async () => {
    await db.games.deleteMany({});
    await db.games.insertMany([game("bad", { durationSec: "600", macroScore: 101 }),
      game("negative", { durationSec: -1, macroScore: -1 }),
      game("empty", { durationSec: null, macroScore: null }),
      game("zero", { durationSec: 0, macroScore: 0 })]);
    const row = (await load("?listDetails=1")).body.items[0];
    expect(row.duration).toEqual({ sumSec: 0, samples: 1, averageSec: 0 });
    expect(row.macro).toEqual({ sum: 0, samples: 1, average: 0 });
    const noGames = (await load("?listDetails=1")).body.items[1];
    expect(noGames).toMatchObject({ latestGame: null, duration: { sumSec: 0, samples: 0, averageSec: null },
      macro: { sum: 0, samples: 0, average: null }, opponentBuildOrderAvailability: "unknown" });
  });

  test("stored cursor remains unchanged after latest-game overlay and ordinary identity/MMR overlays remain", async () => {
    await db.games.insertOne(game("latest", { date: new Date("2026-10-20"), opponent: { pulseId: PULSE, displayName: "Newest name", race: "Terran", mmr: 4321 } }));
    const response = await load("?listDetails=1&limit=1");
    expect(response.body.nextBefore).toBe("2026-10-03T00:00:00.000Z");
    expect(response.body.items[0]).toMatchObject({ lastPlayed: "2026-10-20T00:00:00.000Z", displayNameSample: "Newest name", mmr: 4321,
      latestGame: { gameId: "latest" } });
  });

  test("anonymous request is denied and invalid stamp versions cannot claim known coverage", async () => {
    expect((await request(app).get("/opponents?listDetails=1")).status).toBe(401);
    await db.gameDetails.updateMany({ userId: USER }, { $set: { opponentListDetail: { v: 9, opponentBuildOrder: stamp(true) } } });
    const row = (await load("?listDetails=1")).body.items[0];
    expect(row.opponentBuildOrderAvailability).toBe("unknown");
    expect(row.latestOppBuildOrder).toBeNull();
  });

  test("filtered summaries replace the name overlay without extra endpoint queries or pre-page top-N state", async () => {
    const aggregate = jest.spyOn(db.games, "aggregate");
    await load("?map=Alpha");
    const reads = aggregate.mock.calls.length;
    aggregate.mockClear();
    const response = await load("?map=Alpha&listDetails=1");
    expect(response.status).toBe(200);
    expect(aggregate).toHaveBeenCalledTimes(reads);
    expect(JSON.stringify(aggregate.mock.calls[0][0])).not.toMatch(/\$topN|\$lookup|\$facet/);
    const optional = aggregate.mock.calls.find(([pipeline]) => pipeline.some((stage) => stage.$facet));
    expect(optional[0][0].$match["opponent.pulseId"].$in.sort()).toEqual([PULSE, "two"]);
    expect(optional[1]).toEqual({ maxTimeMS: 5000, timeoutMS: 5000 });
    aggregate.mockRestore();
  });

  test("newest 25 candidates are bounded while full cohort averages remain exact", async () => {
    await db.games.insertMany(Array.from({ length: 30 }, (_, i) => game(`recent-${i}`, { date: new Date(`2026-10-${String(i + 1).padStart(2, "0")}`) })));
    const row = (await load("?listDetails=1&limit=1")).body.items[0];
    expect(row.duration).toEqual({ sumSec: 19800, samples: 33, averageSec: 600 });
    expect(row.latestOppBuildOrder).toBeNull();
    expect(row.opponentBuildOrderAvailability).toBe("unknown");
  });

  test("R2 metadata remains latest known, never complete coverage or current-blob absence", async () => {
    await db.gameDetails.updateMany({}, { $set: { storedIn: "r2" } });
    const { items } = (await load("?listDetails=1")).body;
    expect(items[0]).toMatchObject({ latestOppBuildOrder: { gameId: "old-log" }, opponentBuildOrderAvailability: "unknown" });
    expect(items[1]).toMatchObject({ latestOppBuildOrder: null, opponentBuildOrderAvailability: "unknown" });
  });

  test("foreign metadata and forged Games stamps cannot fill missing owner knowledge", async () => {
    await db.gameDetails.deleteMany({});
    await db.games.updateMany({}, { $set: { _opponentBuildOrder: stamp(true) } });
    await db.gameDetails.insertOne({ userId: "foreign", gameId: "a", opponentListDetail: { v: 1, opponentBuildOrder: stamp(true) } });
    const row = (await load("?listDetails=1")).body.items[0];
    expect(row).toMatchObject({ latestOppBuildOrder: null, opponentBuildOrderAvailability: "unknown" });
  });

  test.each([undefined, "", "r2", "future"])("an unconfirmed active store %s cannot claim complete Mongo coverage", async (kind) => {
    const previous = service.gameDetails.store;
    service.gameDetails.store = kind === undefined ? undefined : { kind };
    try {
      const { items } = (await load("?listDetails=1")).body;
      expect(items[0]).toMatchObject({ latestOppBuildOrder: { gameId: "old-log" }, opponentBuildOrderAvailability: "unknown" });
      expect(items[1]).toMatchObject({ latestOppBuildOrder: null, opponentBuildOrderAvailability: "unknown" });
    } finally { service.gameDetails.store = previous; }
  });

  test("the metadata join uses the existing owner/game index and never scans or returns heavy fields", async () => {
    const pipeline = listDetailsPipeline(USER, gamesMatchStage(USER, {}), [PULSE, "two"]);
    const explained = await db.games.aggregate(pipeline).explain("executionStats");
    const lookups = [];
    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (value.$lookup?.from === "game_details" && typeof value.collectionScans === "number") lookups.push(value);
      for (const child of Object.values(value)) visit(child);
    }
    visit(explained);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatchObject({ collectionScans: 0, indexesUsed: ["userId_1_gameId_1"] });
    expect(lookups[0].totalDocsExamined).toBeLessThanOrEqual(4);
    const metadata = (await db.games.aggregate(pipeline).toArray()).filter((row) => row._listDetailRows);
    expect(JSON.stringify(metadata)).not.toMatch(/PRIVATE_LOG|PRIVATE_PLAYBACK|oppBuildLog|mapPlayback/);
  });

  test("max-page candidate and BSON bounds are finite even for largest supported labels", async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `opponent-${i}`);
    const pipeline = listDetailsPipeline(USER, gamesMatchStage(USER, {}), ids);
    expect(pipeline[1].$facet.details.find((stage) => stage.$group).$group._listCandidates.$topN.n).toBe(1);
    const narrow = listDetailsPipeline(USER, gamesMatchStage(USER, {}), [PULSE]);
    const [facet] = await db.games.aggregate(narrow.slice(0, 2)).toArray();
    const wide = "𐍈".repeat(200);
    function widen(value) {
      if (typeof value === "string") return wide;
      if (value instanceof Date || value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(widen);
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, widen(child)]));
    }
    const largest = widen(facet.details[0]);
    largest._listCandidates = largest._listCandidates.slice(0, 1);
    largest._listDetailRows = largest._listDetailRows.slice(0, 1);
    largest._listLatest.top3Leaks = [wide, wide, wide];
    const names = { _id: wide, _listName: wide };
    const estimated = BSON.calculateObjectSize({ names: Array(5000).fill(names), details: Array(5000).fill(largest) });
    expect(estimated).toBeLessThan(100 * 1024 * 1024);
    expect(estimated).toBeGreaterThan(16 * 1024 * 1024);
    const stress = [{ $limit: 1 }, { $project: {
      names: { $map: { input: { $range: [0, 5000] }, in: { $literal: names } } },
      details: { $map: { input: { $range: [0, 5000] }, in: { $literal: largest } } },
    } }, ...pipeline.slice(2), { $group: { _id: null, rows: { $sum: 1 }, maxBytes: { $max: { $bsonSize: "$$ROOT" } } } }];
    const [result] = await db.games.aggregate(stress, { maxTimeMS: 5000, timeoutMS: 5000 }).toArray();
    expect(result.rows).toBe(10000);
    expect(result.maxBytes).toBeLessThan(16 * 1024 * 1024);
  });
});
