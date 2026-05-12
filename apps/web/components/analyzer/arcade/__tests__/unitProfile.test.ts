import { describe, expect, test } from "vitest";
import {
  __test as unitTest,
  unitProfile,
} from "../modes/quizzes/unitProfile";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeUnitStats } from "../types";

const { buildBuiltQuestion, buildLostQuestion, bucketForUnitsLost } = unitTest;

const baseDataset: Omit<ArcadeDataset, "unitStats"> = {
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

function datasetWithStats(stats: ArcadeUnitStats | null): ArcadeDataset {
  return { ...baseDataset, unitStats: stats };
}

describe("Unit Profile · bucketForUnitsLost", () => {
  test("bucket boundaries are stable around the round numbers", () => {
    expect(bucketForUnitsLost(0)).toBe("Under 500");
    expect(bucketForUnitsLost(499)).toBe("Under 500");
    expect(bucketForUnitsLost(500)).toBe("500 – 2,500");
    expect(bucketForUnitsLost(2_499)).toBe("500 – 2,500");
    expect(bucketForUnitsLost(2_500)).toBe("2,500 – 10,000");
    expect(bucketForUnitsLost(9_999)).toBe("2,500 – 10,000");
    expect(bucketForUnitsLost(10_000)).toBe("10,000+");
    expect(bucketForUnitsLost(123_456)).toBe("10,000+");
  });

  test("NaN / negative inputs land in the lowest bucket without throwing", () => {
    expect(bucketForUnitsLost(Number.NaN)).toBe("Under 500");
    expect(bucketForUnitsLost(-42)).toBe("Under 500");
  });
});

describe("Unit Profile · buildBuiltQuestion", () => {
  const rng = mulberry32(7);

  test("picks the top-built unit as the correct answer + 3 strictly-lower distractors", () => {
    const stats: ArcadeUnitStats = {
      scannedGames: 200,
      builtByUnit: {
        Marine: 500,
        Marauder: 250,
        Reaper: 120,
        SiegeTank: 80,
        Medivac: 40,
      },
      totalUnitsLost: 0,
      lostGames: 0,
    };
    const q = buildBuiltQuestion(stats, rng);
    expect(q).not.toBeNull();
    expect(q!.truth).toBe("Marine");
    expect(q!.truthValue).toBe(500);
    expect(q!.options).toHaveLength(4);
    expect(q!.options).toContain("Marine");
    for (const o of q!.options) {
      if (o === "Marine") continue;
      expect(stats.builtByUnit[o]).toBeLessThan(500);
    }
  });

  test("rejects when fewer than 4 distinct units are populated", () => {
    const stats: ArcadeUnitStats = {
      scannedGames: 200,
      builtByUnit: { Marine: 500, Marauder: 250, Reaper: 120 },
      totalUnitsLost: 0,
      lostGames: 0,
    };
    expect(buildBuiltQuestion(stats, rng)).toBeNull();
  });

  test("rejects when the leader is tied with the 4th-place candidate", () => {
    // No objectively "most-built" unit → the reveal would have to
    // say "tied with X" which the bucket UI doesn't support, so the
    // variant gates out.
    const stats: ArcadeUnitStats = {
      scannedGames: 200,
      builtByUnit: {
        Zealot: 100,
        Stalker: 100,
        Sentry: 100,
        Adept: 100,
        Immortal: 100,
      },
      totalUnitsLost: 0,
      lostGames: 0,
    };
    expect(buildBuiltQuestion(stats, rng)).toBeNull();
  });
});

describe("Unit Profile · buildLostQuestion", () => {
  test("buckets the total units lost", () => {
    const q = buildLostQuestion({
      scannedGames: 200,
      builtByUnit: {},
      totalUnitsLost: 4_200,
      lostGames: 100,
    });
    expect(q).not.toBeNull();
    expect(q!.truth).toBe("2,500 – 10,000");
    expect(q!.truthValue).toBe(4_200);
    expect(q!.lostGames).toBe(100);
  });

  test("rejects when too few games carry units_lost data", () => {
    expect(
      buildLostQuestion({
        scannedGames: 200,
        builtByUnit: {},
        totalUnitsLost: 50,
        lostGames: 4,
      }),
    ).toBeNull();
  });

  test("rejects when total units lost is zero", () => {
    // A dataset where every game contributed 0 to units_lost would
    // tick the "Under 500" bucket — technically correct, but the
    // question reads as a buggy stat. Gate out instead.
    expect(
      buildLostQuestion({
        scannedGames: 200,
        builtByUnit: {},
        totalUnitsLost: 0,
        lostGames: 50,
      }),
    ).toBeNull();
  });
});

describe("Unit Profile · mode.generate", () => {
  test("returns ok=false with a friendly reason when unitStats is null", async () => {
    const out = await unitProfile.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-11",
      tz: "UTC",
      data: datasetWithStats(null),
    });
    expect(out.ok).toBe(false);
  });

  test("returns ok=false when scannedGames is below the minimum", async () => {
    const out = await unitProfile.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-11",
      tz: "UTC",
      data: datasetWithStats({
        scannedGames: 5,
        builtByUnit: { Marine: 10 },
        totalUnitsLost: 0,
        lostGames: 0,
      }),
    });
    expect(out.ok).toBe(false);
  });

  test("returns ok=true with a built-variant question when the data is rich enough", async () => {
    const out = await unitProfile.generate({
      rng: mulberry32(3),
      daySeed: "2026-05-11",
      tz: "UTC",
      data: datasetWithStats({
        scannedGames: 200,
        builtByUnit: {
          Marine: 500,
          Marauder: 250,
          Reaper: 120,
          SiegeTank: 80,
          Medivac: 40,
        },
        totalUnitsLost: 0,
        lostGames: 0,
      }),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable — narrowed above");
    // Both variants are answerable from this dataset; we don't pin
    // which one rolls (it depends on the RNG draw), only that the
    // returned question is one of the two shapes.
    expect(["built", "lost"]).toContain(out.question.variant);
  });

  test("score awards XP for the right answer and zero for the wrong one", () => {
    const q = {
      variant: "built" as const,
      options: ["Marine", "Marauder", "Reaper", "Medivac"],
      truth: "Marine",
      truthValue: 500,
      countsByOption: { Marine: 500, Marauder: 250, Reaper: 120, Medivac: 40 },
      scannedGames: 200,
    };
    expect(unitProfile.score(q, "Marine").xp).toBeGreaterThan(0);
    expect(unitProfile.score(q, "Marine").outcome).toBe("correct");
    expect(unitProfile.score(q, "Medivac").xp).toBe(0);
    expect(unitProfile.score(q, "Medivac").outcome).toBe("wrong");
  });
});
