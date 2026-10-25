import { describe, expect, it } from "vitest";
import { currentAndBestStreak } from "../h2hSeries";

describe("currentAndBestStreak newest-first history", () => {
  it("keeps current and best runs distinct while skipping ties and unknown results", () => {
    const games = ["Loss", "Tie", "Defeat", "Win", "Unknown", "Victory", "Win", "Loss"].map(result => ({ result }));
    expect(currentAndBestStreak(games)).toEqual({ current: { result: "L", count: 2 }, bestWin: 3, bestLoss: 2 });
    expect(games[0].result).toBe("Loss");
  });
  it("handles absent decisions and preserves a run across undecided games", () => {
    expect(currentAndBestStreak([])).toEqual({ current: null, bestWin: 0, bestLoss: 0 });
    expect(currentAndBestStreak([{ result: "Draw" }, {}]).current).toBeNull();
    expect(currentAndBestStreak([{ result: "Win" }, { result: "Draw" }, { result: "Win" }])).toEqual({ current: { result: "W", count: 2 }, bestWin: 2, bestLoss: 0 });
  });
});
