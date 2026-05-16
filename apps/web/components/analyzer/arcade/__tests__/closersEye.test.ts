import { describe, expect, test } from "vitest";
import { closersEye } from "../modes/quizzes/closersEye";
import { meanWinLengths } from "../modes/quizzes/closersEye";
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

const game = (
  build: string,
  result: "Win" | "Loss",
  duration: number,
  i = 0,
): ArcadeGame => ({
  gameId: `${build}-${i}`,
  date: new Date(2026, 0, 1 + i).toISOString(),
  result,
  myBuild: build,
  duration,
});

describe("Closer's Eye — meanWinLengths", () => {
  test("excludes any build whose name contains 'cannon rush' (case-insensitive)", () => {
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 6; i++) games.push(game("Cannon Rush", "Win", 200, i));
    for (let i = 0; i < 6; i++) games.push(game("Reaper FE", "Win", 600, i + 10));
    const out = meanWinLengths(games);
    expect(out.find((b) => /cannon rush/i.test(b.build))).toBeUndefined();
    expect(out.find((b) => b.build === "Reaper FE")?.wins).toBe(6);
  });
  test("requires ≥3 wins (lowered from 5 to play with realistic build spreads)", () => {
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 2; i++) games.push(game("TooThin", "Win", 500, i));
    expect(meanWinLengths(games).length).toBe(0);
    const enough: ArcadeGame[] = [];
    for (let i = 0; i < 3; i++) enough.push(game("Goldilocks", "Win", 500, i));
    expect(meanWinLengths(enough).length).toBe(1);
  });

  test("playable on a ~50-game account spread across 4 builds with 3 wins each", async () => {
    const games: ArcadeGame[] = [];
    // Each build gets its own win-length tier so the mean is distinct;
    // otherwise the slate has no strict winner and generate refuses.
    const builds: Array<[string, number]> = [
      ["Reaper FE", 480],
      ["Mech Macro", 600],
      ["Bio Drop", 720],
      ["Air Switch", 840],
    ];
    let i = 0;
    for (const [b, base] of builds) {
      // 3 wins + 2 losses per build = 20 games total (still a thin sample).
      for (let k = 0; k < 3; k++) games.push(game(b, "Win", base + k * 30, i++));
      for (let k = 0; k < 2; k++) games.push(game(b, "Loss", 720, i++));
    }
    // Pad with 30 more games across various builds so the dataset
    // resembles ~50 ranked games total — none of which break the
    // 4-distinct-builds requirement.
    for (let k = 0; k < 30; k++) games.push(game(`Junk Bucket ${k % 8}`, "Win", 1200 + k, i++));
    const result = await closersEye.generate({
      rng: mulberry32(7),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(result.ok).toBe(true);
  });
  test("computes mean win duration only over wins", () => {
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 5; i++) games.push(game("Macro", "Win", 1200, i));
    games.push(game("Macro", "Loss", 60, 99)); // outlier loss — must not affect mean
    const [row] = meanWinLengths(games);
    expect(row.meanWinSec).toBe(1200);
  });
});

describe("Closer's Eye generate (depth + thin-data)", () => {
  test("returns ok=false when fewer than 4 builds clear the gate (no synth)", async () => {
    const dataset: ArcadeDataset = { ...baseDataset, games: [] };
    const result = await closersEye.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(result.ok).toBe(false);
  });
  test("score awards XP only on a correct pick", () => {
    const q = {
      candidates: [
        { build: "A", meanWinSec: 600, wins: 5 },
        { build: "B", meanWinSec: 700, wins: 5 },
        { build: "C", meanWinSec: 800, wins: 5 },
        { build: "D", meanWinSec: 900, wins: 5 },
      ],
      correctIndex: 2,
    };
    expect(closersEye.score(q, 2).outcome).toBe("correct");
    expect(closersEye.score(q, 1).outcome).toBe("wrong");
  });

  test("correct answer varies across rngs — not pinned to the globally fastest build", async () => {
    // 6 builds with distinct mean win-lengths. Three of them (the
    // three fastest) can be valid "correct" answers because each
    // dominates ≥3 slower peers.
    const games: ArcadeGame[] = [];
    const builds: Array<[string, number]> = [
      ["Reaper FE", 420],
      ["Mech Macro", 480],
      ["Bio Drop", 540],
      ["Air Switch", 600],
      ["Ravager Bust", 660],
      ["Late Skytoss", 720],
    ];
    let i = 0;
    for (const [b, base] of builds) {
      for (let k = 0; k < 4; k++) games.push(game(b, "Win", base + k, i++));
    }
    const dataset: ArcadeDataset = { ...baseDataset, games };
    const corrects = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const r = await closersEye.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      if (r.ok) {
        corrects.add(r.question.candidates[r.question.correctIndex].build);
      }
    }
    // Should see more than just the absolute fastest as the correct
    // answer — that's the bug this regression test guards.
    expect(corrects.size).toBeGreaterThanOrEqual(3);
    expect(corrects.has("Reaper FE")).toBe(true);
    expect(corrects.has("Mech Macro")).toBe(true);
    expect(corrects.has("Bio Drop")).toBe(true);
  });

  test("the displayed correct candidate strictly beats every distractor", async () => {
    const games: ArcadeGame[] = [];
    const builds: Array<[string, number]> = [
      ["X1", 420],
      ["X2", 510],
      ["X3", 600],
      ["X4", 690],
      ["X5", 780],
    ];
    let i = 0;
    for (const [b, base] of builds) {
      for (let k = 0; k < 3; k++) games.push(game(b, "Win", base + k, i++));
    }
    const dataset: ArcadeDataset = { ...baseDataset, games };
    for (let seed = 1; seed <= 40; seed++) {
      const r = await closersEye.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const correct = r.question.candidates[r.question.correctIndex];
      for (let j = 0; j < r.question.candidates.length; j++) {
        if (j === r.question.correctIndex) continue;
        expect(r.question.candidates[j].meanWinSec).toBeGreaterThan(
          correct.meanWinSec,
        );
      }
    }
  });
});

describe("Closer's Eye share summary", () => {
  test("includes the question prompt and every candidate row", () => {
    const q = {
      candidates: [
        { build: "Reaper FE", meanWinSec: 8 * 60 + 30, wins: 4 },
        { build: "Hellion Banshee", meanWinSec: 10 * 60, wins: 3 },
        { build: "1-1-1", meanWinSec: 12 * 60, wins: 5 },
        { build: "Mech", meanWinSec: 15 * 60, wins: 3 },
      ],
      correctIndex: 0,
    };
    expect(closersEye.share).toBeTypeOf("function");
    const summary = closersEye.share!(q, 0, {
      raw: 1,
      xp: 14,
      outcome: "correct",
    });
    expect(summary.question).toMatch(/shortest average win length/i);
    expect(summary.answer[0]).toContain("Reaper FE");
    expect(summary.answer).toHaveLength(1 + q.candidates.length);
    // Every candidate appears as its own line in the breakdown.
    for (const c of q.candidates) {
      expect(summary.answer.some((line) => line.includes(c.build))).toBe(true);
    }
    // Correct candidate gets a star marker so the share image's reader
    // can see which row was the right answer.
    const correctLine = summary.answer.find((line) =>
      line.startsWith("Reaper FE"),
    );
    expect(correctLine).toContain("★");
  });
});
