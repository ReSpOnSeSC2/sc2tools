import { describe, expect, it } from "vitest";
import { buildCasualtyTimeline, casualtiesAt, emptyCasualtyCounts } from "../casualtiesAt";
import type { CasualtyEvent } from "../MacroBreakdownPanel.types";

const event = (overrides: Partial<CasualtyEvent> = {}): CasualtyEvent => ({
  time: 10, owner: "opp", killer: "me", category: "units", name: "Marine", ...overrides,
});

describe("casualty resource timeline", () => {
  it("accumulates costs at the exact selected time without mutating earlier snapshots", () => {
    const timeline = buildCasualtyTimeline([
      event({ time: 30, name: "Ravager" }),
      event({ time: 10 }),
      event({ time: 20, name: "Baneling" }),
      event({ time: 20, category: "workers", name: "Drone" }),
    ]);
    expect(timeline.map(({ time }) => time)).toEqual([10, 20, 30]);
    const before = casualtiesAt(timeline, 9.999);
    expect(before).toEqual(emptyCasualtyCounts());
    expect(casualtiesAt(timeline, 10).me.units.killedCost).toEqual({ minerals: 50, gas: 0, unpriced: 0 });
    expect(casualtiesAt(timeline, 19.999).me.workers.killed).toBe(0);
    const at = casualtiesAt(timeline, 20);
    expect(at.me.units.killed).toBe(2);
    expect(at.me.units.killedCost).toEqual({ minerals: 100, gas: 25, unpriced: 0 });
    expect(at.me.workers.killedCost).toEqual({ minerals: 50, gas: 0, unpriced: 0 });
    expect(at.opp.units.lostCost).toEqual(at.me.units.killedCost);
    expect(casualtiesAt(timeline, 30).me.units.killedCost).toEqual({ minerals: 200, gas: 125, unpriced: 0 });
    expect(at.me.units.killedCost).toEqual({ minerals: 100, gas: 25, unpriced: 0 });
  });

  it("keeps unknown-killer and friendly deaths in losses without awarding kills", () => {
    const counts = casualtiesAt(buildCasualtyTimeline([
      event({ owner: "me", killer: null, category: "buildings", name: "Hive" }),
      event({ owner: "me", killer: "me", name: "Zealot" }),
    ]), 10);
    expect(counts.me.buildings.lost).toBe(1);
    expect(counts.me.buildings.lostCost).toEqual({ minerals: 700, gas: 250, unpriced: 0 });
    expect(counts.me.units.lostCost).toEqual({ minerals: 100, gas: 0, unpriced: 0 });
    expect(counts.opp.buildings.killed).toBe(0);
    expect(counts.me.units.killed).toBe(0);
    expect(counts.opp.units.killedCost).toEqual({ minerals: 0, gas: 0, unpriced: 0 });
  });

  it("preserves unknown-type counts and flags incomplete resource subtotals", () => {
    const counts = casualtiesAt(buildCasualtyTimeline([
      event(), event({ name: "NewUnitType" }),
    ]), 10);
    expect(counts.me.units.killed).toBe(2);
    expect(counts.opp.units.lost).toBe(2);
    expect(counts.me.units.killedCost).toEqual({ minerals: 50, gas: 0, unpriced: 1 });
    expect(counts.opp.units.lostCost).toEqual(counts.me.units.killedCost);
  });

  it("uses the replay patch era and keeps worker and structure costs separate", () => {
    const events = [
      event({ name: "Queen" }),
      event({ category: "workers", name: "Drone" }),
      event({ category: "buildings", name: "SpawningPool" }),
    ];
    const before = casualtiesAt(buildCasualtyTimeline(events, "before"), 10);
    const after = casualtiesAt(buildCasualtyTimeline(events, "after"), 10);
    expect(before.me.units.killedCost.minerals).toBe(150);
    expect(after.me.units.killedCost.minerals).toBe(175);
    expect(after.me.workers.killedCost.minerals).toBe(50);
    expect(after.me.buildings.killedCost.minerals).toBe(250);
  });

  it("ignores invalid timestamps and returns independent empty totals outside the timeline", () => {
    const timeline = buildCasualtyTimeline([
      event({ time: -1 }), event({ time: Number.NaN }), event({ time: Number.POSITIVE_INFINITY }),
    ]);
    expect(timeline).toEqual([]);
    const empty = emptyCasualtyCounts();
    empty.me.units.lostCost.minerals = 100;
    expect(empty.me.units.killedCost.minerals).toBe(0);
    expect(empty.me.workers.lostCost.minerals).toBe(0);
    expect(empty.opp.units.lostCost.minerals).toBe(0);
    for (const time of [-1, Number.NaN, Number.POSITIVE_INFINITY, 10]) {
      expect(casualtiesAt(timeline, time)).toEqual(emptyCasualtyCounts());
    }
  });
});
