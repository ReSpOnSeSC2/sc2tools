import { describe, expect, it } from "vitest";
import type { LeagueBenchmark } from "../benchmarks";
import {
  TARGET_METRICS,
  TIMING_ROWS,
  gapText,
  leagueFromMmr,
  matchupFromFilters,
  percentileTag,
  seasonEstimate,
  selectBands,
  targetRow,
  timingGapText,
  timingRow,
  type TimingTable,
} from "../leagueTargets";

const deciles = (start: number, step: number) => Array.from({ length: 9 }, (_, i) => start + i * step);

function table(leagueId: number, league: string, spq: number[] | null, n = 400): LeagueBenchmark {
  return {
    leagueId, league, matchup: "PvZ", n, updatedAt: "2026-11-10T00:00:00.000Z",
    metrics: { spq: { n, deciles: spq }, macroScore: { n, deciles: deciles(40, 5) }, apm: { n, deciles: deciles(100, 10) }, durationSec: { n, deciles: deciles(400, 60) } },
  };
}

const SQ = TARGET_METRICS.find((spec) => spec.key === "spq")!;
const LENGTH = TARGET_METRICS.find((spec) => spec.key === "durationSec")!;

describe("band selection", () => {
  it("prefers a manual override, then replay MMR, then SC2Pulse", () => {
    expect(selectBands({ override: 2, replayMmr: 4120, pulseMmr: 5000 })).toEqual({ current: 2, next: 3, source: "override", mmr: 4120 });
    expect(selectBands({ override: null, replayMmr: 4120, pulseMmr: 5000 })).toEqual({ current: 4, next: 5, source: "replays", mmr: 4120 });
    expect(selectBands({ override: null, replayMmr: null, pulseMmr: 4700 })).toEqual({ current: 5, next: 6, source: "pulse", mmr: 4700 });
    expect(selectBands({ override: 9, replayMmr: 0, pulseMmr: 99999 })).toBeNull();
  });

  it("uses the API's league floors, and Grandmaster has no next league", () => {
    expect(leagueFromMmr(4599)).toBe(4);
    expect(leagueFromMmr(4600)).toBe(5);
    expect(leagueFromMmr(6600)).toBe(6);
    expect(selectBands({ override: null, replayMmr: 6600, pulseMmr: null })).toMatchObject({ current: 6, next: null });
  });

  it("reads the matchup only when both races are pinned", () => {
    expect(matchupFromFilters({ race: "P", opp_race: "Z" })).toBe("PvZ");
    expect(matchupFromFilters({ race: "P" })).toBeNull();
    expect(matchupFromFilters({ race: "R", opp_race: "Z" })).toBeNull();
  });
});

describe("target rows", () => {
  const diamond = table(4, "Diamond", deciles(55, 5));
  const master = table(5, "Master", deciles(62, 5));

  it("places your median in your league and states the step to the next median", () => {
    // Diamond p50 75, Master p50 82; 68 interpolates between p30 (65) and p40 (70): p36.
    const row = targetRow(SQ, { n: 20, median: 68 }, diamond, master);
    expect(row).toMatchObject({ state: "ok", currentP50: 75, nextP50: 82, gap: 14 });
    expect(gapText(row, "Diamond", "Master", "PvZ")).toBe("Diamond PvZ p36 → Master median needs +14 SQ");
    const above = targetRow(SQ, { n: 20, median: 90 }, diamond, master);
    expect(gapText(above, "Diamond", "Master", "PvZ")).toBe("Diamond PvZ p80 → at or above the Master median");
  });

  it("keeps absolute values below the floor and never says 'needs' for a profile", () => {
    const thin = targetRow(SQ, { n: 20, median: 68 }, table(4, "Diamond", deciles(55, 5), 49), master);
    expect(thin).toMatchObject({ state: "below_floor", mine: 68, currentP50: null, percentile: null, deciles: null });
    const length = targetRow(LENGTH, { n: 20, median: 660 }, diamond, master);
    expect(length.gap).toBeNull();
    expect(gapText(length, "Diamond", "Master", "PvZ")).toBe("Diamond PvZ p53 · Master median 10:40");
    expect(targetRow(SQ, { n: 0, median: null }, diamond, master).state).toBe("no_sample");
  });

  it("tags a game's SQ as pXX · League MU, or falls back without a table", () => {
    expect(percentileTag(diamond, "spq", 68)).toBe("p36 · Diamond PvZ");
    expect(percentileTag(diamond, "spq", 20)).toBe("<p10 · Diamond PvZ");
    expect(percentileTag(diamond, "spq", 200)).toBe(">p90 · Diamond PvZ");
    expect(percentileTag(null, "spq", 68)).toBeNull();
    expect(percentileTag(table(4, "Diamond", null), "spq", 68)).toBeNull();
  });

  it("states timing gaps against the next league's median", () => {
    const timings = (p50: number): TimingTable => ({ era: "after", leagueId: 5, league: "Master", matchup: "PvZ", n: 300,
      timings: { natural: { n: 300, deciles: deciles(p50 - 20, 5) }, third: { n: 10, deciles: null }, firstUpgrade: { n: 0, deciles: null }, keyTech: { n: 0, deciles: null } } });
    const row = timingRow(TIMING_ROWS[0], { n: 12, median: 102 }, timings(95), timings(90));
    expect(row).toMatchObject({ currentP50: 95, nextP50: 90, gap: 12 });
    expect(timingGapText(row.gap, "Master")).toBe("12 s later than the Master median");
    expect(timingGapText(-8, "Master")).toBe("8 s earlier than the Master median");
    expect(timingRow(TIMING_ROWS[1], { n: 12, median: 200 }, timings(95), timings(90)).nextP50).toBeNull();
  });
});

describe("season estimate", () => {
  const prefs = { leagueOverride: null, targetLeague: null, targetMmr: 4600 };
  const now = Date.parse("2026-11-10T00:00:00.000Z");
  const end = new Date(now + 28 * 86_400_000).toISOString();

  it("is plain arithmetic: MMR to go, games at the recent pace, games per week", () => {
    expect(seasonEstimate({ currentMmr: 4400, prefs, perGame: 5, seasonEnd: end, now }))
      .toEqual({ state: "estimate", target: 4600, mmrToGo: 200, games: 40, weeksLeft: 4, perWeek: 10 });
    expect(seasonEstimate({ currentMmr: 4400, prefs: { ...prefs, targetMmr: null, targetLeague: 5 }, perGame: 3, seasonEnd: null, now }))
      .toMatchObject({ state: "estimate", target: 4600, games: 67, perWeek: null });
  });

  it("names every state it cannot estimate", () => {
    expect(seasonEstimate({ currentMmr: 4400, prefs: { ...prefs, targetMmr: null }, perGame: 5, seasonEnd: end, now }).state).toBe("no_target");
    expect(seasonEstimate({ currentMmr: null, prefs, perGame: 5, seasonEnd: end, now }).state).toBe("no_mmr");
    expect(seasonEstimate({ currentMmr: 4700, prefs, perGame: 5, seasonEnd: end, now })).toMatchObject({ state: "reached", mmrToGo: 0 });
    expect(seasonEstimate({ currentMmr: 4400, prefs, perGame: -2, seasonEnd: end, now })).toMatchObject({ state: "no_trend", mmrToGo: 200 });
  });
});
