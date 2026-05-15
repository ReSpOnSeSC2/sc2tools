// @ts-nocheck
"use strict";

const {
  SnapshotCompareService,
  classifyPosition,
  verdictFor,
  scoreSide,
  VERDICTS,
} = require("../src/services/snapshotCompare");

describe("classifyPosition", () => {
  const band = { p25l: 100, p50l: 200, p75l: 250, p25w: 250, p50w: 300, p75w: 400, p90w: 500 };

  test("v >= p75w returns +2 (winning)", () => {
    expect(classifyPosition(400, band)).toBe(2);
    expect(classifyPosition(450, band)).toBe(2);
  });

  test("p50w <= v < p75w returns +1 (likely winning)", () => {
    expect(classifyPosition(350, band)).toBe(1);
    expect(classifyPosition(300, band)).toBe(1);
  });

  test("p50l < v < p50w returns 0 (neutral)", () => {
    expect(classifyPosition(220, band)).toBe(0);
    expect(classifyPosition(290, band)).toBe(0);
  });

  test("p25l < v <= p50l returns -1 (likely losing)", () => {
    expect(classifyPosition(150, band)).toBe(-1);
    expect(classifyPosition(200, band)).toBe(-1);
  });

  test("v <= p25l returns -2 (losing)", () => {
    expect(classifyPosition(50, band)).toBe(-2);
    expect(classifyPosition(100, band)).toBe(-2);
  });
});

describe("verdictFor", () => {
  test("strong positive diff is winning", () => {
    expect(verdictFor(1.5, 0)).toBe(VERDICTS.WINNING);
    expect(verdictFor(2, -1)).toBe(VERDICTS.WINNING);
  });

  test("moderate positive is likely winning", () => {
    expect(verdictFor(0.4, 0)).toBe(VERDICTS.LIKELY_WINNING);
  });

  test("near zero is neutral", () => {
    expect(verdictFor(0.1, 0)).toBe(VERDICTS.NEUTRAL);
    expect(verdictFor(0, 0)).toBe(VERDICTS.NEUTRAL);
    expect(verdictFor(-0.2, 0)).toBe(VERDICTS.NEUTRAL);
  });

  test("moderate negative is likely losing", () => {
    expect(verdictFor(-0.5, 0)).toBe(VERDICTS.LIKELY_LOSING);
  });

  test("strong negative is losing", () => {
    expect(verdictFor(-1.5, 0)).toBe(VERDICTS.LOSING);
  });
});

describe("scoreSide", () => {
  test("aggregates weighted score over metrics with data", () => {
    const bands = {
      army_value: { p25l: 0, p50l: 100, p75l: 150, p25w: 200, p50w: 300, p75w: 400, p90w: 500 },
      workers: { p25l: 0, p50l: 30, p75l: 40, p25w: 45, p50w: 55, p75w: 65, p90w: 75 },
    };
    const values = { army_value: 500, workers: 30, army_supply: null, bases: null, income_min: null, income_gas: null };
    const result = scoreSide(values, bands);
    expect(result.scores.army_value).toBe(2);
    expect(result.scores.workers).toBe(-1);
    expect(result.aggregate).toBeGreaterThan(0);
  });

  test("returns zero aggregate when nothing scoreable", () => {
    const result = scoreSide({}, {});
    expect(result.aggregate).toBe(0);
    expect(Object.keys(result.scores)).toHaveLength(0);
  });
});

describe("SnapshotCompareService", () => {
  test("compareGameToCohort produces per-tick scores and verdicts", () => {
    const svc = new SnapshotCompareService();
    const bands = {
      ticks: [
        {
          t: 0,
          my: { army_value: bandRow(0, 100), workers: bandRow(12, 12) },
          opp: { army_value: bandRow(0, 100), workers: bandRow(12, 12) },
        },
        {
          t: 60,
          my: { army_value: bandRow(50, 200), workers: bandRow(14, 18) },
          opp: { army_value: bandRow(50, 200), workers: bandRow(14, 18) },
        },
      ],
    };
    const detail = {
      macroBreakdown: {
        stats_events: [
          { time: 0, army_value: 0, food_used: 12, workers_active_count: 12, minerals_collection_rate: 0, gas_collection_rate: 0 },
          { time: 60, army_value: 220, food_used: 18, workers_active_count: 18, minerals_collection_rate: 200, gas_collection_rate: 0 },
        ],
        opp_stats_events: [
          { time: 0, army_value: 0, food_used: 12, workers_active_count: 12, minerals_collection_rate: 0, gas_collection_rate: 0 },
          { time: 60, army_value: 50, food_used: 14, workers_active_count: 14, minerals_collection_rate: 100, gas_collection_rate: 0 },
        ],
      },
    };
    const scores = svc.compareGameToCohort(detail, bands, {
      myRace: "Protoss",
      oppRace: "Zerg",
    });
    expect(scores).toHaveLength(2);
    expect(scores[1].my.aggregateScore).toBeGreaterThan(0);
    expect(scores[1].opp.aggregateScore).toBeLessThan(0);
    expect(scores[1].verdict).toMatch(/winning|likely_winning/);
  });

  test("missing tick data yields zero aggregate scores", () => {
    const svc = new SnapshotCompareService();
    const bands = {
      ticks: [
        {
          t: 0,
          my: { army_value: bandRow(0, 100) },
          opp: { army_value: bandRow(0, 100) },
        },
      ],
    };
    const detail = { macroBreakdown: { stats_events: [], opp_stats_events: [], unit_timeline: [] } };
    const scores = svc.compareGameToCohort(detail, bands, { myRace: "P", oppRace: "Z" });
    expect(scores[0].my.aggregateScore).toBe(0);
    expect(scores[0].opp.aggregateScore).toBe(0);
    expect(scores[0].verdict).toBe(VERDICTS.NEUTRAL);
  });
});

function bandRow(loser, winner) {
  return {
    p25l: loser * 0.5,
    p50l: loser,
    p75l: loser * 1.3,
    p25w: winner * 0.7,
    p50w: winner,
    p75w: winner * 1.3,
    p90w: winner * 1.6,
    sampleWinners: 6,
    sampleLosers: 6,
  };
}
