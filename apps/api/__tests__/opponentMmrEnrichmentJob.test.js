// @ts-nocheck
"use strict";

/**
 * Integration coverage for the forward-only opponent-MMR enrichment job.
 * Mongo is real; only the outbound SC2Pulse boundary is faked.
 */

const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const {
  buildOpponentMmrEnrichmentJob,
  __internal,
} = require("../src/jobs/opponentMmrEnrichmentJob");

const NOW_MS = Date.parse("2026-07-11T12:00:00.000Z");
const WINDOW_DAYS = 14;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const logger = pino({ level: "silent" });

function game(gameId, opponent, extra = {}) {
  return {
    userId: "user-1",
    gameId,
    date: new Date(NOW_MS - 60_000),
    createdAt: new Date(NOW_MS - 60_000),
    result: "Victory",
    myRace: "Zerg",
    map: "Amygdala LE",
    isLadderGame: true,
    opponent: {
      pulseCharacterId: gameId.replace(/\D/g, "") || "1",
      race: "Protoss",
      ...opponent,
    },
    ...extra,
  };
}

function pulseFake(responses = {}) {
  const calls = [];
  return {
    calls,
    getRaceBreakdown: jest.fn(async (ids) => {
      const id = String(ids[0]);
      calls.push(id);
      const response = responses[id];
      if (response instanceof Error) throw response;
      return response || [];
    }),
  };
}

  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_mmr_enrich_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.db.collection("jobLocks").deleteMany({});
  });

  function build(pulseMmr, overrides = {}) {
    return buildOpponentMmrEnrichmentJob({
      db,
      pulseMmr,
      logger,
      gamesPerTick: 25,
      windowDays: WINDOW_DAYS,
      nowFn: () => NOW_MS,
      ...overrides,
    });
  }

  test("matches the race actually played and ignores a higher wrong-race team", async () => {
    await db.games.insertMany([
      game("race-101", { pulseCharacterId: "101", race: "p" }),
      game("race-102", { pulseCharacterId: "102", race: "Terran" }),
      game("race-103", { pulseCharacterId: "103", race: "zerg" }),
    ]);
    const pulse = pulseFake({
      101: [
        { race: "ZERG", mmr: 6100, games: 20, league: "Grandmaster" },
        { race: "PROTOSS", mmr: 4210.6, games: 10, league: "Diamond" },
      ],
      102: [{ race: "TERRAN", mmr: 4321, games: 10, league: "Master" }],
      103: [{ race: "ZERG", mmr: 4432.4, games: 10, league: 4 }],
    });

    await build(pulse).runOnce();

    const rows = await db.games.find({}).sort({ gameId: 1 }).toArray();
    expect(rows.map((row) => row.opponent.mmr)).toEqual([4211, 4321, 4432]);
    expect(rows.map((row) => row.opponent.leagueId)).toEqual([4, 5, 4]);
    expect(rows.every((row) => row.opponent.mmrLookupAttempted === true)).toBe(true);
    expect(rows.every((row) => row.opponent.leagueLookupAttempted === true)).toBe(true);
  });

  test.each([
    ["random", [{ race: "RANDOM", mmr: 4500 }]],
    ["ai", [{ race: "AI", mmr: 4500 }]],
    ["no-match", [{ race: "ZERG", mmr: 4500 }]],
  ])("marks a Pulse %s result attempted without stamping MMR", async (suffix, result) => {
    await db.games.insertOne(
      game(`miss-${suffix}-201`, {
        pulseCharacterId: "201",
        race: "Protoss",
      }),
    );
    const pulse = pulseFake({ 201: result });

    await build(pulse).runOnce();

    const row = await db.games.findOne({ gameId: `miss-${suffix}-201` });
    expect(row.opponent.mmrLookupAttempted).toBe(true);
    expect(row.opponent).not.toHaveProperty("mmr");
  });

  test("accepts the inclusive MMR limits and rejects values outside them", async () => {
    await db.games.insertMany([
      game("limit-301", { pulseCharacterId: "301" }),
      game("limit-302", { pulseCharacterId: "302" }),
      game("limit-303", { pulseCharacterId: "303" }),
      game("limit-304", { pulseCharacterId: "304" }),
    ]);
    const pulse = pulseFake({
      301: [{ race: "PROTOSS", mmr: 1000 }],
      302: [{ race: "PROTOSS", mmr: 8000 }],
      303: [{ race: "PROTOSS", mmr: 999 }],
      304: [{ race: "PROTOSS", mmr: 8001 }],
    });

    await build(pulse).runOnce();

    const rows = Object.fromEntries(
      (await db.games.find({}).toArray()).map((row) => [row.gameId, row.opponent]),
    );
    expect(rows["limit-301"].mmr).toBe(1000);
    expect(rows["limit-302"].mmr).toBe(8000);
    expect(rows["limit-303"]).not.toHaveProperty("mmr");
    expect(rows["limit-304"]).not.toHaveProperty("mmr");
    expect(Object.values(rows).every((opponent) => opponent.mmrLookupAttempted)).toBe(true);
  });

  test("includes the exact recency boundary but leaves the preceding millisecond untouched", async () => {
    const cutoff = NOW_MS - WINDOW_MS;
    await db.games.insertMany([
      game("window-401", { pulseCharacterId: "401" }, { createdAt: new Date(cutoff) }),
      game("window-402", { pulseCharacterId: "402" }, { createdAt: new Date(cutoff - 1) }),
    ]);
    const pulse = pulseFake({
      401: [{ race: "PROTOSS", mmr: 4100 }],
      402: [{ race: "PROTOSS", mmr: 4200 }],
    });

    await build(pulse).runOnce();

    const included = await db.games.findOne({ gameId: "window-401" });
    const excluded = await db.games.findOne({ gameId: "window-402" });
    expect(included.opponent.mmr).toBe(4100);
    expect(included.opponent.mmrLookupAttempted).toBe(true);
    expect(excluded.opponent).not.toHaveProperty("mmrLookupAttempted");
    expect(pulse.calls).toEqual(["401"]);
  });

  test("does not stamp current Pulse MMR onto an old replay imported today", async () => {
    await db.games.insertOne(
      game(
        "historical-450",
        { pulseCharacterId: "450" },
        {
          date: new Date(NOW_MS - WINDOW_MS - 1),
          createdAt: new Date(NOW_MS - 1),
        },
      ),
    );
    const pulse = pulseFake({
      450: [{ race: "PROTOSS", mmr: 4450, league: "Master" }],
    });

    await build(pulse).runOnce();

    const row = await db.games.findOne({ gameId: "historical-450" });
    expect(row.opponent).not.toHaveProperty("mmr");
    expect(row.opponent).not.toHaveProperty("mmrLookupAttempted");
    expect(pulse.calls).toEqual([]);
  });

  test("an attempted row is not selected again", async () => {
    await db.games.insertOne(
      game("attempted-501", {
        pulseCharacterId: "501",
        mmrLookupAttempted: true,
        leagueLookupAttempted: true,
      }),
    );
    const pulse = pulseFake({
      501: [{ race: "PROTOSS", mmr: 4500 }],
    });

    await build(pulse).runOnce();

    expect(pulse.calls).toEqual([]);
    const row = await db.games.findOne({ gameId: "attempted-501" });
    expect(row.opponent).not.toHaveProperty("mmr");
  });

  test("does not enrich quarantined resume-from-replay rows", async () => {
    await db.games.insertMany([
      game("competitive-521", { pulseCharacterId: "521" }),
      game(
        "resumed-522",
        { pulseCharacterId: "522" },
        { isResumedFromReplay: true },
      ),
    ]);
    const pulse = pulseFake({
      521: [{ race: "PROTOSS", mmr: 4521, league: "Master" }],
      522: [{ race: "PROTOSS", mmr: 4522, league: "Master" }],
    });

    await build(pulse).runOnce();

    expect(pulse.calls).toEqual(["521"]);
    expect(await db.games.findOne({ gameId: "competitive-521" }))
      .toMatchObject({
        opponent: {
          mmr: 4521,
          mmrLookupAttempted: true,
          leagueLookupAttempted: true,
        },
      });
    expect(await db.games.findOne({ gameId: "resumed-522" }))
      .toMatchObject({
        opponent: { pulseCharacterId: "522" },
      });
    expect(await db.games.findOne({ gameId: "resumed-522" }))
      .not.toHaveProperty("opponent.mmrLookupAttempted");
  });

  test("server-owned MMR and league fields survive an agent re-upload", async () => {
    const games = new GamesService(db);
    await games.upsert("user-1", {
      gameId: "reupload-551",
      date: new Date(NOW_MS - 60_000),
      result: "Victory",
      myRace: "Zerg",
      map: "Amygdala LE",
      opponent: {
        pulseCharacterId: "551",
        race: "Protoss",
      },
    });
    await db.games.updateOne(
      { gameId: "reupload-551" },
      {
        $set: {
          "opponent.mmr": 4551,
          "opponent.mmrLookupAttempted": true,
          "opponent.leagueId": 5,
          "opponent.leagueLookupAttempted": true,
        },
      },
    );

    await games.upsert("user-1", {
      gameId: "reupload-551",
      date: new Date(NOW_MS - 60_000),
      result: "Victory",
      myRace: "Zerg",
      map: "Amygdala LE",
      opponent: {
        pulseCharacterId: "551",
        race: "Protoss",
      },
    });

    const row = await db.games.findOne({ gameId: "reupload-551" });
    expect(row.opponent.mmr).toBe(4551);
    expect(row.opponent.mmrLookupAttempted).toBe(true);
    expect(row.opponent.leagueId).toBe(5);
    expect(row.opponent.leagueLookupAttempted).toBe(true);
  });

  test("honors the per-tick cap and processes the remainder next cycle", async () => {
    await db.games.insertMany([
      game("cap-601", { pulseCharacterId: "601" }),
      game("cap-602", { pulseCharacterId: "602" }),
      game("cap-603", { pulseCharacterId: "603" }),
    ]);
    const pulse = pulseFake({
      601: [{ race: "PROTOSS", mmr: 4601 }],
      602: [{ race: "PROTOSS", mmr: 4602 }],
      603: [{ race: "PROTOSS", mmr: 4603 }],
    });
    const job = build(pulse, { gamesPerTick: 2 });

    await job.runOnce();
    expect(await db.games.countDocuments({ "opponent.mmrLookupAttempted": true })).toBe(2);
    expect(pulse.calls).toHaveLength(2);

    await job.runOnce();
    expect(await db.games.countDocuments({ "opponent.mmrLookupAttempted": true })).toBe(3);
    expect(pulse.calls).toHaveLength(3);
  });

  test("does not run when another replica holds the advisory lock", async () => {
    await db.games.insertOne(game("lock-701", { pulseCharacterId: "701" }));
    const lockKey = (__internal && __internal.LOCK_KEY) || "opponentMmrEnrichment";
    await db.db.collection("jobLocks").insertOne({
      key: lockKey,
      acquiredAt: new Date(NOW_MS),
      expiresAt: new Date(NOW_MS + 60_000),
    });
    const pulse = pulseFake({
      701: [{ race: "PROTOSS", mmr: 4700 }],
    });

    const summary = await build(pulse).runOnce();

    expect(summary.ranAsLeader).toBe(false);
    expect(pulse.calls).toEqual([]);
    expect(await db.db.collection("jobLocks").findOne({ key: lockKey })).not.toBeNull();
  });

  test("Pulse misses are one-shot while transport errors remain retryable", async () => {
    await db.games.insertMany([
      game("pulse-801", { pulseCharacterId: "801" }),
      game("pulse-802", { pulseCharacterId: "802" }),
    ]);
    const pulse = pulseFake({
      801: [],
      802: new Error("Pulse unavailable"),
    });

    await build(pulse).runOnce();

    const miss = await db.games.findOne({ gameId: "pulse-801" });
    const failed = await db.games.findOne({ gameId: "pulse-802" });
    expect(miss.opponent.mmrLookupAttempted).toBe(true);
    expect(miss.opponent.leagueLookupAttempted).toBe(true);
    expect(miss.opponent).not.toHaveProperty("mmr");
    expect(failed.opponent).not.toHaveProperty("mmrLookupAttempted");
    expect(failed.opponent).not.toHaveProperty("leagueLookupAttempted");
    expect(pulse.calls.sort()).toEqual(["801", "802"]);

    await build(pulse).runOnce();
    expect(pulse.calls.filter((id) => id === "801")).toHaveLength(1);
    expect(pulse.calls.filter((id) => id === "802")).toHaveLength(2);
  });

  test("selects ladder=true or league-present rows and excludes ineligible rows", async () => {
    await db.games.insertMany([
      game("select-901", { pulseCharacterId: "901" }),
      game(
        "select-902",
        { pulseCharacterId: "902", leagueId: 4 },
        { isLadderGame: false },
      ),
      game("select-903", { pulseCharacterId: "903" }, { isLadderGame: false }),
      game("select-904", { pulseCharacterId: "" }),
      game("select-905", { pulseCharacterId: "905", race: "Random" }),
      game("select-906", {
        pulseCharacterId: "906",
        mmr: 4900,
        mmrLookupAttempted: true,
      }),
    ]);
    const pulse = pulseFake({
      901: [{ race: "PROTOSS", mmr: 4901, league: "Diamond" }],
      902: [{ race: "PROTOSS", mmr: 4902, league: "Master" }],
      903: [{ race: "PROTOSS", mmr: 4903 }],
      905: [{ race: "RANDOM", mmr: 4905 }],
      906: [{ race: "PROTOSS", mmr: 4906, league: "Master" }],
    });

    await build(pulse).runOnce();

    expect(pulse.calls.sort()).toEqual(["901", "902", "906"]);
    expect(await db.games.countDocuments({ "opponent.mmrLookupAttempted": true })).toBe(3);
    const eligible = await db.games.find({ gameId: { $in: ["select-901", "select-902"] } }).toArray();
    expect(eligible.map((row) => row.opponent.mmr).sort()).toEqual([4901, 4902]);
    const leagueOnly = await db.games.findOne({ gameId: "select-906" });
    expect(leagueOnly.opponent.mmr).toBe(4900);
    expect(leagueOnly.opponent.mmrLookupAttempted).toBe(true);
    expect(leagueOnly.opponent.leagueId).toBe(5);
    expect(leagueOnly.opponent.leagueLookupAttempted).toBe(true);
  });

  test("normalizes Pulse league shapes and rejects missing or invalid values", () => {
    expect(__internal.normalizeLeagueId("Grandmaster")).toBe(6);
    expect(__internal.normalizeLeagueId({ type: 3 })).toBe(3);
    expect(__internal.normalizeLeagueId("0")).toBe(0);
    expect(__internal.normalizeLeagueId(null)).toBeNull();
    expect(__internal.normalizeLeagueId("Unknown")).toBeNull();
    expect(__internal.normalizeLeagueId(7)).toBeNull();
  });

  test("notifies aggregate refresh after a league is repaired", async () => {
    await db.games.insertOne(
      game("refresh-951", {
        pulseCharacterId: "951",
        mmr: 4951,
      }),
    );
    const pulse = pulseFake({
      951: [{ race: "PROTOSS", mmr: 4951, league: "Master" }],
    });
    const onLeagueEnriched = jest.fn(async () => {});

    const summary = await build(pulse, { onLeagueEnriched }).runOnce();

    expect(summary.leagueEnriched).toBe(1);
    expect(onLeagueEnriched).toHaveBeenCalledTimes(1);
    expect(onLeagueEnriched).toHaveBeenCalledWith(summary);
  });

  test("concurrent runOnce calls coalesce onto one Pulse request", async () => {
    await db.games.insertOne(game("flight-1001", { pulseCharacterId: "1001" }));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const pulseMmr = {
      getRaceBreakdown: jest.fn(async () => {
        entered();
        await gate;
        return [{ race: "PROTOSS", mmr: 5100 }];
      }),
    };
    const job = build(pulseMmr);

    const first = job.runOnce();
    await started;
    const second = job.runOnce();
    release();
    await Promise.all([first, second]);

    expect(pulseMmr.getRaceBreakdown).toHaveBeenCalledTimes(1);
    const row = await db.games.findOne({ gameId: "flight-1001" });
    expect(row.opponent.mmr).toBe(5100);
  });
