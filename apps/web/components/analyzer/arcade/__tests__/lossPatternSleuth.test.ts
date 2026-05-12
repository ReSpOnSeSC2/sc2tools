import { describe, expect, test } from "vitest";
import {
  lossPatternSleuth,
  pickRaceWithLosses,
} from "../modes/quizzes/lossPatternSleuth";
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

/**
 * Build a chronological sequence of (lossVsP → nextBuild) pairs with
 * fully labelled next-builds, so the per-build "next after losing to P"
 * histogram comes out exactly as supplied.
 *
 * `pairs` is an array of build names — one entry per L→W pair to emit.
 * Each call emits two games: a loss vs P with placeholder build "Misc",
 * then a win with the supplied next-build name.
 */
function buildPairsVsP(pairs: string[]): ArcadeGame[] {
  const games: ArcadeGame[] = [];
  let dayCursor = 0;
  for (const nextBuild of pairs) {
    games.push({
      gameId: `loss-${dayCursor}`,
      date: new Date(2026, 0, 1 + dayCursor++).toISOString(),
      result: "Loss",
      oppRace: "P",
      myBuild: "Misc",
      duration: 600,
    });
    games.push({
      gameId: `next-${dayCursor}`,
      date: new Date(2026, 0, 1 + dayCursor++).toISOString(),
      result: "Win",
      oppRace: "P",
      myBuild: nextBuild,
      duration: 600,
    });
  }
  return games;
}

describe("Loss Pattern Sleuth — randomized correct answer", () => {
  const matchups = [
    { name: "vs P", oppRace: "P" as const, wins: 0, losses: 20, total: 20, winRate: 0 },
  ];

  test("correct answer varies across rngs — not pinned to the modal next-build", async () => {
    // Distinct post-loss-vs-P counts so several builds can be valid
    // correct answers. Counts: A=6, B=5, C=4, D=3, E=2, F=1.
    const pairs = [
      ...Array(6).fill("A"),
      ...Array(5).fill("B"),
      ...Array(4).fill("C"),
      ...Array(3).fill("D"),
      ...Array(2).fill("E"),
      ...Array(1).fill("F"),
    ];
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games: buildPairsVsP(pairs),
      matchups,
    };
    const corrects = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const r = await lossPatternSleuth.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      if (r.ok) {
        corrects.add(r.question.candidates[r.question.correctIndex].build);
      }
    }
    // A/B/C all dominate ≥3 strictly-lower-count peers and are
    // therefore valid correct answers. D dominates only E and F, so
    // it must NOT appear as the correct answer.
    expect(corrects.has("A")).toBe(true);
    expect(corrects.has("B")).toBe(true);
    expect(corrects.has("C")).toBe(true);
    expect(corrects.has("D")).toBe(false);
  });

  test("displayed correct candidate strictly beats every distractor on count", async () => {
    const pairs = [
      ...Array(6).fill("A"),
      ...Array(5).fill("B"),
      ...Array(4).fill("C"),
      ...Array(3).fill("D"),
      ...Array(2).fill("E"),
    ];
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games: buildPairsVsP(pairs),
      matchups,
    };
    for (let seed = 1; seed <= 40; seed++) {
      const r = await lossPatternSleuth.generate({
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
        expect(r.question.candidates[j].count).toBeLessThan(correct.count);
      }
    }
  });
});
