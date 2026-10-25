import { describe, expect, it } from "vitest";
import { mechanicsGeometry, mechanicsPoints } from "../mechanicsTrend";
import { apiToPeriods, type Period } from "../timeseries";

const row = (date: string, patch: Partial<Period> = {}): Period => ({ date, games: 10, wins: 6, losses: 4, winRate: .6, avgMacroScore: 60, macroN: 5, ...patch });

describe("mechanics trend observations", () => {
  it("positions a long calendar gap proportionally and interrupts the path", () => {
    const points = mechanicsPoints([row("2026-01-01"), row("2026-01-02"), row("2026-02-01")], "macro", "day");
    const chart = mechanicsGeometry(points, "macro");
    expect((chart.x(points[1].time) - chart.x(points[0].time)) / (chart.x(points[2].time) - chart.x(points[0].time))).toBeCloseTo(1 / 31);
    expect(points.map(point => point.breakBefore)).toEqual([false, false, true]);
    expect(chart.path.match(/M/g)).toHaveLength(2);
  });

  it("uses metric-specific sample counts, a strict five-game threshold and real zeros", () => {
    const series = [row("2026-10-01", { games: 100, macroN: 4, apmN: 5, avgApm: 0 }), row("2026-10-02", { macroN: 5 })];
    expect(mechanicsPoints(series, "macro", "day").map(point => point.hollow)).toEqual([true, false]);
    expect(mechanicsPoints(series, "apm", "day")[0]).toMatchObject({ value: 0, n: 5, hollow: false });
  });

  it("leaves absent metrics/counts and calendar gaps unknown, without interpolating across them", () => {
    const points = mechanicsPoints([row("2026-10-01"), row("2026-10-02", { avgMacroScore: null, macroN: 0 }), row("2026-10-03", { macroN: undefined })], "macro", "day");
    expect(points[1].value).toBeNull();
    expect(points[2]).toMatchObject({ n: null, hollow: true });
    expect(mechanicsGeometry(points, "macro").path.match(/M/g)).toHaveLength(2);
    expect(mechanicsPoints([row("2026-02-31"), row("bad")], "macro", "day")).toEqual([]);
  });

  it("keeps calendar-month and week spacing continuous only for adjacent periods", () => {
    expect(mechanicsPoints([row("2026-01-01"), row("2026-02-01"), row("2026-04-01")], "macro", "month").map(point => point.breakBefore)).toEqual([false, false, true]);
    expect(mechanicsPoints([row("2026-03-08"), row("2026-03-15")], "macro", "week")[1].breakBefore).toBe(false);
  });

  it("adapts new measurements without treating strings, infinities or invalid counts as observations", () => {
    const [period] = apiToPeriods({ interval: "day", points: [{ bucket: "2026-10-01T00:00:00Z", wins: 0, losses: 0, total: 1, winRate: 0, avgMacroScore: NaN, avgApm: 123.4, avgSpq: Infinity, macroN: 1, apmN: 5, spqN: -1 }] }, "UTC");
    expect(period).toMatchObject({ avgMacroScore: null, avgApm: 123.4, avgSpq: null, macroN: 1, apmN: 5, spqN: null });
    expect(mechanicsPoints([period], "sq", "day")[0].value).toBeNull();
  });
});
