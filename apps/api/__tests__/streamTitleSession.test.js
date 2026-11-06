// @ts-nocheck
"use strict";
const { streamTitleSession } = require("../src/services/streamTitleSession");
const { streamTitleMatch } = require("../src/services/streamTitleMatch");

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

function liveMatch() {
  return { phase: "match_started", receivedAt: Date.now(), gameKey: "current-game", isReplay: false,
    user: { name: "Streamer", race: "Protoss" }, map: "Alcyone LE",
    opponent: { name: "Barcode", toonHandle: "1-S2-1-42" },
    players: [{ name: "Streamer", type: "user", race: "Protoss", team_id: 1 },
      { name: "Barcode", type: "user", race: "Terran", team_id: 2 }],
    streamerHistory: { oppName: "Barcode", opponentIdentityMatched: true, opponentPulseId: "1-S2-1-42",
      oppRevealedName: "KnownPlayer", headToHead: { wins: 3, losses: 2 },
      opponentNotes: { text: "PRIVATE note" }, recentGames: [{ map: "Previous map" }] } };
}

test("projects only title-safe current-match fields from the existing owner cache", async () => {
  const cursor = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn(async () => []) };
  const db = { games: { find: jest.fn(() => cursor) } };
  const games = { todaySession: jest.fn(async () => ({ wins: 0, losses: 0 })) };
  const envelope = liveMatch(), before = structuredClone(envelope);
  const snapshot = jest.fn(() => envelope);
  const result = await streamTitleSession(db, games, "owner", snapshot);
  expect(result.currentMatch).toEqual({ gameKey: "current-game", opponent: "Barcode", alias: "KnownPlayer",
    map: "Alcyone LE", race: "Protoss", h2h: { wins: 3, losses: 2 } });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|S2-1|toon|opponentNotes|recentGames|Previous map/);
  expect(envelope).toEqual(before);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(games.todaySession).toHaveBeenCalledTimes(1);
  expect(db.games.find).toHaveBeenCalledTimes(1);
});

test("reads the current envelope after awaited statistics work, never a captured old opponent", async () => {
  const order = [], first = liveMatch();
  let current = first;
  const cursor = { sort() { return this; }, limit() { return this; }, toArray: async () => {
    order.push("history"); current = { ...first, phase: "menu" }; return [];
  } };
  const result = await streamTitleSession({ games: { find: () => cursor } }, {
    todaySession: async () => { order.push("session"); return { wins: 0, losses: 0 }; },
  }, "owner", () => { order.push("live"); return current; });
  expect(order).toEqual(["session", "history", "live"]);
  expect(result).not.toHaveProperty("currentMatch");
});

test.each(["match_loading", "match_started", "match_in_progress"])("projects the %s phase", phase => {
  expect(streamTitleMatch({ ...liveMatch(), phase })).toHaveProperty("opponent", "Barcode");
});

test.each([
  { phase: "match_ended" }, { phase: "menu" }, { phase: "idle" },
  { isReplay: true }, { isObserver: true }, { gameKey: "" }, { gameKey: " padded " },
  { receivedAt: Date.now() - 91_000 }, { receivedAt: Date.now() + 30_000 },
  { receivedAt: NaN }, { receivedAt: undefined },
  { players: [] }, { players: [{ name: "Streamer", type: "user" }, { name: "Barcode", type: "computer" }] },
  { players: [{ name: "Streamer", type: "user", result: "Victory" }, { name: "Barcode", type: "user", result: "Defeat" }] },
  { players: [{ name: "Streamer", type: "user", team_id: 1 }, { name: "Barcode", type: "user", team_id: 1 }] },
  { players: [{ name: "Streamer", type: "user" }, { name: "Barcode", type: "user" }, { name: "Third", type: "user" }] },
  { user: { name: "Someone else" } }, { opponent: { name: "Unmatched" } },
  { opponent: { name: "<unsafe>" } },
])("omits stale, unsupported or ambiguous live contexts: %j", patch => {
  expect(streamTitleMatch({ ...liveMatch(), ...patch })).toBeNull();
});

test("no live map, identity history or decided record is invented", () => {
  const envelope = liveMatch();
  delete envelope.map;
  delete envelope.streamerHistory;
  expect(streamTitleMatch(envelope)).toEqual({ gameKey: "current-game", opponent: "Barcode", alias: "", race: "Protoss" });
  envelope.opponent.revealedName = "Direct identity";
  expect(streamTitleMatch(envelope).alias).toBe("Direct identity");
});

test.each([
  { oppName: "Different opponent" }, { opponentIdentityMatched: false }, { opponentPulseId: "1-S2-1-99" },
])("does not reuse mismatched opponent history: %j", patch => {
  const envelope = liveMatch();
  Object.assign(envelope.streamerHistory, patch);
  expect(streamTitleMatch(envelope)).toEqual({ gameKey: "current-game", opponent: "Barcode", alias: "",
    map: "Alcyone LE", race: "Protoss" });
});

test("empty or duplicated aliases and missing win-rate samples stay distinct", () => {
  const envelope = liveMatch();
  envelope.streamerHistory.oppRevealedName = "barcode";
  envelope.streamerHistory.headToHead = { wins: 0, losses: 0 };
  expect(streamTitleMatch(envelope)).toMatchObject({ alias: "", h2h: { wins: 0, losses: 0 } });
  envelope.streamerHistory.headToHead = { wins: "0", losses: 2 };
  expect(streamTitleMatch(envelope)).not.toHaveProperty("h2h");
  envelope.map = "Old map\nInjected title";
  expect(streamTitleMatch(envelope)).not.toHaveProperty("map");
});
