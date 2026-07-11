import { describe, expect, it } from "vitest";
import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import {
  buildTimelinePoints,
  detectBattles,
  parseClockToSeconds,
  readoutAt,
} from "../gameTimeline";

/**
 * Locks in the pure math behind the game deep-dive's InteractiveTimeline:
 * series merging, fight (battle-marker) detection from army-value drops,
 * and the scrub cursor's "at this moment" readout.
 */

function ev(partial: Partial<StatsEvent> & { time: number }): StatsEvent {
  return partial as StatsEvent;
}

describe("buildTimelinePoints", () => {
  it("merges my/opp streams into one time-sorted series with nulls for gaps", () => {
    const my = [
      ev({
        time: 20,
        army_value: 100,
        minerals_current: 50,
        food_used: 14,
        food_made: 15,
        food_workers: 13,
      }),
      ev({ time: 10, army_value: 0, minerals_current: 40, food_used: 12 }),
    ];
    const opp = [
      ev({ time: 10, army_value: 0, food_used: 12 }),
      ev({ time: 25, army_value: 120, food_used: 18 }),
    ];
    const points = buildTimelinePoints(my, opp);
    expect(points.map((p) => p.time)).toEqual([10, 20, 25]);
    // Merged sample at t=10 carries both sides.
    expect(points[0].myMinerals).toBe(40);
    expect(points[0].oppArmy).toBe(0);
    // My-only sample: opp fields null.
    expect(points[1].myArmy).toBe(100);
    expect(points[1].mySupplyCap).toBe(15);
    expect(points[1].myWorkers).toBe(13);
    expect(points[1].oppArmy).toBeNull();
    // Opp-only sample: my fields null.
    expect(points[2].oppArmy).toBe(120);
    expect(points[2].oppSupply).toBe(18);
    expect(points[2].myArmy).toBeNull();
  });

  it("returns [] for missing streams and skips samples without a time", () => {
    expect(buildTimelinePoints(undefined, null)).toEqual([]);
    const junk = [ev({ time: Number.NaN }), { army_value: 5 } as StatsEvent];
    expect(buildTimelinePoints(junk, [])).toEqual([]);
  });
});

describe("detectBattles", () => {
  // One real fight around 290–330 (I lose 1500, opp loses 200) plus a
  // second, opponent-sided fight around 600–640 (opp loses 820).
  const my: StatsEvent[] = [
    ev({ time: 280, army_value: 1900 }),
    ev({ time: 290, army_value: 2000 }),
    ev({ time: 300, army_value: 2000 }),
    ev({ time: 310, army_value: 1200 }),
    ev({ time: 320, army_value: 700 }),
    ev({ time: 330, army_value: 500 }),
    ev({ time: 340, army_value: 520 }),
    ev({ time: 580, army_value: 1400 }),
    ev({ time: 600, army_value: 1400 }),
    ev({ time: 620, army_value: 1360 }),
    ev({ time: 640, army_value: 1350 }),
  ];
  const opp: StatsEvent[] = [
    ev({ time: 280, army_value: 1800 }),
    ev({ time: 300, army_value: 1800 }),
    ev({ time: 320, army_value: 1650 }),
    ev({ time: 330, army_value: 1600 }),
    ev({ time: 340, army_value: 1600 }),
    ev({ time: 580, army_value: 1700 }),
    ev({ time: 600, army_value: 1700 }),
    ev({ time: 620, army_value: 950 }),
    ev({ time: 640, army_value: 880 }),
  ];

  it("finds the largest drop per engagement, prices both sides, sorts by time", () => {
    const battles = detectBattles(my, opp);
    expect(battles).toHaveLength(2);

    // Fight 1: my biggest windowed drop (2000 → 500), deduped against
    // every overlapping candidate window.
    expect(battles[0].start).toBe(290);
    expect(battles[0].end).toBe(330);
    expect(battles[0].myLoss).toBe(1500);
    expect(battles[0].oppLoss).toBe(200);
    expect(battles[0].magnitude).toBe(1700);

    // Fight 2 was detected from the OPPONENT's series (my loss there is
    // only 50, far under the 400 threshold).
    expect(battles[1].start).toBe(600);
    expect(battles[1].end).toBe(640);
    expect(battles[1].oppLoss).toBe(820);
    expect(battles[1].myLoss).toBe(50);
  });

  it("is deterministic", () => {
    expect(detectBattles(my, opp)).toEqual(detectBattles(my, opp));
  });

  it("ignores dips under the loss threshold", () => {
    const calm = [
      ev({ time: 100, army_value: 900 }),
      ev({ time: 120, army_value: 600 }),
      ev({ time: 140, army_value: 850 }),
    ];
    expect(detectBattles(calm, [])).toEqual([]);
  });

  it("returns [] without army_value samples (pre-v0.5.11 payloads)", () => {
    const noArmy = [
      ev({ time: 100, minerals_current: 500 }),
      ev({ time: 200, minerals_current: 900 }),
    ];
    expect(detectBattles(noArmy, noArmy)).toEqual([]);
  });

  it("caps the number of markers", () => {
    const spiky: StatsEvent[] = [];
    for (let f = 0; f < 10; f++) {
      const t0 = f * 200;
      spiky.push(ev({ time: t0, army_value: 2000 }));
      spiky.push(ev({ time: t0 + 20, army_value: 1000 }));
      spiky.push(ev({ time: t0 + 100, army_value: 2000 }));
    }
    const battles = detectBattles(spiky, [], { maxMarkers: 4 });
    expect(battles).toHaveLength(4);
  });
});

describe("readoutAt", () => {
  const points = buildTimelinePoints(
    [
      ev({
        time: 10,
        army_value: 0,
        minerals_current: 50,
        food_used: 12,
        food_made: 14,
      }),
      ev({
        time: 30,
        army_value: 200,
        minerals_current: 125,
        food_used: 20,
        food_made: 22,
      }),
      ev({ time: 50, army_value: 450, minerals_current: 80, food_used: 28 }),
    ],
    [ev({ time: 20, army_value: 150 })],
  );

  it("answers with last-known values at or before t", () => {
    const r = readoutAt(points, 35);
    expect(r).not.toBeNull();
    expect(r!.time).toBe(35);
    expect(r!.myArmy).toBe(200);
    expect(r!.myMinerals).toBe(125);
    expect(r!.mySupply).toBe(20);
    expect(r!.mySupplyCap).toBe(22);
    // Opp only sampled at t=20 — carried forward.
    expect(r!.oppArmy).toBe(150);
  });

  it("carries forward fields the newest sample omitted", () => {
    const r = readoutAt(points, 55);
    expect(r!.mySupply).toBe(28);
    // t=50 sample had no food_made — last known cap survives.
    expect(r!.mySupplyCap).toBe(22);
  });

  it("clamps t into the sampled range instead of blanking", () => {
    const early = readoutAt(points, 0);
    expect(early!.time).toBe(10);
    expect(early!.myMinerals).toBe(50);
    const late = readoutAt(points, 9999);
    expect(late!.time).toBe(50);
    expect(late!.myArmy).toBe(450);
  });

  it("returns null only for an empty series", () => {
    expect(readoutAt([], 10)).toBeNull();
  });
});

describe("parseClockToSeconds", () => {
  it("parses m:ss clocks", () => {
    expect(parseClockToSeconds("3:42")).toBe(222);
    expect(parseClockToSeconds("12:05")).toBe(725);
    expect(parseClockToSeconds("0:00")).toBe(0);
  });

  it("rejects junk", () => {
    expect(parseClockToSeconds("abc")).toBeNull();
    expect(parseClockToSeconds("3:7")).toBeNull();
    expect(parseClockToSeconds("3:99")).toBeNull();
    expect(parseClockToSeconds(null)).toBeNull();
    expect(parseClockToSeconds(undefined)).toBeNull();
  });
});
