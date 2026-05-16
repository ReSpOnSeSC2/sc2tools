import { describe, expect, test } from "vitest";
import {
  bucketize,
  dayOfYearUtc,
  groupByOpponent,
  headToHeadCensus,
  matchesProfile,
  matchingOpponents,
  qualifyingCount,
  VARIANT_ROTATION,
  variantKey,
  variantOrderFor,
  windowCutoff,
  type CensusVariant,
  type OppStats,
} from "../modes/quizzes/headToHeadCensus";
import { mulberry32 } from "../ArcadeEngine";
import type {
  ArcadeDataset,
  ArcadeGame,
  ArcadeOpponent,
} from "../types";

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

const ONE_DAY = 86_400_000;
const NOW = new Date("2026-05-16T00:00:00Z");

/* ──────────── helpers ──────────── */

/**
 * Build a deterministic list of games against `oppPulseId` with the
 * supplied W/L pattern. Each game's `date` is at `daysAgo` days before
 * NOW; the first game lands at `daysAgo`, subsequent games shift 1
 * minute later to keep them in the same window.
 */
function gamesAgainst(
  oppPulseId: string,
  pattern: ReadonlyArray<"W" | "L">,
  daysAgo: number,
): ArcadeGame[] {
  return pattern.map((p, i) => {
    const t = NOW.getTime() - daysAgo * ONE_DAY + i * 60 * 1000;
    return {
      gameId: `${oppPulseId}-${daysAgo}-${i}`,
      date: new Date(t).toISOString(),
      result: p === "W" ? "Win" : "Loss",
      oppPulseId,
    };
  });
}

function opp(
  pulseId: string,
  name = pulseId,
  displayName: string | null = null,
): ArcadeOpponent {
  return {
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
  };
}

/* ──────────── pure bucketers & predicates ──────────── */

describe("bucketize", () => {
  test("maps exact counts to 4 buckets", () => {
    expect(bucketize(0)).toBe("0");
    expect(bucketize(1)).toBe("1-2");
    expect(bucketize(2)).toBe("1-2");
    expect(bucketize(3)).toBe("3-5");
    expect(bucketize(5)).toBe("3-5");
    expect(bucketize(6)).toBe("6+");
    expect(bucketize(99)).toBe("6+");
  });

  test("negative or NaN clamps to 0", () => {
    expect(bucketize(-1)).toBe("0");
    expect(bucketize(Number.NaN)).toBe("0");
  });
});

describe("matchesProfile", () => {
  const mk = (w: number, l: number): OppStats => ({
    pulseId: "x",
    wins: w,
    losses: l,
    games: w + l,
    winRate: w + l === 0 ? 0 : w / (w + l),
  });

  test("perfect — no losses, ≥1 win", () => {
    expect(matchesProfile(mk(5, 0), "perfect")).toBe(true);
    expect(matchesProfile(mk(1, 0), "perfect")).toBe(true);
    expect(matchesProfile(mk(0, 0), "perfect")).toBe(false);
    expect(matchesProfile(mk(5, 1), "perfect")).toBe(false);
  });

  test("winless — no wins, ≥1 loss", () => {
    expect(matchesProfile(mk(0, 5), "winless")).toBe(true);
    expect(matchesProfile(mk(0, 1), "winless")).toBe(true);
    expect(matchesProfile(mk(0, 0), "winless")).toBe(false);
    expect(matchesProfile(mk(1, 5), "winless")).toBe(false);
  });

  test("even — wins === losses, ≥1 game", () => {
    expect(matchesProfile(mk(5, 5), "even")).toBe(true);
    expect(matchesProfile(mk(10, 10), "even")).toBe(true);
    expect(matchesProfile(mk(0, 0), "even")).toBe(false);
    expect(matchesProfile(mk(5, 6), "even")).toBe(false);
  });

  test("dominant — ≥70% WR, ≥1 loss (excludes perfect)", () => {
    expect(matchesProfile(mk(7, 3), "dominant")).toBe(true);
    expect(matchesProfile(mk(9, 1), "dominant")).toBe(true);
    expect(matchesProfile(mk(10, 0), "dominant")).toBe(false); // perfect
    expect(matchesProfile(mk(6, 4), "dominant")).toBe(false);
  });

  test("struggle — ≤30% WR, ≥1 win (excludes winless)", () => {
    expect(matchesProfile(mk(3, 7), "struggle")).toBe(true);
    expect(matchesProfile(mk(1, 9), "struggle")).toBe(true);
    expect(matchesProfile(mk(0, 10), "struggle")).toBe(false); // winless
    expect(matchesProfile(mk(4, 6), "struggle")).toBe(false);
  });
});

/* ──────────── windowCutoff ──────────── */

describe("windowCutoff", () => {
  test("90d / 365d return now - N days", () => {
    expect(windowCutoff("90d", NOW)).toBe(NOW.getTime() - 90 * ONE_DAY);
    expect(windowCutoff("365d", NOW)).toBe(NOW.getTime() - 365 * ONE_DAY);
  });
  test("all returns null", () => {
    expect(windowCutoff("all", NOW)).toBeNull();
  });
});

/* ──────────── groupByOpponent ──────────── */

describe("groupByOpponent", () => {
  test("groups by pulseId, counts decided W/L", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "L"], 5),
      ...gamesAgainst("B", ["L", "L"], 5),
    ];
    const out = groupByOpponent(games, null);
    expect(out.size).toBe(2);
    expect(out.get("A")).toMatchObject({ wins: 2, losses: 1, games: 3 });
    expect(out.get("B")).toMatchObject({ wins: 0, losses: 2, games: 2 });
  });

  test("filters by `since`", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W"], 100),
      ...gamesAgainst("A", ["L"], 30),
    ];
    const out = groupByOpponent(games, NOW.getTime() - 60 * ONE_DAY);
    expect(out.get("A")?.games).toBe(1);
    expect(out.get("A")?.losses).toBe(1);
  });

  test("ignores games with no oppPulseId or undecided result", () => {
    const games: ArcadeGame[] = [
      { gameId: "x", date: NOW.toISOString(), result: "Win" }, // no oppPulseId
      {
        gameId: "y",
        date: NOW.toISOString(),
        result: "Tie",
        oppPulseId: "A",
      },
    ];
    expect(groupByOpponent(games, null).size).toBe(0);
  });

  test("rejects games with invalid date", () => {
    const games: ArcadeGame[] = [
      { gameId: "z", date: "not-a-date", result: "Win", oppPulseId: "A" },
    ];
    expect(groupByOpponent(games, null).size).toBe(0);
  });

  test("winRate is computed from wins / games", () => {
    const games = gamesAgainst("A", ["W", "W", "W", "L"], 1);
    const stats = groupByOpponent(games, null).get("A");
    expect(stats?.winRate).toBeCloseTo(0.75, 6);
  });
});

/* ──────────── matchingOpponents + qualifyingCount ──────────── */

describe("matchingOpponents + qualifyingCount", () => {
  test("filters by minGames AND profile predicate", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "W", "W", "W"], 5), // 5-0 (perfect)
      ...gamesAgainst("B", ["W", "W", "L"], 5), // 3 games — below minGames=5
      ...gamesAgainst("C", ["W", "W", "L", "L", "L"], 5), // 2-3 (neither)
      ...gamesAgainst("D", ["L", "L", "L", "L", "L"], 5), // 0-5 (winless)
    ];
    const stats = groupByOpponent(games, null);
    const v: CensusVariant = {
      wr: "perfect",
      window: "all",
      minGames: 5,
    };
    expect(matchingOpponents(stats, v).map((s) => s.pulseId)).toEqual(["A"]);
    expect(
      matchingOpponents(stats, { ...v, wr: "winless" }).map((s) => s.pulseId),
    ).toEqual(["D"]);
    // A, C, D all have ≥5 games; B has 3 and is excluded.
    expect(qualifyingCount(stats, v)).toBe(3);
  });

  test("respects minGames threshold strictly", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "W", "W"], 5), // 4 games
      ...gamesAgainst("B", ["W", "W", "W", "W", "W"], 5), // 5 games
    ];
    const stats = groupByOpponent(games, null);
    expect(qualifyingCount(stats, { wr: "perfect", window: "all", minGames: 5 })).toBe(1);
    expect(qualifyingCount(stats, { wr: "perfect", window: "all", minGames: 10 })).toBe(0);
  });

  test("even profile — needs exact wins===losses", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "W", "W", "W", "L", "L", "L", "L", "L"], 5),
      ...gamesAgainst("B", ["W", "W", "W", "W", "W", "W", "L", "L", "L", "L"], 5),
    ];
    const stats = groupByOpponent(games, null);
    const v: CensusVariant = { wr: "even", window: "all", minGames: 10 };
    expect(matchingOpponents(stats, v).map((s) => s.pulseId)).toEqual(["A"]);
  });
});

/* ──────────── variant rotation ──────────── */

describe("variant rotation", () => {
  test("rotation has the curated 12 variants", () => {
    expect(VARIANT_ROTATION.length).toBe(12);
  });

  test("variant keys are unique", () => {
    const seen = new Set<string>();
    for (const v of VARIANT_ROTATION) {
      const k = variantKey(v);
      expect(seen.has(k), `duplicate key ${k}`).toBe(false);
      seen.add(k);
    }
  });

  test("pins head by day-of-year for daily mode", () => {
    const [head0] = variantOrderFor({ daySeed: "2026-01-01", rng: () => 0 });
    expect(variantKey(head0)).toBe(variantKey(VARIANT_ROTATION[0]));
    const [head1] = variantOrderFor({ daySeed: "2026-01-02", rng: () => 0 });
    expect(variantKey(head1)).toBe(variantKey(VARIANT_ROTATION[1]));
  });

  test("rolls via rng when daySeed is empty (Quick Play)", () => {
    const [head] = variantOrderFor({ daySeed: "", rng: () => 0.5 });
    const pinIdx = Math.floor(0.5 * VARIANT_ROTATION.length);
    expect(variantKey(head)).toBe(variantKey(VARIANT_ROTATION[pinIdx]));
  });

  test("the tail contains every variant once (full rotation)", () => {
    const order = variantOrderFor({ daySeed: "2026-03-04", rng: () => 0 });
    const keys = new Set(order.map(variantKey));
    expect(keys.size).toBe(VARIANT_ROTATION.length);
  });
});

describe("dayOfYearUtc", () => {
  test("January 1 → 0", () => {
    expect(dayOfYearUtc("2026-01-01")).toBe(0);
  });
  test("January 31 → 30", () => {
    expect(dayOfYearUtc("2026-01-31")).toBe(30);
  });
  test("empty / invalid → 0", () => {
    expect(dayOfYearUtc("")).toBe(0);
    expect(dayOfYearUtc("garbage")).toBe(0);
  });
});

/* ──────────── generate wiring ──────────── */

describe("headToHeadCensus.generate — gates", () => {
  test("ok=false on empty dataset", async () => {
    const out = await headToHeadCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-16",
      tz: "UTC",
      data: baseDataset,
    });
    expect(out.ok).toBe(false);
  });

  test("ok=false below the year-games floor", async () => {
    // 10 games against one opponent in the last year — below 30 floor.
    const games = gamesAgainst("A", ["W", "L", "W", "L", "W", "L", "W", "L", "W", "L"], 50);
    const out = await headToHeadCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-16",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/≥30/);
    }
  });
});

describe("headToHeadCensus.generate — produces a question on rich data", () => {
  test("answers the pinned perfect-365d-5 variant when data fits", async () => {
    // 6 opponents in the past year, each with 5+ games. Two are
    // perfect-5 (5-0 W). Day-of-year(2026-01-01) % 12 = 0 → variant
    // is { perfect, 365d, 5 }.
    const games: ArcadeGame[] = [];
    games.push(...gamesAgainst("A", ["W", "W", "W", "W", "W"], 10));
    games.push(...gamesAgainst("B", ["W", "W", "W", "W", "W", "W"], 20));
    games.push(...gamesAgainst("C", ["L", "L", "L", "L", "L"], 30));
    games.push(...gamesAgainst("D", ["W", "L", "W", "L", "W"], 40));
    games.push(...gamesAgainst("E", ["W", "W", "L", "L", "W"], 60));
    games.push(...gamesAgainst("F", ["W", "L", "W", "L", "W", "L"], 70));
    const opponents = [
      opp("A", "Alpha"),
      opp("B", "Bravo"),
      opp("C", "Charlie"),
      opp("D", "Delta"),
      opp("E", "Echo"),
      opp("F", "Foxtrot"),
    ];
    const out = await headToHeadCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-01",
      tz: "UTC",
      data: { ...baseDataset, games, opponents },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toEqual({
      wr: "perfect",
      window: "365d",
      minGames: 5,
    });
    expect(out.question.count).toBe(2); // A and B
    expect(out.question.truth).toBe("1-2");
    expect(out.question.qualifying).toBe(6);
    // Examples list contains both, sorted by game count desc → B then A.
    const exampleIds = out.question.examples.map((e) => e.pulseId);
    expect(exampleIds).toEqual(["B", "A"]);
    expect(out.question.examples[0].displayName).toBe("Bravo");
  });

  test("falls back to next variant when pinned has no qualifying opponents", async () => {
    // Set up so the pinned head variant has zero qualifying opponents
    // but the next does. Day pinned variant index 8 →
    // { perfect, 90d, 5 } — no opponent has ≥5 games in last 90 days.
    // Games happen 200 days ago, so the perfect-365d-5 fallback works.
    const games: ArcadeGame[] = [];
    games.push(...gamesAgainst("A", ["W", "W", "W", "W", "W"], 200));
    games.push(...gamesAgainst("B", ["W", "W", "W", "W", "W"], 250));
    games.push(...gamesAgainst("C", ["W", "W", "W", "W", "W"], 300));
    games.push(...gamesAgainst("D", ["W", "W", "W", "W", "W"], 350));
    games.push(...gamesAgainst("E", ["W", "L", "W", "L", "W", "L", "W"], 100));
    games.push(...gamesAgainst("F", ["W", "L", "W", "L", "W"], 100));
    // Pinned variant for day-of-year=8 is { perfect, 90d, 5 } — no
    // opponent has ≥5 games in the past 90 days, so generate falls
    // through. We don't assert the exact landed variant — just that
    // the quiz produced a question rather than ok=false.
    const out = await headToHeadCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-09",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
  });

  test("examples cap at 6 even when more match", async () => {
    const games: ArcadeGame[] = [];
    // 8 opponents, all perfect at 5+ games.
    for (const id of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      games.push(...gamesAgainst(id, ["W", "W", "W", "W", "W"], 30));
    }
    const opponents = [
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
    ].map((id) => opp(id));
    const out = await headToHeadCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-01",
      tz: "UTC",
      data: { ...baseDataset, games, opponents },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.count).toBe(8);
    expect(out.question.truth).toBe("6+");
    expect(out.question.examples.length).toBe(6);
  });

  test("uses sc2pulse displayName when available, falls back to raw name", async () => {
    // ≥30 games in past year to clear the floor; A is perfect-5.
    const games = gamesAgainst("A", ["W", "W", "W", "W", "W"], 30);
    games.push(...gamesAgainst("B", ["W", "L", "W", "L", "W"], 30));
    games.push(...gamesAgainst("C", ["W", "L", "W", "L", "W"], 60));
    games.push(...gamesAgainst("D", ["W", "L", "W", "L", "W"], 60));
    games.push(...gamesAgainst("E", ["W", "L", "W", "L", "W"], 60));
    games.push(...gamesAgainst("F", ["W", "L", "W", "L", "W"], 60));
    games.push(...gamesAgainst("G", ["W", "L", "W", "L", "W"], 60));
    const opponents = [
      opp("A", "IIIII", "Resolved Name"), // barcode raw, real displayName
      opp("B"),
      opp("C"),
      opp("D"),
      opp("E"),
      opp("F"),
      opp("G"),
    ];
    const out = await headToHeadCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-01",
      tz: "UTC",
      data: { ...baseDataset, games, opponents },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const found = out.question.examples.find((e) => e.pulseId === "A");
    expect(found?.displayName).toBe("Resolved Name");
  });
});

/* ──────────── score / share ──────────── */

describe("headToHeadCensus.score", () => {
  const sampleQ = {
    variant: { wr: "perfect", window: "365d", minGames: 5 } as CensusVariant,
    buckets: ["0", "1-2", "3-5", "6+"] as const,
    truth: "1-2" as const,
    count: 2,
    qualifying: 6,
    examples: [],
  };

  test("correct → XP", () => {
    expect(headToHeadCensus.score(sampleQ, "1-2").outcome).toBe("correct");
    expect(headToHeadCensus.score(sampleQ, "1-2").xp).toBeGreaterThan(0);
  });

  test("wrong → 0 XP", () => {
    expect(headToHeadCensus.score(sampleQ, "0").outcome).toBe("wrong");
    expect(headToHeadCensus.score(sampleQ, "0").xp).toBe(0);
  });

  test("share includes question prompt and matched-opponent rows", () => {
    if (!headToHeadCensus.share) throw new Error("share missing");
    const summary = headToHeadCensus.share(
      {
        ...sampleQ,
        examples: [
          {
            pulseId: "A",
            displayName: "Alpha",
            wins: 5,
            losses: 0,
            games: 5,
            winRate: 1,
          },
        ],
      },
      "1-2",
      headToHeadCensus.score(sampleQ, "1-2"),
    );
    expect(summary.question).toMatch(/100% WR/);
    expect(summary.answer.some((row) => row.includes("Alpha"))).toBe(true);
  });
});
