import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { opponentBracketPick } from "../modes/quizzes/opponentBracketPick";
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
  overrides: Partial<ArcadeOpponent> = {},
): ArcadeOpponent {
  const total = wins + losses;
  const userWr = total > 0 ? wins / total : 0;
  return {
    pulseId: pid,
    pulseCharacterId: overrides.pulseCharacterId ?? null,
    name,
    displayName: overrides.displayName ?? null,
    wins,
    losses,
    games: total,
    userWinRate: userWr,
    opponentWinRate: total > 0 ? 1 - userWr : 0,
    lastPlayed: null,
    ...overrides,
  };
}

describe("Opponent Bracket Pick — WR semantics (opponent perspective)", () => {
  test("correctIndex points to the opponent who beats the user most (1-3), not the easiest (5-0)", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      opponents: [
        opp("p_5_0", "Easy", 5, 0),
        opp("p_4_1", "Medium", 4, 1),
        opp("p_2_2", "Hard", 2, 2),
        opp("p_1_3", "Toughest", 1, 3),
      ],
    };
    const out = await opponentBracketPick.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const correct = out.question.candidates[out.question.correctIndex];
    expect(correct.pulseId).toBe("p_1_3");
    expect(correct.opponentWinRate).toBeCloseTo(0.75, 3);
  });
});

describe("Opponent Bracket Pick — barcode filter", () => {
  test("4 real + 5 unresolved barcodes => ok=true with zero barcode candidates", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      opponents: [
        opp("p1", "Alice", 3, 1),
        opp("p2", "Bob", 3, 1),
        opp("p3", "Carol", 3, 1),
        opp("p4", "Dave", 3, 1),
        opp("b1", "IIlIlI", 3, 1),
        opp("b2", "lIlIlIlIlI", 3, 1),
        opp("b3", "||||", 3, 1),
        opp("b4", "ⅠⅠⅠⅠ", 3, 1),
        opp("b5", "ＩｌＩｌ", 3, 1),
      ],
    };
    const out = await opponentBracketPick.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const c of out.question.candidates) {
      expect(c.pulseId.startsWith("p")).toBe(true);
    }
  });

  test("3 real + 5 barcodes => ok=false (no fallback to include barcodes)", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      opponents: [
        opp("p1", "Alice", 3, 1),
        opp("p2", "Bob", 3, 1),
        opp("p3", "Carol", 3, 1),
        opp("b1", "IIII", 3, 1),
        opp("b2", "llll", 3, 1),
        opp("b3", "1111", 3, 1),
        opp("b4", "||||", 3, 1),
        opp("b5", "iiii", 3, 1),
      ],
    };
    const out = await opponentBracketPick.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });

  test("barcode with resolved pulseCharacterId stays in pool with displayName", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      opponents: [
        opp("p1", "Alice", 3, 1),
        opp("p2", "Bob", 3, 1),
        opp("p3", "Carol", 3, 1),
        opp("b1", "IIlIlI", 3, 1, {
          pulseCharacterId: "994428",
          displayName: "Maru",
        }),
      ],
    };
    const out = await opponentBracketPick.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const masked = out.question.candidates.find((c) => c.pulseId === "b1");
    expect(masked).toBeDefined();
    expect(masked!.displayName).toBe("Maru");
  });
});

describe("Opponent Bracket Pick — reveal renders from opponent perspective", () => {
  afterEach(() => cleanup());

  test("starred row displays opponent's WR (e.g. 100% (3-0)) when user is 0-3 against them", () => {
    // Set up a 4-opponent question where the user has lost 0-3 to one
    // opponent (so opp's WR vs user is 100%) and 100% won against another.
    // The "highest WR against you" should star the (0,3) opponent.
    const candidates = [
      // user 3-0 vs Caelestis: opp WR 0%
      {
        pulseId: "p_caelestis",
        pulseCharacterId: null,
        name: "Caelestis",
        displayName: null,
        wins: 3,
        losses: 0,
        games: 3,
        userWinRate: 1,
        opponentWinRate: 0,
      },
      // user 5-2 vs Rumeith: opp WR 28.6%
      {
        pulseId: "p_rumeith",
        pulseCharacterId: null,
        name: "Rumeith",
        displayName: null,
        wins: 5,
        losses: 2,
        games: 7,
        userWinRate: 5 / 7,
        opponentWinRate: 2 / 7,
      },
      // user 3-2 vs OttoVonAiur: opp WR 40%
      {
        pulseId: "p_otto",
        pulseCharacterId: null,
        name: "OttoVonAiur",
        displayName: null,
        wins: 3,
        losses: 2,
        games: 5,
        userWinRate: 0.6,
        opponentWinRate: 0.4,
      },
      // user 1-3 vs ninja: opp WR 75%
      {
        pulseId: "p_ninja",
        pulseCharacterId: null,
        name: "ninja",
        displayName: null,
        wins: 1,
        losses: 3,
        games: 4,
        userWinRate: 0.25,
        opponentWinRate: 0.75,
      },
    ];
    // ninja is the correct answer at index 3 — highest opponentWinRate.
    const question = {
      candidates,
      correctIndex: 3,
    };
    render(
      opponentBracketPick.render({
        question,
        answer: 3,
        onAnswer: () => undefined,
        score: opponentBracketPick.score(question, 3),
        revealed: true,
        isDaily: false,
      }) as React.ReactElement,
    );
    // ninja's reveal row shows opp perspective: 75.0% (3-1).
    expect(screen.getByText(/75\.0%/)).toBeTruthy();
    expect(screen.getByText(/\(3-1\)/)).toBeTruthy();
  });
});
