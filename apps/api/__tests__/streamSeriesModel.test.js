// @ts-nocheck
"use strict";
const { startSeries, readSeries, matchesSeriesOpponent, scoreSeriesGame, editSeries, publicSeries } = require("../src/services/streamSeriesModel");
const START = Date.parse("2026-10-25T10:00:00Z"), NOW = START + 3_600_000;
const begin = (patch = {}) => startSeries({ action: "start", revision: 0, format: 3, opponentName: "Clem", maps: ["Alcyone", "Goldenaura", "Site Delta"], ...patch }, START, "server-series", 1);
const game = (patch = {}) => ({ gameId: "private-replay-one", startedAt: new Date(START + 1000).toISOString(), date: new Date(START + 601_000).toISOString(),
  result: "Victory", map: "Alcyone", myRace: "Protoss", opponent: { displayName: "Clem", toonHandle: "2-S2-1-99", race: "Terran" }, ...patch });

test.each([1, 3, 5, 7])("explicit Bo%i start is bounded and does not change unrelated preferences", format => {
  const series = begin({ format });
  expect(series).toMatchObject({ format, status: "active", score: { you: 0, opponent: 0 }, startedAt: START, games: [] });
  expect(readSeries(series)).toEqual(series);
});
test.each([{ format: 2 }, { opponentName: "" }, { opponentName: "x".repeat(81) }, { opponentName: "<b>Clem</b>" },
  { opponentToon: "not-an-account" }, { maps: [""] }, { maps: Array(21).fill("Map") }, { maps: ["x".repeat(101)] }, { extra: true }])("invalid explicit start fails closed: %j", patch => {
  expect(() => begin(patch)).toThrow("invalid_series");
});
test("toon identity is preferred and a known mismatch never falls through to the same name", () => {
  const series = begin({ opponentToon: "2-s2-1-99" });
  expect(matchesSeriesOpponent(series, game())).toBe(true);
  expect(matchesSeriesOpponent(series, game({ opponent: { displayName: "Clem", toonHandle: "2-S2-1-100" } }))).toBe(false);
  expect(matchesSeriesOpponent(series, game({ opponent: { displayName: "Renamed", toonHandle: "2-s2-1-99" } }))).toBe(true);
  expect(matchesSeriesOpponent(series, game({ opponent: { displayName: "cLeM" } }))).toBe(true);
  expect(matchesSeriesOpponent(series, game({ opponent: { displayName: "Clem clone" } }))).toBe(false);
});
test("a typed name pins its first recorded toon and rejects later same-name different identities", () => {
  const first = scoreSeriesGame(begin(), game(), NOW);
  expect(first.opponentToon).toBe("2-S2-1-99");
  expect(scoreSeriesGame(first, game({ gameId: "other", opponent: { displayName: "Clem", toonHandle: "2-S2-1-100" } }), NOW)).toBeNull();
});
test.each([-1, 0, 1])("start boundary %+i ms uses the replay's explicit start, not its end", offset => {
  const accepted = scoreSeriesGame(begin(), game({ startedAt: new Date(START + offset).toISOString() }), NOW);
  expect(!!accepted).toBe(offset > 0);
});
test("a long game crossing the series start is excluded even when it ends afterward", () => {
  expect(scoreSeriesGame(begin(), game({ startedAt: new Date(START - 3_600_000).toISOString(), date: new Date(START + 600_000).toISOString(), durationSec: 600 }), NOW)).toBeNull();
});
test.each([undefined, null, "bad-date"])("missing or invalid exact start %s stays manual-only; game-clock duration is never a wall-clock fallback", startedAt => {
  expect(scoreSeriesGame(begin(), game({ startedAt, durationSec: 600 }), NOW)).toBeNull();
});
test.each([{ date: "bad" }, { date: new Date(START).toISOString() }, { date: new Date(NOW + 61_000).toISOString() },
  { result: "Unknown" }, { isTest: true }, { isResumedFromReplay: true }, { excluded: true }, { _deleted: true }, { _deletionPending: true }])("synthetic, invisible or invalid replay is excluded: %j", patch => {
  expect(scoreSeriesGame(begin(), game(patch), NOW)).toBeNull();
});
test.each([true, false, undefined])("matching ladder/custom flag %s does not change eligibility", isLadderGame => {
  expect(scoreSeriesGame(begin(), game({ isLadderGame }), NOW).score.you).toBe(1);
});
test("stored Victory/Defeat and legacy result spellings score exactly once per private receipt", () => {
  const first = scoreSeriesGame(begin({ format: 5 }), game(), NOW);
  expect(first.score).toEqual({ you: 1, opponent: 0 });
  expect(scoreSeriesGame(first, game({ result: "loss" }), NOW)).toBeNull();
  const second = scoreSeriesGame(first, game({ gameId: "two", result: "Defeat" }), NOW);
  expect(second.score).toEqual({ you: 1, opponent: 1 });
  const third = scoreSeriesGame(second, game({ gameId: "three", result: "wIn" }), NOW);
  expect(third.score).toEqual({ you: 2, opponent: 1 });
  expect(third.revision).toBe(4);
});
test("ties consume a recorded map without inventing wins, losses or completion", () => {
  const next = scoreSeriesGame(begin(), game({ result: "Tie" }), NOW);
  expect(next.score).toEqual({ you: 0, opponent: 0 });
  expect(next.status).toBe("active");
  expect(publicSeries(next)).toMatchObject({ gamesPlayed: 1, currentMap: "Goldenaura", nextMap: "Site Delta" });
});
test("completion stops further auto-scoring and retains the played map", () => {
  const complete = scoreSeriesGame(begin({ format: 1 }), game(), NOW);
  expect(complete.status).toBe("complete");
  expect(publicSeries(complete)).toMatchObject({ currentMap: "Alcyone", score: { you: 1, opponent: 0 } });
  expect(scoreSeriesGame(complete, game({ gameId: "two" }), NOW)).toBeNull();
});
test("manual correction is bounded, retains dedupe and can reopen an accidentally completed series", () => {
  const complete = scoreSeriesGame(begin({ format: 1 }), game(), NOW);
  const reopen = editSeries(complete, { action: "adjust", revision: complete.revision, side: "you", delta: -1 }, NOW);
  expect(reopen).toMatchObject({ status: "active", score: { you: 0, opponent: 0 }, games: complete.games });
  expect(scoreSeriesGame(reopen, game(), NOW)).toBeNull();
  expect(editSeries(reopen, { action: "adjust", revision: reopen.revision, side: "you", delta: -1 }, NOW).score.you).toBe(0);
  expect(() => editSeries(complete, { action: "adjust", revision: complete.revision, side: "opponent", delta: 1 }, NOW)).toThrow("series_already_decided");
});
test("stale manual operations and malformed actions fail closed; explicit End never reopens", () => {
  const series = begin();
  expect(() => editSeries(series, { action: "adjust", revision: 0, side: "you", delta: 1 }, NOW)).toThrow("series_changed");
  for (const body of [{ action: "adjust", revision: 1, side: "you", delta: 2 }, { action: "adjust", revision: 1, side: "other", delta: 1 }, { action: "end", revision: 1, userId: "private" }]) expect(() => editSeries(series, body, NOW)).toThrow("invalid_series_action");
  const ended = editSeries(series, { action: "end", revision: 1 }, NOW);
  expect(scoreSeriesGame(ended, game(), NOW)).toBeNull();
  expect(() => editSeries(ended, { action: "adjust", revision: ended.revision, side: "you", delta: 1 }, NOW)).toThrow("series_ended");
});
test("80 draw receipts pause safely without evicting dedupe entries", () => {
  let series = begin();
  for (let i = 0; i < 80; i++) series = scoreSeriesGame(series, game({ gameId: `draw-${i}`, result: "draw" }), NOW);
  expect(series).toMatchObject({ status: "paused", score: { you: 0, opponent: 0 } });
  expect(series.games).toHaveLength(80);
  expect(readSeries(series)).toEqual(series);
  expect(scoreSeriesGame(series, game({ gameId: "new" }), NOW)).toBeNull();
});
test("public DTO contains no game IDs, receipts, account handles, token or replay URLs", () => {
  const stored = scoreSeriesGame(begin(), game(), NOW);
  const dto = publicSeries({ ...stored, token: "secret", replayUrl: "private-url", userId: "owner" });
  expect(JSON.stringify(dto)).not.toMatch(/receipt|private-replay|S2|server-series|secret|private-url|userId|token/i);
  expect(dto).toMatchObject({ games: [{ result: "win", map: "Alcyone" }], opponentName: "Clem", playerRace: "P", opponentRace: "T" });
});
test("corrupt or oversized persisted series never reach the public transport", () => {
  for (const patch of [{ games: Array(81).fill({}) }, { score: { you: 99, opponent: 0 } }, { status: "complete" }, { opponentToon: "invalid" }, { revision: -1 }, { maps: Array(21).fill("Map") }]) expect(readSeries({ ...begin(), ...patch })).toBeNull();
});
