// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { SnapshotCohortService } = require("../src/services/snapshotCohort");
const { SnapshotNeighborsService, oppositeResult, vectorAt, subtractVectors } = require("../src/services/snapshotNeighbors");
const { GameDetailsService } = require("../src/services/gameDetails");
const { makeGameAndDetail } = require("./fixtures/snapshotFixtures");

class InMemoryStore {
  constructor() {
    this.rows = new Map();
  }
  k(u, g) { return `${u}:${g}`; }
  async write(u, g, _d, blob) { this.rows.set(this.k(u, g), blob); }
  async read(u, g) { return this.rows.get(this.k(u, g)) || null; }
  async readMany(u, ids) {
    const m = new Map();
    for (const id of ids) {
      const r = this.rows.get(this.k(u, id));
      if (r) m.set(id, r);
    }
    return m;
  }
  async delete() {}
  async deleteAllForUser() {}
}

describe("snapshotNeighbors helpers", () => {
  test("oppositeResult flips win<->loss", () => {
    expect(oppositeResult("Victory")).toBe("loss");
    expect(oppositeResult("Defeat")).toBe("win");
    expect(oppositeResult("Tie")).toBe("win");
  });

  test("vectorAt extracts the unit map at the given tick", () => {
    const detail = {
      macroBreakdown: {
        unit_timeline: [
          { time: 0, my: { Probe: 12 } },
          { time: 240, my: { Probe: 30, Stalker: 4 } },
        ],
      },
    };
    expect(vectorAt(detail, 240)).toEqual({ Probe: 30, Stalker: 4 });
    expect(vectorAt(detail, 30)).toEqual({});
  });

  test("subtractVectors returns non-zero diffs only", () => {
    const a = { Probe: 30, Stalker: 6, Sentry: 1 };
    const b = { Probe: 30, Stalker: 4 };
    expect(subtractVectors(a, b)).toEqual({ Stalker: 2, Sentry: 1 });
  });
});

describe("SnapshotNeighborsService.findNeighbors", () => {
  let mongo;
  let db;
  let svc;
  let cohort;
  let gameDetails;
  let store;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "snapshot_neighbors_test" });
    store = new InMemoryStore();
    gameDetails = new GameDetailsService(store);
    cohort = new SnapshotCohortService(db, { gameDetails });
    svc = new SnapshotNeighborsService(db, { gameDetails, cohort });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    store.rows.clear();
  });

  test("finds K winning neighbors when focus game lost", async () => {
    const seeds = [
      makeGameAndDetail({ gameId: "focus", result: "Defeat" }),
    ];
    for (let i = 0; i < 10; i += 1) {
      seeds.push(makeGameAndDetail({ gameId: `g${i}`, result: i < 7 ? "Victory" : "Defeat" }));
    }
    for (const { game, detail } of seeds) {
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    const out = await svc.findNeighbors({
      userId: "u1",
      gameId: "focus",
      anchorTick: 240,
      divergenceTick: 360,
      k: 3,
    });
    expect(out.neighbors.length).toBeGreaterThan(0);
    for (const n of out.neighbors) {
      expect(n.result).toBe("win");
      expect(n.similarityAtAnchor).toBeGreaterThan(0);
      expect(typeof n.summary).toBe("string");
    }
  });

  test("returns empty list when focus game not found", async () => {
    await expect(
      svc.findNeighbors({ userId: "u1", gameId: "missing", anchorTick: 60 }),
    ).rejects.toThrow("focus_game_not_found");
  });

  test("rejects invalid anchor tick", async () => {
    await expect(
      svc.findNeighbors({ userId: "u1", gameId: "g", anchorTick: -1 }),
    ).rejects.toThrow("invalid_anchor_tick");
  });
});
