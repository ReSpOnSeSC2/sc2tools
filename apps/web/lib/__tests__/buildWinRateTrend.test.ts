import { describe, expect, it } from "vitest";
import { TREND_WINDOW, gameOutcome, rollingWinRate } from "@/lib/buildWinRateTrend";

const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();
const game = (n: number, result: string) => ({ gameId: `g${n}`, date: day(n), result });

describe("rollingWinRate", () => {
  it("reads Win/Victory and Loss/Defeat in any case; everything else is skipped", () => {
    expect(["Win", "victory", "LOSS", "Defeat", "Tie", "", null].map(gameOutcome)).toEqual([
      "win", "win", "loss", "loss", null, null, null,
    ]);
  });

  it("draws nothing below the window", () => {
    const trend = rollingWinRate(Array.from({ length: TREND_WINDOW - 1 }, (_, i) => game(i + 1, "Win")));
    expect(trend).toMatchObject({ window: 10, decided: 9, points: [] });
  });

  it("one point per full window, oldest first, sorted by date whatever the input order", () => {
    // 12 games: W L L W L L W W W L | W W (oldest → newest), given newest first.
    const results = ["Win", "Loss", "Loss", "Win", "Loss", "Loss", "Win", "Win", "Win", "Loss", "Win", "Win"];
    const games = results.map((r, i) => game(i + 1, r)).reverse();
    const trend = rollingWinRate(games);
    expect(trend.decided).toBe(12);
    expect(trend.points.map((p) => [p.game, p.wins, p.losses, p.rate, p.gameId])).toEqual([
      [10, 5, 5, 50, "g10"],
      [11, 5, 5, 50, "g11"], // g1 (win) leaves, g11 (win) joins
      [12, 6, 4, 60, "g12"], // g2 (loss) leaves, g12 (win) joins
    ]);
  });

  it("skips ties and unknown results so every window holds 10 decided games", () => {
    const games = [
      ...Array.from({ length: 10 }, (_, i) => game(i + 1, i % 2 === 0 ? "Win" : "Loss")),
      game(11, "Tie"),
      game(12, ""),
    ];
    const trend = rollingWinRate(games);
    expect(trend.decided).toBe(10);
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0]).toMatchObject({ rate: 50, wins: 5, losses: 5, gameId: "g10" });
  });

  it("keeps the API's newest-first order for unreadable dates", () => {
    const games = Array.from({ length: 10 }, (_, i) => ({
      gameId: `g${i}`,
      date: "not a date",
      result: i === 0 ? "Loss" : "Win",
    }));
    // Newest first: g0 (a loss) is the newest, so it closes the only window.
    expect(rollingWinRate(games).points[0]).toMatchObject({ gameId: "g0", wins: 9, losses: 1 });
  });
});
