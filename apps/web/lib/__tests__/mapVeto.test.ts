import { describe, expect, it } from "vitest";
import { currentMapPoolKey, currentPool, POOL_MAX_AGE_MS } from "../currentMapPool";
import { communityMapRate, mapRecord, mostPlayedMapMatchup, poolMapRows, vetoMaps } from "../mapVeto";

describe("current map pool matching and freshness", () => {
  it("matches editions, accents and ampersands while preserving distinct Roman numerals", () => {
    expect(currentMapPoolKey("Féár & Faith [LE]")).toBe(currentMapPoolKey("Fear and Faith"));
    expect(currentMapPoolKey("Sanctuary III Ladder Edition")).toBe(currentMapPoolKey("Sanctuary III LE"));
    expect(currentMapPoolKey("Sanctuary II")).not.toBe(currentMapPoolKey("Sanctuary III"));
  });
  it("requires a measured fresh non-fallback pool, bounds and deduplicates maps", () => {
    const now = 1_000_000_000, base = { mapPool: ["Alpha", "Alpha LE", "Sanctuary II", "Sanctuary III"], mapPoolSource: "persisted" as const, mapPoolFetchedAt: now };
    expect(currentPool(base, now)).toMatchObject({ maps: ["Alpha", "Sanctuary II", "Sanctuary III"], fresh: true, age: 0 });
    for (const patch of [{ mapPoolSource: "fallback" as const }, { mapPoolFetchedAt: null }, { mapPoolFetchedAt: now - POOL_MAX_AGE_MS - 1 }, { mapPoolFetchedAt: now + 600_000 }]) expect(currentPool({ ...base, ...patch }, now).fresh).toBe(false);
    expect(currentPool({ ...base, mapPool: Array.from({ length: 40 }, (_, i) => `Map ${i}`) }, now).maps).toHaveLength(30);
  });
});

describe("map sample statistics and veto ranking", () => {
  it("uses the guides' Wilson 95% interval and decided games rather than ties", () => {
    expect(mapRecord(60, 40, 110)).toMatchObject({ decided: 100, total: 110, winRate: 0.6, ci: { low: 0.502, high: 0.6906 } });
    expect(mapRecord(0, 0, 12)).toMatchObject({ total: 12, decided: 0, winRate: null, ci: null });
  });
  it("combines matching pool aliases and per-race cells without inventing missing records", () => {
    const rows = poolMapRows(["Alpha", "Beta"], [{ map: "Alpha LE", matchup: "vs Z", wins: 2, losses: 3, total: 6 }, { map: "Alpha", matchup: "vs T", wins: 4, losses: 1, total: 5 }]);
    expect(rows[0]).toMatchObject({ gameMap: "Alpha LE", all: { wins: 6, losses: 4, total: 11, decided: 10, winRate: 0.6 }, cells: { Z: { decided: 5 }, T: { decided: 5 } } });
    expect(rows[1].all.winRate).toBeNull();
  });
  it("never vetoes a map with fewer than five decided games, including ties-heavy maps", () => {
    const rows = poolMapRows(["Tiny", "Weak", "Strong", "Ties"], [
      { map: "Tiny", matchup: "vs Z", wins: 0, losses: 4, total: 4 }, { map: "Weak", matchup: "vs Z", wins: 1, losses: 9, total: 10 },
      { map: "Strong", matchup: "vs Z", wins: 9, losses: 1, total: 10 }, { map: "Ties", matchup: "vs Z", wins: 0, losses: 2, total: 20 },
    ]);
    expect(vetoMaps(rows, "Z", 3)).toEqual(["Weak", "Strong"]);
    expect(vetoMaps(rows, "P", 3)).toEqual([]);
  });
  it("ranks lower Wilson bounds rather than raw rates and breaks ties by stable map name", () => {
    const rows = poolMapRows(["B", "A", "Long sample"], [
      { map: "B", matchup: "vs P", wins: 3, losses: 2, total: 5 }, { map: "A", matchup: "vs P", wins: 3, losses: 2, total: 5 },
      { map: "Long sample", matchup: "vs P", wins: 50, losses: 50, total: 100 },
    ]);
    expect(vetoMaps(rows, "P", 2)).toEqual(["A", "B"]);
    expect(vetoMaps(rows, "", 20)).toHaveLength(3);
  });
  it("defaults to the most played opponent race, while Random defaults to all", () => {
    const cells = [{ map: "A", matchup: "vs Z", wins: 3, losses: 4, total: 7 }, { map: "B", matchup: "vs T", wins: 2, losses: 1, total: 3 }];
    expect(mostPlayedMapMatchup(cells)).toBe("Z"); expect(mostPlayedMapMatchup(cells, true)).toBe("");
  });
  it("uses only the published exact community side, including reverse matchups without complementing", () => {
    const maps = [{ map: "Alpha", slug: "alpha", games: 200, cells: [{ matchup: "ZvP" as const, games: 100, winRate: 0.43, ci: { low: 0.3, high: 0.6 } }] }];
    expect(communityMapRate(maps, "Alpha LE", "Z", "P")).toBe(0.43);
    expect(communityMapRate(maps, "Alpha", "P", "Z")).toBeNull();
    expect(communityMapRate(maps, "Alpha", "R", "P")).toBeNull();
  });
});
