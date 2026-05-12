import { describe, expect, it } from "vitest";
import {
  buildOrderUnitsAt,
  canonicalizeName,
  countBuildingsAt,
  countUpgradesAt,
  deriveUnitComposition,
  derivedDeathsFromTimeline,
  nearestTimelineEntry,
  type BuildEvent,
} from "../compositionAt";
import type { UnitTimelineEntry } from "../MacroBreakdownPanel.types";

/**
 * Locks in the cumulative-built semantics for the macro-breakdown
 * units roster. The reported regression: a Protoss player who built
 * 11 Immortals over a 19-minute game (most of them dying to siege
 * tank fire) saw "Immortal × 1" in the Units row, because the panel
 * read alive counts off the death-aware ``unit_timeline``. Buildings
 * and Upgrades on the same panel have always been cumulative built,
 * so the inconsistency made the Units row look broken.
 *
 * Fix: the Units roster now reads ``buildOrderUnitsAt`` like the
 * Buildings / Upgrades rows do. Death-aware ``unit_timeline`` stays
 * the source of truth for the chart's army-value LINE (alive
 * mineral+gas), so the chart and the roster intentionally disagree on
 * Immortal count: the chart line shows the unit's contribution
 * vanishing when it dies; the roster shows it was BUILT.
 */
describe("buildOrderUnitsAt — cumulative-built semantics", () => {
  it("counts every build event for the unit up to time t (regression: 11 Immortals built, only 1 alive)", () => {
    // 11 Immortals trained between 4:00 and 16:00. None of these
    // events know about death — the build log only records starts.
    const events: BuildEvent[] = Array.from({ length: 11 }, (_, i) => ({
      time: 240 + i * 60,
      name: "Immortal",
      is_building: false,
    }));
    const composition = buildOrderUnitsAt(events, 16 * 60);
    expect(composition.Immortal).toBe(11);
  });

  it("respects time cutoff — only events at-or-before t are counted", () => {
    const events: BuildEvent[] = [
      { time: 60, name: "Stalker", is_building: false },
      { time: 120, name: "Stalker", is_building: false },
      { time: 180, name: "Stalker", is_building: false },
      { time: 240, name: "Stalker", is_building: false },
    ];
    expect(buildOrderUnitsAt(events, 200).Stalker).toBe(3);
    expect(buildOrderUnitsAt(events, 60).Stalker).toBe(1);
    // Boundary: t equal to event time → included.
    expect(buildOrderUnitsAt(events, 240).Stalker).toBe(4);
  });

  it("skips buildings, workers, and noise — only army-relevant units count", () => {
    const events: BuildEvent[] = [
      { time: 10, name: "Probe", is_building: false },
      { time: 20, name: "Probe", is_building: false },
      { time: 30, name: "Pylon", is_building: true },
      { time: 40, name: "Gateway", is_building: true },
      { time: 50, name: "Stalker", is_building: false },
      { time: 60, name: "Immortal", is_building: false },
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.Probe).toBeUndefined();
    expect(out.Pylon).toBeUndefined();
    expect(out.Gateway).toBeUndefined();
    expect(out.Stalker).toBe(1);
    expect(out.Immortal).toBe(1);
  });

  it("applies single-parent morphs (Hydralisk→Lurker decrements the parent)", () => {
    const events: BuildEvent[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        time: 100 + i * 5,
        name: "Hydralisk",
        is_building: false,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        time: 200 + i * 5,
        name: "Lurker",
        is_building: false,
      })),
    ];
    const out = buildOrderUnitsAt(events, 9999);
    // 8 Hydras built, 3 morphed into Lurkers → 5 Hydras left, 3 Lurkers.
    expect(out.Hydralisk).toBe(5);
    expect(out.Lurker).toBe(3);
  });

  it("applies 2-parent morphs (Archon consumes 2 Templar parents, DT-preferred)", () => {
    const events: BuildEvent[] = [
      { time: 100, name: "DarkTemplar", is_building: false },
      { time: 110, name: "DarkTemplar", is_building: false },
      { time: 120, name: "HighTemplar", is_building: false },
      { time: 130, name: "HighTemplar", is_building: false },
      // 1 Archon — consumes 2 DTs first by the ARCHON_PARENTS rule.
      { time: 200, name: "Archon", is_building: false },
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.Archon).toBe(1);
    expect(out.DarkTemplar ?? 0).toBe(0);
    expect(out.HighTemplar).toBe(2);
  });

  it("returns empty object for null / empty / non-array input", () => {
    expect(buildOrderUnitsAt(undefined, 100)).toEqual({});
    expect(buildOrderUnitsAt(null, 100)).toEqual({});
    expect(buildOrderUnitsAt([], 100)).toEqual({});
  });

  it("strips stance suffixes so a SiegeTank toggle doesn't double-count", () => {
    const events: BuildEvent[] = [
      { time: 100, name: "SiegeTank", is_building: false },
      { time: 110, name: "SiegeTankSieged", is_building: false },
    ];
    const out = buildOrderUnitsAt(events, 9999);
    expect(out.SiegeTank).toBe(2);
    expect(out.SiegeTankSieged).toBeUndefined();
  });
});

describe("canonicalizeName — stance/state suffix stripping", () => {
  it("strips known stance suffixes", () => {
    expect(canonicalizeName("SiegeTankSieged")).toBe("SiegeTank");
    expect(canonicalizeName("WarpPrismPhasing")).toBe("WarpPrism");
    expect(canonicalizeName("BurrowedRoach")).toBe("Roach");
    expect(canonicalizeName("LurkerMPBurrowed")).toBe("LurkerMP");
  });

  it("preserves semantically-distinct suffixes", () => {
    // MP is a data-version tag (LurkerMP, SwarmHostMP), not a stance —
    // keeping it lets the morph map and the cost catalog both resolve.
    expect(canonicalizeName("LurkerMP")).toBe("LurkerMP");
    expect(canonicalizeName("SwarmHostMP")).toBe("SwarmHostMP");
    // LiberatorAG / ThorAP encode combat posture the user reads from
    // the chip; preserved.
    expect(canonicalizeName("LiberatorAG")).toBe("LiberatorAG");
  });

  it("handles empty / falsy input safely", () => {
    expect(canonicalizeName("")).toBe("");
  });
});

describe("countBuildingsAt — Buildings row parity", () => {
  it("counts buildings cumulatively and applies the WarpGate→Gateway morph", () => {
    const events: BuildEvent[] = [
      { time: 30, name: "Gateway", is_building: true },
      { time: 60, name: "Gateway", is_building: true },
      // First Gateway → WarpGate at 4:00.
      { time: 240, name: "WarpGate", is_building: true },
    ];
    const out = countBuildingsAt(events, 9999);
    expect(out.Gateway).toBe(1);
    expect(out.WarpGate).toBe(1);
  });

  it("ignores non-building events", () => {
    const events: BuildEvent[] = [
      { time: 30, name: "Gateway", is_building: true },
      { time: 60, name: "Stalker", is_building: false },
      { time: 90, name: "Probe", is_building: false },
    ];
    const out = countBuildingsAt(events, 9999);
    expect(out.Gateway).toBe(1);
    expect(out.Stalker).toBeUndefined();
    expect(out.Probe).toBeUndefined();
  });
});

describe("countUpgradesAt — Upgrades row", () => {
  it("counts only entries tagged ``category: upgrade``", () => {
    const events: BuildEvent[] = [
      { time: 240, name: "WarpGateResearch", is_building: false, category: "upgrade" },
      { time: 300, name: "Charge", is_building: false, category: "upgrade" },
      { time: 360, name: "Stalker", is_building: false, category: "unit" },
    ];
    const out = countUpgradesAt(events, 9999);
    expect(out.WarpGateResearch).toBe(1);
    expect(out.Charge).toBe(1);
    expect(out.Stalker).toBeUndefined();
  });
});

describe("deriveUnitComposition — used by chart's army-value fallback path", () => {
  /*
   * deriveUnitComposition powers the chart's army-value LINE when
   * sc2reader's authoritative ``army_value`` is missing. It still
   * needs alive-aware (timeline-preferred, build-order + deaths
   * hybrid) semantics — the LINE must drop when units die. Only the
   * Units ROSTER below the chart switched to cumulative-built; this
   * function stays as it was, and the test below locks that down.
   */
  it("prefers timeline when populated for the side under inspection", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 60, my: { Stalker: 3, Immortal: 1 }, opp: {} },
    ];
    const buildEvents: BuildEvent[] = [
      { time: 30, name: "Stalker", is_building: false },
      { time: 40, name: "Stalker", is_building: false },
      { time: 50, name: "Stalker", is_building: false },
      { time: 55, name: "Immortal", is_building: false },
    ];
    const out = deriveUnitComposition({
      timeline,
      buildEvents,
      side: "my",
      t: 60,
    });
    expect(out.source).toBe("timeline");
    expect(out.units).toEqual({ Stalker: 3, Immortal: 1 });
  });

  it("falls through to build_order when the timeline side is empty AND build-order has events", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: { Drone: 12 } },
      { time: 60, my: {}, opp: { Drone: 14 } },
    ];
    const buildEvents: BuildEvent[] = [
      { time: 30, name: "Stalker", is_building: false },
      { time: 40, name: "Stalker", is_building: false },
    ];
    const out = deriveUnitComposition({
      timeline,
      buildEvents,
      side: "my",
      t: 60,
    });
    // Has timeline but ``my`` side is empty AND opponent isn't empty
    // at the same step — that's not the "both sides empty" gap case,
    // so we fall through to build_order. Source carries that fact.
    expect(out.source).toBe("build_order");
    expect(out.units.Stalker).toBe(2);
  });

  it("returns empty source when nothing's available", () => {
    const out = deriveUnitComposition({
      timeline: undefined,
      buildEvents: undefined,
      side: "my",
      t: 60,
    });
    expect(out.source).toBe("empty");
    expect(out.units).toEqual({});
  });
});

describe("derivedDeathsFromTimeline — death extraction from timeline diffs", () => {
  it("records (prev - cur) deaths anchored to the later sample", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 60, my: { Stalker: 10 }, opp: {} },
      { time: 120, my: { Stalker: 6 }, opp: {} },
    ];
    const deaths = derivedDeathsFromTimeline(timeline, "my");
    expect(deaths).toEqual([{ time: 120, name: "Stalker", count: 4 }]);
  });

  it("treats both-sides-empty drop as a data gap (no spurious deaths)", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: { Stalker: 5 }, opp: { Roach: 3 } },
      // Extractor produced an empty entry — both sides go to zero
      // simultaneously. Pre-fix this synthesised 5 Stalker deaths +
      // 3 Roach deaths and dropped the chart line to 0.
      { time: 30, my: {}, opp: {} },
    ];
    const deaths = derivedDeathsFromTimeline(timeline, "my");
    expect(deaths).toEqual([]);
  });

  it("returns empty array for null / single-entry input", () => {
    expect(derivedDeathsFromTimeline(undefined, "my")).toEqual([]);
    expect(derivedDeathsFromTimeline([], "my")).toEqual([]);
    expect(
      derivedDeathsFromTimeline(
        [{ time: 0, my: { Stalker: 1 }, opp: {} }],
        "my",
      ),
    ).toEqual([]);
  });
});

describe("nearestTimelineEntry", () => {
  it("returns the entry with the smallest |entry.time - t|", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 30, my: {}, opp: {} },
      { time: 60, my: {}, opp: {} },
      { time: 90, my: {}, opp: {} },
    ];
    expect(nearestTimelineEntry(timeline, 14)?.time).toBe(0);
    expect(nearestTimelineEntry(timeline, 16)?.time).toBe(30);
    expect(nearestTimelineEntry(timeline, 9999)?.time).toBe(90);
  });

  it("returns null for empty / null input", () => {
    expect(nearestTimelineEntry(undefined, 0)).toBeNull();
    expect(nearestTimelineEntry([], 0)).toBeNull();
  });
});
