// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const { buildAggregationsRouter } = require("../src/routes/aggregations");

describe("net MMR by opponent", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "net_mmr_opponents" });
    service = new AggregationsService(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
  });

  function game(gameId, minute, myMmr, result, opponent) {
    return {
      userId: "u1",
      gameId,
      date: new Date(Date.UTC(2026, 6, 1, 12, minute)),
      result,
      myRace: "Protoss",
      myLadderRace: "Protoss",
      myMmr,
      myMmrSource: "replay",
      myToonHandle: "1-S2-1-100",
      isLadderGame: true,
      playerCount: 2,
      map: "Test LE",
      durationSec: 600,
      opponent,
    };
  }

  async function seedAcceptedPairs() {
    await db.games.insertMany([
      game("g1", 0, 4000, "Victory", {
        pulseId: "1-S2-1-alpha",
        toonHandle: "1-S2-1-alpha",
        pulseCharacterId: "101",
        displayName: "AlphaOld",
        race: "Zerg",
      }),
      game("g2", 10, 4025, "Defeat", {
        pulseId: "1-S2-1-alpha",
        toonHandle: "1-S2-1-alpha",
        pulseCharacterId: "101",
        displayName: "Alpha",
        race: "Zerg",
      }),
      game("g3", 20, 4005, "Victory", {
        pulseId: "1-S2-1-beta",
        toonHandle: "1-S2-1-beta",
        pulseCharacterId: "202",
        displayName: "Beta",
        race: "Zerg",
      }),
      game("g4", 30, 4035, "Victory", {
        pulseId: "1-S2-1-beta",
        toonHandle: "1-S2-1-beta",
        pulseCharacterId: "202",
        displayName: "Beta",
        race: "Zerg",
      }),
      // Terminal observation: supplies g4's +25 but has no own delta.
      game("g5", 40, 4060, "Defeat", {
        pulseId: "1-S2-1-gamma",
        toonHandle: "1-S2-1-gamma",
        displayName: "Gamma",
        race: "Protoss",
      }),
    ]);
  }

  test("groups accepted pairs by stable opponent identity and reconciles to the race bar", async () => {
    await seedAcceptedPairs();

    const result = await service.netMmrByOpponent("u1", {}, {
      opponentRace: "Z",
      sort: "name",
    });
    expect(result.totalOpponents).toBe(2);
    expect(result.items.map((row) => row.name)).toEqual(["Alpha", "Beta"]);

    const [alpha, beta] = result.items;
    expect(alpha).toMatchObject({
      pulseId: "1-S2-1-alpha",
      toonHandle: "1-S2-1-alpha",
      pulseCharacterId: "101",
      opponentRace: "Z",
      netMmr: 5,
      mmrWon: 25,
      mmrLost: 20,
      pairs: 2,
      games: 2,
      wins: 1,
      losses: 1,
      avgDelta: 2.5,
    });
    expect(alpha.winRate).toBeCloseTo(0.5);
    expect(beta).toMatchObject({
      netMmr: 55,
      mmrWon: 55,
      mmrLost: 0,
      pairs: 2,
      wins: 2,
      losses: 0,
      avgDelta: 27.5,
    });

    expect(result.summary).toMatchObject({
      netMmr: 60,
      mmrWon: 80,
      mmrLost: 20,
      pairs: 4,
      opponents: 2,
    });
    expect(result.summary.mostMmrGainedFrom.name).toBe("Beta");
    expect(result.summary.mostMmrLostTo.name).toBe("Alpha");

    const matchup = await service.netMmrByMatchup("u1", { oppRace: "Z" });
    expect(matchup.matchups).toHaveLength(1);
    expect(matchup.matchups[0].netMmr).toBe(result.summary.netMmr);
    expect(matchup.matchups[0].pairs).toBe(result.summary.pairs);
  });

  test("search, minimum pairs, sorting, and pagination apply after grouping", async () => {
    await seedAcceptedPairs();

    const searched = await service.netMmrByOpponent("u1", {}, {
      opponentRace: "Z",
      search: "beta",
    });
    expect(searched.items).toHaveLength(1);
    expect(searched.items[0].name).toBe("Beta");
    expect(searched.summary).toMatchObject({
      opponents: 1,
      pairs: 2,
      netMmr: 55,
    });

    const tooFew = await service.netMmrByOpponent("u1", {}, {
      opponentRace: "Z",
      minPairs: 3,
    });
    expect(tooFew.items).toEqual([]);
    expect(tooFew.total).toBe(0);
    expect(tooFew.summary.mostMmrGainedFrom).toBeNull();
    expect(tooFew.summary.mostMmrLostTo).toBeNull();

    const page = await service.netMmrByOpponent("u1", {}, {
      opponentRace: "Z",
      sort: "mmr_lost",
      order: "desc",
      limit: 1,
      offset: 1,
    });
    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].name).toBe("Beta");
    // Headline leaders are pre-pagination.
    expect(page.summary.mostMmrLostTo.name).toBe("Alpha");
  });

  test("supports unknown race without treating display names as player identity", async () => {
    await db.games.insertMany([
      game("u1", 0, 4100, "Victory", { displayName: "Mystery", race: "" }),
      // Same visible name, but no durable ID: these must remain separate
      // opponents rather than silently merging two different barcodes.
      game("u2", 10, 4120, "Victory", { displayName: "Mystery", race: "" }),
      game("u3", 20, 4140, "Victory", { race: "" }),
      game("u4", 30, 4160, "Victory", { race: "Zerg" }),
    ]);

    const result = await service.netMmrByOpponent("u1", {}, {
      opponentRace: "U",
      sort: "name",
    });
    expect(result.summary).toMatchObject({ netMmr: 60, pairs: 3, opponents: 3 });
    expect(result.items.map((row) => row.name)).toEqual([
      "Mystery",
      "Mystery",
      "Unknown opponent",
    ]);
  });
});

describe("GET /v1/mmr-by-matchup/opponents", () => {
  test("normalizes drill-down controls and forwards global filters", async () => {
    const netMmrByOpponent = jest.fn(async () => ({ items: [] }));
    const router = buildAggregationsRouter({
      auth: (req, _res, next) => {
        req.auth = { userId: "u-route" };
        next();
      },
      aggregations: { netMmrByOpponent },
      macroReport: {},
      streak: {},
    });
    const app = express();
    app.use("/v1", router);

    const res = await request(app).get(
      "/v1/mmr-by-matchup/opponents?oppRace=U&since=2026-01-01" +
        "&search=Alpha&min_pairs=3&sort=mmr_lost&order=asc&limit=25&offset=5",
    );
    expect(res.status).toBe(200);
    expect(netMmrByOpponent).toHaveBeenCalledWith(
      "u-route",
      expect.objectContaining({ since: expect.any(Date) }),
      {
        opponentRace: "U",
        search: "Alpha",
        minPairs: 3,
        sort: "mmr_lost",
        order: "asc",
        limit: 25,
        offset: 5,
      },
    );
  });

  test("accepts canonical opp_race and keeps it in the global filter set", async () => {
    const netMmrByOpponent = jest.fn(async () => ({ items: [] }));
    const router = buildAggregationsRouter({
      auth: (req, _res, next) => {
        req.auth = { userId: "u-route" };
        next();
      },
      aggregations: { netMmrByOpponent },
      macroReport: {},
      streak: {},
    });
    const app = express();
    app.use("/v1", router);

    const res = await request(app).get(
      "/v1/mmr-by-matchup/opponents?opp_race=P",
    );
    expect(res.status).toBe(200);
    expect(netMmrByOpponent).toHaveBeenCalledWith(
      "u-route",
      { oppRace: "P" },
      expect.objectContaining({ opponentRace: "P" }),
    );
  });
});
