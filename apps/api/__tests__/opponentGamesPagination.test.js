// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { buildOpponentsRouter } = require("../src/routes/opponents");
const { OpponentsService } = require("../src/services/opponents");

describe("opponent replay-history cursor pages", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "opponent_games_pagination_test",
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  function game({ userId = "u1", id, date, pulseId = "opp-a", cid = "11", map = "Alcyone LE", ladder = true }) {
    return {
      userId,
      gameId: id,
      date,
      result: id.endsWith("1") ? "Defeat" : "Victory",
      map,
      myRace: "Protoss",
      myBuild: "Blink",
      myMmr: 4010,
      durationSec: 611,
      macroScore: 82,
      isLadderGame: ladder,
      matchFormat: "1v1",
      playerCount: 2,
      // These are intentionally large/private and must not reach the page.
      buildLog: [{ name: "Gateway", payload: "x".repeat(500) }],
      macroBreakdown: { stats_events: [{ secret: true }] },
      replayFile: {
        sizeBytes: 123456,
        storedAt: new Date("2026-08-11T00:00:00Z"),
        sha256: "do-not-serialize",
      },
      opponent: {
        pulseId,
        pulseCharacterId: cid,
        displayName: pulseId === "opp-b" ? "Alias" : "Rival",
        race: "Terran",
        strategy: "2-1-1",
        mmr: 4150,
      },
    };
  }

  async function seedOpponentRows() {
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: "opp-a",
        pulseCharacterId: "11",
        displayNameSample: "Rival",
        gameCount: 5,
        wins: 4,
        losses: 1,
        lastSeen: new Date("2026-08-10T12:00:00Z"),
      },
      {
        userId: "u2",
        pulseId: "opp-a",
        pulseCharacterId: "11",
        displayNameSample: "Other user's Rival",
        gameCount: 1,
        wins: 1,
        losses: 0,
        lastSeen: new Date("2026-08-10T12:00:00Z"),
      },
    ]);
  }

  test("walks identical timestamps once each, stays owner-scoped, and emits only compact rows", async () => {
    await seedOpponentRows();
    const sharedDate = new Date("2026-08-10T12:00:00.000Z");
    await db.games.insertMany([
      game({ id: "g1", date: sharedDate }),
      game({ id: "g2", date: sharedDate }),
      game({ id: "g3", date: sharedDate }),
      game({ id: "g4", date: new Date("2026-08-09T12:00:00Z") }),
      game({ userId: "u2", id: "other-user", date: sharedDate }),
    ]);
    const gameDetails = { findMany: jest.fn() };
    const service = new OpponentsService(db, Buffer.alloc(32, 1), {
      gameDetails,
    });

    const first = await service.listGames("u1", "opp-a", { limit: 2 });
    const second = await service.listGames("u1", "opp-a", {
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids)).toEqual(new Set(["g1", "g2", "g3", "g4"]));
    expect(ids).not.toContain("other-user");
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toBeNull();
    expect(gameDetails.findMany).not.toHaveBeenCalled();

    expect(first.items[0]).toEqual(
      expect.objectContaining({
        opponent: "Rival",
        opp_race: "Terran",
        opp_strategy: "2-1-1",
        my_mmr: 4010,
        opp_mmr: 4150,
        replayAvailable: true,
        replaySizeBytes: 123456,
      }),
    );
    expect(first.items[0]).not.toHaveProperty("_id");
    expect(first.items[0]).not.toHaveProperty("buildLog");
    expect(first.items[0]).not.toHaveProperty("macroBreakdown");
    expect(first.items[0]).not.toHaveProperty("replayFile");
    expect(first.items[0]).not.toHaveProperty("sha256");
  });

  test("applies analyzer filters in Mongo before the page limit", async () => {
    await seedOpponentRows();
    await db.games.insertMany([
      game({ id: "custom-new", date: new Date("2026-08-10T00:00:00Z"), ladder: false }),
      game({ id: "ladder-old", date: new Date("2026-08-09T00:00:00Z"), ladder: true }),
      game({ id: "wrong-map", date: new Date("2026-08-08T00:00:00Z"), map: "Ghost River LE", ladder: true }),
    ]);
    const service = new OpponentsService(db, Buffer.alloc(32, 1));

    const page = await service.listGames("u1", "opp-a", {
      limit: 1,
      filters: { mapPool: "ladder", gameSize: "1v1", map: "alcyone" },
    });

    expect(page.items.map((row) => row.id)).toEqual(["ladder-old"]);
    expect(page.nextCursor).toBeNull();
  });

  test("hard-caps a crafted large limit at 200 metadata rows", async () => {
    await seedOpponentRows();
    const base = new Date("2026-08-10T00:00:00Z").getTime();
    await db.games.insertMany(
      Array.from({ length: 205 }, (_, i) =>
        game({ id: `bounded-${i}`, date: new Date(base - i * 1000) }),
      ),
    );
    const service = new OpponentsService(db, Buffer.alloc(32, 1));

    const page = await service.listGames("u1", "opp-a", { limit: 50_000 });

    expect(page.items).toHaveLength(200);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  test("mergeLinked includes linked aliases while excluding unrelated identities", async () => {
    await seedOpponentRows();
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: "opp-b",
        pulseCharacterId: "22",
        displayNameSample: "Alias",
        gameCount: 1,
        wins: 1,
        losses: 0,
        lastSeen: new Date("2026-08-09T00:00:00Z"),
      },
      {
        userId: "u1",
        pulseId: "opp-c",
        pulseCharacterId: "33",
        displayNameSample: "Bystander",
        gameCount: 1,
        wins: 1,
        losses: 0,
        lastSeen: new Date("2026-08-08T00:00:00Z"),
      },
    ]);
    await db.games.insertMany([
      game({ id: "main", date: new Date("2026-08-10T00:00:00Z") }),
      game({ id: "alias", date: new Date("2026-08-09T00:00:00Z"), pulseId: "opp-b", cid: "22" }),
      game({ id: "unrelated", date: new Date("2026-08-08T00:00:00Z"), pulseId: "opp-c", cid: "33" }),
    ]);
    const pulseLinks = {
      getLinks: async (ids) => {
        const links = new Map();
        for (const id of ids) {
          if (id === "11" || id === "22") {
            links.set(id, { accountId: "same-account" });
          }
        }
        return { links, partial: false };
      },
    };
    const service = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseLinks,
    });

    const page = await service.listGames("u1", "opp-a", {
      mergeLinked: true,
    });

    expect(page.items.map((row) => row.id)).toEqual(["main", "alias"]);
  });

  test("rejects malformed cursors and returns null for a non-owner", async () => {
    await seedOpponentRows();
    const service = new OpponentsService(db, Buffer.alloc(32, 1));

    await expect(
      service.listGames("u1", "opp-a", { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(service.listGames("u3", "opp-a")).resolves.toBeNull();
  });
});

describe("GET /opponents/:pulseId/games", () => {
  function appWith(listGames) {
    const app = express();
    const auth = (req, _res, next) => {
      req.auth = { userId: "owner" };
      next();
    };
    app.use(buildOpponentsRouter({ opponents: { listGames }, auth }));
    app.use(buildErrorHandler({ error: jest.fn() }));
    return app;
  }

  test("forwards the cursor, linked mode, page limit, and analyzer scope", async () => {
    const listGames = jest.fn(async () => ({
      items: [{ id: "g1" }],
      nextCursor: "next-opaque",
    }));
    const res = await request(appWith(listGames)).get(
      "/opponents/opp-a/games?limit=75&cursor=opaque"
      + "&mergeLinked=1&map_pool=ladder&opp_race=T",
    );

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(listGames).toHaveBeenCalledWith("owner", "opp-a", {
      filters: expect.objectContaining({ mapPool: "ladder", oppRace: "T" }),
      mergeLinked: true,
      limit: 75,
      cursor: "opaque",
    });
    expect(res.body.nextCursor).toBe("next-opaque");
  });

  test("does not reveal whether another user's opponent games exist", async () => {
    const res = await request(appWith(jest.fn(async () => null))).get(
      "/opponents/not-owned/games",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
  });
});
