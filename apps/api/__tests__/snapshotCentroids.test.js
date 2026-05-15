// @ts-nocheck
"use strict";

const {
  SnapshotCentroidsService,
  cosineSimilarity,
  indexUnitTimeline,
  deltaRows,
} = require("../src/services/snapshotCentroids");

describe("cosineSimilarity", () => {
  test("identical vectors -> 1", () => {
    expect(cosineSimilarity({ Stalker: 4, Probe: 30 }, { Stalker: 4, Probe: 30 })).toBeCloseTo(1, 5);
  });

  test("orthogonal vectors -> 0", () => {
    expect(cosineSimilarity({ Stalker: 4 }, { Marine: 4 })).toBe(0);
  });

  test("zero-norm vector -> 0", () => {
    expect(cosineSimilarity({}, { Stalker: 4 })).toBe(0);
    expect(cosineSimilarity({ Stalker: 4 }, {})).toBe(0);
  });

  test("scaled vectors -> 1", () => {
    expect(cosineSimilarity({ Stalker: 4, Probe: 30 }, { Stalker: 8, Probe: 60 })).toBeCloseTo(1, 5);
  });
});

describe("indexUnitTimeline", () => {
  test("buckets by 30s ticks", () => {
    const timeline = [
      { time: 0, my: { Probe: 12 }, opp: { Drone: 12 } },
      { time: 30, my: { Probe: 14 } },
      { time: 35, my: { Probe: 15 } },
    ];
    const { my } = indexUnitTimeline(timeline);
    expect(my.get(0)).toEqual({ Probe: 12 });
    expect(my.get(30).Probe).toBe(15);
  });

  test("empty input yields empty maps", () => {
    const { my, opp } = indexUnitTimeline(undefined);
    expect(my.size).toBe(0);
    expect(opp.size).toBe(0);
  });
});

describe("SnapshotCentroidsService.computeCentroids", () => {
  test("computes mean unit counts per tick across winners and losers", () => {
    const games = [
      { userId: "u1", gameId: "g1", result: "Victory", myRace: "Protoss" },
      { userId: "u1", gameId: "g2", result: "Victory", myRace: "Protoss" },
      { userId: "u1", gameId: "g3", result: "Defeat", myRace: "Protoss" },
    ];
    const details = new Map([
      ["u1:g1", buildDetail([{ time: 360, my: { Probe: 60, Stalker: 6 }, opp: {} }])],
      ["u1:g2", buildDetail([{ time: 360, my: { Probe: 60, Stalker: 8 }, opp: {} }])],
      ["u1:g3", buildDetail([{ time: 360, my: { Probe: 40, Stalker: 4 }, opp: {} }])],
    ]);
    const svc = new SnapshotCentroidsService();
    const centroids = svc.computeCentroids(games, details);
    expect(centroids.my.size).toBe(0);
  });

  test("emits a centroid row once MIN_TICK_SAMPLES winners are present", () => {
    const games = [];
    const details = new Map();
    for (let i = 0; i < 8; i += 1) {
      const gameId = `g${i}`;
      games.push({ userId: "u1", gameId, result: "Victory", myRace: "Protoss" });
      details.set(`u1:${gameId}`, buildDetail([{ time: 360, my: { Probe: 60, Stalker: 6 + i }, opp: {} }]));
    }
    const svc = new SnapshotCentroidsService();
    const centroids = svc.computeCentroids(games, details);
    const tick360 = centroids.my.get(360);
    expect(tick360).toBeDefined();
    expect(tick360.winnerCentroid.Probe).toBe(60);
    expect(tick360.winnerCentroid.Stalker).toBeCloseTo((6 + 7 + 8 + 9 + 10 + 11 + 12 + 13) / 8, 5);
  });
});

describe("deltaRows", () => {
  test("sorts by absolute delta and reports per-unit info", () => {
    const mine = { Probe: 60, Stalker: 8, Phoenix: 0 };
    const centroid = {
      winnerCentroid: { Probe: 58, Stalker: 4, Phoenix: 3 },
      winnerMedian: { Probe: 58, Stalker: 4, Phoenix: 3 },
    };
    const rows = deltaRows(mine, centroid);
    expect(rows[0].unit).toBe("Stalker");
    expect(rows[0].delta).toBe(4);
    expect(rows.find((r) => r.unit === "Phoenix").delta).toBe(-3);
  });

  test("returns empty array when centroid missing", () => {
    expect(deltaRows({ Probe: 10 }, undefined)).toEqual([]);
  });
});

function buildDetail(timeline) {
  return { macroBreakdown: { unit_timeline: timeline } };
}
