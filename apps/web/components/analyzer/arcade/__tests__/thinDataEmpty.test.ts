import { describe, expect, test } from "vitest";
import { QUIZZES } from "../modes";
import { mulberry32 } from "../ArcadeEngine";
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
