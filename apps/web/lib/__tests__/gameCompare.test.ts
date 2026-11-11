import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "@/components/analyzer/macro/activeArmyLayout";
import { compareHref, isLegacyCompareGameId } from "@/lib/compareGameLinks";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import {
  alignBuildOrders, bestWinCandidate, compareBuildSteps, compareMechanics, deltaTone, formatDelta,
  metricDelta, pointAt,
} from "@/lib/gameCompare";

const step = (name: string, time: number) => ({ name, time, display: name.replace(/([a-z])([A-Z])/g, "$1 $2") });

describe("build-order alignment", () => {
  it("pairs repeated steps by occurrence, not by nearest time", () => {
    const a = compareBuildSteps([step("Pylon", 18), step("Gateway", 90), step("Gateway", 130), step("Gateway", 180), step("Probe", 12)]);
    const b = compareBuildSteps([step("Pylon", 20), step("Gateway", 85), step("CyberneticsCore", 110), step("Gateway", 210)]);
    const rows = alignBuildOrders(a, b);
    expect(rows.map((row) => [row.id, row.aTime, row.bTime, row.delta])).toEqual([
      ["pylon#1", 18, 20, -2],
      ["gateway#1", 90, 85, 5],
      ["cyberneticscore#1", null, 110, null],
      ["gateway#2", 130, 210, -80],
      ["gateway#3", 180, null, null],
    ]);
    expect(rows[1].label).toBe("Gateway");
    expect(rows[3].occurrence).toBe(2);
    expect(rows[2].label).toBe("Cybernetics Core");
  });

  it("matches names the way the Ghost Build grader does and drops workers and junk", () => {
    const a = compareBuildSteps([{ name: "Spawning Pool", time: 60 }, { name: "Drone", time: 5 }, { name: "", time: 3 }, { name: "Extractor", time: -1 }]);
    const b = compareBuildSteps([{ name: "SpawningPool", time: 70 }]);
    expect(a).toHaveLength(1);
    expect(alignBuildOrders(a, b)).toEqual([{ id: "spawningpool#1", label: "Spawning Pool", occurrence: 1, aTime: 60, bTime: 70, delta: -10 }]);
    expect(alignBuildOrders([], b)).toEqual([{ id: "spawningpool#1", label: "SpawningPool", occurrence: 1, aTime: null, bTime: 70, delta: null }]);
  });

  it("colours and formats deltas: within 5 s even, positive later, negative earlier", () => {
    expect(deltaTone(5)).toBe("even");
    expect(deltaTone(-5)).toBe("even");
    expect(deltaTone(6)).toBe("later");
    expect(deltaTone(-6)).toBe("earlier");
    expect(deltaTone(null)).toBe("none");
    expect(formatDelta(12)).toBe("+12 s");
    expect(formatDelta(-8)).toBe("−8 s");
    expect(formatDelta(65)).toBe("+1:05");
    expect(formatDelta(0.2)).toBe("0 s");
    expect(formatDelta(null)).toBe("—");
  });
});

describe("timeline reads", () => {
  const series = [{ t: 0, workers: 12 }, { t: 10, workers: 14 }, { t: 600, workers: 60 }] as SeriesPoint[];

  it("reads the sample at or before the cursor and nothing after the game ended", () => {
    expect(pointAt(series, 9)?.workers).toBe(12);
    expect(pointAt(series, 10)?.workers).toBe(14);
    expect(pointAt(series, 609)?.workers).toBe(60);
    expect(pointAt(series, 611)).toBeNull();
    expect(pointAt([], 10)).toBeNull();
    expect(metricDelta(14, 10)).toBe(4);
    expect(metricDelta(14, null)).toBeNull();
  });
});

describe("mechanics", () => {
  it("reads SQ, credited supply block, the race mechanic and APM, and leaves gaps empty", () => {
    const breakdown = {
      ok: true, race: "Zerg", macro_score: 71,
      raw: { sq: 82.4, supply_block_windows: [{ start: 100, end: 120, blocked_sec: 12 }, { start: 300, end: 305 }], injects_actual: 34, injects_expected: 41 },
    } as unknown as MacroBreakdownData;
    expect(compareMechanics(breakdown, { gameId: "g", apm: 145 })).toEqual({
      sq: 82.4, supplyBlockedSec: 17, mechanic: { label: "Injects", actual: 34, expected: 41 }, apm: 145, macroScore: 71,
    });
    expect(compareMechanics(null, { gameId: "g", apm: 0 })).toEqual({ sq: null, supplyBlockedSec: null, mechanic: null, apm: null, macroScore: null });
    expect(compareMechanics({ ok: true, raw: { supply_blocked_seconds: 9.6 } } as unknown as MacroBreakdownData, { gameId: "g", spq: 70, myRace: "Protoss" }))
      .toMatchObject({ sq: 70, supplyBlockedSec: 10, mechanic: null });
  });
});

describe("picker and links", () => {
  it("picks the best other win by macro score, then recency", () => {
    const items = [
      { gameId: "self", macroScore: 99 },
      { gameId: "old", macroScore: 80, date: "2026-01-01T00:00:00.000Z" },
      { gameId: "new", macroScore: 80, date: "2026-02-01T00:00:00.000Z" },
      { gameId: "low", macroScore: 40 },
    ];
    expect(bestWinCandidate(items, "self")?.gameId).toBe("new");
    expect(bestWinCandidate([{ gameId: "self" }], "self")).toBeNull();
  });

  it("accepts legacy IDs for private resolution and only writes opaque references to the URL", () => {
    const legacy = "date|Rival Name|Map / 600";
    const reference = "r-0123456789abcdef01234567";
    expect(isLegacyCompareGameId(legacy)).toBe(true);
    expect(isLegacyCompareGameId("x".repeat(201))).toBe(false);
    expect(isLegacyCompareGameId(["a"])).toBe(false);
    expect(compareHref(legacy, reference)).toBe("/app/compare?b=" + reference);
    expect(compareHref(legacy, null)).toBe("/app/compare");
  });
});
