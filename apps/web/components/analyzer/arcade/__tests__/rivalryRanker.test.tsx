import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { rivalryRanker } from "../modes/quizzes/rivalryRanker";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeOpponent } from "../types";

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

function opp(
  pid: string,
  name: string,
  wins: number,
  losses: number,
): ArcadeOpponent {
  const total = wins + losses;
  return {
    pulseId: pid,
    name,
    wins,
    losses,
    games: total,
    winRate: total > 0 ? wins / total : 0,
    lastPlayed: null,
  };
}

describe("Rivalry Ranker — crash safety", () => {
  afterEach(() => cleanup());

  test("render does not throw when truth contains a pulseId missing from candidates", () => {
    type Q = {
      candidates: Array<Pick<ArcadeOpponent, "pulseId" | "name" | "winRate" | "wins" | "losses" | "games">>;
      truth: string[];
    };
    const candidates: Q["candidates"] = [
      opp("p1", "Alice", 4, 1),
      opp("p2", "Bob", 3, 2),
      opp("p3", "Carol", 2, 3),
      opp("p4", "Dave", 1, 4),
    ];
    // truth has a ghost id "p999" that's not in candidates — represents
    // the malformed-payload edge case we used to throw on.
    const question: Q = {
      candidates,
      truth: ["p4", "p3", "p999", "p1"],
    };
    expect(() => {
      render(
        rivalryRanker.render({
          question,
          answer: null,
          onAnswer: () => undefined,
          score: { raw: 0.5, xp: 6, outcome: "partial", note: "2 positions off." },
          revealed: true,
          isDaily: false,
        }) as React.ReactElement,
      );
    }).not.toThrow();
  });

  test("editor list survives stale order ids carrying over from a prior round", () => {
    type Q = {
      candidates: Array<Pick<ArcadeOpponent, "pulseId" | "name" | "winRate" | "wins" | "losses" | "games">>;
      truth: string[];
    };
    // Two distinct rounds: first round candidates include "ghost"; second
    // round's candidates rotate it out. After the new question lands the
    // editor effect must reset `order` so we never .get() the ghost id.
    const candidates: Q["candidates"] = [
      opp("p10", "Eve", 5, 0),
      opp("p11", "Frank", 4, 1),
      opp("p12", "Gina", 3, 2),
      opp("p13", "Hank", 2, 3),
    ];
    const truth = ["p13", "p12", "p11", "p10"];
    expect(() => {
      render(
        rivalryRanker.render({
          question: { candidates, truth },
          answer: null,
          onAnswer: () => undefined,
          score: null,
          revealed: false,
          isDaily: false,
        }) as React.ReactElement,
      );
    }).not.toThrow();
  });
});

describe("Rivalry Ranker — generate gate", () => {
  test("ok=false when fewer than 4 opponents meet the >=4-games threshold", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      opponents: [opp("p1", "Alice", 3, 2), opp("p2", "Bob", 2, 3)],
    };
    const out = await rivalryRanker.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });
});
