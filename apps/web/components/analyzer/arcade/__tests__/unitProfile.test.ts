import { describe, expect, test } from "vitest";
import {
  __test as unitTest,
  unitProfile,
} from "../modes/quizzes/unitProfile";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeUnitStats } from "../types";

const {
  buildBuiltQuestion,
  buildLostQuestion,
  buildLostPerGameQuestion,
  buildDiversityQuestion,
  bucketForUnitsLost,
  bucketForLostPerGame,
  bucketForDiversity,
  DIVERSITY_MIN_DISTINCT,
} = unitTest;

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

describe("Unit Profile · bucketForLostPerGame", () => {
  test("bucket boundaries", () => {
    expect(bucketForLostPerGame(0)).toBe("Under 10");
    expect(bucketForLostPerGame(9.9)).toBe("Under 10");
    expect(bucketForLostPerGame(10)).toBe("10 – 30");
    expect(bucketForLostPerGame(29.9)).toBe("10 – 30");
    expect(bucketForLostPerGame(30)).toBe("30 – 75");
    expect(bucketForLostPerGame(74.9)).toBe("30 – 75");
    expect(bucketForLostPerGame(75)).toBe("75+");
    expect(bucketForLostPerGame(500)).toBe("75+");
  });

  test("NaN / negative inputs land in the lowest bucket", () => {
    expect(bucketForLostPerGame(Number.NaN)).toBe("Under 10");
    expect(bucketForLostPerGame(-3)).toBe("Under 10");
  });
});

describe("Unit Profile · bucketForDiversity", () => {
  test("bucket boundaries", () => {
    expect(bucketForDiversity(0)).toBe("Under 6");
    expect(bucketForDiversity(5)).toBe("Under 6");
    expect(bucketForDiversity(6)).toBe("6 – 12");
    expect(bucketForDiversity(11)).toBe("6 – 12");
    expect(bucketForDiversity(12)).toBe("12 – 20");
    expect(bucketForDiversity(19)).toBe("12 – 20");
    expect(bucketForDiversity(20)).toBe("20+");
    expect(bucketForDiversity(99)).toBe("20+");
  });

  test("NaN / negative inputs land in the lowest bucket", () => {
    expect(bucketForDiversity(Number.NaN)).toBe("Under 6");
    expect(bucketForDiversity(-5)).toBe("Under 6");
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

describe("Unit Profile · buildLostPerGameQuestion", () => {
  test("buckets the average units-lost per game", () => {
    const q = buildLostPerGameQuestion({
      scannedGames: 200,
      builtByUnit: {},
      totalUnitsLost: 4_200,
      lostGames: 100,
    });
    expect(q).not.toBeNull();
    expect(q!.truthValue).toBeCloseTo(42, 6);
    expect(q!.truth).toBe("30 – 75");
    expect(q!.totalUnitsLost).toBe(4_200);
    expect(q!.lostGames).toBe(100);
  });

  test("rejects when fewer than 10 games carry units_lost data", () => {
    expect(
      buildLostPerGameQuestion({
        scannedGames: 200,
        builtByUnit: {},
        totalUnitsLost: 500,
        lostGames: 5,
      }),
    ).toBeNull();
  });

  test("rejects when total units lost is zero (degenerate aggregate)", () => {
    expect(
      buildLostPerGameQuestion({
        scannedGames: 200,
        builtByUnit: {},
        totalUnitsLost: 0,
        lostGames: 50,
      }),
    ).toBeNull();
  });
});

describe("Unit Profile · buildDiversityQuestion", () => {
  test("counts only units with strictly-positive build counts", () => {
    const stats: ArcadeUnitStats = {
      scannedGames: 200,
      builtByUnit: {
        Marine: 500,
        Marauder: 250,
        Reaper: 120,
        Medivac: 40,
        Hellion: 30,
        SiegeTank: 10,
        Ghost: 0, // Should be excluded
      },
      totalUnitsLost: 0,
      lostGames: 0,
    };
    const q = buildDiversityQuestion(stats);
    expect(q).not.toBeNull();
    expect(q!.truthValue).toBe(6);
    expect(q!.truth).toBe("6 – 12");
    expect(q!.topUnits[0]).toEqual({ name: "Marine", count: 500 });
    expect(q!.topUnits).toHaveLength(5);
  });

  test("rejects when fewer than the diversity minimum distinct units exist", () => {
    const stats: ArcadeUnitStats = {
      scannedGames: 200,
      builtByUnit: { Marine: 100, Marauder: 50, Reaper: 25 },
      totalUnitsLost: 0,
      lostGames: 0,
    };
    expect(buildDiversityQuestion(stats)).toBeNull();
  });

  test("the minimum-distinct floor is the diversity gate, not the built-question gate", () => {
    // Validate the constant the module exposes lines up with the
    // "Under 6" bucket boundary, so failing to clear the gate always
    // means the answer would have been "Under 6".
    expect(DIVERSITY_MIN_DISTINCT).toBe(6);
  });

  test("buckets a wide roster as 20+", () => {
    const builtByUnit: Record<string, number> = {};
    for (let i = 0; i < 25; i++) builtByUnit[`Unit${i}`] = i + 1;
    const q = buildDiversityQuestion({
      scannedGames: 500,
      builtByUnit,
      totalUnitsLost: 0,
      lostGames: 0,
    });
    expect(q).not.toBeNull();
    expect(q!.truthValue).toBe(25);
    expect(q!.truth).toBe("20+");
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

  test("returns ok=true with one of the variants when the data is rich enough", async () => {
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
          Hellion: 30,
          Banshee: 20,
        },
        totalUnitsLost: 0,
        lostGames: 0,
      }),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable — narrowed above");
    expect(["built", "lost", "lost-per-game", "diversity"]).toContain(
      out.question.variant,
    );
  });

  test("variant rotation eventually visits every variant when data supports them all", async () => {
    const stats: ArcadeUnitStats = {
      scannedGames: 500,
      builtByUnit: {
        Marine: 800,
        Marauder: 400,
        Reaper: 200,
        SiegeTank: 100,
        Medivac: 60,
        Hellion: 40,
        Banshee: 30,
      },
      totalUnitsLost: 4_200,
      lostGames: 100,
    };
    const seen = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const out = await unitProfile.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: datasetWithStats(stats),
      });
      if (out.ok) seen.add(out.question.variant);
    }
    expect(seen.has("built")).toBe(true);
    expect(seen.has("lost")).toBe(true);
    expect(seen.has("lost-per-game")).toBe(true);
    expect(seen.has("diversity")).toBe(true);
  });

  test("score awards XP for the right answer and zero for the wrong one (built)", () => {
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

  test("score awards XP for the right answer and zero for the wrong one (lost-per-game)", () => {
    const q = {
      variant: "lost-per-game" as const,
      options: ["Under 10", "10 – 30", "30 – 75", "75+"] as const,
      truth: "30 – 75" as const,
      truthValue: 42,
      totalUnitsLost: 4_200,
      lostGames: 100,
    };
    expect(unitProfile.score(q, "30 – 75").outcome).toBe("correct");
    expect(unitProfile.score(q, "30 – 75").xp).toBeGreaterThan(0);
    expect(unitProfile.score(q, "Under 10").outcome).toBe("wrong");
    expect(unitProfile.score(q, "Under 10").xp).toBe(0);
  });

  test("score awards XP for the right answer and zero for the wrong one (diversity)", () => {
    const q = {
      variant: "diversity" as const,
      options: ["Under 6", "6 – 12", "12 – 20", "20+"] as const,
      truth: "6 – 12" as const,
      truthValue: 8,
      scannedGames: 200,
      topUnits: [{ name: "Marine", count: 500 }],
    };
    expect(unitProfile.score(q, "6 – 12").outcome).toBe("correct");
    expect(unitProfile.score(q, "6 – 12").xp).toBeGreaterThan(0);
    expect(unitProfile.score(q, "20+").outcome).toBe("wrong");
    expect(unitProfile.score(q, "20+").xp).toBe(0);
  });
});
