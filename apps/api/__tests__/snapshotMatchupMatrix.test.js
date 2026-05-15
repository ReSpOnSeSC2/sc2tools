// @ts-nocheck
"use strict";

const {
  SnapshotMatchupMatrixService,
  unitDelta,
  verdictFromRate,
  NEUTRAL_BAND,
  RACE_UNITS,
} = require("../src/services/snapshotMatchupMatrix");

const SVC = new SnapshotMatchupMatrixService();

function makeFrame(time, my, opp) {
  return { time, my, opp };
}

function makeGameDetail(myUnits, oppUnits) {
  return {
    macroBreakdown: { unit_timeline: [makeFrame(360, myUnits, oppUnits)] },
  };
}

describe("SnapshotMatchupMatrixService.buildMatrix", () => {
  test("returns empty matrix when no cohort games", () => {
    const m = SVC.buildMatrix([], new Map(), 360);
    expect(m.myClusters).toEqual([]);
    expect(m.rows).toEqual([]);
  });

  test("builds K×K grid from real-shape cohort games", () => {
    const games = [];
    const details = new Map();
    for (let i = 0; i < 12; i += 1) {
      const id = `g${i}`;
      games.push({
        userId: "u1",
        gameId: id,
        result: i < 6 ? "Victory" : "Defeat",
        myRace: "Protoss",
        opponent: { race: "Zerg" },
      });
      const myUnits = i % 2 === 0
        ? { Stalker: 8, Sentry: 2 }
        : { Phoenix: 6, Stalker: 2 };
      const oppUnits = i < 6
        ? { Zergling: 12, Baneling: 4 }
        : { Roach: 8, Ravager: 2 };
      details.set(`u1:${id}`, makeGameDetail(myUnits, oppUnits));
    }
    const m = SVC.buildMatrix(games, details, 360);
    expect(m.myClusters.length).toBeGreaterThan(1);
    expect(m.oppClusters.length).toBeGreaterThan(1);
    expect(m.rows.length).toBe(m.myClusters.length);
    expect(m.rows[0].length).toBe(m.oppClusters.length);
    // Every cell should carry sampleSize + winRate + CI.
    for (const row of m.rows) {
      for (const cell of row) {
        expect(cell).toHaveProperty("sampleSize");
        expect(cell).toHaveProperty("winRate");
        expect(cell).toHaveProperty("ci");
      }
    }
  });
});

describe("SnapshotMatchupMatrixService.resolveFocal", () => {
  test("assigns a focal vector to the nearest cluster + returns row + counters", () => {
    const games = [];
    const details = new Map();
    for (let i = 0; i < 12; i += 1) {
      const id = `g${i}`;
      games.push({
        userId: "u1",
        gameId: id,
        result: i % 2 === 0 ? "Victory" : "Defeat",
        myRace: "Protoss",
        opponent: { race: "Zerg" },
      });
      const myUnits = i < 6
        ? { Stalker: 8, Sentry: 2 }
        : { Phoenix: 6, Stalker: 1 };
      details.set(`u1:${id}`, makeGameDetail(myUnits, { Roach: 6, Zergling: 6 }));
    }
    const matrix = SVC.buildMatrix(games, details, 360);
    const resolved = SVC.resolveFocal(
      { units: { Phoenix: 5, Stalker: 1 }, race: "P" },
      { units: { Roach: 6, Zergling: 6 }, race: "Z" },
      matrix,
    );
    expect(resolved).toBeTruthy();
    expect(resolved.fullRow.length).toBe(matrix.oppClusters.length);
    expect(["favorable", "neutral", "unfavorable"]).toContain(resolved.verdict);
  });
});

describe("counterSuggestions race validation", () => {
  test("unitDelta only suggests units allowed for the focal race", () => {
    const target = { Hatchery: 3, Drone: 30 };
    const focal = { Probe: 30, Stalker: 4 };
    const diff = unitDelta(focal, target, "P");
    // Hatchery is Zerg — must not appear in toAdd for a Protoss focal.
    expect(diff.toAdd.Hatchery).toBeUndefined();
  });

  test("unitDelta reports positive deltas as toAdd and negative as toRemove", () => {
    const focal = { Stalker: 8, Phoenix: 2 };
    const target = { Stalker: 4, Immortal: 3 };
    const diff = unitDelta(focal, target, "P");
    expect(diff.toAdd.Immortal).toBe(3);
    expect(diff.toRemove.Stalker).toBe(4);
  });
});

describe("verdictFromRate", () => {
  test("≥ upper neutral band = favorable", () => {
    expect(verdictFromRate(NEUTRAL_BAND[1] + 0.01)).toBe("favorable");
  });
  test("≤ lower neutral band = unfavorable", () => {
    expect(verdictFromRate(NEUTRAL_BAND[0] - 0.01)).toBe("unfavorable");
  });
  test("inside band = neutral", () => {
    expect(verdictFromRate(0.5)).toBe("neutral");
  });
});

describe("RACE_UNITS", () => {
  test("covers all three races", () => {
    expect(RACE_UNITS.P.size).toBeGreaterThan(0);
    expect(RACE_UNITS.T.size).toBeGreaterThan(0);
    expect(RACE_UNITS.Z.size).toBeGreaterThan(0);
  });
});
