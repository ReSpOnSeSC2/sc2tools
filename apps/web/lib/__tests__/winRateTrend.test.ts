import { describe, expect, test } from "vitest";
import { buildWinRateTrend, formatTrendDate, type WinRatePeriod } from "../winRateTrend";

const period = (date: string, wins: number, losses: number, games = wins + losses): WinRatePeriod => ({ date, wins, losses, games });

describe("buildWinRateTrend", () => {
  test("weights games instead of giving a one-game day the weight of a busy day", () => {
    const trend = buildWinRateTrend([
      period("2026-09-01", 18, 2),
      period("2026-09-02", 0, 1),
    ], 20);

    expect(trend.latest).toMatchObject({ sampleWins: 18, sampleLosses: 3, sampleGames: 21, ready: true });
    expect(trend.latest?.rate).toBeCloseTo(85.7142857);
    expect(trend.overall.rate).toBeCloseTo(85.7142857);
  });

  test("keeps the oldest whole period until the remaining games meet the target", () => {
    const trend = buildWinRateTrend([
      period("2026-09-01", 5, 4),
      period("2026-09-02", 2, 6),
      period("2026-09-03", 3, 3),
      period("2026-09-04", 4, 2),
    ], 20);

    expect(trend.points[2]).toMatchObject({ sampleGames: 23, sampleWins: 10, sampleLosses: 13, sampleStart: "2026-09-01" });
    expect(trend.points[3]).toMatchObject({ sampleGames: 20, sampleWins: 9, sampleLosses: 11, sampleStart: "2026-09-02", rate: 45 });
  });

  test("uses a whole busy period even when that period alone exceeds the target", () => {
    const trend = buildWinRateTrend([
      period("2026-09-01", 10, 0),
      period("2026-09-02", 10, 20),
    ], 20);

    expect(trend.latest).toMatchObject({ sampleWins: 10, sampleLosses: 20, sampleGames: 30, sampleStart: "2026-09-02" });
    expect(trend.latest?.rate).toBeCloseTo(100 / 3);
  });

  test("does not let future outcomes change earlier samples", () => {
    const history = [period("2026-09-01", 12, 8), period("2026-09-02", 0, 5)];
    const before = buildWinRateTrend(history, 20);
    const after = buildWinRateTrend([...history, period("2026-09-03", 50, 0)], 20);

    expect(after.points.slice(0, history.length)).toEqual(before.points);
  });

  test("uses played periods across long gaps and leaves idle periods unplotted", () => {
    const trend = buildWinRateTrend([
      period("2026-07-01", 3, 2),
      period("2026-08-01", 0, 0),
      period("2026-09-01", 12, 3),
      period("2026-09-02", 0, 0),
    ], 20);

    expect(trend.points.map(point => point.rate)).toEqual([null, null, 75, null]);
    expect(trend.latest?.date).toBe("2026-09-01");
    expect(trend.latest?.sampleStart).toBe("2026-07-01");
    expect(trend.points[3].ready).toBe(false);
    expect(trend.readyPoints).toBe(1);
  });

  test("withholds a small sample while exposing honest totals for an empty state", () => {
    const trend = buildWinRateTrend([period("2026-09-01", 4, 1)], 20);

    expect(trend.latest).toMatchObject({ rate: null, ready: false, sampleGames: 5 });
    expect(trend.overall).toEqual({ wins: 4, losses: 1, games: 5, rate: 80 });
    expect(trend.readyPoints).toBe(0);
  });

  test.each([{ wins: 20, losses: 0, rate: 100 }, { wins: 0, losses: 20, rate: 0 }])(
    "preserves a supported $rate% outcome without smoothing toward 50%",
    ({ wins, losses, rate }) => {
      expect(buildWinRateTrend([period("2026-09-01", wins, losses)], 20).latest?.rate).toBe(rate);
    },
  );

  test("preserves unknown outcomes in the denominator without inventing losses", () => {
    const trend = buildWinRateTrend([period("2026-09-01", 10, 5, 20)], 20);

    expect(trend.overall).toEqual({ wins: 10, losses: 5, games: 20, rate: 50 });
    expect(trend.latest).toMatchObject({ sampleWins: 10, sampleLosses: 5, sampleGames: 20, rate: 50 });
  });

  test("sorts and coalesces duplicate dates deterministically without mutating input", () => {
    const input = [
      period("2026-09-03", 4, 1),
      period("2026-09-01", 2, 3),
      period("2026-09-02", 5, 0),
      period("2026-09-01", 1, 4),
    ];
    const original = structuredClone(input);
    const trend = buildWinRateTrend(input, 10);

    expect(trend).toEqual(buildWinRateTrend([...input].reverse(), 10));
    expect(input).toEqual(original);
    expect(trend.points.map(point => point.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(trend.points[0]).toMatchObject({ games: 10, wins: 3, losses: 7, rate: 30 });
    expect(trend.overall).toEqual({ games: 20, wins: 12, losses: 8, rate: 60 });
  });

  test("handles empty and all-idle histories without division by zero", () => {
    for (const input of [[], [period("2026-09-01", 0, 0)]]) {
      const trend = buildWinRateTrend(input, 20);
      expect(trend.overall).toEqual({ wins: 0, losses: 0, games: 0, rate: null });
      expect(trend.latest).toBeNull();
      expect(trend.readyPoints).toBe(0);
      expect(trend.points.every(point => point.rate === null && point.sampleStart === null)).toBe(true);
    }
  });

  test("normalizes malformed counts and omits invalid calendar dates", () => {
    const trend = buildWinRateTrend([
      period("2026-09-01", Number.NaN, -2, 4.9),
      period("2026-09-02", 20, 20, 5),
      period("2026-09-03", 4, 3, Number.POSITIVE_INFINITY),
      period("2026-09-04", 4, 3, -1),
      period("2026-02-30", 20, 0),
      period("invalid", 20, 0),
    ], 5);

    expect(trend.points).toHaveLength(4);
    expect(trend.points[0]).toMatchObject({ games: 4, wins: 0, losses: 0, rate: null });
    expect(trend.points[1]).toMatchObject({ games: 5, wins: 5, losses: 0, rate: 100 });
    expect(trend.points.slice(2).every(point => point.games === 0 && point.rate === null)).toBe(true);
    expect(trend.overall.games).toBe(9);
  });

  test("uses a safe default for invalid targets and rounds fractional thresholds up", () => {
    const input = [period("2026-09-01", 2, 0)];
    for (const target of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildWinRateTrend(input, target).targetGames).toBe(20);
      expect(buildWinRateTrend(input, target).latest?.rate).toBeNull();
    }
    expect(buildWinRateTrend(input, 2.1)).toMatchObject({ targetGames: 3, readyPoints: 0 });
  });
});

describe("formatTrendDate", () => {
  test("formats date-only values with explicit UTC calendar semantics", () => {
    expect(formatTrendDate("2026-01-01")).toBe("Jan 1");
    expect(formatTrendDate("2026-09-18", true)).toBe("Sep 18, 2026");
    expect(formatTrendDate("2024-02-29")).toBe("Feb 29");
  });

  test("does not normalize invalid dates into a misleading label", () => {
    expect(formatTrendDate("2026-02-29")).toBe("—");
    expect(formatTrendDate("invalid")).toBe("—");
  });
});
