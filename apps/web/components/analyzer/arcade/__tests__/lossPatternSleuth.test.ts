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
  test("returns a race with ≥10 losses summed across rows", () => {
    const out = pickRaceWithLosses(
      [
        { name: "vs T", oppRace: "T", wins: 0, losses: 7, total: 7, winRate: 0 },
        { name: "vs T", oppRace: "T", wins: 1, losses: 5, total: 6, winRate: 0.16 },
      ],
      mulberry32(1),
    );
    expect(out).toBe("T");
  });
  test("null when no race clears the gate", () => {
    const out = pickRaceWithLosses(
      [{ name: "vs T", oppRace: "T", wins: 4, losses: 1, total: 5, winRate: 0.8 }],
      mulberry32(1),
    );
    expect(out).toBeNull();
  });
  test("ignores rows with oppRace=null (e.g. 'vs Unknown' aggregations)", () => {
    const out = pickRaceWithLosses(
      [
        { name: "vs Unknown", oppRace: null, wins: 0, losses: 50, total: 50, winRate: 0 },
        { name: "vs P", oppRace: "P", wins: 0, losses: 12, total: 12, winRate: 0 },
      ],
      mulberry32(1),
    );
    expect(out).toBe("P");
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
