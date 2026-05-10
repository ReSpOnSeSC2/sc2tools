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
    const builds = ["Reaper FE", "Mech Macro", "Bio Drop", "Air Switch"];
    let i = 0;
    for (const b of builds) {
      // 3 wins + 2 losses per build = 20 games total (still a thin sample).
      for (let k = 0; k < 3; k++) games.push(game(b, "Win", 540 + k * 30, i++));
      for (let k = 0; k < 2; k++) games.push(game(b, "Loss", 720, i++));
    }
    // Pad with 30 more games across various builds so the dataset
    // resembles ~50 ranked games total — none of which break the
    // 4-distinct-builds requirement.
    for (let k = 0; k < 30; k++) games.push(game(`Junk Bucket ${k % 8}`, "Win", 600, i++));
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
});
