import { describe, expect, test } from "vitest";
import { streakVeto } from "../modes/quizzes/streakVeto";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame } from "../types";

const baseDataset: ArcadeDataset = {
  games: [],
  opponents: [],
  builds: [],
  customBuilds: [],
  communityBuilds: [],
  matchups: [],
  maps: [],
  summary: null,
  mapPool: [],
};

/**
 * Build a games array where each opponent contributes one streak of the
 * given length, ended by a loss vs that opponent.
 * `streaks` is a list of [opponentName, winCount] tuples in chronological
 * order. Dates are auto-assigned, one day apart starting at 2026-01-01.
 */
function buildGames(streaks: Array<[string, number]>): ArcadeGame[] {
  const games: ArcadeGame[] = [];
  let day = 1;
  let id = 1;
  for (const [opp, len] of streaks) {
    for (let i = 0; i < len; i++) {
      games.push({
        gameId: `g${id++}`,
        date: `2026-01-${String(day++).padStart(2, "0")}T12:00:00Z`,
        result: "Win",
        opponent: { displayName: `${opp}-w${i}` },
      });
    }
    games.push({
      gameId: `g${id++}`,
      date: `2026-01-${String(day++).padStart(2, "0")}T12:00:00Z`,
      result: "Loss",
      opponent: { displayName: opp },
    });
  }
  return games;
}

describe("Streak Veto — generate doesn't always force the all-time longest", () => {
  test("answer varies across seeds when many eligible runs exist", async () => {
    // The all-time longest is a 9W streak ended by MAGYARPÉTER. If the
    // old behavior were still in place, every seed would resolve to that
    // opponent. With the fix, any run with ≥2 strictly shorter runs
    // available as fillers can be the answer. All runs are ≥3 (the
    // streak floor); pre-floor 1-2-game "runs" no longer qualify as
    // fillers.
    const games = buildGames([
      ["MAGYARPÉTER", 9],
      ["Ragnarok", 7],
      ["RedViper", 6],
      ["Maze", 5],
      ["JEROS", 4],
      ["Bob", 3],
      ["Carol", 3],
    ]);
    const dataset: ArcadeDataset = { ...baseDataset, games };
    const winners = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const out = await streakVeto.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const correct = out.question.candidates[out.question.correctIndex];
      winners.add(correct.opponentName);
    }
    // We should see variety — not just the all-time-max opponent.
    expect(winners.size).toBeGreaterThan(1);
  });

  test("correct candidate always has a strictly longer streak than both fillers", async () => {
    // All runs ≥3 so they pass the floor; the spread guarantees there's
    // always an eligible answer with two strictly-shorter fillers.
    const games = buildGames([
      ["A", 7],
      ["B", 6],
      ["C", 5],
      ["D", 4],
      ["E", 3],
      ["F", 3],
    ]);
    const dataset: ArcadeDataset = { ...baseDataset, games };
    for (let seed = 1; seed <= 30; seed++) {
      const out = await streakVeto.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const correct = out.question.candidates[out.question.correctIndex];
      for (let i = 0; i < out.question.candidates.length; i++) {
        if (i === out.question.correctIndex) continue;
        expect(out.question.candidates[i].runLength).toBeLessThan(correct.runLength);
      }
    }
  });

  test("ok=false when fewer than 3 streak-ending losses exist", async () => {
    const games = buildGames([
      ["A", 3],
      ["B", 2],
    ]);
    const dataset: ArcadeDataset = { ...baseDataset, games };
    const out = await streakVeto.generate({
      rng: mulberry32(1),
      daySeed: "x",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });

  test("ok=false when no run has ≥2 strictly shorter runs to use as fillers", async () => {
    // All runs ≥3 (so they pass the floor), but all the same length —
    // no run has two strictly shorter to use as fillers.
    const games = buildGames([
      ["A", 3],
      ["B", 3],
      ["C", 3],
      ["D", 3],
    ]);
    const dataset: ArcadeDataset = { ...baseDataset, games };
    const out = await streakVeto.generate({
      rng: mulberry32(1),
      daySeed: "x",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });

  test("ok=false when no winning run reaches the 3-game streak floor", async () => {
    // A single W isn't a streak — even a pile of length-1 and length-2
    // runs shouldn't be playable.
    const games = buildGames([
      ["A", 1],
      ["B", 2],
      ["C", 1],
      ["D", 2],
      ["E", 1],
    ]);
    const dataset: ArcadeDataset = { ...baseDataset, games };
    const out = await streakVeto.generate({
      rng: mulberry32(1),
      daySeed: "x",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });

  test("runs below the 3-game floor never appear as candidates", async () => {
    // Mix of long (≥3) and short (1-2) runs. The quiz should never
    // surface the short ones as a "streak" — every candidate length
    // shown must be ≥3.
    const games = buildGames([
      ["A", 6],
      ["B", 5],
      ["C", 4],
      ["D", 3],
      ["E", 2],
      ["F", 1],
      ["G", 1],
    ]);
    const dataset: ArcadeDataset = { ...baseDataset, games };
    for (let seed = 1; seed <= 30; seed++) {
      const out = await streakVeto.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      for (const c of out.question.candidates) {
        expect(c.runLength).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
