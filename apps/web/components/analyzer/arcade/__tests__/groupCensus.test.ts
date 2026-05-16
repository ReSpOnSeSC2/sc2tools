import { describe, expect, test } from "vitest";
import {
  bucketize,
  dayOfYearUtc,
  groupCensus,
  groupGames,
  matchesProfile,
  matchingGroups,
  qualifyingCount,
  VARIANT_ROTATION,
  variantKey,
  variantOrderFor,
  windowCutoff,
  type CensusVariant,
  type GroupKind,
  type GroupStats,
} from "../modes/quizzes/groupCensus";
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

function gamesAgainst(
  oppPulseId: string,
  pattern: ReadonlyArray<"W" | "L">,
  daysAgo: number,
  extra: Partial<ArcadeGame> = {},
): ArcadeGame[] {
  return pattern.map((p, i) => {
    const t = NOW.getTime() - daysAgo * ONE_DAY + i * 60 * 1000;
    return {
      gameId: `${oppPulseId}-${daysAgo}-${i}`,
      date: new Date(t).toISOString(),
      result: p === "W" ? "Win" : "Loss",
      oppPulseId,
      ...extra,
    };
  });
}

function gamesOnMap(
  map: string,
  pattern: ReadonlyArray<"W" | "L">,
  daysAgo: number,
): ArcadeGame[] {
  return pattern.map((p, i) => {
    const t = NOW.getTime() - daysAgo * ONE_DAY + i * 60 * 1000;
    return {
      gameId: `${map}-${daysAgo}-${i}`,
      date: new Date(t).toISOString(),
      result: p === "W" ? "Win" : "Loss",
      map,
      oppPulseId: `dummy-${map}-${i}`,
    };
  });
}

function gamesWithBuild(
  build: string,
  pattern: ReadonlyArray<"W" | "L">,
  daysAgo: number,
): ArcadeGame[] {
  return pattern.map((p, i) => {
    const t = NOW.getTime() - daysAgo * ONE_DAY + i * 60 * 1000;
    return {
      gameId: `${build}-${daysAgo}-${i}`,
      date: new Date(t).toISOString(),
      result: p === "W" ? "Win" : "Loss",
      myBuild: build,
      oppPulseId: `dummy-${build}-${i}`,
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

const mkStats = (w: number, l: number): GroupStats => ({
  key: "x",
  displayName: "x",
  wins: w,
  losses: l,
  games: w + l,
  winRate: w + l === 0 ? 0 : w / (w + l),
});

/* ──────────── bucketize ──────────── */

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

/* ──────────── matchesProfile ──────────── */

describe("matchesProfile", () => {
  test("perfect — no losses, ≥1 win", () => {
    expect(matchesProfile(mkStats(5, 0), "perfect")).toBe(true);
    expect(matchesProfile(mkStats(0, 0), "perfect")).toBe(false);
    expect(matchesProfile(mkStats(5, 1), "perfect")).toBe(false);
  });

  test("winless — no wins, ≥1 loss", () => {
    expect(matchesProfile(mkStats(0, 5), "winless")).toBe(true);
    expect(matchesProfile(mkStats(0, 0), "winless")).toBe(false);
    expect(matchesProfile(mkStats(1, 5), "winless")).toBe(false);
  });

  test("even — wins === losses, ≥1 game", () => {
    expect(matchesProfile(mkStats(5, 5), "even")).toBe(true);
    expect(matchesProfile(mkStats(0, 0), "even")).toBe(false);
    expect(matchesProfile(mkStats(5, 6), "even")).toBe(false);
  });

  test("dominant — ≥70% WR, ≥1 loss (excludes perfect)", () => {
    expect(matchesProfile(mkStats(7, 3), "dominant")).toBe(true);
    expect(matchesProfile(mkStats(10, 0), "dominant")).toBe(false);
    expect(matchesProfile(mkStats(6, 4), "dominant")).toBe(false);
  });

  test("struggle — ≤30% WR, ≥1 win (excludes winless)", () => {
    expect(matchesProfile(mkStats(3, 7), "struggle")).toBe(true);
    expect(matchesProfile(mkStats(0, 10), "struggle")).toBe(false);
    expect(matchesProfile(mkStats(4, 6), "struggle")).toBe(false);
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

/* ──────────── groupGames ──────────── */

describe("groupGames — opponent kind", () => {
  test("groups by pulseId, counts decided W/L", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "L"], 5),
      ...gamesAgainst("B", ["L", "L"], 5),
    ];
    const out = groupGames("opponent", games, null, []);
    expect(out.size).toBe(2);
    expect(out.get("A")).toMatchObject({ wins: 2, losses: 1, games: 3 });
    expect(out.get("B")).toMatchObject({ wins: 0, losses: 2, games: 2 });
  });

  test("filters by `since`", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W"], 100),
      ...gamesAgainst("A", ["L"], 30),
    ];
    const out = groupGames("opponent", games, NOW.getTime() - 60 * ONE_DAY, []);
    expect(out.get("A")?.games).toBe(1);
    expect(out.get("A")?.losses).toBe(1);
  });

  test("ignores games with no oppPulseId or undecided result", () => {
    const games: ArcadeGame[] = [
      { gameId: "x", date: NOW.toISOString(), result: "Win" },
      {
        gameId: "y",
        date: NOW.toISOString(),
        result: "Tie",
        oppPulseId: "A",
      },
    ];
    expect(groupGames("opponent", games, null, []).size).toBe(0);
  });

  test("rejects games with invalid date", () => {
    const games: ArcadeGame[] = [
      { gameId: "z", date: "not-a-date", result: "Win", oppPulseId: "A" },
    ];
    expect(groupGames("opponent", games, null, []).size).toBe(0);
  });

  test("lifts sc2pulse displayName when present", () => {
    const games = gamesAgainst("A", ["W"], 5);
    const out = groupGames("opponent", games, null, [
      opp("A", "IIIII", "Resolved Name"),
    ]);
    expect(out.get("A")?.displayName).toBe("Resolved Name");
  });

  test("falls back to raw name when no displayName is resolved", () => {
    const games = gamesAgainst("A", ["W"], 5);
    const out = groupGames("opponent", games, null, [opp("A", "RawName")]);
    expect(out.get("A")?.displayName).toBe("RawName");
  });

  test("falls back to '(unknown)' when opponent is not in the lookup", () => {
    const games = gamesAgainst("Z", ["W"], 5);
    const out = groupGames("opponent", games, null, []);
    expect(out.get("Z")?.displayName).toBe("(unknown)");
  });
});

describe("groupGames — map kind", () => {
  test("groups by trimmed map name, counts decided W/L", () => {
    const games = [
      ...gamesOnMap("Acropolis", ["W", "W", "L"], 10),
      ...gamesOnMap("Goldenaura", ["L", "L"], 10),
    ];
    const out = groupGames("map", games, null, []);
    expect(out.size).toBe(2);
    expect(out.get("Acropolis")?.games).toBe(3);
    expect(out.get("Goldenaura")?.games).toBe(2);
  });

  test("skips games with no map or whitespace map", () => {
    const games: ArcadeGame[] = [
      { gameId: "x", date: NOW.toISOString(), result: "Win" },
      {
        gameId: "y",
        date: NOW.toISOString(),
        result: "Win",
        map: "  ",
      },
    ];
    expect(groupGames("map", games, null, []).size).toBe(0);
  });

  test("filters by since", () => {
    const games = [
      ...gamesOnMap("Acropolis", ["W", "W"], 200),
      ...gamesOnMap("Acropolis", ["L"], 30),
    ];
    const out = groupGames("map", games, NOW.getTime() - 60 * ONE_DAY, []);
    expect(out.get("Acropolis")?.games).toBe(1);
  });
});

describe("groupGames — build kind", () => {
  test("groups by myBuild, counts decided W/L", () => {
    const games = [
      ...gamesWithBuild("Reaper FE", ["W", "W", "L"], 10),
      ...gamesWithBuild("1-1-1", ["L", "L", "W"], 10),
    ];
    const out = groupGames("build", games, null, []);
    expect(out.size).toBe(2);
    expect(out.get("Reaper FE")?.games).toBe(3);
    expect(out.get("1-1-1")?.games).toBe(3);
  });

  test("skips games with no myBuild", () => {
    const games: ArcadeGame[] = [
      {
        gameId: "x",
        date: NOW.toISOString(),
        result: "Win",
        oppPulseId: "A",
      },
      {
        gameId: "y",
        date: NOW.toISOString(),
        result: "Win",
        myBuild: "   ",
        oppPulseId: "B",
      },
    ];
    expect(groupGames("build", games, null, []).size).toBe(0);
  });
});

/* ──────────── matchingGroups + qualifyingCount ──────────── */

describe("matchingGroups + qualifyingCount", () => {
  test("filters by minGames AND profile predicate (opponents)", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "W", "W", "W"], 5),
      ...gamesAgainst("B", ["W", "W", "L"], 5),
      ...gamesAgainst("C", ["W", "W", "L", "L", "L"], 5),
      ...gamesAgainst("D", ["L", "L", "L", "L", "L"], 5),
    ];
    const stats = groupGames("opponent", games, null, []);
    const v: CensusVariant = {
      kind: "opponent",
      wr: "perfect",
      window: "all",
      minGames: 5,
    };
    expect(matchingGroups(stats, v).map((s) => s.key)).toEqual(["A"]);
    expect(
      matchingGroups(stats, { ...v, wr: "winless" }).map((s) => s.key),
    ).toEqual(["D"]);
    expect(qualifyingCount(stats, v)).toBe(3); // A, C, D — B has only 3 games
  });

  test("respects minGames threshold strictly", () => {
    const games = [
      ...gamesAgainst("A", ["W", "W", "W", "W"], 5),
      ...gamesAgainst("B", ["W", "W", "W", "W", "W"], 5),
    ];
    const stats = groupGames("opponent", games, null, []);
    expect(
      qualifyingCount(stats, {
        kind: "opponent",
        wr: "perfect",
        window: "all",
        minGames: 5,
      }),
    ).toBe(1);
    expect(
      qualifyingCount(stats, {
        kind: "opponent",
        wr: "perfect",
        window: "all",
        minGames: 10,
      }),
    ).toBe(0);
  });
});

/* ──────────── variant rotation ──────────── */

describe("variant rotation", () => {
  test("rotation spans all three group kinds", () => {
    const kinds = new Set<GroupKind>(VARIANT_ROTATION.map((v) => v.kind));
    expect(kinds.has("opponent")).toBe(true);
    expect(kinds.has("map")).toBe(true);
    expect(kinds.has("build")).toBe(true);
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
    const [head0] = variantOrderFor({
      daySeed: "2026-01-01",
      rng: () => 0,
    });
    expect(variantKey(head0)).toBe(variantKey(VARIANT_ROTATION[0]));
    const [head1] = variantOrderFor({
      daySeed: "2026-01-02",
      rng: () => 0,
    });
    expect(variantKey(head1)).toBe(variantKey(VARIANT_ROTATION[1]));
  });

  test("rolls via rng when daySeed is empty (Quick Play)", () => {
    const [head] = variantOrderFor({ daySeed: "", rng: () => 0.5 });
    const pinIdx = Math.floor(0.5 * VARIANT_ROTATION.length);
    expect(variantKey(head)).toBe(variantKey(VARIANT_ROTATION[pinIdx]));
  });

  test("the tail contains every variant once (full rotation)", () => {
    const order = variantOrderFor({
      daySeed: "2026-03-04",
      rng: () => 0,
    });
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

/* ──────────── generate — gates ──────────── */

describe("groupCensus.generate — gates", () => {
  test("ok=false on empty dataset", async () => {
    const out = await groupCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-16",
      tz: "UTC",
      data: baseDataset,
    });
    expect(out.ok).toBe(false);
  });

  test("ok=false below the year-games floor", async () => {
    const games = gamesAgainst(
      "A",
      ["W", "L", "W", "L", "W", "L", "W", "L", "W", "L"],
      50,
    );
    const out = await groupCensus.generate({
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

/* ──────────── generate — produces a question ──────────── */

describe("groupCensus.generate — produces a question on rich data", () => {
  test("answers the pinned opponent-perfect-365d-5 variant when data fits", async () => {
    // VARIANT_ROTATION[0] is { opponent, perfect, 365d, 5 }. Day-of-year
    // for 2026-01-01 is 0, so the pinned head matches index 0.
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
    const out = await groupCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-01",
      tz: "UTC",
      data: { ...baseDataset, games, opponents },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toEqual({
      kind: "opponent",
      wr: "perfect",
      window: "365d",
      minGames: 5,
    });
    expect(out.question.count).toBe(2);
    expect(out.question.truth).toBe("1-2");
    expect(out.question.qualifying).toBe(6);
    const exampleKeys = out.question.examples.map((e) => e.key);
    expect(exampleKeys).toEqual(["B", "A"]);
    expect(out.question.examples[0].displayName).toBe("Bravo");
  });

  test("falls back to the next variant when the pinned one has no qualifying groups", async () => {
    // Pinned head for day-of-year=15 (2026-01-16) is index 15:
    // { opponent, perfect, 90d, 5 }. No 90d data exists, so generate
    // falls through to the next variant. Provide enough 365d data to
    // clear the year floor and let the fallback resolve.
    const games: ArcadeGame[] = [];
    for (const id of ["E", "F", "G", "H", "I", "J", "K", "L"]) {
      games.push(...gamesAgainst(id, ["W", "L", "W", "L", "W"], 200));
    }
    const out = await groupCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-16",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
  });

  test("examples cap at 6 even when more match", async () => {
    const games: ArcadeGame[] = [];
    for (const id of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      games.push(...gamesAgainst(id, ["W", "W", "W", "W", "W"], 30));
    }
    const out = await groupCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-01",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.count).toBe(8);
    expect(out.question.truth).toBe("6+");
    expect(out.question.examples.length).toBe(6);
  });

  test("can land on a map-kind variant when opponent variants don't qualify", async () => {
    // Engineer the rotation so a map variant pins. Day-of-year=1
    // → VARIANT_ROTATION[1] = { kind: "map", wr: "perfect", 365d, 5 }.
    const games: ArcadeGame[] = [];
    // Year-floor padding (need ≥30 decided opponent games in 365d):
    for (const id of ["X1", "X2", "X3", "X4", "X5", "X6"]) {
      games.push(...gamesAgainst(id, ["W", "L", "W", "L", "W"], 30));
    }
    // Perfect map: Alpha 5-0; non-perfect map: Bravo 3-2.
    games.push(...gamesOnMap("Alpha", ["W", "W", "W", "W", "W"], 20));
    games.push(...gamesOnMap("Bravo", ["W", "W", "L", "L", "W"], 25));
    const out = await groupCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-02",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant.kind).toBe("map");
    expect(out.question.variant.wr).toBe("perfect");
    expect(out.question.count).toBe(1);
    expect(out.question.truth).toBe("1-2");
    expect(out.question.examples[0].displayName).toBe("Alpha");
  });

  test("can land on a build-kind variant when build data fits", async () => {
    // Day-of-year=2 → VARIANT_ROTATION[2] = { kind: "build", perfect, 365d, 5 }.
    const games: ArcadeGame[] = [];
    // Year-floor padding (≥30 decided opponent games in 365d):
    for (const id of ["X1", "X2", "X3", "X4", "X5", "X6"]) {
      games.push(...gamesAgainst(id, ["W", "L", "W", "L", "W"], 30));
    }
    // Perfect build: "Reaper FE" 5-0; non-perfect "1-1-1" 2-3.
    games.push(...gamesWithBuild("Reaper FE", ["W", "W", "W", "W", "W"], 20));
    games.push(...gamesWithBuild("1-1-1", ["W", "L", "W", "L", "L"], 25));
    const out = await groupCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-03",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant.kind).toBe("build");
    expect(out.question.variant.wr).toBe("perfect");
    expect(out.question.count).toBe(1);
    expect(out.question.examples[0].displayName).toBe("Reaper FE");
  });
});

/* ──────────── score / share ──────────── */

describe("groupCensus.score", () => {
  const sampleQ = {
    variant: {
      kind: "opponent",
      wr: "perfect",
      window: "365d",
      minGames: 5,
    } as CensusVariant,
    buckets: ["0", "1-2", "3-5", "6+"] as const,
    truth: "1-2" as const,
    count: 2,
    qualifying: 6,
    examples: [],
  };

  test("correct → XP", () => {
    expect(groupCensus.score(sampleQ, "1-2").outcome).toBe("correct");
    expect(groupCensus.score(sampleQ, "1-2").xp).toBeGreaterThan(0);
  });

  test("wrong → 0 XP", () => {
    expect(groupCensus.score(sampleQ, "0").outcome).toBe("wrong");
    expect(groupCensus.score(sampleQ, "0").xp).toBe(0);
  });

  test("share includes question prompt and matched-group rows", () => {
    if (!groupCensus.share) throw new Error("share missing");
    const summary = groupCensus.share(
      {
        ...sampleQ,
        examples: [
          {
            key: "A",
            displayName: "Alpha",
            wins: 5,
            losses: 0,
            games: 5,
            winRate: 1,
          },
        ],
      },
      "1-2",
      groupCensus.score(sampleQ, "1-2"),
    );
    expect(summary.question).toMatch(/100% WR/);
    expect(summary.question).toMatch(/against/);
    expect(summary.answer.some((row) => row.includes("Alpha"))).toBe(true);
  });

  test("share preposition tracks the variant kind", () => {
    if (!groupCensus.share) throw new Error("share missing");
    const mapSummary = groupCensus.share(
      {
        ...sampleQ,
        variant: {
          kind: "map",
          wr: "perfect",
          window: "365d",
          minGames: 5,
        } as CensusVariant,
      },
      "1-2",
      groupCensus.score(sampleQ, "1-2"),
    );
    expect(mapSummary.question).toMatch(/ on\?$/);
    const buildSummary = groupCensus.share(
      {
        ...sampleQ,
        variant: {
          kind: "build",
          wr: "perfect",
          window: "365d",
          minGames: 5,
        } as CensusVariant,
      },
      "1-2",
      groupCensus.score(sampleQ, "1-2"),
    );
    expect(buildSummary.question).toMatch(/ with\?$/);
  });
});
