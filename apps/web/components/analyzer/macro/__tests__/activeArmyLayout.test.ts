import { describe, expect, it } from "vitest";
import {
  ARMY_FALLBACK_CAP,
  buildSeries,
  nearestPriorPoint,
  niceCeil,
  seriesAt,
} from "../activeArmyLayout";
import type {
  StatsEvent,
  UnitTimelineEntry,
} from "../MacroBreakdownPanel.types";
import type { BuildEvent } from "../compositionAt";

/**
 * Regression-locks the Active Army & Workers chart math against the
 * concrete data shapes that produced the late-game opponent spike to
 * 9 200 reported on the Jagannatha LE PvZ replay (2020-10-22):
 *
 *   - tooltip ↔ roster equality at every locked tick;
 *   - opp series cannot synthesise a vertical spike when opp's
 *     unit_timeline is empty for late-game samples (the bug);
 *   - food-supply heuristic stays clamped to ARMY_FALLBACK_CAP and
 *     only fires when nothing else is available;
 *   - worker count snaps to the nearest PRIOR sample so a hover at
 *     t=945 with samples at 930/960 reads 930's count, not 960's.
 *
 * These tests cover the failure modes in compositionAt.ts /
 * activeArmyLayout.ts; the agent-side ``army_value`` emission has its
 * own pytest in apps/agent/tests/test_replay_pipeline.py.
 */

function sample(time: number, fields: Partial<StatsEvent> = {}): StatsEvent {
  return { time, food_used: 0, food_workers: 0, ...fields };
}

describe("buildSeries — army_value preferred path", () => {
  it("uses sc2reader's authoritative army_value when present", () => {
    const samples: StatsEvent[] = [
      sample(0, { food_workers: 12, army_value: 0 }),
      sample(60, { food_workers: 18, army_value: 250 }),
      sample(120, { food_workers: 24, army_value: 1475 }),
    ];
    const out = buildSeries(samples, undefined, "my", undefined);
    expect(out.map((p) => p.army)).toEqual([0, 250, 1475]);
    expect(out.map((p) => p.armySource)).toEqual(["stats", "stats", "stats"]);
    expect(out.map((p) => p.workers)).toEqual([12, 18, 24]);
  });

  it("ignores negative army_value (sc2reader cold-start sentinel)", () => {
    const samples: StatsEvent[] = [
      sample(0, { army_value: -1, food_used: 12, food_workers: 12 }),
    ];
    const out = buildSeries(samples, undefined, "my", undefined);
    // -1 is treated as missing → falls through to the "empty" branch
    // (no timeline, no build events, food_used == food_workers so the
    // food heuristic returns 0).
    expect(out[0].army).toBe(0);
    expect(out[0].armySource).toBe("empty");
  });
});

describe("buildSeries — opponent late-game cannot vertical-spike", () => {
  /**
   * Reproduces the regression: opp's unit_timeline is empty for every
   * sample (extractor edge case, opp_pid mismatch, etc.) AND the
   * opp_events build log is fully populated (Zerg endgame: cumulative
   * built ~9 200 mineral+gas worth of units). Pre-fix, the SPA's
   * fallback path returned ``computeArmyValue(buildOrderUnitsAt(...))``
   * for the LAST sample and rendered a 0 → 9 200 vertical line.
   * Post-fix, the build_order branch is clamped to ARMY_FALLBACK_CAP
   * (9 000) so the line CAN'T jump above that, and prior samples
   * already render as build_order cumulative (a smooth ramp), not 0.
   */
  it("clamps build-order cumulative when timeline is empty all game", () => {
    // Empty timeline.opp throughout — extractor never tracked opp
    // units, but it DID emit ``my`` so the timeline is non-null.
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: { Probe: 12 }, opp: {} },
      { time: 30, my: { Probe: 14 }, opp: {} },
      { time: 60, my: { Probe: 16 }, opp: {} },
      { time: 990, my: { Probe: 49 }, opp: {} },
    ];
    // Opp built lots of expensive Zerg units pre-16:30. Cumulative
    // sum = 30×Zergling (25) + 20×Baneling (50) + 10×Hydralisk (150)
    // + 5×Lurker (150) + 8×Mutalisk (200) + 5×Ultralisk (475)
    //  = 750 + 1 000 + 1 500 + 750 + 1 600 + 2 375 = 7 975 — under
    // the cap, so the clamp doesn't fire here. We then add 5 more
    // Ultralisks (5×475 = 2 375) to push past the cap.
    const oppEvents: BuildEvent[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        time: 60 + i * 5,
        name: "Zergling",
        is_building: false,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        time: 200 + i * 5,
        name: "Baneling",
        is_building: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        time: 400 + i * 10,
        name: "Hydralisk",
        is_building: false,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        time: 600 + i * 10,
        name: "Lurker",
        is_building: false,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        time: 720 + i * 10,
        name: "Mutalisk",
        is_building: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        time: 840 + i * 10,
        name: "Ultralisk",
        is_building: false,
      })),
    ];
    const oppSamples: StatsEvent[] = [
      sample(0, { food_workers: 12 }),
      sample(990, { food_workers: 50 }),
    ];
    const out = buildSeries(oppSamples, timeline, "opp", oppEvents);
    // Last sample: cumulative cost would be > ARMY_FALLBACK_CAP. Must
    // be clamped — under no circumstances do we render the unbounded
    // 9 200-style vertical spike.
    const last = out[out.length - 1];
    expect(last.army).toBeLessThanOrEqual(ARMY_FALLBACK_CAP);
    // The data source must signal that this is the build_order
    // approximation (so the roster shows the "build order" badge),
    // never plain "stats".
    expect(last.armySource).toBe("build_order");
  });

  it("uses ``stats`` and ignores composition entirely when army_value is present", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 0, my: {}, opp: {} },
      { time: 30, my: {}, opp: {} },
    ];
    const oppEvents: BuildEvent[] = Array.from(
      { length: 100 },
      (_, i) => ({ time: 5 * i, name: "Ultralisk", is_building: false }),
    );
    const oppSamples: StatsEvent[] = [
      sample(30, { food_workers: 10, army_value: 1200 }),
    ];
    const out = buildSeries(oppSamples, timeline, "opp", oppEvents);
    // 100 Ultralisks would be 47 500 cost — but army_value is
    // authoritative and present, so the chart binds to it directly.
    expect(out[0].army).toBe(1200);
    expect(out[0].armySource).toBe("stats");
  });
});

describe("buildSeries — food fallback gate", () => {
  it("returns army=0 source=empty when no data of any kind is available", () => {
    const samples: StatsEvent[] = [
      sample(60, { food_used: 12, food_workers: 12 }), // food_used == workers
    ];
    const out = buildSeries(samples, undefined, "my", undefined);
    expect(out[0].army).toBe(0);
    expect(out[0].armySource).toBe("empty");
  });

  it("clamps the food-supply heuristic to ARMY_FALLBACK_CAP", () => {
    const samples: StatsEvent[] = [
      // 220 food_used - 16 workers = 204 fighting supply * 50 =
      // 10 200 — would render as a vertical spike pre-fix.
      sample(990, { food_used: 220, food_workers: 16 }),
    ];
    const out = buildSeries(samples, undefined, "my", undefined);
    expect(out[0].army).toBe(ARMY_FALLBACK_CAP);
    expect(out[0].armySource).toBe("fallback");
  });
});

describe("nearestPriorPoint — never leaks future state", () => {
  it("snaps a between-sample hover to the EARLIER sample", () => {
    const series = [
      { t: 0, army: 0, workers: 12, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
      { t: 30, army: 100, workers: 14, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
      { t: 60, army: 250, workers: 16, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
      { t: 90, army: 400, workers: 18, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
    ];
    // Hover at t=45 — between 30 and 60. Pre-fix nearestPoint would
    // pick whichever sample was closer (60 here, distance 15 vs 15;
    // first-best-wins picks 30). nearestPriorPoint always picks the
    // strictly-prior one (30) so the worker count and army value
    // can't reflect future state.
    expect(nearestPriorPoint(series, 45)?.t).toBe(30);
    expect(nearestPriorPoint(series, 60)?.t).toBe(60);
    expect(nearestPriorPoint(series, 89)?.t).toBe(60);
    expect(nearestPriorPoint(series, 90)?.t).toBe(90);
    // Hover before the first sample → return the first (so the UI
    // doesn't flash empty).
    expect(nearestPriorPoint(series, -1)?.t).toBe(0);
    // Hover past the last sample → return the last.
    expect(nearestPriorPoint(series, 9999)?.t).toBe(90);
  });

  it("returns null for an empty series", () => {
    expect(nearestPriorPoint([], 100)).toBeNull();
  });
});

describe("seriesAt — single-source-of-truth at hover time", () => {
  it("returns the same SeriesPoint for both consumers (chart + roster)", () => {
    const mySeries = buildSeries(
      [
        sample(0, { food_workers: 12, army_value: 0 }),
        sample(60, { food_workers: 18, army_value: 525 }),
        sample(120, { food_workers: 24, army_value: 1475 }),
      ],
      undefined,
      "my",
      undefined,
    );
    const oppSeries = buildSeries(
      [
        sample(0, { food_workers: 12, army_value: 0 }),
        sample(60, { food_workers: 16, army_value: 200 }),
      ],
      undefined,
      "opp",
      undefined,
    );
    const layout = { mySeries, oppSeries };
    // Hover at t=119 — chart and roster MUST read identical numbers.
    const a = seriesAt(layout, 119);
    expect(a.my?.army).toBe(525);
    expect(a.my?.workers).toBe(18);
    expect(a.opp?.army).toBe(200);
    expect(a.opp?.workers).toBe(16);

    // Lock at t=120 — both sides advance.
    const b = seriesAt(layout, 120);
    expect(b.my?.army).toBe(1475);
    expect(b.my?.workers).toBe(24);
    // opp has no t=120 sample; should hold at t=60.
    expect(b.opp?.t).toBe(60);
    expect(b.opp?.army).toBe(200);
  });
});

describe("niceCeil", () => {
  it("rounds up to a 1-2-2.5-5 sequence in each decade", () => {
    expect(niceCeil(173)).toBe(200);
    expect(niceCeil(518)).toBe(600);
    expect(niceCeil(2487)).toBe(2500);
  });
});
