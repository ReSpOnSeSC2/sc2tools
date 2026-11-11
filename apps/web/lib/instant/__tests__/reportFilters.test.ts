import { describe, expect, it } from "vitest";
import { DEFAULT_REPORT_FILTERS, filterPayloads, parseReportFilters } from "../reportFilters";
import { bare, realWin } from "./fixtures/reportGames";

const NOW = new Date("2026-06-30T12:00:00Z");
const zerg = realWin().opponent!;
const rows = [
  bare({ gameId: "at-boundary", date: "2026-04-01T12:00:00Z", opponent: zerg }),
  bare({ gameId: "too-old", date: "2026-04-01T11:59:59Z", opponent: zerg }),
  bare({ gameId: "recent-loss", date: "2026-06-30T11:00:00Z", opponent: zerg, result: "Defeat" }),
  bare({ gameId: "unknown", date: "2026-06-30T10:00:00Z", result: "Tie" }),
];

describe("instant report filters", () => {
  it("combines matchup, outcome and an inclusive 90-day window", () => {
    expect(filterPayloads(rows, { matchup: "Z", result: "win", recency: "90d" }, NOW).map(({ gameId }) => gameId))
      .toEqual(["at-boundary"]);
    expect(filterPayloads(rows, { ...DEFAULT_REPORT_FILTERS, matchup: "P" }, NOW)).toEqual([]);
    expect(filterPayloads(rows, { ...DEFAULT_REPORT_FILTERS, result: "loss" }, NOW)).toEqual([rows[2]]);
    expect(filterPayloads(rows, DEFAULT_REPORT_FILTERS, NOW)).toEqual(rows);
  });

  it("keeps the newest 10 or 25 matching games even with unsorted input", () => {
    const games = Array.from({ length: 30 }, (_, index) => bare({
      gameId: String(index), date: new Date(NOW.getTime() - index * 1000).toISOString(),
    })).reverse();
    for (const recency of ["10", "25"] as const) {
      const kept = filterPayloads(games, { ...DEFAULT_REPORT_FILTERS, recency }, NOW);
      expect(kept).toHaveLength(Number(recency));
      expect(kept.every(({ gameId }) => Number(gameId) < Number(recency))).toBe(true);
    }
  });

  it("validates each stored option independently", () => {
    expect(parseReportFilters({ matchup: "Terran", result: "loss", recency: 10 }))
      .toEqual({ matchup: "all", result: "loss", recency: "all" });
  });
});
