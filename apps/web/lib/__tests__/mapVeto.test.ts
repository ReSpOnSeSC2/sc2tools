import { describe, expect, it } from "vitest";
import { currentMapPoolKey, currentPool, POOL_MAX_AGE_MS } from "../currentMapPool";
import { adjustedWinRate, communityMapRate, mapRecord, poolMapRows, poolWinRate, vetoMaps } from "../mapVeto";

// The owner's Maps screenshot (W-L per opponent race on the current pool) that exposed the old rule.
const SCREENSHOT: Record<string, Record<"P" | "T" | "Z", [number, number]>> = {
  "At Eternity's Edge": { P: [18, 12], T: [29, 17], Z: [19, 17] }, Blackrock: { P: [13, 14], T: [19, 14], Z: [23, 20] },
  "Fear and Faith": { P: [3, 4], T: [4, 3], Z: [12, 7] }, Lockdown: { P: [14, 8], T: [27, 23], Z: [31, 16] },
  "Old Sun Temple": { P: [8, 9], T: [5, 3], Z: [21, 16] }, Rainfall: { P: [13, 15], T: [27, 26], Z: [31, 18] },
  Rorschach: { P: [18, 12], T: [16, 21], Z: [28, 12] }, "Sanctuary III": { P: [18, 11], T: [27, 14], Z: [32, 16] },
  Washout: { P: [20, 15], T: [24, 17], Z: [25, 21] },
};
const screenshotRows = () => poolMapRows(Object.keys(SCREENSHOT), Object.entries(SCREENSHOT).flatMap(([map, races]) =>
  Object.entries(races).map(([race, [wins, losses]]) => ({ map: `${map} LE`, matchup: `vs ${race}`, wins, losses, total: wins + losses }))));
const record = (rows: ReturnType<typeof screenshotRows>, name: string) => rows.find((row) => row.name === name)!;
// The manual browser fixture's sparse pool, where Sanctuary III has only losses among its decided games.
const sparseRows = (sanctuaryLosses = 4) => poolMapRows(["Ancient Cistern", "Ruby Rock", "Sanctuary III"], [
  { map: "Ancient Cistern LE", matchup: "vs Z", wins: 2, losses: 10, total: 13 }, { map: "Ancient Cistern LE", matchup: "vs T", wins: 5, losses: 2, total: 7 },
  { map: "Ruby Rock LE", matchup: "vs Z", wins: 9, losses: 3, total: 12 }, { map: "Ruby Rock LE", matchup: "vs P", wins: 4, losses: 3, total: 7 },
  { map: "Sanctuary III LE", matchup: "vs Z", wins: 0, losses: sanctuaryLosses, total: 12 },
]);

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
    expect(rows[0]).toMatchObject({ gameMap: "Alpha LE", gameMaps: ["Alpha LE", "Alpha"], all: { wins: 6, losses: 4, total: 11, decided: 10, winRate: 0.6 }, cells: { Z: { decided: 5 }, T: { decided: 5 } } });
    expect(rows[1].all.winRate).toBeNull();
  });
  it("keeps distinct numbered maps separate and does not invent alias form chronology", () => {
    const rows = poolMapRows(["Sanctuary II", "Sanctuary III"], [{ map: "Sanctuary II LE", matchup: "vs Z", wins: 1, losses: 4, total: 5 }, { map: "Sanctuary III", matchup: "vs Z", wins: 5, losses: 0, total: 5 }],
      [{ name: "Sanctuary II LE", wins: 1, losses: 4, total: 5, recent: ["win", "loss"] }, { name: "Sanctuary III", wins: 5, losses: 0, total: 5, recent: ["win"] }, { name: "Sanctuary III LE", wins: 1, losses: 0, total: 1, recent: ["win"] }]);
    expect(rows[0]).toMatchObject({ gameMaps: ["Sanctuary II LE"], all: { decided: 5 }, recent: ["loss", "win"] });
    expect(rows[1]).toMatchObject({ gameMaps: ["Sanctuary III"], recent: undefined });
  });
  it("never vetoes a map with fewer than five decided games, including ties-heavy maps", () => {
    const rows = poolMapRows(["Tiny", "Weak", "Strong", "Ties"], [
      { map: "Tiny", matchup: "vs Z", wins: 0, losses: 4, total: 4 }, { map: "Weak", matchup: "vs Z", wins: 1, losses: 9, total: 10 },
      { map: "Strong", matchup: "vs Z", wins: 9, losses: 1, total: 10 }, { map: "Ties", matchup: "vs Z", wins: 0, losses: 2, total: 20 },
    ]);
    expect(vetoMaps(rows, "Z", 3)).toEqual(["Weak"]);
    expect(vetoMaps(rows, "P", 3)).toEqual([]);
  });
  it("never suggests a map at or above the pool average, so a sparse pool can return fewer than the veto count", () => {
    const rows = sparseRows();
    // 13-6 (68.4%) sits far above the 47.6% pool average, so it never fills the second or third slot.
    expect(poolWinRate(rows, "")).toBeCloseTo(20 / 42, 10);
    expect(vetoMaps(rows, "", 3)).toEqual(["Ancient Cistern"]); expect(vetoMaps(rows, "Z", 3)).toEqual(["Ancient Cistern"]);
    const even = poolMapRows(["Even", "Weak", "Strong"], [
      { map: "Even", matchup: "vs T", wins: 5, losses: 5, total: 10 }, { map: "Weak", matchup: "vs T", wins: 2, losses: 8, total: 10 },
      { map: "Strong", matchup: "vs T", wins: 8, losses: 2, total: 10 },
    ]);
    expect(vetoMaps(even, "T", 3)).toEqual(["Weak"]);
  });
  it("keeps a 0-4 map out until its fifth decided game without filling its slot with a strong map", () => {
    const rows = sparseRows(), sanctuary = record(rows, "Sanctuary III").all;
    // 0-4 adjusts to about 39.7%, the pool's lowest, but four decided games stay under the five-game floor.
    expect(sanctuary).toMatchObject({ wins: 0, losses: 4, decided: 4, total: 12 });
    expect(adjustedWinRate(sanctuary, poolWinRate(rows, "")!)).toBeCloseTo(0.3968, 4);
    expect(vetoMaps(rows, "", 3)).not.toContain("Sanctuary III"); expect(vetoMaps(rows, "", 3)).not.toContain("Ruby Rock");
    expect(vetoMaps(sparseRows(5), "", 3)).toEqual(["Sanctuary III", "Ancient Cistern"]);
  });
  it("ranks all matchups on the overall record, while one matchup ranks only its own column", () => {
    const rows = screenshotRows();
    expect(record(rows, "At Eternity's Edge").all).toMatchObject({ wins: 66, losses: 46 });
    expect(vetoMaps(rows, "", 1)).toEqual(["Blackrock"]);
    expect(vetoMaps(rows, "", 3)).toEqual(["Blackrock", "Rainfall", "Old Sun Temple"]);
    // At Eternity's Edge (58.9% overall) is only the weakest vs Z record, so it is a vs Z-only suggestion.
    expect(vetoMaps(rows, "Z", 3)).toEqual(["At Eternity's Edge", "Blackrock", "Washout"]);
    expect(vetoMaps(rows, "T", 3)).toEqual(["Rorschach", "Rainfall", "Lockdown"]);
  });
  it("does not veto a short winning run because its Wilson lower bound is low", () => {
    const rows = screenshotRows(), faith = record(rows, "Fear and Faith"), rorschach = record(rows, "Rorschach");
    // 4-3 (57%, n=7) has a lower Wilson bound than 16-21 (43%, n=37); so does 19-14 overall against 55-48.
    expect(faith.cells.T.ci!.low).toBeLessThan(rorschach.cells.T.ci!.low);
    expect(faith.all.ci!.low).toBeLessThan(record(rows, "Blackrock").all.ci!.low);
    expect(vetoMaps(rows, "T", 3)).not.toContain("Fear and Faith");
    expect(vetoMaps(rows, "", 3)).not.toContain("Fear and Faith");
  });
  it("pulls small samples toward the pool average so a long losing record outranks a short one", () => {
    const rows = screenshotRows();
    // vs P: 3-4 (42.9%, n=7) adjusts to about 52%, behind 13-15 (46.4%, n=28) at about 50%.
    expect(adjustedWinRate(record(rows, "Fear and Faith").cells.P, poolWinRate(rows, "P")!)).toBeCloseTo(0.5226, 4);
    expect(adjustedWinRate(record(rows, "Rainfall").cells.P, poolWinRate(rows, "P")!)).toBeCloseTo(0.5023, 4);
    expect(vetoMaps(rows, "P", 3)).toEqual(["Rainfall", "Blackrock", "Old Sun Temple"]);
  });
  it("still vetoes a small sample when its run is bad enough", () => {
    const rows = poolMapRows(["Short", "Long", "Fine"], [
      { map: "Short", matchup: "vs Z", wins: 0, losses: 6, total: 6 }, { map: "Long", matchup: "vs Z", wins: 40, losses: 50, total: 90 },
      { map: "Fine", matchup: "vs Z", wins: 60, losses: 40, total: 100 },
    ]);
    expect(vetoMaps(rows, "Z", 2)).toEqual(["Short", "Long"]);
    expect(vetoMaps(rows, "", 1)).toEqual(["Short"]);
  });
  it("averages decided games across the pool, ignoring ties, and blends 20 of them into each map", () => {
    const rows = screenshotRows();
    expect(poolWinRate(rows, "")).toBeCloseTo(525 / 906, 10); expect(poolWinRate(rows, "Z")).toBeCloseTo(222 / 365, 10);
    expect(poolWinRate(rows, "R")).toBeNull(); expect(vetoMaps(rows, "R", 3)).toEqual([]);
    expect(poolWinRate(poolMapRows(["Ties"], [{ map: "Ties", matchup: "vs Z", wins: 0, losses: 0, total: 4 }]), "")).toBeNull();
    expect(adjustedWinRate(mapRecord(55, 48), 0.6)).toBeCloseTo(67 / 123, 10);
    expect(adjustedWinRate(mapRecord(0, 0, 3), 0.58)).toBeCloseTo(0.58, 10);
  });
  it("breaks equal adjusted rates by the longer record, then by stable map name", () => {
    // In a 50% pool, 1-4 and 12-18 both adjust to exactly 44%; 16-4 is above the average and never qualifies.
    const rows = poolMapRows(["B", "A", "Long sample", "Strong"], [
      { map: "B", matchup: "vs P", wins: 1, losses: 4, total: 5 }, { map: "A", matchup: "vs P", wins: 1, losses: 4, total: 5 },
      { map: "Long sample", matchup: "vs P", wins: 12, losses: 18, total: 30 }, { map: "Strong", matchup: "vs P", wins: 16, losses: 4, total: 20 },
    ]);
    expect(vetoMaps(rows, "P", 3)).toEqual(["Long sample", "A", "B"]);
    expect(vetoMaps(rows, "", 20)).toHaveLength(3);
  });
  it("uses only the published exact community side, including reverse matchups without complementing", () => {
    const maps = [{ map: "Alpha", slug: "alpha", games: 200, cells: [{ matchup: "ZvP" as const, games: 100, winRate: 0.43, ci: { low: 0.3, high: 0.6 } }] }];
    expect(communityMapRate(maps, "Alpha LE", "Z", "P")).toBe(0.43);
    expect(communityMapRate(maps, "Alpha", "P", "Z")).toBeNull();
    expect(communityMapRate(maps, "Alpha", "R", "P")).toBeNull();
  });
});
