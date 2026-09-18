import { describe, expect, it } from "vitest";
import { buildActivityBuckets } from "../activityBuckets";

describe("activity chart buckets", () => {
  it("preserves quiet days and does not turn unknown outcomes into losses", () => {
    const result = buildActivityBuckets([
      { date: "2026-09-04", wins: 1, losses: 1, games: 3 },
      { date: "2026-09-01", wins: 2, losses: 0, games: 2 },
    ], "day");
    expect(result.rows.map((row) => row.games)).toEqual([2, 0, 0, 3]);
    expect(result.rows.at(-1)?.other).toBe(1);
    expect(result.rows.at(-1)?.losses).toBe(1);
  });

  it("combines adjacent periods without dropping dates or counts on a dense range", () => {
    const days = Array.from({ length: 90 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), wins: 2, losses: 1, games: 4 }));
    const { rows, periodsPerBar } = buildActivityBuckets(days, "day");
    expect(periodsPerBar).toBe(3);
    expect(rows).toHaveLength(30);
    expect(rows.reduce((sum, row) => sum + row.games, 0)).toBe(360);
    expect(rows.reduce((sum, row) => sum + row.wins, 0)).toBe(180);
    expect(rows[0].label).toBe("Jan 1, 2026 – Jan 3, 2026");
    expect(rows.at(-1)?.end).toBe("2026-03-31");
  });

  it.each(["week", "month"] as const)("fills missing %s buckets across year boundaries", (interval) => {
    const end = interval === "month" ? "2026-02-01" : "2025-12-22";
    const { rows } = buildActivityBuckets([{ date: "2025-12-01", wins: 3, losses: 1, games: 4 }, { date: end, wins: 2, losses: 2, games: 4 }], interval);
    expect(rows.reduce((sum, row) => sum + row.games, 0)).toBe(8);
    expect(rows.at(-1)?.date).toBe(end);
    expect(rows[1].games).toBe(0);
  });

  it("coalesces duplicates and handles empty data", () => {
    expect(buildActivityBuckets([], "day").rows).toEqual([]);
    const period = { date: "2026-09-01", wins: 1, losses: 1, games: 2 };
    expect(buildActivityBuckets([period, period], "day").rows[0].games).toBe(4);
  });
});
