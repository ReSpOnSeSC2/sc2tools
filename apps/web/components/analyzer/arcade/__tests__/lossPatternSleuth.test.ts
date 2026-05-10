import { describe, expect, test } from "vitest";
import {
  lossPatternSleuth,
  pickRaceWithLosses,
} from "../modes/quizzes/lossPatternSleuth";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset } from "../types";

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

describe("Loss Pattern Sleuth — pickRaceWithLosses", () => {
  test("returns a race with ≥10 losses", () => {
    const out = pickRaceWithLosses(
      [
        { matchup: "PvT", wins: 0, losses: 7, total: 7, winRate: 0 },
        { matchup: "TvT", wins: 1, losses: 5, total: 6, winRate: 0.16 },
      ],
      mulberry32(1),
    );
    expect(out).toBe("T");
  });
  test("null when no race clears the gate", () => {
    const out = pickRaceWithLosses(
      [{ matchup: "PvT", wins: 4, losses: 1, total: 5, winRate: 0.8 }],
      mulberry32(1),
    );
    expect(out).toBeNull();
  });
});

describe("Loss Pattern Sleuth — generate (thin data)", () => {
  test("ok=false on empty dataset", async () => {
    const result = await lossPatternSleuth.generate({
      rng: mulberry32(1),
      daySeed: "d",
      tz: "UTC",
      data: baseDataset,
    });
    expect(result.ok).toBe(false);
  });
});
