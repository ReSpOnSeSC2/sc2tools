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
