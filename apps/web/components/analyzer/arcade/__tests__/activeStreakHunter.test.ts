import { describe, expect, test } from "vitest";
import {
  activeStreakHunter,
  generateActiveStreakHunter,
  groupByOpponent,
} from "../modes/quizzes/activeStreakHunter";
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

describe("Active Streak Hunter generate", () => {
  test("ok=false on thin data (no synth)", async () => {
    const result = await generateActiveStreakHunter({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: baseDataset,
    });
    expect(result.ok).toBe(false);
  });
  test("the leader has the longest active streak in the candidates", async () => {
    // Four opponents from the OPPONENT'S point of view (= user losses).
    // "hot" has won the user's last 3 games in a row — the longest
    // active win streak against the user, which is what the mode now
    // asks about.
    const games: ArcadeGame[] = [
      ...[0, 1, 2].map((i) => g("hot", "Loss", i + 10)),
      g("cold", "Win", 5),
      g("cold", "Loss", 6),
      g("middle", "Loss", 7),
      g("middle", "Win", 8),
      g("middle", "Loss", 9),
      g("low", "Loss", 1),
      g("low", "Win", 2),
    ];
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games,
      opponents: [
        { pulseId: "hot", name: "Hot", wins: 0, losses: 3, games: 3, userWinRate: 0, opponentWinRate: 1, lastPlayed: null },
        { pulseId: "cold", name: "Cold", wins: 1, losses: 1, games: 2, userWinRate: 0.5, opponentWinRate: 0.5, lastPlayed: null },
        { pulseId: "middle", name: "Middle", wins: 1, losses: 2, games: 3, userWinRate: 0.33, opponentWinRate: 0.67, lastPlayed: null },
        { pulseId: "low", name: "Low", wins: 1, losses: 1, games: 2, userWinRate: 0.5, opponentWinRate: 0.5, lastPlayed: null },
      ],
    };
    const result = await generateActiveStreakHunter({
      rng: mulberry32(7),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const leader = result.question.candidates[result.question.correctIndex];
      expect(leader.pulseId).toBe("hot");
      expect(leader.activeStreak).toBe(3);
    }
  });

  test("sample varies across seeds — global leader is not always in the four", async () => {
    // 8 opponents, each with one loss → each has activeLossStreak=1.
    // Plus one opponent ("global") with three losses → streak=3.
    // Old logic force-included "global" every round, so the correct
    // answer was always "global". New logic samples four randomly,
    // so most rounds shouldn't include "global" at all.
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 8; i++) {
      games.push(g(`opp${i}`, "Loss", i + 1));
    }
    games.push(g("global", "Loss", 20));
    games.push(g("global", "Loss", 21));
    games.push(g("global", "Loss", 22));
    const opponents = [
      ...Array.from({ length: 8 }, (_, i) => ({
        pulseId: `opp${i}`,
        name: `Opp${i}`,
        wins: 0,
        losses: 1,
        games: 1,
        userWinRate: 0,
        opponentWinRate: 1,
        lastPlayed: null,
      })),
      {
        pulseId: "global",
        name: "Global",
        wins: 0,
        losses: 3,
        games: 3,
        userWinRate: 0,
        opponentWinRate: 1,
        lastPlayed: null,
      },
    ];
    const dataset: ArcadeDataset = { ...baseDataset, games, opponents };
    const correctIds = new Set<string>();
    let globalInSample = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const result = await generateActiveStreakHunter({
        rng: mulberry32(seed),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: dataset,
      });
      if (!result.ok) continue;
      correctIds.add(
        result.question.candidates[result.question.correctIndex].pulseId,
      );
      if (result.question.candidates.some((c) => c.pulseId === "global")) {
        globalInSample++;
      }
    }
    // At least three distinct opponents have been the answer across
    // the 30 seeds — proving variety, not the same person every time.
    expect(correctIds.size).toBeGreaterThanOrEqual(3);
    // And "global" wasn't in the sample for every single round.
    expect(globalInSample).toBeLessThan(30);
  });

  test("includes 1-game opponents so a sparse history still has variety", async () => {
    // Only one opponent ("opp0") has multiple games. Under the old
    // ≥2-game floor, the eligible pool would have been just opp0,
    // failing the ≥4-eligible gate. Under the new ≥1-game floor the
    // 1-game opponents qualify too and we have enough to build a
    // round.
    const games: ArcadeGame[] = [
      g("opp0", "Loss", 1),
      g("opp0", "Loss", 2),
      g("solo1", "Loss", 3),
      g("solo2", "Win", 4),
      g("solo3", "Loss", 5),
    ];
    const opp1Game = (pid: string, name: string, result: "Win" | "Loss") => ({
      pulseId: pid,
      name,
      wins: result === "Win" ? 1 : 0,
      losses: result === "Loss" ? 1 : 0,
      games: 1,
      userWinRate: result === "Win" ? 1 : 0,
      opponentWinRate: result === "Win" ? 0 : 1,
      lastPlayed: null,
    });
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games,
      opponents: [
        { pulseId: "opp0", name: "Opp0", wins: 0, losses: 2, games: 2, userWinRate: 0, opponentWinRate: 1, lastPlayed: null },
        opp1Game("solo1", "Solo1", "Loss"),
        opp1Game("solo2", "Solo2", "Win"),
        opp1Game("solo3", "Solo3", "Loss"),
      ],
    };
    const result = await generateActiveStreakHunter({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(result.ok).toBe(true);
  });
});

describe("Active Streak Hunter score", () => {
  const cand = (pulseId: string, activeStreak: number) => ({
    pulseId,
    name: pulseId,
    activeStreak,
    games: Math.max(activeStreak, 1),
  });

  test("correct when the picked candidate has the max streak", () => {
    const q = {
      candidates: [cand("a", 1), cand("b", 5), cand("c", 2), cand("d", 0)],
      correctIndex: 1,
    } as Parameters<typeof activeStreakHunter.score>[0];
    expect(activeStreakHunter.score(q, 1).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 0).outcome).toBe("wrong");
  });

  test("ties are all correct — picking any leader counts", () => {
    // Three rivals on a 3-game active streak, one on 1. The user
    // can't disambiguate, so any of the three tied indexes scores.
    const q = {
      candidates: [cand("a", 3), cand("b", 3), cand("c", 3), cand("d", 1)],
      correctIndex: 0,
    } as Parameters<typeof activeStreakHunter.score>[0];
    expect(activeStreakHunter.score(q, 0).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 1).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 2).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 3).outcome).toBe("wrong");
  });
});
