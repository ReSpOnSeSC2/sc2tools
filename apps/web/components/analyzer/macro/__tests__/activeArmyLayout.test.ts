import { describe, expect, it } from "vitest";
import {
  ARMY_FALLBACK_CAP,
  buildLayout,
  buildSeries,
  computeXTicks,
  nearestPriorPoint,
  niceCeil,
  seriesAt,
  type SeriesPoint,
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

describe("buildSeries — a wiped army stays wiped in the roster", () => {
  it("drops build-order units when army value and timeline both read empty", () => {
    // Lost the final fight: sc2reader reports army 0 and the timeline has
    // no units for this side, but units that died between samples never
    // showed up as timeline deaths, so the build order still "had" them.
    const timeline: UnitTimelineEntry[] = [
      { time: 1740, my: { Stalker: 3 }, opp: { Roach: 20 } },
      { time: 1760, my: {}, opp: { Roach: 18 } },
    ];
    const events: BuildEvent[] = Array.from({ length: 17 }, (_, i) => ({
      time: 300 + i * 60,
      name: "Stalker",
      is_building: false,
    }));
    const samples: StatsEvent[] = [
      sample(1740, { food_workers: 53, army_value: 525 }),
      sample(1760, { food_workers: 53, army_value: 0 }),
    ];
    const out = buildSeries(samples, timeline, "my", events);
    expect(out[0].units).toEqual({ Stalker: 3 });
    expect(out[1].army).toBe(0);
    expect(out[1].units).toEqual({});
    expect(out[1].unitsSource).toBe("timeline");
  });

  it("keeps the build-order fallback while the army value says units are alive", () => {
    const timeline: UnitTimelineEntry[] = [
      { time: 600, my: {}, opp: { Roach: 4 } },
    ];
    const events: BuildEvent[] = [
      { time: 300, name: "Stalker", is_building: false },
    ];
    const out = buildSeries(
      [sample(600, { army_value: 175 })],
      timeline,
      "my",
      events,
    );
    expect(out[0].units).toEqual({ Stalker: 1 });
    expect(out[0].unitsSource).toBe("build_order");
  });
});

describe("buildSeries — derived army value follows the patch era", () => {
  // No army_value on the wire (legacy upload): the line is priced from
  // the alive composition, so the game's balance decides a Queen's cost.
  const timeline: UnitTimelineEntry[] = [
    { time: 300, my: { Queen: 2, Zergling: 8 }, opp: {} },
  ];
  const samples = [sample(300, { food_used: 30, food_workers: 22 })];

  it("prices a 12-worker game at the LotV base balance by default", () => {
    // 2 × 175 + 8 × 25
    expect(buildSeries(samples, timeline, "my", undefined, "after")[0].army).toBe(550);
    expect(buildSeries(samples, timeline, "my", undefined)[0].army).toBe(550);
  });

  it("prices an 8-worker 5.0.16 game at 5.0.16b", () => {
    // 2 × 150 + 8 × 25
    const out = buildSeries(samples, timeline, "my", undefined, "before");
    expect(out[0].army).toBe(500);
    expect(out[0].armySource).toBe("timeline");
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

describe("computeXTicks — adaptive density for clean mobile + desktop axes", () => {
  it("uses 30 s steps for very short games and pins the end label exactly", () => {
    // 2 min game with a non-round end time — first ticks at 30 s
    // cadence, final tick pinned to the exact end so the user reads
    // "the game ended at 1:48", not "ended at 1:30".
    const ticks = computeXTicks(108);
    expect(ticks).toEqual([0, 30, 60, 90, 108]);
  });

  it("absorbs the last regular tick when it would crowd the end cap", () => {
    // 121 s — last regular tick would be 120, only 1 s from the end.
    // 1 s < 30 * 0.35 = 10.5 s so the inner tick is replaced by the
    // labelled endpoint to avoid two labels stacking on each other.
    const ticks = computeXTicks(121);
    expect(ticks).toEqual([0, 30, 60, 90, 121]);
  });

  it("scales steps so a 30-minute game produces ~6 clean labels", () => {
    const ticks = computeXTicks(1800);
    expect(ticks).toEqual([0, 300, 600, 900, 1200, 1500, 1800]);
  });

  it("scales steps so a 60-minute game stays under ~8 labels", () => {
    const ticks = computeXTicks(3600);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(3600);
  });
});

describe("buildLayout — game length drives the axis", () => {
  it("clamps maxT to the replay-reported game length when present", () => {
    // Samples extend to 1830 s (sc2reader's post-game grace tick) but
    // the replay's authoritative length is 1422 s — chart must end at
    // 1422, not 1830.
    const samples = Array.from({ length: 184 }, (_, i) => ({
      t: i * 10,
      army: 100,
      workers: 20,
      armySource: "stats" as const,
      units: {},
      unitsSource: "empty" as const,
    }));
    const layout = buildLayout(samples, [], 1422);
    expect(layout?.maxT).toBe(1422);
    // Samples past the cap are dropped so the line never draws outside
    // the plot area.
    expect(layout?.mySeries.every((p) => p.t <= 1422)).toBe(true);
    // The end-of-game tick is labelled exactly at the cap.
    expect(layout?.xTicks[layout.xTicks.length - 1]).toBe(1422);
  });

  it("falls back to the latest observed sample when game length is missing", () => {
    const samples = [
      { t: 0, army: 100, workers: 12, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
      { t: 600, army: 1500, workers: 30, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
    ];
    const layout = buildLayout(samples, [], undefined);
    expect(layout?.maxT).toBe(600);
  });

  it("never goes below the minimum axis floor on tiny replays", () => {
    const samples = [
      { t: 0, army: 0, workers: 12, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
      { t: 12, army: 50, workers: 12, armySource: "stats" as const, units: {}, unitsSource: "empty" as const },
    ];
    const layout = buildLayout(samples, [], 0);
    expect(layout?.maxT).toBeGreaterThanOrEqual(60);
  });
});

describe("buildLayout — metric tabs and measured size", () => {
  function point(t: number, fields: Partial<SeriesPoint> = {}): SeriesPoint {
    return {
      t,
      army: 0,
      workers: 12,
      armySource: "stats",
      units: {},
      unitsSource: "empty",
      ...fields,
    };
  }

  it("draws 1:1 at the measured size so labels are never stretched", () => {
    const layout = buildLayout([point(0), point(600)], [], 600, {
      width: 390,
      height: 250,
    })!;
    expect(layout.width).toBe(390);
    expect(layout.height).toBe(250);
    expect(layout.plotRight).toBeLessThan(390);
    expect(layout.xOf(600)).toBe(layout.plotRight);
  });

  it("plots a lone metric on its own nice scale", () => {
    const my = [point(0, { workers: 12 }), point(300, { workers: 61 })];
    const opp = [point(0, { workers: 12 }), point(300, { workers: 44 })];
    const layout = buildLayout(my, opp, 300, { metrics: ["workers"] })!;
    expect(layout.indexed).toBe(false);
    expect(layout.tracks).toHaveLength(1);
    const [track] = layout.tracks;
    expect(track.metric.key).toBe("workers");
    expect(track.yMax).toBe(80);
    expect(layout.yTicks.map((t) => t.label)).toEqual(["0", "20", "40", "60", "80"]);
    expect(track.yOf(0)).toBe(layout.plotBottom);
    expect(track.yOf(80)).toBe(layout.plotTop);
    expect(track.myPath.startsWith("M")).toBe(true);
    expect(track.oppPath.startsWith("M")).toBe(true);
  });

  it("indexes several metrics to their game peaks on one 0%–Peak axis", () => {
    const my = [point(0, { army: 0, workers: 12 }), point(300, { army: 4000, workers: 61 })];
    const opp = [point(0, { army: 0, workers: 12 }), point(300, { army: 5000, workers: 44 })];
    const layout = buildLayout(my, opp, 300, { metrics: ["army", "workers"] })!;
    expect(layout.indexed).toBe(true);
    expect(layout.tracks.map((t) => t.metric.key)).toEqual(["army", "workers"]);
    expect(layout.yTicks.map((t) => t.label)).toEqual(["0%", "25%", "50%", "75%", "Peak"]);
    const [army, workers] = layout.tracks;
    // Both players of a metric share its peak, so their lines still compare.
    expect(army.yMax).toBe(5000);
    expect(workers.yMax).toBe(61);
    expect(army.yOf(5000)).toBe(layout.plotTop);
    expect(workers.yOf(61)).toBe(layout.plotTop);
    // Lead shading only makes sense for a lone metric.
    expect(layout.leadArea).toBe("");
  });

  it("plots nothing, with unlabelled grid lines, when no metric is selected", () => {
    const layout = buildLayout([point(0), point(60)], [], 60, { metrics: [] })!;
    expect(layout.tracks).toEqual([]);
    expect(layout.yTicks).toHaveLength(5);
    expect(layout.yTicks.every((t) => t.label === "")).toBe(true);
  });

  it("lifts the pen over samples that lack the metric instead of drawing zero", () => {
    const my = [
      point(0, { supply: 12 }),
      point(10),
      point(20, { supply: 20 }),
    ];
    const layout = buildLayout(my, [], 20, { metrics: ["supply"] })!;
    expect(layout.tracks[0].myPath.match(/M/g)).toHaveLength(2);
  });

  it("shades the gap between the lines, split at the opponent's line", () => {
    const my = [point(0, { income: 500 }), point(60, { income: 900 })];
    const opp = [point(0, { income: 700 }), point(60, { income: 600 })];
    const layout = buildLayout(my, opp, 60, { metrics: ["income"] })!;
    // The band runs out along your line and back along the opponent's.
    expect(layout.leadArea).toMatch(/^M.*Z$/);
    expect(layout.leadArea.match(/L/g)).toHaveLength(3);
    // Clipped above the opponent's line it is your lead; below, theirs.
    expect(layout.oppAbove.endsWith(`,${layout.plotTop.toFixed(1)} Z`)).toBe(true);
    expect(layout.oppBelow.endsWith(`,${layout.plotBottom.toFixed(1)} Z`)).toBe(true);
  });

  it("draws no lead shading until both players have a line", () => {
    const layout = buildLayout([point(0), point(60, { army: 400 })], [], 60)!;
    expect(layout.leadArea).toBe("");
    expect(layout.oppAbove).toBe("");
  });

  it("keeps the game-end clock label and drops ticks that would collide", () => {
    const series = [point(0), point(1760)];
    const wide = buildLayout(series, [], 1760, { width: 1200 })!;
    const narrow = buildLayout(series, [], 1760, { width: 300 })!;
    for (const layout of [wide, narrow]) {
      const labels = layout.xTickLabels;
      const last = labels[labels.length - 1];
      expect(last.t).toBe(1760);
      expect(last.anchor).toBe("end");
      for (let i = 1; i < labels.length; i++) {
        expect(labels[i].x - labels[i - 1].x).toBeGreaterThan(30);
      }
    }
    expect(wide.xTickLabels.map((l) => l.t)).toEqual([0, 300, 600, 900, 1200, 1500, 1760]);
    expect(narrow.xTickLabels.length).toBeLessThan(wide.xTickLabels.length);
  });
});

describe("buildSeries — supply and collection rate", () => {
  it("carries supply used, cap and minerals + gas income per sample", () => {
    const out = buildSeries(
      [
        sample(60, {
          food_used: 31,
          food_made: 38,
          minerals_collection_rate: 720,
          vespene_collection_rate: 160,
        }),
      ],
      undefined,
      "my",
      undefined,
    );
    expect(out[0].supply).toBe(31);
    expect(out[0].supplyCap).toBe(38);
    expect(out[0].income).toBe(880);
  });
});
