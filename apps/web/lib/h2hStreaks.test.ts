import { describe, expect, test } from "vitest";
import {
  momentumDelta,
  momentumScore,
  streaksSummary,
} from "./h2hStreaks";
import type { H2HGame } from "./h2hSeries";

function g(result: string, id = `g${Math.random()}`): H2HGame {
  return { id, date: "2026-04-01T00:00:00Z", result };
}

describe("streaksSummary — basic shape", () => {
  test("empty array yields nothing", () => {
    const s = streaksSummary([]);
    expect(s.current).toEqual({ kind: null, count: 0, indexes: [] });
    expect(s.longestWin).toBeNull();
    expect(s.longestLoss).toBeNull();
    expect(s.notableRuns).toEqual([]);
  });
  test("single win", () => {
    const s = streaksSummary([g("Win")]);
    expect(s.current.kind).toBe("win");
    expect(s.current.count).toBe(1);
    expect(s.longestWin?.count).toBe(1);
    expect(s.longestLoss).toBeNull();
    expect(s.notableRuns).toEqual([]);
  });
  test("single loss", () => {
    const s = streaksSummary([g("Loss")]);
    expect(s.current.kind).toBe("loss");
    expect(s.current.count).toBe(1);
    expect(s.longestLoss?.count).toBe(1);
    expect(s.longestWin).toBeNull();
  });
});

describe("streaksSummary — alternating", () => {
  test("WLWL ends on loss with current streak of 1", () => {
    const games = [g("Win"), g("Loss"), g("Win"), g("Loss")];
    const s = streaksSummary(games);
    expect(s.current).toMatchObject({ kind: "loss", count: 1 });
    expect(s.longestWin?.count).toBe(1);
    expect(s.longestLoss?.count).toBe(1);
    expect(s.notableRuns).toEqual([]);
  });
});

describe("streaksSummary — all wins / all losses", () => {
  test("all wins yields one run", () => {
    const games = [g("Win"), g("Win"), g("Win"), g("Win")];
    const s = streaksSummary(games);
    expect(s.current).toMatchObject({ kind: "win", count: 4 });
    expect(s.longestWin?.count).toBe(4);
    expect(s.longestLoss).toBeNull();
    expect(s.notableRuns).toHaveLength(1);
  });
  test("all losses yields one run", () => {
    const games = [g("Loss"), g("Loss"), g("Loss")];
    const s = streaksSummary(games);
    expect(s.current).toMatchObject({ kind: "loss", count: 3 });
    expect(s.longestLoss?.count).toBe(3);
    expect(s.longestWin).toBeNull();
  });
});

describe("streaksSummary — mixed run boundaries", () => {
  test("WWWLLW yields current=1W, longestW=3, longestL=2", () => {
    const games = [g("Win"), g("Win"), g("Win"), g("Loss"), g("Loss"), g("Win")];
    const s = streaksSummary(games);
    expect(s.current).toMatchObject({ kind: "win", count: 1 });
    expect(s.longestWin?.count).toBe(3);
    expect(s.longestLoss?.count).toBe(2);
    expect(s.notableRuns.map((r) => `${r.kind}${r.count}`)).toEqual(["win3", "loss2"]);
  });
  test("ignores ties between runs (does not split)", () => {
    const games = [g("Win"), g("Tie"), g("Win"), g("Loss")];
    const s = streaksSummary(games);
    expect(s.longestWin?.count).toBe(2);
    expect(s.current).toMatchObject({ kind: "loss", count: 1 });
  });
  test("indexes returned for current streak point at chrono decided[]", () => {
    const games = [g("Loss"), g("Win"), g("Win"), g("Win")];
    const s = streaksSummary(games);
    expect(s.current.indexes).toEqual([1, 2, 3]);
  });
});

describe("momentumScore", () => {
  test("zero on empty", () => {
    expect(momentumScore([])).toBe(0);
  });
  test("perfect win run is +100", () => {
    const games = [g("Win"), g("Win"), g("Win"), g("Win"), g("Win")];
    expect(momentumScore(games, 5)).toBe(100);
  });
  test("perfect loss run is -100", () => {
    const games = [g("Loss"), g("Loss"), g("Loss"), g("Loss"), g("Loss")];
    expect(momentumScore(games, 5)).toBe(-100);
  });
  test("symmetric: WWWLLL has momentum near 0 with high decay", () => {
    const games = [g("Win"), g("Win"), g("Win"), g("Loss"), g("Loss"), g("Loss")];
    const m = momentumScore(games, 6, 0.99);
    expect(Math.abs(m)).toBeLessThan(20);
  });
  test("recent loss outweighs older wins with steep decay", () => {
    const games = [g("Win"), g("Win"), g("Win"), g("Loss")];
    const m = momentumScore(games, 4, 0.5);
    expect(m).toBeLessThan(0);
  });
  test("uses only the trailing window when more games exist", () => {
    const losses = Array.from({ length: 10 }, () => g("Loss"));
    const wins = Array.from({ length: 5 }, () => g("Win"));
    const series = [...losses, ...wins];
    const m = momentumScore(series, 5);
    expect(m).toBe(100);
  });
});

describe("momentumDelta", () => {
  test("null when fewer than 2N games", () => {
    const games = [g("Win"), g("Win"), g("Win")];
    expect(momentumDelta(games, 5)).toBeNull();
  });
  test("positive when recent window improves over prior window", () => {
    const prior = Array.from({ length: 10 }, () => g("Loss"));
    const recent = Array.from({ length: 10 }, () => g("Win"));
    const d = momentumDelta([...prior, ...recent], 10);
    expect(d).not.toBeNull();
    expect((d as number) > 100).toBe(true);
  });
  test("negative when recent window regresses", () => {
    const prior = Array.from({ length: 10 }, () => g("Win"));
    const recent = Array.from({ length: 10 }, () => g("Loss"));
    const d = momentumDelta([...prior, ...recent], 10);
    expect(d).not.toBeNull();
    expect((d as number) < -100).toBe(true);
  });
});
