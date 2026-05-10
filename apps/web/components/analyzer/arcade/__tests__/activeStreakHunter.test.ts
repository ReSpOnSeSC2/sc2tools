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
    // Four opponents, leader has a 3-game active win streak.
    const games: ArcadeGame[] = [
      ...[0, 1, 2].map((i) => g("hot", "Win", i + 10)),
      g("cold", "Loss", 5),
      g("cold", "Win", 6),
      g("middle", "Win", 7),
      g("middle", "Loss", 8),
      g("middle", "Win", 9),
      g("low", "Win", 1),
      g("low", "Loss", 2),
    ];
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games,
      opponents: [
        { pulseId: "hot", name: "Hot", wins: 3, losses: 0, games: 3, userWinRate: 1, opponentWinRate: 0, lastPlayed: null },
        { pulseId: "cold", name: "Cold", wins: 1, losses: 1, games: 2, userWinRate: 0.5, opponentWinRate: 0.5, lastPlayed: null },
        { pulseId: "middle", name: "Middle", wins: 2, losses: 1, games: 3, userWinRate: 0.67, opponentWinRate: 0.33, lastPlayed: null },
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
  test("correct only when index matches", () => {
    const q = { candidates: [], correctIndex: 2 } as Parameters<typeof activeStreakHunter.score>[0];
    expect(activeStreakHunter.score(q, 2).outcome).toBe("correct");
    expect(activeStreakHunter.score(q, 0).outcome).toBe("wrong");
  });
});
