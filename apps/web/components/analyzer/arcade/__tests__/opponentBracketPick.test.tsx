import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { opponentBracketPick } from "../modes/quizzes/opponentBracketPick";
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

describe("Opponent Bracket Pick — variant resolution", () => {
  // Generate picks its variant from a seeded rng, so each test walks
  // a small range of seeds until it lands on a run that exercises the
  // variant under test. With four variants in the pool, hitting any
  // given one inside 50 seeds is effectively guaranteed.

  test("most-faced fires when one opponent has a clear lead in games count", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      // Unique games counts → most-faced is unambiguous.
      opponents: [
        opp("p1", "Alice", 10, 5), // 15 games
        opp("p2", "Bob", 4, 3),    // 7
        opp("p3", "Carol", 3, 2),  // 5
        opp("p4", "Dave", 2, 1),   // 3
      ],
    };
    // Walk seeds until we hit a run that picks "most-faced".
    for (let s = 1; s <= 50; s++) {
      const out = await opponentBracketPick.generate({
        rng: mulberry32(s),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: dataset,
      });
      if (out.ok && out.question.variant === "most-faced") {
        const leader = out.question.candidates[out.question.correctIndex];
        expect(leader.pulseId).toBe("p1");
        return;
      }
    }
    throw new Error("most-faced variant never fired across 50 seeds");
  });

  test("last-beaten resolves to the candidate with the most-recent user win", async () => {
    const games: ArcadeGame[] = [
      // Older wins for p2 / p3, very recent for p1.
      { gameId: "1", date: "2026-04-01T12:00:00Z", result: "Win", oppPulseId: "p2" },
      { gameId: "2", date: "2026-04-15T12:00:00Z", result: "Win", oppPulseId: "p3" },
      { gameId: "3", date: "2026-05-09T12:00:00Z", result: "Win", oppPulseId: "p1" },
      // p4 has only losses on record.
      { gameId: "4", date: "2026-04-20T12:00:00Z", result: "Loss", oppPulseId: "p4" },
    ];
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games,
      opponents: [
        opp("p1", "Alice", 3, 1),
        opp("p2", "Bob", 3, 1),
        opp("p3", "Carol", 3, 1),
        opp("p4", "Dave", 3, 1),
      ],
    };
    for (let s = 1; s <= 50; s++) {
      const out = await opponentBracketPick.generate({
        rng: mulberry32(s),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: dataset,
      });
      if (out.ok && out.question.variant === "last-beaten") {
        const leader = out.question.candidates[out.question.correctIndex];
        expect(leader.pulseId).toBe("p1");
        return;
      }
    }
    throw new Error("last-beaten variant never fired across 50 seeds");
  });

  test("last-loss-to resolves to the candidate with the most-recent user loss", async () => {
    const games: ArcadeGame[] = [
      { gameId: "1", date: "2026-04-01T12:00:00Z", result: "Loss", oppPulseId: "p1" },
      { gameId: "2", date: "2026-05-09T12:00:00Z", result: "Loss", oppPulseId: "p2" },
      { gameId: "3", date: "2026-04-10T12:00:00Z", result: "Loss", oppPulseId: "p3" },
      { gameId: "4", date: "2026-04-15T12:00:00Z", result: "Loss", oppPulseId: "p4" },
    ];
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games,
      opponents: [
        opp("p1", "Alice", 3, 1),
        opp("p2", "Bob", 3, 1),
        opp("p3", "Carol", 3, 1),
        opp("p4", "Dave", 3, 1),
      ],
    };
    for (let s = 1; s <= 50; s++) {
      const out = await opponentBracketPick.generate({
        rng: mulberry32(s),
        daySeed: "2026-05-10",
        tz: "UTC",
        data: dataset,
      });
      if (out.ok && out.question.variant === "last-loss-to") {
        const leader = out.question.candidates[out.question.correctIndex];
        expect(leader.pulseId).toBe("p2");
        return;
      }
    }
    throw new Error("last-loss-to variant never fired across 50 seeds");
  });

  test("highest-wr-vs-you is always a viable fallback (no games data)", async () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      // No games array — last-beaten/last-loss-to can't resolve;
      // games counts all equal → most-faced can't resolve.
      opponents: [
        opp("p1", "Alice", 5, 0),
        opp("p2", "Bob", 4, 1),
        opp("p3", "Carol", 2, 2),
        opp("p4", "Dave", 1, 3),
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
    expect(out.question.variant ?? "highest-wr-vs-you").toBe("highest-wr-vs-you");
    expect(out.question.candidates[out.question.correctIndex].pulseId).toBe("p4");
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
