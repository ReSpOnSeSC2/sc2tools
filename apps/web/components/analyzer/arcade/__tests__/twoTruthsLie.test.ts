import { describe, expect, test } from "vitest";
import { buildFactPool, twoTruthsLieShareLines } from "../modes/games/twoTruthsLie";
import { twoTruthsLie } from "../modes/games/twoTruthsLie";
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

const game = (over: Partial<ArcadeGame> = {}): ArcadeGame => ({
  gameId: "g",
  date: "2026-05-01T12:00:00Z",
  result: "Win",
  duration: 600,
  myRace: "P",
  oppRace: "T",
  ...over,
});

describe("Two Truths & a Lie — claim text never says 'undefined'", () => {
  test("map facts drop rows whose name is null/empty/whitespace", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      maps: [
        // The pollutants: null + empty + whitespace map names.
        { map: null as unknown as string, wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { map: "", wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { map: "   ", wins: 3, losses: 2, total: 5, winRate: 0.6 },
        // Real rows that should drive the claim.
        { map: "Equilibrium", wins: 6, losses: 2, total: 8, winRate: 0.75 },
        { map: "Goldenaura", wins: 2, losses: 6, total: 8, winRate: 0.25 },
      ],
    };
    const facts = buildFactPool(dataset);
    for (const f of facts) {
      expect(f.truthText.toLowerCase()).not.toContain("undefined");
      expect(f.lieText.toLowerCase()).not.toContain("undefined");
      expect(f.detail.toLowerCase()).not.toContain("undefined");
    }
    // The valid pair should still produce a real map fact.
    const mapFact = facts.find((f) => f.truthText.includes("higher WR on"));
    expect(mapFact).toBeDefined();
    expect(mapFact!.truthText).toContain("Equilibrium");
    expect(mapFact!.truthText).toContain("Goldenaura");
  });

  test("degenerate single-map case (best === worst) does not emit a claim", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      maps: [
        { map: "", wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { map: "Equilibrium", wins: 4, losses: 1, total: 5, winRate: 0.8 },
      ],
    };
    const facts = buildFactPool(dataset);
    // Filter keeps one valid map => no best/worst pair to compare.
    const mapFact = facts.find((f) => f.truthText.includes("higher WR on"));
    expect(mapFact).toBeUndefined();
  });

  test("build fact ignores builds with no name", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [
        // Empty-name pollutant with a larger plays count must not win.
        { name: "", total: 100, wins: 50, losses: 50, winRate: 0.5 },
        { name: "Reaper FE", total: 8, wins: 6, losses: 2, winRate: 0.75 },
      ],
      summary: { totalGames: 8, wins: 6, losses: 2, winRate: 0.75 },
    };
    const facts = buildFactPool(dataset);
    for (const f of facts) {
      expect(f.truthText.toLowerCase()).not.toContain("undefined");
    }
    const buildFact = facts.find((f) => f.truthText.includes("most-played build"));
    expect(buildFact?.truthText).toContain("Reaper FE");
  });
});

describe("Two Truths & a Lie — share lines", () => {
  test("share lines include outcome header plus every claim with its label", () => {
    const q = {
      claims: [
        { text: "Claim A.", truthful: true, detail: "A detail." },
        { text: "Claim B (the lie).", truthful: false, detail: "B detail." },
        { text: "Claim C.", truthful: true, detail: "C detail." },
      ],
      lieIndex: 1,
    };
    const correct = twoTruthsLieShareLines(q, true);
    expect(correct).toHaveLength(4);
    expect(correct[0]).toMatch(/spotted/i);
    expect(correct[0]).toContain("#2");
    expect(correct[1]).toBe("1. TRUE · Claim A.");
    expect(correct[2]).toBe("2. LIE · Claim B (the lie).");
    expect(correct[3]).toBe("3. TRUE · Claim C.");

    const missed = twoTruthsLieShareLines(q, false);
    expect(missed[0]).toMatch(/missed/i);
    expect(missed[0]).toContain("#2");
  });
});

describe("Two Truths & a Lie — expanded fact families", () => {
  const seq = (n: number, fn: (i: number) => Partial<ArcadeGame>): ArcadeGame[] =>
    Array.from({ length: n }, (_, i) => game({ gameId: `g${i}`, ...fn(i) }));

  test("matchup-vs-overall fires when one matchup diverges by ≥4 pts", () => {
    const facts = buildFactPool({
      ...baseDataset,
      summary: { totalGames: 50, wins: 25, losses: 25, winRate: 0.5 },
      matchups: [
        { name: "vs P", oppRace: "P", wins: 8, losses: 2, total: 10, winRate: 0.8 },
        { name: "vs T", oppRace: "T", wins: 5, losses: 5, total: 10, winRate: 0.5 },
      ],
    });
    const f = facts.find((x) => x.truthText.includes("vs Protoss"));
    expect(f).toBeDefined();
    expect(f!.truthText).toMatch(/higher than your overall WR/);
  });

  test("matchup-vs-overall stays silent on near-tie matchups", () => {
    const facts = buildFactPool({
      ...baseDataset,
      summary: { totalGames: 50, wins: 25, losses: 25, winRate: 0.5 },
      matchups: [
        // 1pt diff — below MIN_WR_GAP.
        { name: "vs P", oppRace: "P", wins: 6, losses: 5, total: 11, winRate: 0.51 },
      ],
    });
    expect(facts.find((x) => x.truthText.includes("vs Protoss"))).toBeUndefined();
  });

  test("recent-vs-older splits chronologically and labels the better half", () => {
    const olderLosses = seq(10, (i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      result: "Loss",
    }));
    const recentWins = seq(10, (i) => ({
      gameId: `r${i}`,
      date: `2026-05-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      result: "Win",
    }));
    const facts = buildFactPool({
      ...baseDataset,
      games: [...olderLosses, ...recentWins],
    });
    const f = facts.find((x) => x.truthText.includes("most recent half"));
    expect(f).toBeDefined();
    expect(f!.truthText).toMatch(/higher than in the earlier half/);
  });

  test("long-vs-short games surfaces game-length WR split", () => {
    const longWins = seq(8, (i) => ({
      gameId: `L${i}`,
      duration: 25 * 60,
      result: "Win",
    }));
    const shortLosses = seq(8, (i) => ({
      gameId: `S${i}`,
      duration: 8 * 60,
      result: "Loss",
    }));
    const facts = buildFactPool({
      ...baseDataset,
      games: [...longWins, ...shortLosses],
    });
    const f = facts.find((x) =>
      x.truthText.includes("games over 20 minutes") ||
      x.truthText.includes("games under 12 minutes"),
    );
    expect(f).toBeDefined();
    expect(f!.truthText).toMatch(/over 20 minutes than in games under 12 minutes/);
  });

  test("weekend-vs-weekday fires when the two slices diverge", () => {
    // 2026-05-02 is a Saturday → weekend; 2026-05-04 is a Monday → weekday.
    const weekendWins = seq(6, (i) => ({
      gameId: `we${i}`,
      date: `2026-05-02T${String(10 + i).padStart(2, "0")}:00:00Z`,
      result: "Win",
    }));
    const weekdayLosses = seq(6, (i) => ({
      gameId: `wd${i}`,
      date: `2026-05-04T${String(10 + i).padStart(2, "0")}:00:00Z`,
      result: "Loss",
    }));
    const facts = buildFactPool({
      ...baseDataset,
      games: [...weekendWins, ...weekdayLosses],
    });
    const f = facts.find((x) => x.truthText.includes("weekend WR"));
    expect(f).toBeDefined();
    expect(f!.truthText).toMatch(/higher than your weekday WR/);
  });

  test("top-rival fires off an opponent the user has faced often", () => {
    const facts = buildFactPool({
      ...baseDataset,
      summary: { totalGames: 50, wins: 25, losses: 25, winRate: 0.5 },
      opponents: [
        {
          pulseId: "p1",
          name: "smurfymcsmurf",
          displayName: "RivalGuy",
          wins: 8,
          losses: 2,
          games: 10,
          userWinRate: 0.8,
          opponentWinRate: 0.2,
          lastPlayed: "2026-05-01T00:00:00Z",
        },
        // Less-faced opponent shouldn't crowd out the top rival.
        {
          pulseId: "p2",
          name: "Other",
          displayName: "Other",
          wins: 1,
          losses: 1,
          games: 2,
          userWinRate: 0.5,
          opponentWinRate: 0.5,
          lastPlayed: "2026-05-01T00:00:00Z",
        },
      ],
    });
    const f = facts.find((x) => x.truthText.includes("most-faced opponent"));
    expect(f).toBeDefined();
    expect(f!.truthText).toContain("RivalGuy");
  });

  test("best-vs-worst-build compares two named, sample-gated builds", () => {
    const facts = buildFactPool({
      ...baseDataset,
      builds: [
        { name: "Reaper FE", total: 10, wins: 8, losses: 2, winRate: 0.8 },
        { name: "1-1-1", total: 8, wins: 2, losses: 6, winRate: 0.25 },
      ],
    });
    const f = facts.find(
      (x) => x.truthText.includes("Reaper FE") && x.truthText.includes("1-1-1"),
    );
    expect(f).toBeDefined();
    expect(f!.truthText).toMatch(/Reaper FE.+wins more often than.+1-1-1/);
  });
});

describe("Two Truths & a Lie — generate gate", () => {
  test("rejects below 25-game floor", async () => {
    const dataset: ArcadeDataset = { ...baseDataset, games: [game()] };
    const out = await twoTruthsLie.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });
});
