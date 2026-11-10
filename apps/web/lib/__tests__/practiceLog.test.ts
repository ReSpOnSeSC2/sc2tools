import { describe, expect, it } from "vitest";
import {
  driftText,
  gradeShares,
  gradeSparkline,
  practiceGamesPath,
  practiceSummaryPath,
  rollingDrift,
  startOfLocalWeek,
  weekProgress,
  type PracticeHistoryRow,
} from "@/lib/practiceLog";

const row = (gameId: string, date: Date, grade: PracticeHistoryRow["grade"], via: PracticeHistoryRow["via"] = "ingest"): PracticeHistoryRow =>
  ({ gameId, date: date.toISOString(), grade, avgDrift: 5, matched: 3, total: 4, via });

describe("practice log helpers", () => {
  it("builds the owner's summary and paged games requests", () => {
    expect(practiceSummaryPath("PvZ")).toBe("/v1/practice/summary?matchup=PvZ");
    expect(practiceSummaryPath("PvZ", "0123456789abcdef")).toBe("/v1/practice/summary?matchup=PvZ&targetHash=0123456789abcdef");
    expect(practiceGamesPath("TvT", "0123456789abcdef", "1700000000000.0123456789abcdef01234567"))
      .toBe("/v1/practice/games?matchup=TvT&limit=20&targetHash=0123456789abcdef&cursor=1700000000000.0123456789abcdef01234567");
  });

  it("plots the newest thirty grades oldest first, S at the top", () => {
    const history = Array.from({ length: 35 }, (_, i) => row(`g${i}`, new Date(2026, 10, 30 - i), i === 0 ? "S" : "D"));
    const points = gradeSparkline(history);
    expect(points).toHaveLength(30);
    expect(points[0]).toMatchObject({ x: 0, y: 1, row: { gameId: "g29" } });
    expect(points[29]).toMatchObject({ x: 1, y: 0, row: { gameId: "g0" } });
    expect(gradeSparkline([row("only", new Date(), "B")])[0]).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("counts this local week from Monday, B or better toward the goal", () => {
    const wednesday = new Date(2026, 10, 11, 20, 0);
    expect(startOfLocalWeek(wednesday)).toEqual(new Date(2026, 10, 9));
    expect(startOfLocalWeek(new Date(2026, 10, 15, 23, 59))).toEqual(new Date(2026, 10, 9));
    const history = [
      row("a", new Date(2026, 10, 11, 18), "A"),
      row("b", new Date(2026, 10, 10, 9), "C"),
      row("c", new Date(2026, 10, 9, 0, 5), "B"),
      row("last-week", new Date(2026, 10, 8, 23), "S"),
    ];
    expect(weekProgress(history, wednesday, 4)).toEqual({ graded: 3, good: 2, goal: 4, ratio: 0.5 });
    expect(weekProgress(history, wednesday, 1).ratio).toBe(1);
  });

  it("compares the newest five graded games' drift with the five before", () => {
    const history = [4, 6, 5, 5, 5, 10, 12, 8, 10, 10].map((avgDrift, i) => ({ ...row(`g${i}`, new Date(2026, 10, 20 - i), "B"), avgDrift }));
    expect(rollingDrift(history)).toEqual({ recent: 5, previous: 10 });
    expect(rollingDrift(history.slice(0, 3))).toEqual({ recent: 5, previous: null });
    expect(rollingDrift([])).toEqual({ recent: null, previous: null });
  });

  it("puts drift and grade shares into words and numbers", () => {
    expect(driftText(null)).toBe("never built");
    expect(driftText(0.2)).toBe("on time");
    expect(driftText(-4)).toBe("on time (-4s)");
    expect(driftText(12.4)).toBe("12s late");
    expect(driftText(-30)).toBe("30s early");
    expect(gradeShares({ S: 1, A: 0, B: 2, C: 0, D: 1 }).map((entry) => [entry.grade, entry.share])).toEqual([["S", 0.25], ["A", 0], ["B", 0.5], ["C", 0], ["D", 0.25]]);
  });
});
