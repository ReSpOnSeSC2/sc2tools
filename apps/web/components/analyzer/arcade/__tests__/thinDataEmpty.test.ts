import { describe, expect, test } from "vitest";
import { GAMES, QUIZZES } from "../modes";
import { dailySeed, mulberry32 } from "../ArcadeEngine";
import { __pickFromEligible } from "../hooks/useEligibleDailyPicks";
import type { ArcadeDataset } from "../types";

const empty: ArcadeDataset = {
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

describe("thin-data empty state", () => {
  test("every quiz returns ok=false on a thin/empty dataset (no synth)", async () => {
    for (const quiz of QUIZZES) {
      const out = await quiz.generate({
        rng: mulberry32(1),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: empty,
      });
      expect(out.ok, `${quiz.id} synthesised data`).toBe(false);
    }
  });
});

describe("daily picker on thin data", () => {
  test("probing every quiz on the empty dataset yields zero eligible ids", async () => {
    const eligibleQuizIds: string[] = [];
    for (const quiz of QUIZZES) {
      const out = await quiz.generate({
        rng: mulberry32(1),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: empty,
      });
      if (out.ok) eligibleQuizIds.push(quiz.id);
    }
    expect(eligibleQuizIds).toEqual([]);
  });

  test("__pickFromEligible returns null/0 when no quiz is eligible (mirrors hook fallback)", () => {
    const rng = mulberry32(dailySeed("test-user", "2026-05-10"));
    const { mode, skips } = __pickFromEligible(QUIZZES, [], rng);
    expect(mode).toBeNull();
    expect(skips).toBe(0);
  });

  test("__pickFromEligible returns null/0 when no game is eligible (mirrors hook fallback)", () => {
    const rng = mulberry32(dailySeed("test-user", "2026-05-10"));
    const { mode, skips } = __pickFromEligible(GAMES, [], rng);
    expect(mode).toBeNull();
    expect(skips).toBe(0);
  });
});
