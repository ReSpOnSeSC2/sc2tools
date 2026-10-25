// @ts-nocheck
"use strict";
const { streamTitleSession } = require("../src/services/streamTitleSession");

test("uses shared owner session and a bounded projected ladder read without detail hydration", async () => {
  const rows = [
    { myToonHandle: "1-S2-1-11", myRace: "Protoss", myMmr: 5000, result: "Victory", opponent: { race: "Zerg" } },
    { myToonHandle: "2-S2-1-22", myRace: "Protoss", myMmr: 6500, result: "Defeat", opponent: { race: "Zerg" } },
    { myToonHandle: "1-S2-1-11", myRace: "Terran", myMmr: 6000, result: "win", opponent: { race: "Protoss" } },
    { myToonHandle: "1-S2-1-11", myRace: "Protoss", myMmr: 5100, result: "Tie", opponent: { race: "Zerg" } },
  ];
  const cursor = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn(async () => rows) };
  const db = { games: { find: jest.fn(() => cursor) } };
  const games = { todaySession: jest.fn(async () => ({ wins: 2, losses: 1, mmrCurrent: 5015, region: "NA", league: "Grandmaster", streak: { kind: "win", count: 2 } })) };
  const result = await streamTitleSession(db, games, "owner");
  expect(games.todaySession).toHaveBeenCalledWith("owner", undefined, { reuseRecent: true });
  expect(db.games.find).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", isLadderGame: true }), expect.objectContaining({ maxTimeMS: 2000, projection: expect.objectContaining({ _id: 0, "opponent.race": 1 }) }));
  expect(cursor.limit).toHaveBeenCalledWith(512);
  expect(result).toMatchObject({ schema: 1, mmr: 5015, league: "Grandmaster", peak: 5100,
    winRates: { PvZ: { wins: 1, losses: 1 }, TvP: { wins: 1, losses: 0 } }, history: { sampled: 4, capped: false } });
  expect(JSON.stringify(result)).not.toContain("S2-1");
});

test("missing ratings/league/identity do not fabricate tokens or peak", async () => {
  const cursor = { sort() { return this; }, limit() { return this; }, toArray: async () => [] };
  const result = await streamTitleSession({ games: { find: () => cursor } }, { todaySession: async () => ({ wins: 0, losses: 0 }) }, "owner");
  expect(result).toMatchObject({ session: { wins: 0, losses: 0 }, winRates: {} });
  expect(result).not.toHaveProperty("mmr");
  expect(result).not.toHaveProperty("league");
  expect(result).not.toHaveProperty("peak");
});
