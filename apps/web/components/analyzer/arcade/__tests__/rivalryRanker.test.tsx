import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

describe("Rivalry Ranker — crash safety", () => {
  afterEach(() => cleanup());

  test("render does not throw when truth contains a pulseId missing from candidates", () => {
    type Q = {
      candidates: Array<Pick<ArcadeOpponent, "pulseId" | "pulseCharacterId" | "name" | "displayName" | "userWinRate" | "opponentWinRate" | "wins" | "losses" | "games">>;
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
    const candidates = [
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

describe("Rivalry Ranker — WR semantics (opponent perspective)", () => {
  test("truth ranks by opponent's WR against the user, not user's WR", async () => {
    // Four opponents: user is 5-0, 4-1, 2-2, 1-3 against them.
    // From the OPPONENT's perspective: 0/5, 1/5, 2/4, 3/4 WR.
    // Toughest matchup ⇒ first ⇒ pulseId of the (1,3) opponent.
    const dataset: ArcadeDataset = {
      ...baseDataset,
      opponents: [
        opp("p_5_0", "Easy", 5, 0),
        opp("p_4_1", "Medium", 4, 1),
        opp("p_2_2", "Hard", 2, 2),
        opp("p_1_3", "Toughest", 1, 3),
      ],
    };
    const out = await rivalryRanker.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.truth[0]).toBe("p_1_3");
    expect(out.question.truth[out.question.truth.length - 1]).toBe("p_5_0");
  });
});

describe("Rivalry Ranker — barcode filter", () => {
  test("dataset of 4 real opponents + 5 unresolved barcodes still produces a round", async () => {
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
    const out = await rivalryRanker.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Every candidate is real (no barcode-only names).
    for (const c of out.question.candidates) {
      expect(c.pulseId.startsWith("p")).toBe(true);
    }
  });

  test("dataset of 3 real + many barcodes returns ok=false", async () => {
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
      ],
    };
    const out = await rivalryRanker.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });

  test("barcode with resolved pulseCharacterId is kept (displayName overrides raw name)", async () => {
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
    const out = await rivalryRanker.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ids = out.question.candidates.map((c) => c.pulseId).sort();
    expect(ids).toContain("b1");
  });
});

describe("Rivalry Ranker — reveal renders from opponent perspective", () => {
  afterEach(() => cleanup());

  test("opponent-perspective WR text is displayed (e.g. 75.0% (3-1) for a 1-3 record vs user)", () => {
    const candidates = [
      opp("p1", "Toughest", 1, 3), // opp WR 75% (3-1)
      opp("p2", "Medium", 2, 2),
      opp("p3", "Easy", 4, 1),
      opp("p4", "Easiest", 5, 0),
    ];
    const truth = ["p1", "p2", "p3", "p4"];
    render(
      rivalryRanker.render({
        question: { candidates, truth },
        answer: null,
        onAnswer: () => undefined,
        score: { raw: 1, xp: 12, outcome: "correct", note: "Your toughest matchup of the four is at #1." },
        revealed: true,
        isDaily: false,
      }) as React.ReactElement,
    );
    // Reveal row for the (1,3) opponent must show opp perspective: 75.0% with (3-1).
    // Both editor and reveal carry the WR text; assert at least one match.
    expect(screen.getAllByText(/75\.0%/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\(3-1\)/)).toBeTruthy();
  });
});
