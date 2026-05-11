import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { dailySeed, mulberry32 } from "../ArcadeEngine";
import { GAMES, QUIZZES } from "../modes";
import { activeStreakHunter } from "../modes/quizzes/activeStreakHunter";
import {
  __pickFromEligible,
  type DailyPicks,
  useEligibleDailyPicks,
} from "../hooks/useEligibleDailyPicks";
import type {
  ArcadeBuild,
  ArcadeDataset,
  ArcadeGame,
  ArcadeOpponent,
} from "../types";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: false,
    getToken: async () => null,
    userId: "test-user",
  }),
}));

const emptyDataset: ArcadeDataset = {
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

const game = (oppPulseId: string, result: "Win" | "Loss", i: number, build = "Reaper FE"): ArcadeGame => ({
  gameId: `${oppPulseId}-${i}`,
  date: new Date(2026, 0, 1 + i).toISOString(),
  result,
  oppPulseId,
  myBuild: build,
  duration: 600 + i * 5,
  myRace: "T",
  oppRace: "Z",
  map: "Goldenaura LE",
});

function opp(
  pid: string,
  name: string,
  wins: number,
  losses: number,
): ArcadeOpponent {
  const total = wins + losses;
  const userWr = total > 0 ? wins / total : 0;
  return {
    pulseId: pid,
    pulseCharacterId: null,
    name,
    displayName: null,
    wins,
    losses,
    games: total,
    userWinRate: userWr,
    opponentWinRate: total > 0 ? 1 - userWr : 0,
    lastPlayed: new Date(2026, 0, wins + losses).toISOString(),
  };
}

function build(name: string, wins: number, losses: number): ArcadeBuild {
  const total = wins + losses;
  return {
    name,
    total,
    wins,
    losses,
    winRate: total > 0 ? wins / total : 0,
    race: "T",
    lastPlayed: new Date(2026, 0, 10).toISOString(),
  };
}

/**
 * Healthy fixture: enough opponents and games that most quizzes
 * become eligible. Active-streak-hunter requires ≥4 opponents WITH
 * at least one non-zero current active win streak — we wire one
 * opponent ("hot") onto a clean 3-win streak.
 */
function healthyDataset(): ArcadeDataset {
  const games: ArcadeGame[] = [
    // "hot": 3-win active streak, most recent.
    game("hot", "Win", 30),
    game("hot", "Win", 31),
    game("hot", "Win", 32),
    // "cold": ended on a loss.
    game("cold", "Win", 10),
    game("cold", "Loss", 11),
    // "middle": mixed.
    game("middle", "Win", 12),
    game("middle", "Loss", 13),
    game("middle", "Win", 14),
    // "low": ended on a loss.
    game("low", "Win", 5),
    game("low", "Loss", 6),
    // bulk for builds list / matchups
    ...Array.from({ length: 12 }, (_, i) => game("bulk", "Win", 40 + i, "Reaper FE")),
    ...Array.from({ length: 10 }, (_, i) => game("bulk", "Loss", 60 + i, "Cyclone Push")),
  ];
  return {
    ...emptyDataset,
    games,
    opponents: [
      opp("hot", "Hot", 3, 0),
      opp("cold", "Cold", 4, 4),
      opp("middle", "Middle", 5, 3),
      opp("low", "Low", 3, 3),
      opp("bulk", "Bulk", 12, 10),
    ],
    builds: [build("Reaper FE", 12, 4), build("Cyclone Push", 6, 10), build("BC Rush", 3, 1)],
    matchups: [
      { name: "vs P", oppRace: "P", wins: 4, losses: 3, total: 7, winRate: 0.57 },
      { name: "vs T", oppRace: "T", wins: 5, losses: 2, total: 7, winRate: 0.71 },
      { name: "vs Z", oppRace: "Z", wins: 6, losses: 5, total: 11, winRate: 0.55 },
    ],
    maps: [
      { map: "Goldenaura LE", wins: 8, losses: 5, total: 13, winRate: 0.62 },
      { map: "Hard Lead LE", wins: 4, losses: 3, total: 7, winRate: 0.57 },
    ],
  };
}

let captured: DailyPicks | null = null;

function Probe({ dataset }: { dataset: ArcadeDataset | null }) {
  const picks = useEligibleDailyPicks(dataset);
  useEffect(() => {
    captured = picks;
  });
  return null;
}

async function flushMicrotasks() {
  // Two ticks: one for Promise.all to settle, one for setState to flush.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useEligibleDailyPicks", () => {
  beforeEach(() => {
    captured = null;
  });
  afterEach(() => {
    cleanup();
  });

  test("empty dataset → no eligible modes, no pick, probing settles to false", async () => {
    render(<Probe dataset={emptyDataset} />);
    await flushMicrotasks();
    expect(captured).toBeTruthy();
    expect(captured!.quiz).toBeNull();
    expect(captured!.game).toBeNull();
    expect(captured!.eligibleQuizIds).toEqual([]);
    expect(captured!.eligibleGameIds).toEqual([]);
    expect(captured!.probing).toBe(false);
  });

  test("healthy dataset → picks come from eligible subsets", async () => {
    render(<Probe dataset={healthyDataset()} />);
    await flushMicrotasks();
    expect(captured!.probing).toBe(false);
    expect(captured!.eligibleQuizIds.length).toBeGreaterThan(0);
    if (captured!.quiz) {
      expect(captured!.eligibleQuizIds).toContain(captured!.quiz.id);
    }
    if (captured!.game) {
      expect(captured!.eligibleGameIds).toContain(captured!.game.id);
    }
  });

  test("deterministic across renders for the same (user, day, dataset)", async () => {
    const data = healthyDataset();
    render(<Probe dataset={data} />);
    await flushMicrotasks();
    const first = { quiz: captured!.quiz?.id, game: captured!.game?.id };
    cleanup();
    captured = null;
    render(<Probe dataset={data} />);
    await flushMicrotasks();
    const second = { quiz: captured!.quiz?.id, game: captured!.game?.id };
    expect(second.quiz).toBe(first.quiz);
    expect(second.game).toBe(first.game);
  });

  test("catch-and-warn: a probe that throws is excluded, hook still resolves", async () => {
    const originalGen = activeStreakHunter.generate;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      (activeStreakHunter as unknown as { generate: () => Promise<never> }).generate =
        async () => {
          throw new Error("boom");
        };
      render(<Probe dataset={healthyDataset()} />);
      await flushMicrotasks();
      expect(captured!.eligibleQuizIds).not.toContain(activeStreakHunter.id);
      expect(captured!.probing).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      (activeStreakHunter as unknown as { generate: typeof originalGen }).generate =
        originalGen;
      warn.mockRestore();
    }
  });
});

/* ──────────── pure helper: __pickFromEligible ──────────── */

describe("__pickFromEligible", () => {
  test("returns null when no catalog entries are eligible", () => {
    const rng = mulberry32(dailySeed("test-user", "2026-05-10"));
    const { mode, skips } = __pickFromEligible(QUIZZES, [], rng);
    expect(mode).toBeNull();
    expect(skips).toBe(0);
  });

  test("rotates past the seed-indexed slot when it's ineligible", () => {
    // Force every quiz to be eligible EXCEPT whichever the RNG would
    // pick first. The pick must then advance to a different mode and
    // report quizSkips >= 1.
    const rng1 = mulberry32(dailySeed("test-user", "2026-05-10"));
    const seedStart = Math.floor(rng1() * QUIZZES.length);
    const blocked = QUIZZES[seedStart].id;
    const eligibleIds = QUIZZES.map((m) => m.id).filter((id) => id !== blocked);
    // Use a fresh RNG with the same seed so the picker sees the same first draw.
    const pickerRng = mulberry32(dailySeed("test-user", "2026-05-10"));
    const { mode, skips } = __pickFromEligible(QUIZZES, eligibleIds, pickerRng);
    expect(mode).not.toBeNull();
    expect(mode!.id).not.toBe(blocked);
    expect(skips).toBeGreaterThanOrEqual(1);
  });

  test("picks within the games catalog when given GAMES + their ids", () => {
    const rng = mulberry32(dailySeed("test-user", "2026-05-10"));
    const allIds = GAMES.map((m) => m.id);
    const { mode } = __pickFromEligible(GAMES, allIds, rng);
    expect(mode).not.toBeNull();
    expect(allIds).toContain(mode!.id);
  });
});
