"use strict";

/**
 * Tests for autoClassify/cluster.
 *
 * Each test hand-builds a small set of game-shaped objects with
 * synthetic `events` lists and asserts the clustering behavior.
 * Hermetic: no replay parsing, no Mongo, no fixtures.
 *
 * Covers the four acceptance scenarios from the discovery-engine
 * spec:
 *   1. Five near-identical games form one cluster.
 *   2. A sixth wildly different game is excluded.
 *   3. A bucket of only four similar games yields no cluster
 *      (min-5 gate).
 *   4. Cohesion is higher for a tighter group than for a looser one.
 *
 * Plus sanity tests for empty input, win-rate computation, medoid
 * selection, sample-id derivation, deterministic sort order, and
 * robustness to malformed events.
 */

const {
  clusterGames,
  DEFAULT_MIN_GAMES,
  DEFAULT_MAX_DISTANCE,
} = require("../src/services/autoClassify/cluster");

function building(name, time) {
  return { name, time, is_building: true, category: "building" };
}
function unit(name, time) {
  return { name, time, category: "unit" };
}

/**
 * A canonical Stargate → Phoenix → Tempest opening, shifted by
 * `wobbleSec` so we can simulate timing variation between
 * playthroughs of the same build.
 */
function stargateOpening(wobbleSec = 0) {
  return [
    building("Gateway", 75 + wobbleSec),
    building("CyberneticsCore", 115 + wobbleSec),
    building("Stargate", 200 + wobbleSec),
    unit("Phoenix", 280 + wobbleSec),
    building("FleetBeacon", 310 + wobbleSec),
    unit("Tempest", 400 + wobbleSec),
  ];
}

/**
 * A canonical Robo → Immortal → Colossus opening. Distinct from
 * `stargateOpening` from the third token onward, so it falls into a
 * different signatureKey bucket.
 */
function roboOpening(wobbleSec = 0) {
  return [
    building("Gateway", 78 + wobbleSec),
    building("CyberneticsCore", 118 + wobbleSec),
    building("RoboticsFacility", 200 + wobbleSec),
    unit("Immortal", 285 + wobbleSec),
    unit("Observer", 310 + wobbleSec),
    building("RoboticsBay", 330 + wobbleSec),
    unit("Colossus", 410 + wobbleSec),
  ];
}

function game(gameId, events, result = "Win") {
  return { gameId, events, result, date: "2026-01-01", map: "Goldenaura LE" };
}

describe("clusterGames — basics", () => {
  test("returns [] for empty / non-array input", () => {
    expect(clusterGames(null)).toEqual([]);
    expect(clusterGames(undefined)).toEqual([]);
    expect(clusterGames([])).toEqual([]);
  });

  test("exported defaults match the discovery-engine spec", () => {
    expect(DEFAULT_MIN_GAMES).toBe(5);
    expect(DEFAULT_MAX_DISTANCE).toBe(0.2);
  });
});

describe("clusterGames — acceptance scenarios", () => {
  test("5 near-identical games form one cluster", () => {
    const games = [
      game("g1", stargateOpening(0)),
      game("g2", stargateOpening(2)),
      game("g3", stargateOpening(4)),
      game("g4", stargateOpening(6)),
      game("g5", stargateOpening(8)),
    ];
    const clusters = clusterGames(games);
    expect(clusters).toHaveLength(1);
    const [c] = clusters;
    expect(c.size).toBe(5);
    expect([...c.gameIds].sort()).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    expect(c.representativeSignature.length).toBeGreaterThan(0);
    expect(c.cohesion).toBeGreaterThan(0.85);
    // Central game by wobble (g3, wobble 4) has the minimum total
    // distance to the rest — it should be picked as the medoid.
    expect(c.medoidGameId).toBe("g3");
  });

  test("a 6th wildly different game is excluded from the cluster", () => {
    const games = [
      game("g1", stargateOpening(0)),
      game("g2", stargateOpening(2)),
      game("g3", stargateOpening(4)),
      game("g4", stargateOpening(6)),
      game("g5", stargateOpening(8)),
      // Robo opening — first six tokens differ from the Stargate
      // games, so it falls into a different signatureKey bucket and
      // can never end up in the same cluster.
      game("g6", roboOpening(0)),
    ];
    const clusters = clusterGames(games);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(5);
    expect(clusters[0].gameIds).not.toContain("g6");
  });

  test("a bucket of only 4 similar games yields no cluster (min-5 gate)", () => {
    const games = [
      game("g1", stargateOpening(0)),
      game("g2", stargateOpening(2)),
      game("g3", stargateOpening(4)),
      game("g4", stargateOpening(6)),
    ];
    expect(clusterGames(games)).toEqual([]);
  });

  test("cohesion is higher for a tighter group than for a looser one", () => {
    // Tight: five games with up to 8s of timing wobble each.
    const tightGames = [
      game("t1", stargateOpening(0)),
      game("t2", stargateOpening(2)),
      game("t3", stargateOpening(4)),
      game("t4", stargateOpening(6)),
      game("t5", stargateOpening(8)),
    ];
    // Loose: five games with up to 40s of timing wobble each — same
    // tokens / order, so they still single-link into one cluster,
    // but with markedly larger mean intra-cluster distance.
    const looseGames = [
      game("l1", stargateOpening(0)),
      game("l2", stargateOpening(10)),
      game("l3", stargateOpening(20)),
      game("l4", stargateOpening(30)),
      game("l5", stargateOpening(40)),
    ];
    const [tight] = clusterGames(tightGames);
    const [loose] = clusterGames(looseGames);
    expect(tight).toBeDefined();
    expect(loose).toBeDefined();
    expect(tight.size).toBe(5);
    expect(loose.size).toBe(5);
    expect(tight.cohesion).toBeGreaterThan(loose.cohesion);
  });
});

describe("clusterGames — derived fields", () => {
  test("winRate is computed from result == 'Win' / 'Loss' (Unknown excluded)", () => {
    const games = [
      game("g1", stargateOpening(0), "Win"),
      game("g2", stargateOpening(2), "Win"),
      game("g3", stargateOpening(4), "Loss"),
      game("g4", stargateOpening(6), "Win"),
      game("g5", stargateOpening(8), "Unknown"),
    ];
    const [c] = clusterGames(games);
    expect(c.size).toBe(5);
    // 3 wins / 4 W+L → 0.75 (the Unknown is excluded from the
    // denominator, matching the rest of the cloud's win-rate code).
    expect(c.winRate).toBeCloseTo(0.75, 5);
  });

  test("sampleGameIds starts with the medoid and is capped at 5", () => {
    const games = [
      game("g1", stargateOpening(0)),
      game("g2", stargateOpening(2)),
      game("g3", stargateOpening(4)),
      game("g4", stargateOpening(6)),
      game("g5", stargateOpening(8)),
      game("g6", stargateOpening(10)),
      game("g7", stargateOpening(12)),
    ];
    const [c] = clusterGames(games);
    expect(c.size).toBe(7);
    expect(c.sampleGameIds[0]).toBe(c.medoidGameId);
    expect(c.sampleGameIds.length).toBeLessThanOrEqual(5);
    for (const id of c.sampleGameIds) expect(c.gameIds).toContain(id);
  });

  test("clusters are sorted by size desc, then cohesion desc", () => {
    const games = [
      // Six tight Stargate games.
      game("s1", stargateOpening(0)),
      game("s2", stargateOpening(2)),
      game("s3", stargateOpening(4)),
      game("s4", stargateOpening(6)),
      game("s5", stargateOpening(8)),
      game("s6", stargateOpening(10)),
      // Five tight Robo games.
      game("r1", roboOpening(0)),
      game("r2", roboOpening(2)),
      game("r3", roboOpening(4)),
      game("r4", roboOpening(6)),
      game("r5", roboOpening(8)),
    ];
    const clusters = clusterGames(games);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].size).toBe(6);
    expect(clusters[1].size).toBe(5);
    // Stargate cluster's gameIds all start with "s"; Robo with "r".
    expect(clusters[0].gameIds.every((id) => id.startsWith("s"))).toBe(true);
    expect(clusters[1].gameIds.every((id) => id.startsWith("r"))).toBe(true);
  });

  test("representativeSignature is the medoid's signature", () => {
    const games = [
      game("g1", stargateOpening(0)),
      game("g2", stargateOpening(2)),
      game("g3", stargateOpening(4)),
      game("g4", stargateOpening(6)),
      game("g5", stargateOpening(8)),
    ];
    const [c] = clusterGames(games);
    const tokens = c.representativeSignature.map((s) => s.token);
    expect(tokens).toEqual([
      "BuildGateway",
      "BuildCyberneticsCore",
      "BuildStargate",
      "BuildPhoenix",
      "BuildFleetBeacon",
      "BuildTempest",
    ]);
  });
});

describe("clusterGames — robustness", () => {
  test("games with no events / empty signature don't form clusters", () => {
    const games = [
      game("g1", []),
      game("g2", []),
      game("g3", []),
      game("g4", []),
      game("g5", []),
    ];
    expect(clusterGames(games)).toEqual([]);
  });

  test("respects a custom minGames option", () => {
    const games = [
      game("g1", stargateOpening(0)),
      game("g2", stargateOpening(2)),
      game("g3", stargateOpening(4)),
    ];
    expect(clusterGames(games, { minGames: 3 })).toHaveLength(1);
    expect(clusterGames(games, { minGames: 4 })).toEqual([]);
  });

  test("a stricter maxDistance can split a bucket into sub-clusters", () => {
    // Two sub-groups within one signatureKey bucket: 3 games with
    // ~0-8s wobble, 3 games with ~80-88s wobble. Between-group
    // timing delta ~80s → between-group distance ~0.3 * 80/480 ≈
    // 0.05, which would single-link at the default threshold.
    // Setting maxDistance below that splits them apart; at the same
    // time the per-group sub-clusters still pass the 3-game gate.
    const games = [
      game("a1", stargateOpening(0)),
      game("a2", stargateOpening(4)),
      game("a3", stargateOpening(8)),
      game("b1", stargateOpening(80)),
      game("b2", stargateOpening(84)),
      game("b3", stargateOpening(88)),
    ];
    const clusters = clusterGames(games, { minGames: 3, maxDistance: 0.02 });
    expect(clusters).toHaveLength(2);
    expect(clusters[0].size).toBe(3);
    expect(clusters[1].size).toBe(3);
    const a = clusters.find((c) => c.gameIds.includes("a1"));
    const b = clusters.find((c) => c.gameIds.includes("b1"));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.gameIds.sort()).toEqual(["a1", "a2", "a3"]);
    expect(b.gameIds.sort()).toEqual(["b1", "b2", "b3"]);
  });
});
