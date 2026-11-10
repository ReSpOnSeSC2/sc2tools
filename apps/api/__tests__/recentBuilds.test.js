// @ts-nocheck
"use strict";

/**
 * Each player's recent builds for the desktop agent's private game-start
 * scouting (``services/scouting/recentBuilds`` and its place on the
 * pre-game enrichment). Runs against a real MongoDB with games in the
 * shape the agent uploads.
 *
 * Covered on each side: no earlier game, one to four, and five or more.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");
const {
  recentBuilds,
  ownRecentBuilds,
  opponentRecentBuilds,
  RECENT_BUILDS_LIMIT,
} = require("../src/services/scouting/recentBuilds");

const OWNER = "owner";
const RIVAL = { pulseId: "1-S2-1-4242", pulseCharacterId: "4242", displayName: "Rival", race: "Zerg" };
const DAY_MS = 86_400_000;
const NEWEST = Date.UTC(2026, 10, 9, 20, 0, 0);

let mongo;
let db;

/**
 * One uploaded game. ``age`` is in days before ``NEWEST``, so a lower
 * age is a newer game.
 */
function game(age, overrides = {}) {
  const { opponent, ...rest } = overrides;
  return {
    userId: OWNER,
    gameId: `game-${age}`,
    date: new Date(NEWEST - age * DAY_MS),
    result: age % 2 === 0 ? "Victory" : "Defeat",
    myRace: "Protoss",
    myBuild: `PvZ - Own build ${age}`,
    map: `Map ${age}`,
    durationSec: 600 + age,
    opponent: { ...RIVAL, strategy: `Zerg - Opening ${age}`, ...opponent },
    ...rest,
  };
}

/** A game against somebody else in the same matchup. */
const versusStranger = (age, overrides = {}) => game(age, {
  ...overrides,
  opponent: { pulseId: `1-S2-1-${9000 + age}`, pulseCharacterId: String(9000 + age), displayName: "Stranger", ...overrides.opponent },
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_recent_builds" });
});

afterEach(async () => {
  await db.games.deleteMany({});
  await db.opponents.deleteMany({});
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

describe("your recent builds in this matchup", () => {
  test("no earlier game is an empty list", async () => {
    expect(await ownRecentBuilds(db.games, OWNER, "Protoss", "Zerg")).toEqual([]);
  });

  test("one to four earlier games are all listed, newest first", async () => {
    await db.games.insertMany([versusStranger(4), versusStranger(1), game(2)]);
    const rows = await ownRecentBuilds(db.games, OWNER, "Protoss", "Zerg");
    expect(rows).toEqual([
      { gameId: "game-1", result: "Loss", map: "Map 1", build: "PvZ - Own build 1", date: new Date(NEWEST - DAY_MS).toISOString() },
      { gameId: "game-2", result: "Win", map: "Map 2", build: "PvZ - Own build 2", date: new Date(NEWEST - 2 * DAY_MS).toISOString() },
      { gameId: "game-4", result: "Win", map: "Map 4", build: "PvZ - Own build 4", date: new Date(NEWEST - 4 * DAY_MS).toISOString() },
    ]);
  });

  test("five or more earlier games list only the newest five", async () => {
    await db.games.insertMany([6, 0, 3, 5, 1, 4, 2].map((age) => versusStranger(age)));
    const rows = await ownRecentBuilds(db.games, OWNER, "Protoss", "Zerg");
    expect(rows.map((row) => row.gameId)).toEqual(["game-0", "game-1", "game-2", "game-3", "game-4"]);
    expect(rows).toHaveLength(RECENT_BUILDS_LIMIT);
  });

  test("other matchups, other accounts and games left out of stats are not listed", async () => {
    await db.games.insertMany([
      versusStranger(0, { opponent: { race: "Terran" } }),
      versusStranger(1, { myRace: "Zerg" }),
      versusStranger(2, { userId: "somebody-else" }),
      versusStranger(3, { excluded: true }),
      versusStranger(4, { _deleted: true }),
      versusStranger(5, { isResumedFromReplay: true }),
      versusStranger(6),
    ]);
    const rows = await ownRecentBuilds(db.games, OWNER, "Protoss", "Zerg");
    expect(rows.map((row) => row.gameId)).toEqual(["game-6"]);
  });

  test("an unknown opponent race does not narrow the list", async () => {
    await db.games.insertMany([versusStranger(0, { opponent: { race: "Terran" } }), versusStranger(1)]);
    const rows = await ownRecentBuilds(db.games, OWNER, "Protoss", undefined);
    expect(rows.map((row) => row.gameId)).toEqual(["game-0", "game-1"]);
  });

  test("an unclassified game is listed with an empty build and an unknown result stays unknown", async () => {
    await db.games.insertOne(versusStranger(0, { myBuild: null, result: "Unknown", map: null, gameId: "x".repeat(201) }));
    expect(await ownRecentBuilds(db.games, OWNER, "Protoss", "Zerg")).toEqual([
      { gameId: null, result: null, map: "", build: "", date: new Date(NEWEST).toISOString() },
    ]);
  });
});

describe("the opponent's recent builds against you", () => {
  test("a first meeting is an empty list", async () => {
    await db.games.insertMany([versusStranger(0), versusStranger(1)]);
    expect(await opponentRecentBuilds(db.games, OWNER, RIVAL)).toEqual([]);
  });

  test("one to four earlier games are all listed, newest first, with the race played", async () => {
    await db.games.insertMany([game(3), game(1, { opponent: { race: "Terran", strategy: "Terran - Proxy Barracks" } }), versusStranger(0)]);
    expect(await opponentRecentBuilds(db.games, OWNER, RIVAL)).toEqual([
      { gameId: "game-1", result: "Loss", map: "Map 1", build: "Terran - Proxy Barracks", date: new Date(NEWEST - DAY_MS).toISOString(), race: "Terran" },
      { gameId: "game-3", result: "Loss", map: "Map 3", build: "Zerg - Opening 3", date: new Date(NEWEST - 3 * DAY_MS).toISOString(), race: "Zerg" },
    ]);
  });

  test("five or more earlier games list only the newest five", async () => {
    await db.games.insertMany([5, 2, 6, 0, 4, 1, 3].map((age) => game(age)));
    const rows = await opponentRecentBuilds(db.games, OWNER, RIVAL);
    expect(rows.map((row) => row.gameId)).toEqual(["game-0", "game-1", "game-2", "game-3", "game-4"]);
  });

  test("a confirmed correction replaces the classifier's opening", async () => {
    await db.games.insertOne(game(0, {
      buildIntent: { opponent: { status: "confirmed", applied: true, build: { name: "Zerg - 12 Pool" } } },
    }));
    const [row] = await opponentRecentBuilds(db.games, OWNER, RIVAL);
    expect(row.build).toBe("Zerg - 12 Pool");
  });

  test("linked accounts are included", async () => {
    const smurf = { pulseId: "1-S2-1-5555", pulseCharacterId: "5555", displayName: "Smurf" };
    await db.games.insertMany([game(1), game(0, { opponent: smurf })]);
    const linked = { ...RIVAL, pulseIds: [RIVAL.pulseId, smurf.pulseId], characterIds: [RIVAL.pulseCharacterId, smurf.pulseCharacterId] };
    const rows = await opponentRecentBuilds(db.games, OWNER, linked);
    expect(rows.map((row) => row.gameId)).toEqual(["game-0", "game-1"]);
  });

  test("a display name alone never identifies the player", async () => {
    await db.games.insertOne(game(0));
    expect(await opponentRecentBuilds(db.games, OWNER, { displayName: "Rival" })).toEqual([]);
    expect(await opponentRecentBuilds(db.games, OWNER, null)).toEqual([]);
  });

  test("another account's games against the same player are never read", async () => {
    await db.games.insertOne(game(0, { userId: "somebody-else" }));
    expect(await opponentRecentBuilds(db.games, OWNER, RIVAL)).toEqual([]);
  });
});

describe("both lists for one live game", () => {
  test("a failed read leaves the lists out instead of calling it a first meeting", async () => {
    await db.opponents.insertOne({
      userId: OWNER, pulseId: RIVAL.pulseId, pulseCharacterId: RIVAL.pulseCharacterId,
      displayNameSample: "Rival", race: "Zerg", gameCount: 1, wins: 1, losses: 0,
    });
    await db.games.insertOne(game(0));
    const find = db.games.find.bind(db.games);
    const failing = { sort: () => failing, limit: () => failing, toArray: () => Promise.reject(new Error("mongo down")) };
    // Only the own-games read fails: it alone asks for a build without a duration.
    const spy = jest.spyOn(db.games, "find").mockImplementation((filter, options) => (
      options?.projection?.myBuild && !options.projection.durationSec ? failing : find(filter, options)));
    try {
      expect(await recentBuilds(db.games, OWNER, { identity: RIVAL, myRace: "Protoss", oppRace: "Zerg", matchup: "PvZ" })).toBeNull();
      const history = await new OverlayLiveService(db).buildFromOpponentName(OWNER, "Rival", "Zerg", 4242, "Protoss", RIVAL.pulseId);
      expect("recentBuilds" in history).toBe(false);
      expect(history.headToHead).toEqual({ wins: 1, losses: 0 });
      expect(history.recentGames).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("the pre-game enrichment carries both lists", async () => {
    await db.opponents.insertOne({
      userId: OWNER, pulseId: RIVAL.pulseId, pulseCharacterId: RIVAL.pulseCharacterId,
      displayNameSample: "Rival", race: "Zerg", gameCount: 2, wins: 1, losses: 1,
    });
    await db.games.insertMany([game(0), game(2), versusStranger(1)]);
    const history = await new OverlayLiveService(db).buildFromOpponentName(OWNER, "Rival", "Zerg", 4242, "Protoss", RIVAL.pulseId);
    expect(history.recentBuilds.matchup).toBe("PvZ");
    expect(history.recentBuilds.mine.map((row) => row.gameId)).toEqual(["game-0", "game-1", "game-2"]);
    expect(history.recentBuilds.theirs.map((row) => row.gameId)).toEqual(["game-0", "game-2"]);
  });

  test("a first meeting still lists your own games and none for the opponent", async () => {
    await db.games.insertMany([versusStranger(0), versusStranger(1)]);
    const history = await new OverlayLiveService(db).buildFromOpponentName(OWNER, "Newcomer", "Zerg", 7777, "Protoss", "1-S2-1-7777");
    expect(history.headToHead).toEqual({ wins: 0, losses: 0 });
    expect(history.recentBuilds.theirs).toEqual([]);
    expect(history.recentBuilds.mine.map((row) => row.gameId)).toEqual(["game-0", "game-1"]);
  });

  test("a name shared with another account does not lend that account's games", async () => {
    await db.opponents.insertOne({
      userId: OWNER, pulseId: RIVAL.pulseId, pulseCharacterId: RIVAL.pulseCharacterId,
      displayNameSample: "IIIIIIIIIIII", race: "Zerg", gameCount: 1, wins: 1, losses: 0,
    });
    await db.games.insertOne(game(0, { opponent: { displayName: "IIIIIIIIIIII" } }));
    const history = await new OverlayLiveService(db).buildFromOpponentName(OWNER, "IIIIIIIIIIII", "Zerg", 8888, "Protoss", "1-S2-1-8888");
    expect(history.opponentIdentityMatched).toBe(false);
    expect(history.recentBuilds.theirs).toEqual([]);
  });
});
