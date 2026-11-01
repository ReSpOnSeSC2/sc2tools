// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  ReplayLibraryService,
  REPLAY_LIBRARY_RECENT_WINDOW,
  REPLAY_LIBRARY_RECENT_DEADLINE_MS,
} = require("../src/services/replayLibrary");
const { REPLAY_SEARCH_COMMENT } = require("../src/middleware/searchQueryPrivacy");

const START = Date.parse("2026-01-01T00:00:00.000Z");

function game(userId, index, overrides = {}) {
  return {
    userId,
    gameId: `${userId}-g-${index}`,
    date: new Date(START + index * 60_000),
    result: "Victory",
    map: "Alcyone LE",
    myRace: "Protoss",
    myBuild: "Blink",
    opponent: { displayName: `Opponent ${index}`, race: "Terran", strategy: "Bio" },
    ...overrides,
  };
}

/** Every numeric value of `key` anywhere in an explain document. */
function explainValues(node, key, out = []) {
  if (Array.isArray(node)) node.forEach(child => explainValues(child, key, out));
  else if (node && typeof node === "object") {
    for (const [name, value] of Object.entries(node)) {
      if (name === key && typeof value === "number") out.push(value);
      else explainValues(value, key, out);
    }
  }
  return out;
}

/** 1,500 owner games plus four newer ones; the owner's only old "Needle" map sits just outside the window. */
async function seedRecentGames(db) {
  const rows = Array.from({ length: REPLAY_LIBRARY_RECENT_WINDOW + 500 }, (_, index) => game("owner", index,
    index === 499 ? { map: "Needle Station LE" } : {}));
  rows.push(game("owner", 2000, { map: "Needle Gardens LE", excluded: true }));
  rows.push(game("owner", 2001, { opponent: { displayName: "NeedleCaster", race: "Zerg" }, result: "Defeat" }));
  rows.push(game("owner", 2002, { map: "Needle Gardens LE", _deleted: true }));
  rows.push(game("other", 2003, { map: "Needle Gardens LE" }));
  await db.games.insertMany(rows);
}

describe("ReplayLibraryService.listRecent (quick search's recent games)", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_replay_library_recent" });
    service = new ReplayLibraryService(db);
    await seedRecentGames(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("searches only the owner's latest games, newest first, without hidden rows", async () => {
    const recent = await service.listRecent("owner", { search: "needle", limit: 5 });
    expect(recent.items.map(item => item.gameId)).toEqual(["owner-g-2001"]);
    expect(recent).toMatchObject({ nextCursor: null, hasMore: false });
    expect(recent.items[0]).toMatchObject({ result: "Defeat", opponent: { displayName: "NeedleCaster" } });
    // The full-history list still finds the old match, so the window is what hides it.
    const all = await service.list("owner", { search: "needle", limit: 5 });
    expect(all.items.map(item => item.gameId)).toEqual(["owner-g-2001", "owner-g-499"]);
  });

  test("keeps the limit, the result filter and hasMore", async () => {
    const page = await service.listRecent("owner", { limit: 3 });
    expect(page.items.map(item => item.gameId)).toEqual(["owner-g-2001", "owner-g-1499", "owner-g-1498"]);
    expect(page.hasMore).toBe(true);
    const losses = await service.listRecent("owner", { result: "loss", limit: 5 });
    expect(losses.items.map(item => item.gameId)).toEqual(["owner-g-2001"]);
    expect(await service.listRecent("", { search: "needle" })).toEqual({ items: [], nextCursor: null, hasMore: false, sourceGames: [] });
  });

  test("examines at most the window on the {userId, date, _id} index, under a deadline, marked private", async () => {
    const aggregate = jest.spyOn(db.games, "aggregate");
    await service.listRecent("owner", { search: "zzz-no-match", limit: 5 });
    const [pipeline, options] = aggregate.mock.calls[0];
    aggregate.mockRestore();
    expect(options).toEqual({
      hint: { userId: 1, date: -1, _id: -1 },
      maxTimeMS: REPLAY_LIBRARY_RECENT_DEADLINE_MS,
      allowDiskUse: false,
      comment: REPLAY_SEARCH_COMMENT,
    });
    const explain = await db.games.aggregate(pipeline, { hint: options.hint }).explain("executionStats");
    const docs = explainValues(explain, "totalDocsExamined"), keys = explainValues(explain, "totalKeysExamined");
    expect(docs.length).toBeGreaterThan(0);
    expect(Math.max(...docs)).toBeLessThanOrEqual(REPLAY_LIBRARY_RECENT_WINDOW);
    expect(Math.max(...keys)).toBeLessThanOrEqual(REPLAY_LIBRARY_RECENT_WINDOW + 1);
  });

  test("the full-history list marks only a searched read private", async () => {
    const find = jest.spyOn(db.games, "find");
    await service.list("owner", { search: "needle", limit: 1 });
    await service.list("owner", { limit: 1 });
    await service.list("owner", { search: "  ", limit: 1 });
    const comments = find.mock.calls.map(([, options]) => options.comment);
    find.mockRestore();
    expect(comments).toEqual([REPLAY_SEARCH_COMMENT, undefined, undefined]);
  });
});
