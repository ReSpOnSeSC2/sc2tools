import { describe, expect, test } from "vitest";
import {
  bucketByPeriod,
  buildMatchupGrid,
  cellKey,
  chronological,
  cumulativeSeries,
  decidedOnly,
  gameOutcome,
  mapPeriodGrid,
  totalsOf,
  type H2HGame,
} from "./h2hSeries";

function game(opts: Partial<H2HGame>): H2HGame {
  return { id: "g", date: "2026-04-01T12:00:00Z", result: "Win", ...opts };
}

describe("gameOutcome", () => {
  test("treats Win/Victory as W and Loss/Defeat as L", () => {
    expect(gameOutcome({ result: "Win" })).toBe("W");
    expect(gameOutcome({ result: "Victory" })).toBe("W");
    expect(gameOutcome({ result: "Loss" })).toBe("L");
    expect(gameOutcome({ result: "Defeat" })).toBe("L");
  });
  test("treats unknowns as U", () => {
    expect(gameOutcome({ result: null })).toBe("U");
    expect(gameOutcome({ result: "Tie" })).toBe("U");
    expect(gameOutcome({})).toBe("U");
  });
});

describe("chronological + decidedOnly", () => {
  test("reverses without mutating", () => {
    const newest = [game({ id: "c" }), game({ id: "b" }), game({ id: "a" })];
    const out = chronological(newest);
    expect(out.map((g) => g.id)).toEqual(["a", "b", "c"]);
    expect(newest.map((g) => g.id)).toEqual(["c", "b", "a"]);
  });
  test("decidedOnly keeps W and L", () => {
    const games = [
      game({ id: "1", result: "Win" }),
      game({ id: "2", result: "Tie" }),
      game({ id: "3", result: "Loss" }),
    ];
    expect(decidedOnly(games).map((g) => g.id)).toEqual(["1", "3"]);
  });
});

describe("cumulativeSeries", () => {
  test("empty array yields empty series", () => {
    expect(cumulativeSeries([], 5)).toEqual([]);
  });
  test("computes cumulative WR after each game", () => {
    const games = [
      game({ id: "1", result: "Win" }),
      game({ id: "2", result: "Loss" }),
      game({ id: "3", result: "Win" }),
      game({ id: "4", result: "Win" }),
    ];
    const series = cumulativeSeries(games, 3);
    expect(series.map((p) => p.cumulativeWrPct)).toEqual([100, 50, 67, 75]);
    expect(series.map((p) => p.cumulativeWins)).toEqual([1, 1, 2, 3]);
    expect(series.map((p) => p.cumulativeLosses)).toEqual([0, 1, 1, 1]);
  });
  test("rolling WR is null until window full", () => {
    const games = [
      game({ id: "1", result: "Win" }),
      game({ id: "2", result: "Loss" }),
      game({ id: "3", result: "Win" }),
      game({ id: "4", result: "Win" }),
      game({ id: "5", result: "Loss" }),
    ];
    const series = cumulativeSeries(games, 3);
    expect(series[0].rollingWrPct).toBeNull();
    expect(series[1].rollingWrPct).toBeNull();
    expect(series[2].rollingWrPct).toBe(67);
    expect(series[3].rollingWrPct).toBe(67);
    expect(series[4].rollingWrPct).toBe(67);
  });
  test("filters out unknown results before indexing", () => {
    const games = [
      game({ id: "1", result: "Win" }),
      game({ id: "2", result: "Tie" }),
      game({ id: "3", result: "Loss" }),
    ];
    const series = cumulativeSeries(games, 5);
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.game.id)).toEqual(["1", "3"]);
    expect(series.map((p) => p.index)).toEqual([1, 2]);
  });
  test("macro percentile is null when no scored games exist", () => {
    const games = [
      game({ id: "1", result: "Win", macro_score: null }),
      game({ id: "2", result: "Loss", macro_score: null }),
    ];
    const series = cumulativeSeries(games, 2);
    expect(series.every((p) => p.macroPercentile === null)).toBe(true);
  });
  test("macro percentile maps to nearest rank within scored games", () => {
    const games = [
      game({ id: "1", result: "Win", macro_score: 10 }),
      game({ id: "2", result: "Win", macro_score: 50 }),
      game({ id: "3", result: "Win", macro_score: 90 }),
      game({ id: "4", result: "Loss", macro_score: null }),
    ];
    const series = cumulativeSeries(games, 5);
    expect(series[0].macroPercentile).toBe(33);
    expect(series[1].macroPercentile).toBe(67);
    expect(series[2].macroPercentile).toBe(100);
    expect(series[3].macroPercentile).toBeNull();
  });
});

describe("bucketByPeriod", () => {
  test("groups games into the right day bucket in UTC", () => {
    const games: H2HGame[] = [
      game({ id: "1", date: "2026-04-01T01:00:00Z", result: "Win" }),
      game({ id: "2", date: "2026-04-01T22:00:00Z", result: "Loss" }),
      game({ id: "3", date: "2026-04-02T08:00:00Z", result: "Win" }),
    ];
    const out = bucketByPeriod(games, "day", "UTC");
    expect(out).toEqual([
      { date: "2026-04-01", wins: 1, losses: 1, total: 2, winRatePct: 50 },
      { date: "2026-04-02", wins: 1, losses: 0, total: 1, winRatePct: 100 },
    ]);
  });
  test("buckets weeks at Monday in user tz", () => {
    const games: H2HGame[] = [
      // 2026-04-01 is a Wednesday
      game({ id: "1", date: "2026-04-01T12:00:00Z", result: "Win" }),
      game({ id: "2", date: "2026-04-04T12:00:00Z", result: "Win" }),
      // 2026-04-07 is the Tuesday of the next ISO week
      game({ id: "3", date: "2026-04-07T12:00:00Z", result: "Loss" }),
    ];
    const out = bucketByPeriod(games, "week", "UTC");
    expect(out).toEqual([
      { date: "2026-03-30", wins: 2, losses: 0, total: 2, winRatePct: 100 },
      { date: "2026-04-06", wins: 0, losses: 1, total: 1, winRatePct: 0 },
    ]);
  });
  test("month bucketing keys to the first of the month", () => {
    const games: H2HGame[] = [
      game({ id: "1", date: "2026-03-30T00:00:00Z", result: "Win" }),
      game({ id: "2", date: "2026-04-15T00:00:00Z", result: "Win" }),
      game({ id: "3", date: "2026-04-30T23:00:00Z", result: "Loss" }),
    ];
    const out = bucketByPeriod(games, "month", "UTC");
    expect(out.map((p) => p.date)).toEqual(["2026-03-01", "2026-04-01"]);
    expect(out[1]).toEqual({
      date: "2026-04-01",
      wins: 1,
      losses: 1,
      total: 2,
      winRatePct: 50,
    });
  });
  test("ignores undecided rows", () => {
    const games: H2HGame[] = [
      game({ id: "1", date: "2026-04-01T01:00:00Z", result: "Tie" }),
      game({ id: "2", date: "2026-04-01T01:00:00Z", result: "Win" }),
    ];
    const out = bucketByPeriod(games, "day", "UTC");
    expect(out).toEqual([
      { date: "2026-04-01", wins: 1, losses: 0, total: 1, winRatePct: 100 },
    ]);
  });
});

describe("mapPeriodGrid", () => {
  function chronoSet(): H2HGame[] {
    return [
      game({ id: "1", map: "Aiur", result: "Win" }),
      game({ id: "2", map: "Aiur", result: "Loss" }),
      game({ id: "3", map: "Aiur", result: "Loss" }),
      game({ id: "4", map: "Frost", result: "Win" }),
      game({ id: "5", map: "Aiur", result: "Win" }),
      game({ id: "6", map: "Aiur", result: "Win" }),
    ];
  }
  test("halves split returns two columns and a per-map row", () => {
    const grid = mapPeriodGrid(chronoSet(), "halves");
    expect(grid.columns).toHaveLength(2);
    const aiur = grid.rows.find((r) => r.map === "Aiur");
    expect(aiur).toBeTruthy();
    if (!aiur) throw new Error("Aiur row missing");
    expect(aiur.cells[0].total).toBe(3);
    expect(aiur.cells[0].wins).toBe(1);
    expect(aiur.cells[1].total).toBe(2);
    expect(aiur.cells[1].wins).toBe(2);
    expect(aiur.trendDeltaPct).toBe(67);
  });
  test("thirds split returns three columns", () => {
    const grid = mapPeriodGrid(chronoSet(), "thirds");
    expect(grid.columns).toHaveLength(3);
    const aiur = grid.rows.find((r) => r.map === "Aiur");
    if (!aiur) throw new Error("Aiur row missing");
    expect(aiur.cells).toHaveLength(3);
  });
  test("rows with empty array yields empty rows", () => {
    expect(mapPeriodGrid([], "halves").rows).toEqual([]);
  });
});

describe("buildMatchupGrid", () => {
  function games(): H2HGame[] {
    return [
      game({ my_build: "1/1/1", opp_strategy: "Roach Allin", result: "Win" }),
      game({ my_build: "1/1/1", opp_strategy: "Roach Allin", result: "Win" }),
      game({ my_build: "1/1/1", opp_strategy: "Roach Allin", result: "Loss" }),
      game({ my_build: "Reaper FE", opp_strategy: "Hatch first", result: "Win" }),
      game({ my_build: "Reaper FE", opp_strategy: "Roach Allin", result: "Loss" }),
      game({ my_build: "1/1/1", opp_strategy: "Hatch first", result: "Win" }),
    ];
  }
  test("limits to top K of each axis and counts WR per cell", () => {
    const grid = buildMatchupGrid(games(), 2, 2);
    expect(grid.myBuilds).toContain("1/1/1");
    expect(grid.myBuilds).toContain("Reaper FE");
    expect(grid.oppStrategies).toContain("Roach Allin");
    const cell = grid.cells.get(cellKey("1/1/1", "Roach Allin"));
    expect(cell?.total).toBe(3);
    expect(cell?.wins).toBe(2);
    expect(cell?.losses).toBe(1);
  });
  test("skips games with missing build/strategy", () => {
    const list: H2HGame[] = [
      game({ my_build: "1/1/1", opp_strategy: "", result: "Win" }),
      game({ my_build: "", opp_strategy: "Roach Allin", result: "Win" }),
    ];
    const grid = buildMatchupGrid(list, 5, 5);
    expect(grid.cells.size).toBe(0);
  });
  test("captures opponent race for legend", () => {
    const list: H2HGame[] = [
      game({ my_build: "x", opp_strategy: "y", opp_race: "Z", result: "Win" }),
    ];
    const grid = buildMatchupGrid(list, 5, 5);
    expect(grid.oppStrategyRace.get("y")).toBe("Z");
  });
});

describe("totalsOf", () => {
  test("counts decided games and computes WR", () => {
    const list: H2HGame[] = [
      game({ result: "Win" }),
      game({ result: "Loss" }),
      game({ result: "Tie" }),
      game({ result: "Win" }),
    ];
    const t = totalsOf(list);
    expect(t).toEqual({ wins: 2, losses: 1, total: 3, winRate: 2 / 3 });
  });
  test("zero games yields zero WR without dividing by zero", () => {
    expect(totalsOf([])).toEqual({ wins: 0, losses: 0, total: 0, winRate: 0 });
  });
});
