// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService profile analyzer scope", () => {
  let mongo;
  let db;
  let opponents;

  const userId = "profile-scope-user";
  const pulseId = "1-S2-1-424242";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_profile_scope" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));

    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      displayNameSample: "ScopedOpponent",
      race: "T",
      gameCount: 5,
      wins: 2,
      losses: 3,
      firstSeen: new Date("2026-01-01T00:00:00Z"),
      lastSeen: new Date("2026-01-05T00:00:00Z"),
    });

    const shared = {
      userId,
      myRace: "Protoss",
      myBuild: "PvT - Core First",
      durationSec: 600,
      macroScore: 75,
      opponent: {
        pulseId,
        toonHandle: pulseId,
        displayName: "ScopedOpponent",
        race: "Terran",
        strategy: "TvP - Reaper Expand",
        region: "NA",
        mmr: 4500,
      },
    };

    await db.games.insertMany([
      {
        ...shared,
        gameId: "ladder-1v1",
        date: new Date("2026-01-05T00:00:00Z"),
        result: "Victory",
        map: "Current Ladder",
        isLadderGame: true,
        isLadderMap: true,
        playerCount: 2,
        matchFormat: "1v1",
      },
      {
        ...shared,
        gameId: "ladder-team",
        date: new Date("2026-01-04T00:00:00Z"),
        result: "Defeat",
        map: "Team Ladder",
        isLadderGame: true,
        isLadderMap: true,
        playerCount: 4,
        matchFormat: "team",
      },
      {
        ...shared,
        gameId: "custom-1v1-on-ladder-map",
        date: new Date("2026-01-03T00:00:00Z"),
        result: "Defeat",
        map: "Historical Ladder",
        isLadderGame: false,
        // This conflict pins the bug: map membership cannot decide
        // whether the lobby itself was ladder or custom.
        isLadderMap: true,
        playerCount: 2,
        matchFormat: "1v1",
      },
      {
        ...shared,
        gameId: "custom-team",
        date: new Date("2026-01-02T00:00:00Z"),
        result: "Victory",
        map: "Custom Team Arena",
        isLadderGame: false,
        isLadderMap: false,
        playerCount: 4,
        matchFormat: "team",
      },
      {
        ...shared,
        gameId: "custom-ffa",
        date: new Date("2026-01-01T00:00:00Z"),
        result: "Defeat",
        map: "Star Auction",
        isLadderGame: false,
        isLadderMap: false,
        playerCount: 8,
        matchFormat: "ffa",
      },
    ]);
  });

  test("ladder 1v1 scope removes custom and multiplayer games everywhere", async () => {
    const out = await opponents.get(userId, pulseId, {
      filters: { mapPool: "ladder", gameSize: "1v1" },
    });

    expect(out.games.map((g) => g.id)).toEqual(["ladder-1v1"]);
    expect(out.last5Games.map((g) => g.id)).toEqual(["ladder-1v1"]);
    expect(out.totals).toMatchObject({ wins: 1, losses: 0, total: 1 });
    expect(Object.keys(out.byMap)).toEqual(["Current Ladder"]);
    expect(
      Object.values(out.phases.sampleSize).reduce((sum, n) => sum + n, 0),
    ).toBe(1);
  });

  test("custom 1v1 trusts lobby classification even on a ladder map", async () => {
    const out = await opponents.get(userId, pulseId, {
      filters: { mapPool: "nonladder", gameSize: "1v1" },
    });

    expect(out.games.map((g) => g.id)).toEqual([
      "custom-1v1-on-ladder-map",
    ]);
  });

  test("team scope uses normalized format and does not include FFA", async () => {
    const out = await opponents.get(userId, pulseId, {
      filters: { gameSize: "team" },
    });

    expect(out.games.map((g) => g.id)).toEqual([
      "ladder-team",
      "custom-team",
    ]);
    expect(out.games.map((g) => g.id)).not.toContain("custom-ffa");
  });

  test("an empty filtered cohort does not fall back to lifetime totals", async () => {
    const out = await opponents.get(userId, pulseId, {
      filters: { build: "Never Played" },
    });

    expect(out.games).toEqual([]);
    expect(out.totals).toEqual({ wins: 0, losses: 0, total: 0, winRate: 0 });
  });

  test("date windows exclude invalid legacy dates like gamesMatchStage", async () => {
    const seed = await db.games.findOne({ userId, gameId: "ladder-1v1" });
    const invalidDateGame = { ...seed };
    delete invalidDateGame._id;
    await db.games.insertOne({
      ...invalidDateGame,
      gameId: "invalid-date",
      date: "not-a-date",
    });

    const out = await opponents.get(userId, pulseId, {
      filters: {
        since: new Date("2026-01-01T00:00:00Z"),
        mapPool: "ladder",
        gameSize: "1v1",
      },
    });

    expect(out.games.map((g) => g.id)).toEqual(["ladder-1v1"]);
  });
});
