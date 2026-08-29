// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  ReplayLibraryService,
  REPLAY_LIBRARY_LIST_DEFAULT,
  REPLAY_LIBRARY_LIST_LIMIT,
} = require("../src/services/replayLibrary");

// eslint-disable-next-line max-lines-per-function
describe("ReplayLibraryService", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_replay_library_service",
    });
    service = new ReplayLibraryService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function game(id, date, overrides = {}) {
    return {
      userId: "owner",
      gameId: id,
      date,
      startedAt: new Date(new Date(date).getTime() - 600_000),
      result: "Victory",
      map: "Alcyone LE",
      durationSec: 600,
      playerCount: 2,
      matchFormat: "1v1",
      myRace: "Protoss",
      myMmr: 4_200,
      myBuild: "Blink pressure",
      macroScore: 82,
      myToonHandle: "1-S2-1-100",
      opponent: {
        displayName: "Rival",
        race: "Terran",
        mmr: 4_250,
        strategy: "2-1-1",
        toonHandle: "1-S2-1-200",
        pulseCharacterId: "9988",
        pulseId: "private-pulse-id",
        privateEnrichment: { huge: "x".repeat(10_000) },
      },
      replayFile: {
        storedAt: new Date("2026-08-20T00:00:00Z"),
        sizeBytes: 123_456,
        sha256: "private-sha",
        key: "private-object-key",
      },
      buildLog: ["private-heavy-detail"],
      ...overrides,
    };
  }

  test("returns strict public rows and separate bounded VOD sources", async () => {
    await db.games.insertOne(game("g-safe", new Date("2026-08-20T12:00:00Z")));

    const page = await service.list("owner");

    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(page.items).toHaveLength(1);
    expect(page.sourceGames).toHaveLength(1);
    expect(page.items[0]).toEqual({
      gameId: "g-safe",
      date: "2026-08-20T12:00:00.000Z",
      result: "Victory",
      map: "Alcyone LE",
      durationSec: 600,
      playerCount: 2,
      matchFormat: "1v1",
      myRace: "Protoss",
      myMmr: 4_200,
      myBuild: "Blink pressure",
      macroScore: 82,
      opponent: {
        displayName: "Rival",
        race: "Terran",
        mmr: 4_250,
        strategy: "2-1-1",
      },
      matchup: "PvT",
      replayAvailable: true,
      replaySizeBytes: 123_456,
    });
    expect(page.sourceGames[0]).toEqual(
      expect.objectContaining({
        gameId: "g-safe",
        myToonHandle: "1-S2-1-100",
        opponent: expect.objectContaining({
          toonHandle: "1-S2-1-200",
          pulseCharacterId: "9988",
        }),
      }),
    );
    const publicJson = JSON.stringify(page.items);
    expect(publicJson).not.toContain("private-pulse-id");
    expect(publicJson).not.toContain("private-sha");
    expect(publicJson).not.toContain("private-object-key");
    expect(publicJson).not.toContain("private-heavy-detail");
    expect(publicJson).not.toContain("userId");
  });

  test("paginates equal and mixed-type dates exactly once in both directions", async () => {
    const rows = [
      game("date-a", new Date("2026-08-20T12:00:00Z")),
      game("date-b", new Date("2026-08-20T12:00:00Z")),
      game("string-a", "2025-08-20T12:00:00.000Z"),
      game("number-a", 1_724_155_200_000),
      game("null-a", null, { startedAt: null }),
      game("resumed", new Date("2026-08-21T12:00:00Z"), {
        isResumedFromReplay: true,
      }),
      game("other-owner", new Date("2026-08-22T12:00:00Z"), {
        userId: "someone-else",
      }),
    ];
    await db.games.insertMany(rows);

    for (const sort of ["date_desc", "date_asc"]) {
      const ids = [];
      let cursor;
      do {
        const page = await service.list("owner", { limit: 2, cursor, sort });
        ids.push(...page.items.map((item) => item.gameId));
        cursor = page.nextCursor || undefined;
      } while (cursor);
      expect(ids).toHaveLength(5);
      expect(new Set(ids)).toEqual(
        new Set(["date-a", "date-b", "string-a", "number-a", "null-a"]),
      );
    }
  });

  test("applies whitelisted filters, list controls, and bounded search in Mongo", async () => {
    await db.games.insertMany([
      game("match", new Date("2026-08-20T12:00:00Z")),
      game("wrong-result", new Date("2026-08-19T12:00:00Z"), {
        result: "Defeat",
      }),
      game("wrong-matchup", new Date("2026-08-18T12:00:00Z"), {
        opponent: { displayName: "Rival", race: "Zerg", strategy: "Pool" },
      }),
      game("wrong-map", new Date("2026-08-17T12:00:00Z"), {
        map: "Ghost River LE",
      }),
    ]);

    const page = await service.list("owner", {
      filters: {
        map: "alcyone",
        ignoredMongoOperator: { $where: "malicious" },
      },
      result: "win",
      matchup: "PvT",
      search: "rival",
    });

    expect(page.items.map((item) => item.gameId)).toEqual(["match"]);
  });

  test("defaults to 50 rows and hard-caps a crafted limit at 100", async () => {
    const at = new Date("2026-08-20T12:00:00Z");
    await db.games.insertMany(
      Array.from({ length: REPLAY_LIBRARY_LIST_LIMIT + 1 }, (_, index) =>
        game(`g-${index}`, new Date(at.getTime() - index * 1_000))),
    );

    const defaultPage = await service.list("owner");
    const cappedPage = await service.list("owner", { limit: 50_000 });

    expect(defaultPage.items).toHaveLength(REPLAY_LIBRARY_LIST_DEFAULT);
    expect(defaultPage.hasMore).toBe(true);
    expect(defaultPage.nextCursor).toEqual(expect.any(String));
    expect(cappedPage.items).toHaveLength(REPLAY_LIBRARY_LIST_LIMIT);
    expect(cappedPage.hasMore).toBe(true);
  });

  test("returns slim detail plus a private source and rejects bad cursors", async () => {
    await db.games.insertMany([
      game("detail", new Date("2026-08-20T12:00:00Z")),
      game("older", new Date("2026-08-19T12:00:00Z")),
      game("resumed-detail", new Date("2026-08-18T12:00:00Z"), {
        isResumedFromReplay: true,
      }),
    ]);

    const detail = await service.getDetail("owner", "detail");
    expect(detail.game.gameId).toBe("detail");
    expect(detail.game).not.toHaveProperty("replayFile");
    expect(detail.sourceGame.opponent.pulseCharacterId).toBe("9988");
    await expect(
      service.getDetail("owner", "resumed-detail"),
    ).resolves.toBeNull();
    await expect(
      service.list("owner", { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });

    const first = await service.list("owner", {
      limit: 1,
      sort: "date_desc",
    });
    await expect(
      service.list("owner", {
        limit: 1,
        sort: "date_asc",
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
});
