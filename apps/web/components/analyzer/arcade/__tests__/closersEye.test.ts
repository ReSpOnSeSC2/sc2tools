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
  test("requires ≥5 wins", () => {
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 4; i++) games.push(game("ThinBuild", "Win", 500, i));
    expect(meanWinLengths(games).length).toBe(0);
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
});
