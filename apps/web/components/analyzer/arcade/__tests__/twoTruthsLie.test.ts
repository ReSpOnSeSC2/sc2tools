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

  test("Mode.share returns the full question prompt plus every claim", () => {
    const q = {
      claims: [
        { text: "Claim A.", truthful: true, detail: "A detail." },
        { text: "Claim B (the lie).", truthful: false, detail: "B detail." },
        { text: "Claim C.", truthful: true, detail: "C detail." },
      ],
      lieIndex: 1,
    };
    expect(twoTruthsLie.share).toBeTypeOf("function");
    const summary = twoTruthsLie.share!(q, 1, {
      raw: 1,
      xp: 16,
      outcome: "correct",
    });
    // Plain-text question is included, no JSX.
    expect(summary.question).toMatch(/two are true/i);
    expect(summary.question).toMatch(/lie/i);
    // Every claim should appear with its TRUE/LIE label.
    expect(summary.answer.some((l) => l.includes("TRUE") && l.includes("Claim A"))).toBe(true);
    expect(summary.answer.some((l) => l.includes("LIE") && l.includes("Claim B"))).toBe(true);
    expect(summary.answer.some((l) => l.includes("TRUE") && l.includes("Claim C"))).toBe(true);
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

/* ──────────── Census-style fact families ──────────── */

describe("Two Truths & a Lie — census-style facts", () => {
  const opp = (
    pulseId: string,
    name = pulseId,
    displayName: string | null = null,
  ) => ({
    pulseId,
    pulseCharacterId: null,
    name,
    displayName,
    wins: 0,
    losses: 0,
    games: 0,
    userWinRate: 0,
    opponentWinRate: 0,
    lastPlayed: null,
  });

  const gamesAgainst = (
    pulseId: string,
    pattern: ReadonlyArray<"W" | "L">,
  ): ArcadeGame[] =>
    pattern.map((p, i) => ({
      gameId: `${pulseId}-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      result: p === "W" ? "Win" : "Loss",
      oppPulseId: pulseId,
    }));

  const gamesOnMap = (
    map: string,
    pattern: ReadonlyArray<"W" | "L">,
    extra: Partial<ArcadeGame> = {},
  ): ArcadeGame[] =>
    pattern.map((p, i) => ({
      gameId: `${map}-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      result: p === "W" ? "Win" : "Loss",
      map,
      oppPulseId: `${map}-opp-${i}`,
      ...extra,
    }));

  const gamesWithBuild = (
    build: string,
    pattern: ReadonlyArray<"W" | "L">,
  ): ArcadeGame[] =>
    pattern.map((p, i) => ({
      gameId: `${build}-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      result: p === "W" ? "Win" : "Loss",
      myBuild: build,
      oppPulseId: `${build}-opp-${i}`,
    }));

  test("perfect-opponent-exists fires when a 5+ game perfect rivalry is present", () => {
    const facts = buildFactPool({
      ...baseDataset,
      opponents: [opp("A", "RivalA"), opp("B", "RivalB")],
      games: [
        ...gamesAgainst("A", ["W", "W", "W", "W", "W"]),
        ...gamesAgainst("B", ["W", "L", "W", "L", "W"]),
      ],
    });
    const f = facts.find((x) =>
      x.truthText.includes("without ever losing"),
    );
    expect(f).toBeDefined();
    expect(f!.truthText).toMatch(/at least one opponent.+5\+/);
    expect(f!.lieText).toMatch(/every opponent/);
    expect(f!.detail).toContain("RivalA");
  });

  test("perfect-opponent-exists stays silent when every rivalry has at least one loss", () => {
    const facts = buildFactPool({
      ...baseDataset,
      opponents: [opp("A"), opp("B")],
      games: [
        ...gamesAgainst("A", ["W", "L", "W", "L", "W"]),
        ...gamesAgainst("B", ["W", "L", "W", "L", "W"]),
      ],
    });
    expect(
      facts.find((x) => x.truthText.includes("without ever losing")),
    ).toBeUndefined();
  });

  test("perfect-opponent-exists stays silent when there's no non-perfect opponent to refute the lie", () => {
    const facts = buildFactPool({
      ...baseDataset,
      opponents: [opp("A")],
      games: gamesAgainst("A", ["W", "W", "W", "W", "W"]),
    });
    expect(
      facts.find((x) => x.truthText.includes("without ever losing")),
    ).toBeUndefined();
  });

  test("winless-map-exists fires when a 5+ game winless map is present", () => {
    const facts = buildFactPool({
      ...baseDataset,
      games: [
        ...gamesOnMap("Acropolis", ["L", "L", "L", "L", "L"]),
        ...gamesOnMap("Equilibrium", ["W", "L", "W", "L", "W"]),
      ],
    });
    const f = facts.find((x) =>
      x.truthText.includes("without winning a single game"),
    );
    expect(f).toBeDefined();
    expect(f!.detail).toContain("Acropolis");
  });

  test("dominant-build-exists fires when any 5+ game build clears 70% WR", () => {
    const facts = buildFactPool({
      ...baseDataset,
      games: [
        ...gamesWithBuild("Reaper FE", ["W", "W", "W", "W", "L"]), // 80%
        ...gamesWithBuild("1-1-1", ["W", "L", "W", "L", "L"]), // 40%
      ],
    });
    const f = facts.find((x) =>
      x.truthText.includes("at least one build with a 70%"),
    );
    expect(f).toBeDefined();
    expect(f!.detail).toContain("Reaper FE");
  });

  test("even-rivalry-exists fires when a 10+ game rivalry is exactly tied", () => {
    const facts = buildFactPool({
      ...baseDataset,
      opponents: [opp("A", "Tied"), opp("B", "Lopsided")],
      games: [
        ...gamesAgainst("A", ["W", "L", "W", "L", "W", "L", "W", "L", "W", "L"]),
        ...gamesAgainst("B", ["W", "W", "W", "W", "W", "W", "W", "W", "L", "L"]),
      ],
    });
    const f = facts.find((x) => x.truthText.includes("exactly even"));
    expect(f).toBeDefined();
    expect(f!.detail).toContain("Tied");
  });

  test("one-and-done-opponents fires when the majority of opponents are singletons", () => {
    const opponents = Array.from({ length: 10 }, (_, i) =>
      opp(`p${i}`, `Player ${i}`),
    );
    // 8 singletons + 2 multi-game rivalries → 80% singleton ratio.
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 8; i++) {
      games.push(...gamesAgainst(`p${i}`, ["W"]));
    }
    games.push(...gamesAgainst("p8", ["W", "L"]));
    games.push(...gamesAgainst("p9", ["W", "L"]));
    const facts = buildFactPool({ ...baseDataset, opponents, games });
    const f = facts.find((x) =>
      x.truthText.includes("More than half of your opponents"),
    );
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/8 one-time opponents out of 10/);
  });

  test("distinct-maps-recent fires when ≥4 distinct maps appear in the last 90 days", () => {
    const recentDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const facts = buildFactPool({
      ...baseDataset,
      games: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map(
        (m, i): ArcadeGame => ({
          gameId: `${m}-${i}`,
          date: recentDate,
          result: "Win",
          map: m,
          oppPulseId: `opp-${i}`,
        }),
      ),
    });
    const f = facts.find((x) =>
      x.truthText.includes("distinct maps in the past 90 days"),
    );
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/5 distinct maps/);
  });

  test("census facts never produce text containing 'undefined'", () => {
    // A torture-test dataset covering all six census builders. Ensures
    // the templating + display-name fallbacks don't emit "undefined".
    const facts = buildFactPool({
      ...baseDataset,
      opponents: [opp("A", "", null), opp("B", "B")],
      games: [
        ...gamesAgainst("A", ["W", "W", "W", "W", "W"]),
        ...gamesAgainst("B", ["W", "L", "W", "L", "W"]),
        ...gamesOnMap("Acropolis", ["L", "L", "L", "L", "L"]),
        ...gamesOnMap("Equilibrium", ["W", "L", "W", "L", "W"]),
        ...gamesWithBuild("Reaper FE", ["W", "W", "W", "W", "L"]),
        ...gamesWithBuild("1-1-1", ["W", "L", "W", "L", "L"]),
      ],
    });
    for (const f of facts) {
      expect(f.truthText.toLowerCase()).not.toContain("undefined");
      expect(f.lieText.toLowerCase()).not.toContain("undefined");
      expect(f.detail.toLowerCase()).not.toContain("undefined");
    }
  });
});
