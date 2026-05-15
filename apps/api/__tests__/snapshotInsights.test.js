// @ts-nocheck
"use strict";

const {
  SnapshotInsightsService,
  applyTagRules,
  firstAppearancesFor,
  medianTick,
  severityFor,
} = require("../src/services/snapshotInsights");
const { VERDICTS } = require("../src/services/snapshotCompare");

describe("SnapshotInsightsService.detectInflection", () => {
  test("flags the first neutral->losing transition", () => {
    const svc = new SnapshotInsightsService();
    const ticks = [
      tickRow(0, "winning", { army_value: 2, workers: 2 }),
      tickRow(30, "winning", { army_value: 2, workers: 2 }),
      tickRow(60, "neutral", { army_value: 1, workers: 1 }),
      tickRow(90, "losing", { army_value: -1, workers: -1 }),
    ];
    const out = svc.detectInflection(ticks);
    expect(out.inflectionTick).toBe(90);
    expect(["army_value", "workers"]).toContain(out.primaryMetric);
  });

  test("returns null when no inflection", () => {
    const svc = new SnapshotInsightsService();
    const ticks = [tickRow(0, "winning", { army_value: 2 })];
    expect(svc.detectInflection(ticks).inflectionTick).toBeNull();
  });
});

describe("SnapshotInsightsService.deriveCoachingTags", () => {
  test("emits worker-deficit-early when workers ≤ -1 early", () => {
    const svc = new SnapshotInsightsService();
    const tags = svc.deriveCoachingTags([
      tickRow(180, "neutral", { workers: -1 }),
    ]);
    expect(tags).toEqual([{ t: 180, tags: ["worker-deficit-early"] }]);
  });

  test("emits tech-rushed when army_value high + workers low pre-5min", () => {
    const tags = applyTagRules(tickRow(240, "neutral", { army_value: 2, workers: -1 }));
    expect(tags).toContain("tech-rushed");
  });

  test("emits over-droned when late workers ahead but army behind", () => {
    const tags = applyTagRules(tickRow(540, "neutral", { workers: 2, army_value: -1 }));
    expect(tags).toContain("over-droned");
  });

  test("emits supply-blocked when supply score is -2", () => {
    const tags = applyTagRules(tickRow(120, "neutral", { army_supply: -2 }));
    expect(tags).toContain("supply-blocked");
  });
});

describe("firstAppearancesFor", () => {
  test("captures the first tick a unit reaches a positive count", () => {
    const timeline = [
      { time: 0, my: { Probe: 12 } },
      { time: 60, my: { Probe: 14 } },
      { time: 180, my: { Probe: 18, Stalker: 0 } },
      { time: 240, my: { Probe: 22, Stalker: 2 } },
    ];
    const fa = firstAppearancesFor(timeline);
    expect(fa.get("Probe")).toBe(0);
    expect(fa.get("Stalker")).toBe(240);
  });

  test("returns empty map for missing timeline", () => {
    expect(firstAppearancesFor(undefined).size).toBe(0);
  });
});

describe("medianTick", () => {
  test("returns 30-aligned median of odd-length array", () => {
    expect(medianTick([60, 120, 180])).toBe(120);
  });

  test("returns 30-aligned median of even-length array", () => {
    expect(medianTick([60, 120, 180, 240])).toBe(150);
  });

  test("returns null for empty array", () => {
    expect(medianTick([])).toBeNull();
  });
});

describe("severityFor", () => {
  test("rates high when both share + delay are high", () => {
    expect(severityFor(0.9, 120)).toBe("high");
  });

  test("rates medium when share is high but delay is small", () => {
    expect(severityFor(0.85, 30)).toBe("medium");
  });

  test("rates low when share is small", () => {
    expect(severityFor(0.4, 30)).toBe("low");
  });
});

describe("SnapshotInsightsService.detectTimingMisses", () => {
  test("flags a unit absent from the focus game when winners had it", () => {
    const svc = new SnapshotInsightsService();
    const games = [];
    const details = new Map();
    for (let i = 0; i < 8; i += 1) {
      const id = `g${i}`;
      games.push({ userId: "u1", gameId: id, result: "Victory", myRace: "Protoss" });
      details.set(`u1:${id}`, {
        macroBreakdown: {
          unit_timeline: [
            { time: 300, my: { Stargate: 1 } },
            { time: 330, my: { Stargate: 1 } },
          ],
        },
      });
    }
    const focusTimeline = [{ time: 360, my: { Stalker: 4 } }];
    const misses = svc.detectTimingMisses(games, details, focusTimeline);
    const stargate = misses.find((m) => m.unit === "Stargate");
    expect(stargate).toBeDefined();
    expect(stargate.gameBuiltAt).toBeNull();
    expect(stargate.type).toBe("tech");
  });
});

function tickRow(t, verdict, myScores) {
  return {
    t,
    my: { value: {}, scores: myScores, aggregateScore: 0 },
    opp: { value: {}, scores: {}, aggregateScore: 0 },
    verdict,
  };
}

test.skip("VERDICTS export check", () => {
  expect(VERDICTS).toBeDefined();
});
