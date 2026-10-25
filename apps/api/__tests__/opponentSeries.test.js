"use strict";
const { opponentSeries } = require("../src/services/opponentSeries");

describe("compact all-time dossier series", () => {
  it("uses min/max identity document dates, never the oldest capped game", () => {
    const game = { gameId: "latest", date: new Date("2026-10-25"), result: "Victory", map: "Alpha", buildLog: ["private detail"], opponent: { displayName: "private" } };
    const series = opponentSeries([game], [{ firstSeen: new Date("2025-02-01"), lastSeen: new Date("2026-10-01") }, { firstSeen: new Date("2024-01-01"), lastSeen: new Date("2026-10-25") }], 1000, true);
    expect(series).toEqual({ firstSeen: "2024-01-01T00:00:00.000Z", lastSeen: "2026-10-25T00:00:00.000Z", sourceLimit: 1000, truncated: true, games: [{ id: "latest", date: "2026-10-25T00:00:00.000Z", result: "Victory", map: "Alpha" }] });
    expect(game).toHaveProperty("buildLog");
  });

  it("keeps a missing document first meeting unknown instead of substituting a game date", () => {
    expect(opponentSeries([{ gameId: "one", date: "2026-10-25" }], [{ firstSeen: "invalid", lastSeen: null }], 1000, false)).toMatchObject({ firstSeen: null, lastSeen: null, truncated: false });
  });

  it("bounds direct callers, excludes unsafe fields and marks clipping", () => {
    const rows = Array.from({ length: 1002 }, (_, i) => ({ gameId: String(i), result: "not a result", date: null, map: "M".repeat(300), token: "secret" }));
    const series = opponentSeries(rows, [], 5000, false);
    expect(series.sourceLimit).toBe(1000); expect(series.games).toHaveLength(1000); expect(series.truncated).toBe(true);
    expect(series.games[0]).toEqual({ id: "0", date: null, map: "M".repeat(200), result: null });
  });
});
