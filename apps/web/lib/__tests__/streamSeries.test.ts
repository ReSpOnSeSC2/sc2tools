import { describe, expect, it } from "vitest";
import { newerSeries, normalizeSeriesSnapshot, SERIES_SAMPLE } from "../streamSeries";

describe("public Series snapshot", () => {
  it("keeps absent state distinct from invalid input and strips private fields", () => {
    expect(normalizeSeriesSnapshot(null)).toBeNull(); expect(normalizeSeriesSnapshot({})).toBeUndefined();
    const clean = normalizeSeriesSnapshot({ ...SERIES_SAMPLE, token: "private-token", opponentToon: "2-S2-1-99", userId: "owner", games: SERIES_SAMPLE.games.map(game => ({ ...game, gameId: "private-replay", receipt: "hash", replayUrl: "private" })) });
    expect(clean).toEqual(SERIES_SAMPLE); expect(JSON.stringify(clean)).not.toMatch(/token|toon|userId|receipt|replayUrl|private/);
  });
  it("refuses malformed scores, formats, statuses and unbounded samples", () => {
    for (const patch of [{ format: "5" }, { format: 2 }, { revision: -1 }, { score: { you: 4, opponent: 0 } }, { score: { you: 3, opponent: 3 } }, { status: "complete" }, { games: Array(81).fill({ result: "draw", map: null }), gamesPlayed: 81 }, { maps: Array(21).fill("Map") }]) expect(normalizeSeriesSnapshot({ ...SERIES_SAMPLE, ...patch })).toBeUndefined();
  });
  it("held bootstrap/null and response revisions cannot roll a newer series backward", () => {
    const newer = { ...SERIES_SAMPLE, revision: 10 };
    expect(newerSeries(newer, null)).toBe(newer); expect(newerSeries(newer, SERIES_SAMPLE)).toBe(newer);
    expect(newerSeries(null, SERIES_SAMPLE)).toBe(SERIES_SAMPLE);
  });
});
