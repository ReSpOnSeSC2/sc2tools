"use strict";

const Dna = require("../src/services/dnaTimings");
const TimingCatalog = require("../src/services/timingCatalog");

describe("dnaTimings.computeMatchupAwareMedianTimings", () => {
  test("returns {} when myRace is unknown", () => {
    expect(Dna.computeMatchupAwareMedianTimings([], "")).toEqual({});
  });

  test("computes median + p25/p75 + trend for opponent's tech", () => {
    const games = [
      makeGame({
        myRace: "Protoss",
        oppRace: "Zerg",
        oppBuildLog: ["[1:30] Pool", "[2:00] Hatchery"],
      }),
      makeGame({
        myRace: "Protoss",
        oppRace: "Zerg",
        oppBuildLog: ["[2:00] SpawningPool", "[3:15] Hatchery"],
      }),
      makeGame({
        myRace: "Protoss",
        oppRace: "Zerg",
        oppBuildLog: ["[1:45] Pool"],
      }),
    ];
    const out = Dna.computeMatchupAwareMedianTimings(games, "P");
    expect(out.SpawningPool.sampleCount).toBe(3);
    expect(out.SpawningPool.medianSeconds).toBe(105); // 1:45
    expect(out.SpawningPool.medianDisplay).toBe("1:45");
    expect(out.SpawningPool.source).toBe("opp_build_log");
    expect(out.Hatchery.sampleCount).toBe(2);
    // Tokens not seen still appear (canonical order, empty rows).
    expect(out.Lair.sampleCount).toBe(0);
    expect(out.Lair.medianDisplay).toBe("-");
  });

  test("uses build_log for the user's-race tokens", () => {
    const games = [
      makeGame({
        myRace: "Protoss",
        oppRace: "Zerg",
        buildLog: ["[2:30] Gateway"],
      }),
    ];
    const out = Dna.computeMatchupAwareMedianTimings(games, "P");
    expect(out.Gateway.source).toBe("build_log");
    expect(out.Gateway.sampleCount).toBe(1);
    expect(out.Gateway.medianDisplay).toBe("2:30");
  });
});

describe("dnaTimings.recencyWeightedStrategies", () => {
  test("returns [] for empty input", () => {
    expect(Dna.recencyWeightedStrategies([])).toEqual([]);
  });

  test("weights last 10 games at 2x", () => {
    const games = [];
    for (let i = 0; i < 8; i++) {
      games.push(makeGame({ oppStrategy: "Recent" })); // i < 10 => weight 2
    }
    for (let i = 0; i < 4; i++) {
      games.push(makeGame({ oppStrategy: "Old" })); // weight 1
    }
    // Newest-first: positions 0..7 = Recent (each 2x); 8..9 = Old (each 2x); 10..11 = Old (each 1x)
    const result = Dna.recencyWeightedStrategies(games);
    expect(result.length).toBe(2);
    expect(result[0].strategy).toBe("Recent");
    expect(result[0].probability).toBeGreaterThan(0.5);
    const sum = result.reduce((a, r) => a + r.probability, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("dnaTimings.resolveMyRace", () => {
  test("falls through Matchup, my_build, build", () => {
    expect(Dna.resolveMyRace([{ myRace: "Protoss" }])).toBe("P");
    expect(Dna.resolveMyRace([{ Matchup: "PvT" }])).toBe("P");
    expect(Dna.resolveMyRace([{ myBuild: "Zerg - 12 Pool" }])).toBe("Z");
    expect(Dna.resolveMyRace([])).toBe("");
  });
});

describe("dnaTimings.topStrategiesFromBy", () => {
  test("sorts by total games descending and slices to limit", () => {
    const by = {
      Macro: { wins: 5, losses: 3 },
      Cheese: { wins: 1, losses: 0 },
      Allin: { wins: 4, losses: 1 },
    };
    const top = Dna.topStrategiesFromBy(by, 2);
    expect(top.length).toBe(2);
    expect(top[0].strategy).toBe("Macro");
    expect(top[0].count).toBe(8);
    expect(top[0].winRate).toBeCloseTo(5 / 8, 5);
    expect(top[1].strategy).toBe("Allin");
  });
});

describe("TimingCatalog", () => {
  test("matchupLabel reflects normalised input", () => {
    expect(TimingCatalog.matchupLabel("Protoss", "Zerg")).toBe("PvZ");
    expect(TimingCatalog.matchupLabel("p", "t")).toBe("PvT");
    expect(TimingCatalog.matchupLabel("", "Z")).toBe("");
  });

  test("relevantTokens unions the two races without duplicates", () => {
    const tokens = TimingCatalog.relevantTokens("P", "Z");
    const internalNames = tokens.map((t) => t.internalName);
    expect(internalNames).toContain("Nexus");
    expect(internalNames).toContain("SpawningPool");
    // No duplicates.
    expect(new Set(internalNames).size).toBe(internalNames.length);
  });
});

function makeGame({
  myRace = "Protoss",
  oppRace = "Zerg",
  buildLog = [],
  oppBuildLog = [],
  oppStrategy = null,
  result = "Victory",
  date = "2026-01-01T00:00:00.000Z",
} = {}) {
  return {
    myRace,
    buildLog,
    oppBuildLog,
    result,
    date,
    map: "Goldenaura",
    opponent: { race: oppRace, strategy: oppStrategy || undefined },
  };
}
