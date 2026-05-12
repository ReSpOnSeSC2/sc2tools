import { describe, expect, test } from "vitest";
import {
  activeStreakHunter,
  generateStreakHunter,
  groupByOpponent,
} from "../modes/quizzes/activeStreakHunter";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame, ArcadeOpponent } from "../types";

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

const g = (
  oppPulseId: string,
  result: "Win" | "Loss",
  i = 0,
): ArcadeGame => ({
  gameId: `${oppPulseId}-${i}`,
  date: new Date(2026, 0, 1 + i).toISOString(),
  result,
  oppPulseId,
});

/**
 * Build a streak-bearing opponent: `pid` plays `streak` consecutive
 * games of `dir` ("Loss" = opp won the run; "Win" = user won the run).
 * Used to bulk-fabricate the ≥20-opponent eligible pool the mode
 * requires before unlocking.
 */
function streakOpp(
  pid: string,
  dir: "Win" | "Loss",
  streak: number,
  startIdx: number,
): { games: ArcadeGame[]; opp: ArcadeOpponent } {
  const games = Array.from({ length: streak }, (_, i) =>
    g(pid, dir, startIdx + i),
  );
  const wins = dir === "Win" ? streak : 0;
  const losses = dir === "Loss" ? streak : 0;
  return {
    games,
    opp: {
      pulseId: pid,
      name: pid,
      wins,
      losses,
      games: streak,
      userWinRate: wins / streak,
      opponentWinRate: losses / streak,
      lastPlayed: null,
    },
  };
}

describe("groupByOpponent", () => {
  test("groups and sorts ascending by date", () => {
    const games = [
      g("opp-1", "Win", 5),
      g("opp-1", "Loss", 1),
      g("opp-2", "Win", 3),
    ];
    const out = groupByOpponent(games);
    expect(out.get("opp-1")?.map((x) => x.gameId)).toEqual(["opp-1-1", "opp-1-5"]);
    expect(out.get("opp-2")?.length).toBe(1);
  });
});

describe("Streak Hunter — eligibility gate", () => {
  test("ok=false on empty data", async () => {
    const result = await generateStreakHunter({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: baseDataset,
    });
    expect(result.ok).toBe(false);
  });

  test("ok=false when fewer than 20 opponents have a 3-game streak", async () => {
    // 10 opponents with 3-loss streaks (= opp 3-win streaks). Below
    // the 20-opponent gate.
    const games: ArcadeGame[] = [];
    const opponents: ArcadeOpponent[] = [];
    for (let i = 0; i < 10; i++) {
      const built = streakOpp(`p${i}`, "Loss", 3, i * 10);
      games.push(...built.games);
      opponents.push(built.opp);
    }
    const result = await generateStreakHunter({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: { ...baseDataset, games, opponents },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Need more streak data/i);
      // The reason text must include the actual counts so the user
      // knows how close they are.
      expect(result.reason).toMatch(/10 of 10/);
    }
  });

  test("ok=true once ≥20 opponents carry a 3-game streak", async () => {
    const games: ArcadeGame[] = [];
    const opponents: ArcadeOpponent[] = [];
    // 12 opp-W streaks + 12 user-W streaks → 24 streak-bearing
    // opponents, well over the gate.
    for (let i = 0; i < 12; i++) {
      const built = streakOpp(`loser${i}`, "Loss", 3, i * 10);
      games.push(...built.games);
      opponents.push(built.opp);
    }
    for (let i = 0; i < 12; i++) {
      const built = streakOpp(`winner${i}`, "Win", 3, 200 + i * 10);
      games.push(...built.games);
      opponents.push(built.opp);
    }
    const result = await generateStreakHunter({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: { ...baseDataset, games, opponents },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.question.candidates).toHaveLength(4);
      expect(result.question.variant === "their-longest-vs-you" || result.question.variant === "your-longest-vs-them").toBe(true);
    }
  });
});

describe("Streak Hunter — historical (not just active) streaks", () => {
  test("counts a 5-game L-streak that's been broken by recent wins", async () => {
    // Build 20 streak-bearing opponents for the gate, plus one
    // "ancient5" opponent with a 5-loss streak FOLLOWED by 4 wins.
    // The active streak is 0 (most recent decided game was a W),
    // but historical longestLoss is 5. The mode should still treat
    // ancient5 as a streak-bearing candidate.
    const games: ArcadeGame[] = [];
    const opponents: ArcadeOpponent[] = [];
    for (let i = 0; i < 20; i++) {
      const built = streakOpp(`bg${i}`, "Loss", 3, i * 10);
      games.push(...built.games);
      opponents.push(built.opp);
    }
    // Ancient 5-L streak with recent recovery.
    for (let i = 0; i < 5; i++) games.push(g("ancient5", "Loss", 500 + i));
    for (let i = 0; i < 4; i++) games.push(g("ancient5", "Win", 510 + i));
    opponents.push({
      pulseId: "ancient5",
      name: "Ancient5",
      wins: 4,
      losses: 5,
      games: 9,
      userWinRate: 4 / 9,
      opponentWinRate: 5 / 9,
      lastPlayed: null,
    });
    // Walk many seeds until we land on a "their-longest-vs-you" round
    // that includes ancient5 — proves the historical streak is picked
    // up even though it's no longer active.
    let observedHistorical = false;
    for (let seed = 1; seed <= 80 && !observedHistorical; seed++) {
      const result = await generateStreakHunter({
        rng: mulberry32(seed),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: { ...baseDataset, games, opponents },
      });
      if (!result.ok) continue;
      if (result.question.variant !== "their-longest-vs-you") continue;
      const a5 = result.question.candidates.find((c) => c.pulseId === "ancient5");
      if (a5) {
        expect(a5.longestLoss).toBe(5);
        observedHistorical = true;
      }
    }
    expect(observedHistorical).toBe(true);
  });
});

describe("Streak Hunter — sample variety", () => {
  test("the correct answer is not always the same opponent", async () => {
    // 22 opponents, each with a 3-loss streak. With random sampling
    // and no global-leader privileging, the correct answer should
    // rotate across seeds.
    const games: ArcadeGame[] = [];
    const opponents: ArcadeOpponent[] = [];
    for (let i = 0; i < 22; i++) {
      const built = streakOpp(`p${i}`, "Loss", 3, i * 10);
      games.push(...built.games);
      opponents.push(built.opp);
    }
    const correctIds = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const result = await generateStreakHunter({
        rng: mulberry32(seed),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: { ...baseDataset, games, opponents },
      });
      if (!result.ok) continue;
      correctIds.add(
        result.question.candidates[result.question.correctIndex].pulseId,
      );
    }
    // 22 candidates all tied at 3-L. Score accepts any of them per
    // round; correctIndex points at the FIRST tied candidate in the
    // sample. With 4 random samples per seed across 40 seeds we
    // should see at least 10 distinct first-tied opponents — proves
    // the same person isn't pinned as the answer every round.
    expect(correctIds.size).toBeGreaterThanOrEqual(10);
  });
});

describe("Streak Hunter — score", () => {
  test("any candidate tied at max counts as correct", () => {
    const q = {
      variant: "their-longest-vs-you" as const,
      candidates: [
        { pulseId: "a", name: "A", longestWin: 0, longestLoss: 5, games: 6 },
        { pulseId: "b", name: "B", longestWin: 0, longestLoss: 5, games: 6 },
        { pulseId: "c", name: "C", longestWin: 0, longestLoss: 3, games: 4 },
        { pulseId: "d", name: "D", longestWin: 0, longestLoss: 2, games: 3 },
      ],
      correctIndex: 0,
    } as Parameters<typeof activeStreakHunter.score>[0];
    expect(activeStreakHunter.score(q, 0).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 1).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 2).outcome).toBe("wrong");
    expect(activeStreakHunter.score(q, 3).outcome).toBe("wrong");
  });

  test("uses the variant-specific metric (W-streak when 'your-longest-vs-them')", () => {
    const q = {
      variant: "your-longest-vs-them" as const,
      candidates: [
        // a has longer L-streak; b has longer W-streak. With the
        // "your" variant, b wins.
        { pulseId: "a", name: "A", longestWin: 2, longestLoss: 7, games: 9 },
        { pulseId: "b", name: "B", longestWin: 6, longestLoss: 1, games: 7 },
      ],
      correctIndex: 1,
    } as Parameters<typeof activeStreakHunter.score>[0];
    expect(activeStreakHunter.score(q, 1).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 0).outcome).toBe("wrong");
  });
});
