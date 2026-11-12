import { describe, expect, it } from "vitest";
import { gamePaceGap } from "../gmGap";
import { PACE_MATCHUPS, paceCrossing, paceCurves, type PaceSample } from "../paceCurves";
import { buildPaceReference, readPaceReference } from "../paceReference";
import reference from "../pace-reference.json";
import { parseInstantPayload } from "../reportPayload";

const SAMPLE_TIMES = [0, 13, 20, 36, 51, 67, 88, 101, 113, 128, 144, 163, 179, 190, 209, 229, 245, 262, 275];

function samples({ start = 12, workerDelay = 0, rate = 600 } = {}): PaceSample[] {
  return SAMPLE_TIMES.map((time) => ({
    time, food_workers: start + Math.max(0, time - workerDelay) / 10,
    minerals_collection_rate: rate - 60, vespene_collection_rate: 60,
  }));
}

function sourceGame(index: number) {
  return {
    gameKey: `local-game-${index}`, opponentKey: `local-opponent-${index % 5}`,
    anchorMmr: 5326, durationSec: 300, matchup: "PvT", era: "after", samples: samples(),
  };
}

const source = Array.from({ length: 30 }, (_, i) => sourceGame(i));
const buckets = buildPaceReference(source).buckets;

function game(overrides: Record<string, unknown> = {}) {
  const payload = parseInstantPayload(JSON.stringify({
    gameId: "synthetic-test", date: "2026-11-10T12:00:00Z", result: "Victory",
    durationSec: 300, gameVersion: "5.0.17.98000", myRace: "Protoss", isLadderGame: true,
    opponent: { race: "Terran" }, macroBreakdown: { stats_events: samples() }, ...overrides,
  }));
  if (!payload) throw new Error("Invalid synthetic replay fixture.");
  return payload;
}

describe("opening pace curves", () => {
  it("interpolates irregular samples and integrates minerals plus gas in resources per minute", () => {
    const series = samples().map((point) => ({ ...point, minerals_collection_rate: 60 + point.time * 6 }));
    const curve = paceCurves(series, "after");
    expect(curve?.workers).toHaveLength(28);
    expect(curve?.workers[24]).toBe(36);
    expect(curve?.income[24]).toBeCloseTo(3360, 10);
    expect(curve?.income[27]).toBeCloseTo(4185, 10);
  });

  it("rejects the wrong worker start, a hole, non-increasing time and extrapolation", () => {
    expect(paceCurves(samples({ start: 8 }), "after")).toBeNull();
    expect(paceCurves(samples().filter(({ time }) => time < 100 || time > 200), "after")).toBeNull();
    expect(paceCurves([...samples(), samples()[0]], "after")).toBeNull();
    expect(paceCurves(samples().slice(0, -1), "after")).toBeNull();
    expect(paceCurves(samples().slice(1), "after")).toBeNull();
  });

  it("finds the first crossing despite later losses and never guesses past the series", () => {
    expect(paceCrossing([12, 14, 11, 16], 13)).toBe(5);
    expect(paceCrossing([12, 14, 11, 16], 12)).toBe(0);
    expect(paceCrossing([12, 14, 11, 16], 18)).toBeNull();
  });
});

describe("offline 5,300-MMR reference", () => {
  it("publishes exact cohort statistics and only the allowlisted aggregate", () => {
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ matchup: "PvT", era: "after", games: 30, opponents: 5 });
    expect(buckets[0].income[24]).toBe(2400);
    expect(Object.keys(buckets[0]).sort()).toEqual(["era", "games", "income", "matchup", "opponents", "workers"]);
    const output = JSON.stringify(buildPaceReference(source));
    expect(output).not.toMatch(/local-game|local-opponent|5326/);
    expect(readPaceReference(JSON.parse(output))).toEqual(buckets);
  });

  it("uses per-point medians rather than the mean or a single replay", () => {
    const games = source.map((entry, i) => ({ ...entry, samples: samples({ rate: i < 15 ? 600 : i < 29 ? 720 : 3000 }) }));
    expect(buildPaceReference(games).buckets[0].income[24]).toBe(2640);
  });

  it("enforces the game and distinct-opponent floors within each patch-era cohort", () => {
    expect(buildPaceReference(source.slice(0, -1)).buckets).toEqual([]);
    expect(buildPaceReference(source.map((entry, i) => ({ ...entry, opponentKey: String(i % 4) }))).buckets).toEqual([]);
    const split = source.map((entry, i) => i < 15 ? { ...entry, era: "before", samples: samples({ start: 8 }) } : entry);
    expect(buildPaceReference(split).buckets).toEqual([]);
  });

  it("excludes short games, out-of-band ratings and incomplete curves from the floor", () => {
    for (const ineligible of [{ durationSec: 269.9 }, { anchorMmr: 5350 }, { samples: samples().slice(0, -1) }]) {
      expect(buildPaceReference([...source.slice(1), { ...source[0], ...ineligible }]).buckets).toEqual([]);
    }
    expect(buildPaceReference(source.map((entry) => ({ ...entry, durationSec: 270, anchorMmr: 5250 }))).buckets).toHaveLength(1);
  });

  it.each(PACE_MATCHUPS)("builds %s from a qualifying cohort", (matchup) => {
    expect(buildPaceReference(source.map((entry) => ({ ...entry, matchup }))).buckets[0]?.matchup).toBe(matchup);
  });

  it("fails closed on unsupported matchups, duplicated games and malformed samples", () => {
    expect(() => buildPaceReference([{ ...source[0], matchup: "TvZ" }])).toThrow("row 1");
    expect(() => buildPaceReference([source[0], { ...source[0], era: "before" }])).toThrow("Duplicate");
    expect(() => buildPaceReference([{ ...source[0], samples: [null] }])).toThrow("row 1");
  });

  it("rejects duplicate, wrong-era or low-count reference buckets", () => {
    const [bucket] = buckets;
    expect(readPaceReference({ version: 1, buckets: [bucket, bucket] })).toEqual([]);
    expect(readPaceReference({ version: 1, buckets: [{ ...bucket, era: "before" }] })).toEqual([]);
    expect(readPaceReference({ version: 1, buckets: [{ ...bucket, opponents: 4 }] })).toEqual([]);
    expect(readPaceReference({ version: 1, buckets: [{ ...bucket, income: Array(28).fill(0) }] })).toEqual([]);
  });

  it("keeps the packaged registry within the reviewed aggregate-only schema", () => {
    expect(reference).toEqual({ version: 1, buckets: readPaceReference(reference) });
  });
});

describe("local pace comparison", () => {
  it("compares time-to-reference at 4:00 and reports the cohort", () => {
    const replay = game({ macroBreakdown: { stats_events: samples({ workerDelay: 20, rate: 576 }) } });
    expect(gamePaceGap(replay, buckets)).toEqual({
      kind: "measured", matchup: "PvT", era: "after", games: 30, opponents: 5, workers: 20, income: 10, allIn: false,
    });
  });

  it("labels either detected all-in and omits times for targets not reached by 4:30", () => {
    const replay = game({
      opponent: { race: "Terran", strategy: "TvP - Marine All-in" },
      macroBreakdown: { stats_events: samples({ workerDelay: 50, rate: 100 }) },
    });
    expect(gamePaceGap(replay, buckets)).toMatchObject({ kind: "measured", workers: null, income: null, allIn: true });
    expect(gamePaceGap(game({ myBuild: "PvT - 7 Gate Blink All-in" }), buckets).allIn).toBe(true);
  });

  it("never substitutes another era, race, non-ladder game or unsupported matchup", () => {
    for (const overrides of [
      { gameVersion: "5.0.16.97425" },
      { myRace: "Terran", opponent: { race: "Zerg" } }, { opponent: { race: "Zerg" } },
    ]) expect(gamePaceGap(game(overrides), buckets).kind).toBe("no-reference");
    expect(gamePaceGap(game({ isLadderGame: false }), buckets).kind).toBe("not-ladder");
    expect(gamePaceGap(game({ isLadderGame: null }), buckets).kind).toBe("not-ladder");
  });

  it("reports zero difference for a matching replay even if the reference plateaus before 4:00", () => {
    const plateau = samples().map((point) => ({ ...point, food_workers: Math.min(30, point.food_workers ?? 0) }));
    const reference = buildPaceReference(source.map((entry) => ({ ...entry, samples: plateau }))).buckets;
    expect(gamePaceGap(game({ macroBreakdown: { stats_events: plateau } }), reference))
      .toMatchObject({ kind: "measured", workers: 0, income: 0 });
  });

  it("reports short or incomplete games instead of manufacturing a gap", () => {
    expect(gamePaceGap(game({ durationSec: 269 }), buckets).kind).toBe("short");
    expect(gamePaceGap(game({ durationSec: 270 }), buckets).kind).toBe("measured");
    expect(gamePaceGap(game({ macroBreakdown: { stats_events: [] } }), buckets).kind).toBe("missing-samples");
  });
});
