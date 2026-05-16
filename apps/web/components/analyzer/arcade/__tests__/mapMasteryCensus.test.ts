import { describe, expect, test } from "vitest";
import {
  groupByMap,
  MAP_VARIANT_ROTATION,
  mapBucketize,
  mapMasteryCensus,
  mapVariantKey,
  mapVariantOrderFor,
  mapWindowCutoff,
  matchesMapProfile,
  matchingMaps,
  qualifyingMapCount,
  type MapStats,
  type MapVariant,
} from "../modes/quizzes/mapMasteryCensus";
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

const ONE_DAY = 86_400_000;
const NOW = new Date("2026-05-16T00:00:00Z");

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
      oppPulseId: `dummy-${i}`,
    };
  });
}

/* ──────────── bucketize ──────────── */

describe("mapBucketize", () => {
  test("maps exact counts to 4 buckets", () => {
    expect(mapBucketize(0)).toBe("0");
    expect(mapBucketize(1)).toBe("1-2");
    expect(mapBucketize(3)).toBe("3-5");
    expect(mapBucketize(6)).toBe("6+");
  });
});

/* ──────────── matchesMapProfile ──────────── */

describe("matchesMapProfile", () => {
  const mk = (w: number, l: number): MapStats => ({
    map: "x",
    wins: w,
    losses: l,
    games: w + l,
    winRate: w + l === 0 ? 0 : w / (w + l),
  });

  test("perfect / winless / even / dominant predicates", () => {
    expect(matchesMapProfile(mk(5, 0), "perfect")).toBe(true);
    expect(matchesMapProfile(mk(5, 1), "perfect")).toBe(false);
    expect(matchesMapProfile(mk(0, 5), "winless")).toBe(true);
    expect(matchesMapProfile(mk(0, 0), "winless")).toBe(false);
    expect(matchesMapProfile(mk(5, 5), "even")).toBe(true);
    expect(matchesMapProfile(mk(7, 3), "dominant")).toBe(true);
    expect(matchesMapProfile(mk(10, 0), "dominant")).toBe(false); // perfect
  });
});

/* ──────────── mapWindowCutoff ──────────── */

describe("mapWindowCutoff", () => {
  test("returns the expected ms cutoffs", () => {
    expect(mapWindowCutoff("90d", NOW)).toBe(NOW.getTime() - 90 * ONE_DAY);
    expect(mapWindowCutoff("365d", NOW)).toBe(NOW.getTime() - 365 * ONE_DAY);
    expect(mapWindowCutoff("all", NOW)).toBeNull();
  });
});

/* ──────────── groupByMap ──────────── */

describe("groupByMap", () => {
  test("groups by map name, counts decided W/L", () => {
    const games = [
      ...gamesOnMap("Acropolis", ["W", "W", "L"], 10),
      ...gamesOnMap("Goldenaura", ["L", "L"], 10),
    ];
    const out = groupByMap(games, null);
    expect(out.size).toBe(2);
    expect(out.get("Acropolis")?.games).toBe(3);
    expect(out.get("Goldenaura")?.games).toBe(2);
  });

  test("skips games with no `map` field", () => {
    const games: ArcadeGame[] = [
      { gameId: "x", date: NOW.toISOString(), result: "Win" }, // no map
      {
        gameId: "y",
        date: NOW.toISOString(),
        result: "Win",
        map: "  ",
      }, // empty map
    ];
    expect(groupByMap(games, null).size).toBe(0);
  });

  test("filters by `since`", () => {
    const games = [
      ...gamesOnMap("Acropolis", ["W", "W"], 200),
      ...gamesOnMap("Acropolis", ["L"], 30),
    ];
    const out = groupByMap(games, NOW.getTime() - 60 * ONE_DAY);
    expect(out.get("Acropolis")?.games).toBe(1);
  });
});

/* ──────────── matchingMaps + qualifyingMapCount ──────────── */

describe("matchingMaps + qualifyingMapCount", () => {
  test("filters by minGames and profile", () => {
    const games = [
      ...gamesOnMap("Alpha", ["W", "W", "W", "W", "W"], 30),
      ...gamesOnMap("Bravo", ["L", "L", "L", "L", "L"], 30),
      ...gamesOnMap("Charlie", ["W", "L", "W", "L"], 30), // 4 games — below 5
    ];
    const stats = groupByMap(games, null);
    const v: MapVariant = { wr: "perfect", window: "all", minGames: 5 };
    expect(matchingMaps(stats, v).map((s) => s.map)).toEqual(["Alpha"]);
    expect(qualifyingMapCount(stats, v)).toBe(2); // Alpha + Bravo
  });
});

/* ──────────── rotation ──────────── */

describe("MAP_VARIANT_ROTATION", () => {
  test("has 6 curated variants", () => {
    expect(MAP_VARIANT_ROTATION.length).toBe(6);
  });

  test("variant keys are unique", () => {
    const seen = new Set<string>();
    for (const v of MAP_VARIANT_ROTATION) {
      const k = mapVariantKey(v);
      expect(seen.has(k), `duplicate ${k}`).toBe(false);
      seen.add(k);
    }
  });

  test("mapVariantOrderFor pins head by day-of-year for daily mode", () => {
    const [head] = mapVariantOrderFor({ daySeed: "2026-01-01", rng: () => 0 });
    expect(mapVariantKey(head)).toBe(mapVariantKey(MAP_VARIANT_ROTATION[0]));
  });

  test("the tail contains every variant exactly once", () => {
    const order = mapVariantOrderFor({
      daySeed: "2026-02-15",
      rng: () => 0,
    });
    const keys = new Set(order.map(mapVariantKey));
    expect(keys.size).toBe(MAP_VARIANT_ROTATION.length);
  });
});

/* ──────────── generate ──────────── */

describe("mapMasteryCensus.generate — gates", () => {
  test("ok=false on empty dataset", async () => {
    const out = await mapMasteryCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-16",
      tz: "UTC",
      data: baseDataset,
    });
    expect(out.ok).toBe(false);
  });

  test("ok=false below the year-games floor", async () => {
    const games = gamesOnMap("A", ["W", "L", "W", "L", "W", "L", "W", "L", "W", "L"], 50);
    const out = await mapMasteryCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-16",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(false);
  });
});

describe("mapMasteryCensus.generate — produces a question on rich data", () => {
  test("answers the pinned perfect-365d-5 variant when data fits", async () => {
    const games: ArcadeGame[] = [];
    games.push(...gamesOnMap("Map-A", ["W", "W", "W", "W", "W"], 10));
    games.push(...gamesOnMap("Map-B", ["W", "W", "W", "W", "W", "W"], 20));
    games.push(...gamesOnMap("Map-C", ["L", "L", "L", "L", "L"], 30));
    games.push(...gamesOnMap("Map-D", ["W", "L", "W", "L", "W"], 40));
    games.push(...gamesOnMap("Map-E", ["W", "W", "L", "L", "W"], 60));
    games.push(...gamesOnMap("Map-F", ["W", "L", "W", "L", "W", "L"], 70));
    const out = await mapMasteryCensus.generate({
      rng: mulberry32(1),
      daySeed: "2026-01-01",
      tz: "UTC",
      data: { ...baseDataset, games },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.question.variant).toEqual({
      wr: "perfect",
      window: "365d",
      minGames: 5,
    });
    expect(out.question.count).toBe(2);
    expect(out.question.truth).toBe("1-2");
    expect(out.question.qualifying).toBe(6);
    const names = out.question.examples.map((e) => e.map);
    expect(names).toEqual(["Map-B", "Map-A"]);
  });

  test("examples cap at 6", async () => {
    const games: ArcadeGame[] = [];
    for (const m of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      games.push(...gamesOnMap(m, ["W", "W", "W", "W", "W"], 30));
    }
    const out = await mapMasteryCensus.generate({
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
});

/* ──────────── score / share ──────────── */

describe("mapMasteryCensus.score", () => {
  const sampleQ = {
    variant: { wr: "perfect", window: "365d", minGames: 5 } as MapVariant,
    buckets: ["0", "1-2", "3-5", "6+"] as const,
    truth: "1-2" as const,
    count: 2,
    qualifying: 6,
    examples: [],
  };

  test("correct → XP", () => {
    expect(mapMasteryCensus.score(sampleQ, "1-2").outcome).toBe("correct");
    expect(mapMasteryCensus.score(sampleQ, "1-2").xp).toBeGreaterThan(0);
  });

  test("wrong → 0 XP", () => {
    expect(mapMasteryCensus.score(sampleQ, "6+").outcome).toBe("wrong");
    expect(mapMasteryCensus.score(sampleQ, "6+").xp).toBe(0);
  });

  test("share includes question prompt", () => {
    if (!mapMasteryCensus.share) throw new Error("share missing");
    const summary = mapMasteryCensus.share(
      sampleQ,
      "1-2",
      mapMasteryCensus.score(sampleQ, "1-2"),
    );
    expect(summary.question).toMatch(/100% WR/);
  });
});
