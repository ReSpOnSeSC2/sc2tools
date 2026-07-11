// @ts-nocheck
"use strict";

/**
 * Ladder Meta Radar (services/ladderMeta.js + routes/ladderMeta.js)
 * against real Mongo (mongodb-memory-server):
 *
 *   1. recompute builds one row per (leagueBand, matchup) band whose
 *      top openers are ranked by games, carry correct wins/losses/
 *      winrate/frequency, and drop excluded rows (Game Too Short, team
 *      games, non-P/T/Z races, missing league) + sub-floor openers.
 *   2. lookup suppresses a band below the MIN_SAMPLE games floor
 *      (k-anonymity) and normalizes matchup casing.
 *   3. A second recompute with shifted data yields week-over-week
 *      winrate/frequency deltas; an unchanged re-run is idempotent with
 *      zero deltas.
 *   4. No userId (or any per-user field) appears in the output.
 *   5. Route contract for GET /v1/meta/ladder through the real app
 *      wiring: 400 on bad params, 404 not_enough_data, 200 { row }.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const {
  LadderMetaService,
  COLLECTION_NAME,
  MIN_SAMPLE,
  OPENER_MIN_SAMPLE,
} = require("../src/services/ladderMeta");
const { buildLadderMetaRouter } = require("../src/routes/ladderMeta");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async () => {
    throw new Error("invalid");
  }),
}));

const DIAMOND = 4;
const MASTER = 5;

const A = "PvZ - Gateway Expand";
const B = "PvZ - 4 Gate";
const C = "PvZ - Cannon Rush";
const D = "PvZ - Proxy Stargate";

describe("ladder meta radar", () => {
  let mongo;
  let db;
  let svc;
  let outColl;
  let idSeq;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_ladder_meta",
    });
    svc = new LadderMetaService(db, { logger: null });
    outColl = db.db.collection(COLLECTION_NAME);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await outColl.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  /** Emit ``count`` slim games rows for one (league, matchup, opener)
   *  bucket, the first ``wins`` of them Victories and the rest Defeats.
   *  Global id counter keeps every gameId unique so the {userId,gameId}
   *  index never collides regardless of the userId spread. */
  function bucket({
    count,
    wins,
    build,
    leagueId = DIAMOND,
    myRace = "Protoss",
    oppRace = "Zerg",
    extra = {},
  }) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      idSeq += 1;
      out.push({
        userId: `seed-user-${idSeq % 12}`,
        gameId: `g-${idSeq}`,
        date: new Date(Date.UTC(2026, 5, 1 + (idSeq % 27))),
        result: i < wins ? "Victory" : "Defeat",
        myRace,
        map: "Meta Map",
        myBuild: build,
        opponent: {
          displayName: `opp-${idSeq}`,
          race: oppRace,
          ...(leagueId === null ? {} : { leagueId }),
        },
        _schemaVersion: 5,
        ...extra,
      });
    }
    return out;
  }

  /**
   * Diamond PvZ band: A(30g,21w=.70), B(20g,8w=.40), C(12g,6w=.50),
   * D(5g — below the per-opener floor). Band n = 67.
   * Plus EXCLUDED rows shaped like Diamond PvZ, all all-wins so any leak
   * would visibly move opener A / band n: Game Too Short, team game
   * (playerCount 4), Random race, missing leagueId.
   * Plus a below-MIN_SAMPLE band: Master PvZ, one opener, 20 games.
   */
  async function seedCorpus() {
    idSeq = 0;
    const docs = [
      ...bucket({ build: A, count: 30, wins: 21 }),
      ...bucket({ build: B, count: 20, wins: 8 }),
      ...bucket({ build: C, count: 12, wins: 6 }),
      ...bucket({ build: D, count: 5, wins: 3 }),
      // excluded — must not contaminate n or opener A
      ...bucket({ build: "PvZ - Game Too Short", count: 10, wins: 10 }),
      ...bucket({ build: A, count: 10, wins: 10, extra: { playerCount: 4 } }),
      ...bucket({ build: A, count: 8, wins: 8, myRace: "Random" }),
      ...bucket({ build: A, count: 8, wins: 8, leagueId: null }),
      // separate band, below the games floor -> suppressed
      ...bucket({ build: B, count: 20, wins: 10, leagueId: MASTER }),
    ];
    await db.games.insertMany(docs);
  }

  test("recompute ranks top openers and excludes junk + sub-floor", async () => {
    await seedCorpus();
    const res = await svc.recompute();
    // Diamond PvZ + Master PvZ each produce a stored band row.
    expect(res.bands).toBe(2);
    expect(res.updatedAt).toBeInstanceOf(Date);

    const row = await svc.lookup({ leagueId: DIAMOND, matchup: "PvZ" });
    expect(row).not.toBeNull();
    expect(row.league).toBe("Diamond");
    expect(row.matchup).toBe("PvZ");
    expect(row.leagueBand).toBe(DIAMOND);
    // n counts A+B+C+D (67); excluded rows did not contaminate it.
    expect(row.n).toBe(67);

    // D (5 games) is below OPENER_MIN_SAMPLE -> dropped; top openers are
    // ranked by games desc.
    expect(OPENER_MIN_SAMPLE).toBe(10);
    expect(row.openers.map((o) => o.build)).toEqual([A, B, C]);

    const opA = row.openers[0];
    expect(opA.games).toBe(30);
    expect(opA.wins).toBe(21);
    expect(opA.losses).toBe(9);
    expect(opA.winRate).toBeCloseTo(0.7, 5);
    // frequency = games / band n
    expect(opA.frequency).toBeCloseTo(30 / 67, 4);
    // no prior run yet
    expect(opA.winRateDelta).toBeNull();
    expect(opA.freqDelta).toBeNull();
    expect(opA.isNew).toBe(true);

    expect(row.openers[1].winRate).toBeCloseTo(0.4, 5);
    expect(row.openers[2].winRate).toBeCloseTo(0.5, 5);
  });

  test("lookup suppresses bands under the MIN_SAMPLE games floor", async () => {
    await seedCorpus();
    await svc.recompute();
    // The raw aggregate row exists (aggregate-only data)...
    const raw = await outColl.findOne({ leagueBand: MASTER, matchup: "PvZ" });
    expect(raw).not.toBeNull();
    expect(raw.n).toBe(20);
    expect(raw.n).toBeLessThan(MIN_SAMPLE);
    // ...but lookup refuses to serve it.
    expect(await svc.lookup({ leagueId: MASTER, matchup: "PvZ" })).toBeNull();
  });

  test("lookup normalizes matchup casing and rejects junk", async () => {
    await seedCorpus();
    await svc.recompute();
    const row = await svc.lookup({ leagueId: DIAMOND, matchup: "pvz" });
    expect(row).not.toBeNull();
    expect(row.matchup).toBe("PvZ");
    expect(await svc.lookup({ leagueId: DIAMOND, matchup: "PvX" })).toBeNull();
    expect(await svc.lookup({ leagueId: "4", matchup: "PvZ" })).toBeNull();
    expect(await svc.lookup({ leagueId: 2, matchup: "PvZ" })).toBeNull();
  });

  test("week-over-week deltas appear after a second, shifted recompute", async () => {
    await seedCorpus();
    await svc.recompute(); // run 1: opener A winrate .70

    // Shift: add 30 Defeats for opener A. New A: 60 games, 21 wins ->
    // winrate .35 (was .70).
    idSeq = 10000;
    await db.games.insertMany(bucket({ build: A, count: 30, wins: 0 }));
    const second = await svc.recompute(); // run 2: prev = run 1 openers
    expect(second.bands).toBe(2);

    const row = await svc.lookup({ leagueId: DIAMOND, matchup: "PvZ" });
    const opA = row.openers.find((o) => o.build === A);
    expect(opA.games).toBe(60);
    expect(opA.winRate).toBeCloseTo(0.35, 4);
    expect(opA.isNew).toBe(false);
    // winrate fell by ~0.35
    expect(opA.winRateDelta).toBeCloseTo(0.35 - 0.7, 3);
    expect(opA.winRateDelta).toBeLessThan(0);
    // prevalence rose (A now a bigger share of the band)
    expect(opA.freqDelta).toBeGreaterThan(0);
    expect(row.prevUpdatedAt).toBeInstanceOf(Date);
  });

  test("recompute is idempotent: unchanged re-run => zero deltas", async () => {
    await seedCorpus();
    await svc.recompute();
    const second = await svc.recompute();
    expect(second.bands).toBe(2);

    const row = await svc.lookup({ leagueId: DIAMOND, matchup: "PvZ" });
    expect(row.openers.map((o) => o.build)).toEqual([A, B, C]);
    for (const o of row.openers) {
      expect(o.isNew).toBe(false);
      expect(o.winRateDelta).toBe(0);
      expect(o.freqDelta).toBe(0);
    }
    // A vanished band is dropped on the next run.
    await db.games.deleteMany({ "opponent.leagueId": MASTER });
    const third = await svc.recompute();
    expect(third.bands).toBe(1);
    expect(await outColl.findOne({ leagueBand: MASTER })).toBeNull();
  });

  test("no userId (or per-user field) in the output collection", async () => {
    await seedCorpus();
    await svc.recompute();
    const docs = await outColl.find({}).toArray();
    expect(docs.length).toBe(2);
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      expect(json).not.toContain("userId");
      expect(json).not.toContain("seed-user");
      expect(Object.keys(doc).sort()).toEqual(
        [
          "_id",
          "_schemaVersion",
          "league",
          "leagueBand",
          "matchup",
          "n",
          "openers",
          "prevOpeners",
          "prevUpdatedAt",
          "updatedAt",
        ].sort(),
      );
    }
  });
});

describe("GET /v1/meta/ladder", () => {
  let mongo;
  let db;
  let app;
  let ladderMeta;
  let idSeq = 0;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_ladder_meta_route",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 9),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    // buildApp constructs the network-disabled service bundle and proves
    // the wiring. The Ladder Meta route is PUBLIC and (pending the app.js
    // wiring change — app.js is off-limits for this change, see the PR's
    // wiring report) not yet in buildApp's public bundle, so mount it on
    // a small standalone express app here — the same idiom
    // publicProfile.test.js uses. No auth — see routes/ladderMeta.js.
    buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });
    ladderMeta = new LadderMetaService(db, { logger: null });
    app = express();
    app.use(express.json());
    app.use("/v1", buildLadderMetaRouter({ ladderMeta }));
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function get(query) {
    return request(app).get(`/v1/meta/ladder${query}`);
  }

  test("400s on missing/invalid params", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?leagueId=4")).status).toBe(400);
    expect((await get("?leagueId=4&matchup=XvY")).status).toBe(400);
    expect((await get("?leagueId=abc&matchup=PvZ")).status).toBe(400);
  });

  test("404s when the band has no table yet", async () => {
    const res = await get("?leagueId=4&matchup=PvZ");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_enough_data");
  });

  test("serves the row once the corpus supports the band", async () => {
    const docs = [];
    // 60 Diamond PvZ games across two openers, past the games floor.
    for (let i = 0; i < 40; i += 1) {
      idSeq += 1;
      docs.push({
        userId: `u_${idSeq % 10}`,
        gameId: `meta_g_${idSeq}`,
        date: new Date(Date.UTC(2026, 5, 1 + (idSeq % 27))),
        result: i % 2 === 0 ? "Victory" : "Defeat",
        myRace: "Protoss",
        map: "Meta Map",
        myBuild: A,
        playerCount: 2,
        opponent: { race: "Zerg", leagueId: 4 },
      });
    }
    for (let i = 0; i < 20; i += 1) {
      idSeq += 1;
      docs.push({
        userId: `u_${idSeq % 10}`,
        gameId: `meta_g_${idSeq}`,
        date: new Date(Date.UTC(2026, 5, 1 + (idSeq % 27))),
        result: i < 5 ? "Victory" : "Defeat",
        myRace: "Protoss",
        map: "Meta Map",
        myBuild: B,
        playerCount: 2,
        opponent: { race: "Zerg", leagueId: 4 },
      });
    }
    await db.games.insertMany(docs);
    await ladderMeta.recompute();

    const res = await get("?leagueId=4&matchup=PvZ");
    expect(res.status).toBe(200);
    expect(res.body.row).toBeTruthy();
    expect(res.body.row.matchup).toBe("PvZ");
    expect(res.body.row.leagueBand).toBe(4);
    expect(res.body.row.openers[0].build).toBe(A);
  });
});
