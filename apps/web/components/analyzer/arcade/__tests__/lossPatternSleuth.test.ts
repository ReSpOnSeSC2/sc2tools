import { describe, expect, test } from "vitest";
import {
  __test as lpsTest,
  lossPatternSleuth,
  pickRaceWithLosses,
} from "../modes/quizzes/lossPatternSleuth";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame } from "../types";

const {
  buildNextBuildQuestion,
  buildBounceBackQuestion,
  buildWorstVsRaceQuestion,
  bucketForBounceBack,
  chronoSort,
  MIN_NEXT_GAMES_FOR_BOUNCE_BACK,
} = lpsTest;

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

describe("Loss Pattern Sleuth — buildNextBuildQuestion", () => {
  test("correct answer varies across rngs — not pinned to the modal next-build", () => {
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
    const games = chronoSort(buildPairsVsP(pairs));
    const truths = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const q = buildNextBuildQuestion(games, "P", mulberry32(seed));
      if (q) truths.add(q.truth);
    }
    // A/B/C all dominate ≥3 strictly-lower-count peers and are
    // therefore valid correct answers. D dominates only E and F, so
    // it must NOT appear as the correct answer.
    expect(truths.has("A")).toBe(true);
    expect(truths.has("B")).toBe(true);
    expect(truths.has("C")).toBe(true);
    expect(truths.has("D")).toBe(false);
  });

  test("displayed correct candidate strictly beats every distractor on count", () => {
    const pairs = [
      ...Array(6).fill("A"),
      ...Array(5).fill("B"),
      ...Array(4).fill("C"),
      ...Array(3).fill("D"),
      ...Array(2).fill("E"),
    ];
    const games = chronoSort(buildPairsVsP(pairs));
    for (let seed = 1; seed <= 40; seed++) {
      const q = buildNextBuildQuestion(games, "P", mulberry32(seed));
      expect(q).not.toBeNull();
      if (!q) continue;
      const truthCount = q.countsByOption[q.truth];
      for (const o of q.options) {
        if (o === q.truth) continue;
        expect(q.countsByOption[o]).toBeLessThan(truthCount);
      }
    }
  });

  test("returns null when fewer than 4 distinct next-builds exist", () => {
    const games = chronoSort(buildPairsVsP(["A", "A", "B", "B", "C", "C"]));
    expect(buildNextBuildQuestion(games, "P", mulberry32(1))).toBeNull();
  });

  test("ignores losses against other races when bucketing next-builds", () => {
    // Plenty of loss-vs-P → next-build pairs for race=P, followed by a
    // strictly-later Loss vs T → Win vs Z (FromT). The FromT next-build
    // belongs to the "vs T" loss, not the "vs P" loss-stream, so it
    // must not appear in race=P's histogram.
    const games: ArcadeGame[] = [
      ...buildPairsVsP([
        ...Array(6).fill("A"),
        ...Array(5).fill("B"),
        ...Array(4).fill("C"),
        ...Array(3).fill("D"),
      ]),
      {
        gameId: "extra-l-t",
        date: new Date(2026, 6, 1).toISOString(),
        result: "Loss",
        oppRace: "T",
        myBuild: "Misc",
        duration: 600,
      },
      {
        gameId: "extra-w-z",
        date: new Date(2026, 6, 2).toISOString(),
        result: "Win",
        oppRace: "Z",
        myBuild: "FromT",
        duration: 600,
      },
    ];
    const chrono = chronoSort(games);
    const q = buildNextBuildQuestion(chrono, "P", mulberry32(1));
    expect(q).not.toBeNull();
    expect(q!.options).not.toContain("FromT");
  });
});

describe("Loss Pattern Sleuth — bucketForBounceBack", () => {
  test("bucket boundaries are stable around the round percentages", () => {
    expect(bucketForBounceBack(0)).toBe("Under 30%");
    expect(bucketForBounceBack(0.2999)).toBe("Under 30%");
    expect(bucketForBounceBack(0.3)).toBe("30 – 50%");
    expect(bucketForBounceBack(0.4999)).toBe("30 – 50%");
    expect(bucketForBounceBack(0.5)).toBe("50 – 65%");
    expect(bucketForBounceBack(0.6499)).toBe("50 – 65%");
    expect(bucketForBounceBack(0.65)).toBe("65%+");
    expect(bucketForBounceBack(1)).toBe("65%+");
  });

  test("NaN / negative inputs land in the lowest bucket without throwing", () => {
    expect(bucketForBounceBack(Number.NaN)).toBe("Under 30%");
    expect(bucketForBounceBack(-0.1)).toBe("Under 30%");
  });
});

describe("Loss Pattern Sleuth — buildBounceBackQuestion", () => {
  test("returns a populated question when ≥10 decided post-loss-vs-race games exist", () => {
    // 10 L→W pairs vs P (100% bounce-back rate).
    const games = chronoSort(buildPairsVsP(Array(10).fill("A")));
    const q = buildBounceBackQuestion(games, "P");
    expect(q).not.toBeNull();
    expect(q!.variant).toBe("bounce-back");
    expect(q!.sample).toBe(10);
    expect(q!.wins).toBe(10);
    expect(q!.losses).toBe(0);
    expect(q!.truth).toBe("65%+");
    expect(q!.truthValue).toBe(1);
  });

  test("buckets a mixed bounce-back rate correctly", () => {
    // Construct exactly 10 decided post-loss-vs-P samples: 6 wins + 4
    // losses → 60% → "50 – 65%". The triplet form for the loss-samples
    // (Loss vs P → Loss vs T → Win vs T) puts a non-P game in between
    // consecutive Loss-vs-P entries so each one contributes exactly
    // one sample without daisy-chaining into the next loss.
    const games: ArcadeGame[] = [];
    let cursor = 0;
    const push = (
      result: "Win" | "Loss",
      oppRace: "P" | "T" | "Z",
      myBuild = "X",
    ) => {
      games.push({
        gameId: `g-${cursor}`,
        date: new Date(2026, 0, 1 + cursor++).toISOString(),
        result,
        oppRace,
        myBuild,
        duration: 600,
      });
    };
    for (let i = 0; i < 6; i++) {
      push("Loss", "P");
      push("Win", "P");
    }
    for (let i = 0; i < 4; i++) {
      push("Loss", "P");
      push("Loss", "T");
      push("Win", "T");
    }
    const chrono = chronoSort(games);
    const q = buildBounceBackQuestion(chrono, "P");
    expect(q).not.toBeNull();
    expect(q!.sample).toBe(10);
    expect(q!.wins).toBe(6);
    expect(q!.losses).toBe(4);
    expect(q!.truth).toBe("50 – 65%");
    expect(q!.truthValue).toBeCloseTo(0.6, 6);
  });

  test("rejects when fewer than the minimum next-games are decided", () => {
    const games = chronoSort(
      buildPairsVsP(Array(MIN_NEXT_GAMES_FOR_BOUNCE_BACK - 1).fill("A")),
    );
    expect(buildBounceBackQuestion(games, "P")).toBeNull();
  });

  test("ignores trailing losses that have no next-game", () => {
    const games: ArcadeGame[] = [
      {
        gameId: "trail-loss",
        date: new Date(2026, 0, 1).toISOString(),
        result: "Loss",
        oppRace: "P",
        myBuild: "Misc",
        duration: 600,
      },
    ];
    expect(buildBounceBackQuestion(games, "P")).toBeNull();
  });

  test("ignores losses against other races", () => {
    // 10 L→W pairs vs Z; race=P should return null because the post-
    // loss-vs-P sample is empty.
    const zGames: ArcadeGame[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      zGames.push({
        gameId: `loss-${cursor}`,
        date: new Date(2026, 0, 1 + cursor++).toISOString(),
        result: "Loss",
        oppRace: "Z",
        myBuild: "Misc",
        duration: 600,
      });
      zGames.push({
        gameId: `next-${cursor}`,
        date: new Date(2026, 0, 1 + cursor++).toISOString(),
        result: "Win",
        oppRace: "Z",
        myBuild: "A",
        duration: 600,
      });
    }
    const chrono = chronoSort(zGames);
    expect(buildBounceBackQuestion(chrono, "P")).toBeNull();
    expect(buildBounceBackQuestion(chrono, "Z")).not.toBeNull();
  });
});

describe("Loss Pattern Sleuth — buildWorstVsRaceQuestion", () => {
  test("picks the most-losing build as the correct answer", () => {
    // Counts of losses vs P by build: A=10, B=6, C=4, D=2, E=1.
    const games: ArcadeGame[] = [];
    let cursor = 0;
    const pushLossesVsP = (build: string, n: number) => {
      for (let i = 0; i < n; i++) {
        games.push({
          gameId: `l-${cursor}`,
          date: new Date(2026, 0, 1 + cursor++).toISOString(),
          result: "Loss",
          oppRace: "P",
          myBuild: build,
          duration: 600,
        });
      }
    };
    pushLossesVsP("A", 10);
    pushLossesVsP("B", 6);
    pushLossesVsP("C", 4);
    pushLossesVsP("D", 2);
    pushLossesVsP("E", 1);

    const truths = new Set<string>();
    for (let seed = 1; seed <= 80; seed++) {
      const q = buildWorstVsRaceQuestion(games, "P", mulberry32(seed));
      expect(q).not.toBeNull();
      if (!q) continue;
      const truthLosses = q.lossesByOption[q.truth];
      for (const o of q.options) {
        if (o === q.truth) continue;
        expect(q.lossesByOption[o]).toBeLessThan(truthLosses);
      }
      truths.add(q.truth);
    }
    // A/B can both be valid correct answers (each has ≥3 strictly-
    // worse peers). C has only D & E strictly below it so must NOT
    // surface as the correct answer.
    expect(truths.has("A")).toBe(true);
    expect(truths.has("C")).toBe(false);
  });

  test("ignores wins, including big wins, when ranking by loss count", () => {
    const games: ArcadeGame[] = [];
    let cursor = 0;
    const push = (result: "Win" | "Loss", build: string) => {
      games.push({
        gameId: `g-${cursor}`,
        date: new Date(2026, 0, 1 + cursor++).toISOString(),
        result,
        oppRace: "P",
        myBuild: build,
        duration: 600,
      });
    };
    // Build A has 0 losses but 100 wins; should still be excluded from
    // the loss-ranked slate.
    for (let i = 0; i < 100; i++) push("Win", "A");
    // Builds B/C/D/E each have distinct loss counts vs P.
    for (let i = 0; i < 8; i++) push("Loss", "B");
    for (let i = 0; i < 6; i++) push("Loss", "C");
    for (let i = 0; i < 4; i++) push("Loss", "D");
    for (let i = 0; i < 2; i++) push("Loss", "E");

    const q = buildWorstVsRaceQuestion(games, "P", mulberry32(7));
    expect(q).not.toBeNull();
    expect(q!.options).not.toContain("A");
  });

  test("returns null when fewer than 4 distinct losing builds exist", () => {
    const games: ArcadeGame[] = [
      {
        gameId: "1",
        date: new Date(2026, 0, 1).toISOString(),
        result: "Loss",
        oppRace: "P",
        myBuild: "A",
        duration: 600,
      },
    ];
    expect(buildWorstVsRaceQuestion(games, "P", mulberry32(1))).toBeNull();
  });
});

describe("Loss Pattern Sleuth — generate (variant rotation)", () => {
  test("rolls a question for every variant when data supports them all", async () => {
    // Construct a dataset rich enough that all three variants gate-pass:
    //   - many distinct next-builds (next-build variant ok)
    //   - many losses vs P with distinct myBuild values (worst-vs-race ok)
    //   - ≥10 decided next-game samples after losing to P (bounce-back ok)
    const games: ArcadeGame[] = [];
    let cursor = 0;
    const push = (
      result: "Win" | "Loss",
      oppRace: "P" | "T" | "Z",
      myBuild: string,
    ) => {
      games.push({
        gameId: `g-${cursor}`,
        date: new Date(2026, 0, 1 + cursor++).toISOString(),
        result,
        oppRace,
        myBuild,
        duration: 600,
      });
    };
    // 6 "L vs P (build X) → W (build Y)" pairs for each of 4 distinct
    // losing builds + 4 distinct next-builds. That feeds both the
    // next-build histogram and the worst-vs-race histogram with
    // strictly-different counts, AND yields >10 decided next-games.
    const losingBuilds = ["LossA", "LossB", "LossC", "LossD"];
    const nextBuilds = ["NextA", "NextB", "NextC", "NextD"];
    const counts = [9, 7, 5, 3]; // strictly decreasing
    for (let i = 0; i < losingBuilds.length; i++) {
      for (let r = 0; r < counts[i]; r++) {
        push("Loss", "P", losingBuilds[i]);
        push("Win", "P", nextBuilds[i]);
      }
    }
    const matchups = [
      {
        name: "vs P",
        oppRace: "P" as const,
        wins: 0,
        losses: 24,
        total: 48,
        winRate: 0,
      },
    ];
    const dataset: ArcadeDataset = { ...baseDataset, games, matchups };

    const variants = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const r = await lossPatternSleuth.generate({
        rng: mulberry32(seed),
        daySeed: `seed-${seed}`,
        tz: "UTC",
        data: dataset,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      variants.add(r.question.variant);
    }
    expect(variants.has("next-build")).toBe(true);
    expect(variants.has("bounce-back")).toBe(true);
    expect(variants.has("worst-vs-race")).toBe(true);
  });

  test("score awards XP for the right answer and zero for the wrong one (bounce-back)", () => {
    const q = {
      variant: "bounce-back" as const,
      raceLetter: "P" as const,
      options: ["Under 30%", "30 – 50%", "50 – 65%", "65%+"] as const,
      truth: "50 – 65%" as const,
      truthValue: 0.6,
      sample: 10,
      wins: 6,
      losses: 4,
    };
    expect(lossPatternSleuth.score(q, "50 – 65%").outcome).toBe("correct");
    expect(lossPatternSleuth.score(q, "50 – 65%").xp).toBeGreaterThan(0);
    expect(lossPatternSleuth.score(q, "Under 30%").outcome).toBe("wrong");
    expect(lossPatternSleuth.score(q, "Under 30%").xp).toBe(0);
  });

  test("score awards XP for the right answer and zero for the wrong one (worst-vs-race)", () => {
    const q = {
      variant: "worst-vs-race" as const,
      raceLetter: "P" as const,
      options: ["A", "B", "C", "D"],
      truth: "A",
      lossesByOption: { A: 10, B: 6, C: 4, D: 2 },
    };
    expect(lossPatternSleuth.score(q, "A").outcome).toBe("correct");
    expect(lossPatternSleuth.score(q, "A").xp).toBeGreaterThan(0);
    expect(lossPatternSleuth.score(q, "B").outcome).toBe("wrong");
    expect(lossPatternSleuth.score(q, "B").xp).toBe(0);
  });
});
