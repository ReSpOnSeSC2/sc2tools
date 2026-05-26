"use strict";

/**
 * Tests for autoClassify/deriveBuild.
 *
 * Each test hand-builds a small fixture of game-shaped objects with
 * synthetic `events` lists (the same shape `parseBuildLogLines`
 * emits), then runs the discovery engine end-to-end:
 *
 *   game events → clusterGames → deriveRules / deriveName
 *
 * Hermetic: no replay parsing, no Mongo, no on-disk fixtures.
 *
 * Acceptance scenarios from the discovery-engine spec:
 *   1. Derived rules pass validation/customBuild.js (slug + name +
 *      race + v3 rules with the right shape).
 *   2. Every game in the cluster passes evaluateRules with the
 *      derived rules (self-match round-trips with the rule engine).
 *   3. Names are deterministic (same inputs → same output) and
 *      collision-stable (same representative signature → same slug,
 *      regardless of underlying gameId set).
 *
 * Plus sanity for the not_before discriminator, MAX_DERIVED_RULES
 * cap, (Fast) suffix, time_lt 15-second grid, and rule-name regex.
 */

const {
  deriveRules,
  deriveName,
  MIN_SELF_MATCH_RATE,
  MAX_DERIVED_RULES,
} = require("../src/services/autoClassify/deriveBuild");
const {
  clusterGames: doCluster,
} = require("../src/services/autoClassify/cluster");
const { evaluateRules } = require("../src/services/buildRulesEvaluator");
const { validateCustomBuild } = require("../src/validation/customBuild");

function building(name, time) {
  return { name, time, is_building: true, category: "building" };
}
function unit(name, time) {
  return { name, time, category: "unit" };
}

/** Stargate → Phoenix → FleetBeacon → Tempest opening, with wobble. */
function stargateOpening(w = 0) {
  return [
    building("Gateway", 75 + w),
    building("CyberneticsCore", 115 + w),
    building("Stargate", 200 + w),
    unit("Phoenix", 280 + w),
    building("FleetBeacon", 310 + w),
    unit("Tempest", 400 + w),
  ];
}

/** Robo → Immortal → Colossus opening. */
function roboOpening(w = 0) {
  return [
    building("Gateway", 78 + w),
    building("CyberneticsCore", 118 + w),
    building("RoboticsFacility", 200 + w),
    unit("Immortal", 285 + w),
    unit("Observer", 310 + w),
    building("RoboticsBay", 330 + w),
    unit("Colossus", 410 + w),
  ];
}

/** Stargate-first transitioning into Robotics — the spec example. */
function stargateIntoRobo(w = 0) {
  return [
    building("Gateway", 75 + w),
    building("CyberneticsCore", 115 + w),
    building("Stargate", 200 + w),
    unit("Phoenix", 280 + w),
    building("RoboticsFacility", 320 + w),
    unit("Immortal", 410 + w),
  ];
}

function game(gameId, events, result = "Win") {
  return { gameId, events, result, date: "2026-01-01", map: "Goldenaura LE" };
}

function buildCluster(games) {
  const clusters = doCluster(games);
  expect(clusters.length).toBeGreaterThanOrEqual(1);
  return clusters[0];
}

function fiveStargateGames() {
  return [
    game("g1", stargateOpening(0)),
    game("g2", stargateOpening(2)),
    game("g3", stargateOpening(4)),
    game("g4", stargateOpening(6)),
    game("g5", stargateOpening(8)),
  ];
}

describe("deriveRules — output shape", () => {
  test("returns null for an empty / invalid cluster input", () => {
    expect(deriveRules(null, [])).toBeNull();
    expect(deriveRules({ representativeSignature: [] }, [])).toBeNull();
    expect(deriveRules({ representativeSignature: [] }, null)).toBeNull();
  });

  test("derived rules round-trip through validateCustomBuild", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    expect(result).not.toBeNull();
    expect(Array.isArray(result.rules)).toBe(true);
    expect(result.rules.length).toBeGreaterThan(0);

    const candidate = {
      slug: "auto-test-stargate",
      name: "PvZ - Stargate into Fleet Beacon",
      race: "Protoss",
      rules: result.rules,
    };
    const v = validateCustomBuild(candidate);
    expect(v.valid).toBe(true);
  });

  test("never emits more than MAX_DERIVED_RULES rules", () => {
    // Same opening across 5 games with 7 distinct non-economy tokens
    // — force the cap to engage.
    const events = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
      building("FleetBeacon", 310),
      building("TwilightCouncil", 360),
      unit("Tempest", 400),
    ];
    const games = [
      game("g1", events),
      game("g2", events),
      game("g3", events),
      game("g4", events),
      game("g5", events),
    ];
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    expect(result).not.toBeNull();
    expect(result.rules.length).toBeLessThanOrEqual(MAX_DERIVED_RULES);
  });

  test("rule names match ^[A-Za-z][A-Za-z0-9]*$", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    const re = /^[A-Za-z][A-Za-z0-9]*$/;
    for (const r of result.rules) {
      expect(re.test(r.name)).toBe(true);
    }
  });

  test("time_lt is a multiple of 15 within [1, 1800]", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    for (const r of result.rules) {
      expect(r.time_lt).toBeGreaterThanOrEqual(1);
      expect(r.time_lt).toBeLessThanOrEqual(1800);
      expect(r.time_lt % 15).toBe(0);
    }
  });
});

describe("deriveRules — self-match round-trip", () => {
  test("every game in a tight Stargate cluster passes evaluateRules", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    expect(result).not.toBeNull();
    expect(result.selfMatchRate).toBe(1);
    for (const g of games) {
      const r = evaluateRules(result.rules, g.events);
      expect(r.pass).toBe(true);
    }
  });

  test("every game in a Robo cluster passes evaluateRules", () => {
    const games = [
      game("g1", roboOpening(0)),
      game("g2", roboOpening(2)),
      game("g3", roboOpening(4)),
      game("g4", roboOpening(6)),
      game("g5", roboOpening(8)),
    ];
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    expect(result).not.toBeNull();
    for (const g of games) {
      expect(evaluateRules(result.rules, g.events).pass).toBe(true);
    }
  });

  test("selfMatchRate is ≥ MIN_SELF_MATCH_RATE on success", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    expect(result.selfMatchRate).toBeGreaterThanOrEqual(MIN_SELF_MATCH_RATE);
  });
});

describe("deriveRules — discriminator", () => {
  test("Stargate cluster includes a not_before for BuildRoboticsFacility", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    const notBefore = result.rules.find((r) => r.type === "not_before");
    expect(notBefore).toBeDefined();
    expect(notBefore.name).toBe("BuildRoboticsFacility");
  });

  test("Robo cluster includes a not_before for BuildStargate", () => {
    const games = [
      game("g1", roboOpening(0)),
      game("g2", roboOpening(2)),
      game("g3", roboOpening(4)),
      game("g4", roboOpening(6)),
      game("g5", roboOpening(8)),
    ];
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    const notBefore = result.rules.find((r) => r.type === "not_before");
    expect(notBefore).toBeDefined();
    expect(notBefore.name).toBe("BuildStargate");
  });

  test("Stargate-into-Robo cluster falls through to BuildTwilightCouncil", () => {
    // Both Stargate AND Robo are committed by the cluster — the
    // first-listed alternative (Robo) is NOT absent, so the
    // discriminator falls through to BuildTwilightCouncil.
    const games = [
      game("g1", stargateIntoRobo(0)),
      game("g2", stargateIntoRobo(2)),
      game("g3", stargateIntoRobo(4)),
      game("g4", stargateIntoRobo(6)),
      game("g5", stargateIntoRobo(8)),
    ];
    const cluster = buildCluster(games);
    const result = deriveRules(cluster, games);
    const notBefore = result.rules.find((r) => r.type === "not_before");
    expect(notBefore).toBeDefined();
    expect(notBefore.name).toBe("BuildTwilightCouncil");
  });
});

describe("deriveName — naming", () => {
  test("matches the example: 'PvZ - Stargate into Robo'", () => {
    const games = [
      game("g1", stargateIntoRobo(0)),
      game("g2", stargateIntoRobo(2)),
      game("g3", stargateIntoRobo(4)),
      game("g4", stargateIntoRobo(6)),
      game("g5", stargateIntoRobo(8)),
    ];
    const cluster = buildCluster(games);
    const r = deriveName("PvZ", cluster, games);
    expect(r).not.toBeNull();
    expect(r.name).toBe("PvZ - Stargate into Robo");
  });

  test("Robo-first cluster names as 'PvT - Robo ...'", () => {
    const games = [
      game("g1", roboOpening(0)),
      game("g2", roboOpening(2)),
      game("g3", roboOpening(4)),
      game("g4", roboOpening(6)),
      game("g5", roboOpening(8)),
    ];
    const cluster = buildCluster(games);
    const r = deriveName("PvT", cluster, games);
    expect(r.name.startsWith("PvT - Robo")).toBe(true);
  });

  test("matchup prefix uses the caller's argument", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    expect(deriveName("PvZ", cluster, games).name.startsWith("PvZ - ")).toBe(true);
    expect(deriveName("PvT", cluster, games).name.startsWith("PvT - ")).toBe(true);
  });
});

describe("deriveName — Fast suffix", () => {
  test("appends (Fast) when lead-tech p50 is below the threshold", () => {
    // Stargate at ~150s — comfortably below the 210s FAST threshold.
    const fast = (w = 0) => [
      building("Gateway", 50 + w),
      building("CyberneticsCore", 90 + w),
      building("Stargate", 150 + w),
      unit("Phoenix", 220 + w),
      building("FleetBeacon", 250 + w),
      unit("Tempest", 350 + w),
    ];
    const games = [
      game("g1", fast(0)),
      game("g2", fast(2)),
      game("g3", fast(4)),
      game("g4", fast(6)),
      game("g5", fast(8)),
    ];
    const cluster = buildCluster(games);
    const r = deriveName("PvZ", cluster, games);
    expect(r.name).toMatch(/\(Fast\)$/);
  });

  test("no (Fast) suffix for a typical Stargate timing", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const r = deriveName("PvZ", cluster, games);
    expect(r.name).not.toMatch(/\(Fast\)/);
  });
});

describe("deriveName — determinism + collision stability", () => {
  test("same inputs → same name and slug", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const a = deriveName("PvZ", cluster, games);
    const b = deriveName("PvZ", cluster, games);
    expect(a.name).toBe(b.name);
    expect(a.slug).toBe(b.slug);
  });

  test("same signature, different gameIds → same slug", () => {
    const games1 = fiveStargateGames();
    const games2 = [
      game("x1", stargateOpening(0)),
      game("x2", stargateOpening(2)),
      game("x3", stargateOpening(4)),
      game("x4", stargateOpening(6)),
      game("x5", stargateOpening(8)),
    ];
    const c1 = buildCluster(games1);
    const c2 = buildCluster(games2);
    // Sanity: the medoid signatures should match — both clusters'
    // games are stargateOpening(...) shifted by the same wobbles, so
    // the medoid (mid-wobble game) has identical events in both.
    expect(c1.representativeSignature.map((s) => s.token)).toEqual(
      c2.representativeSignature.map((s) => s.token),
    );
    const n1 = deriveName("PvZ", c1, games1);
    const n2 = deriveName("PvZ", c2, games2);
    expect(n1.slug).toBe(n2.slug);
  });

  test("different signatures → different slugs", () => {
    const sg = fiveStargateGames();
    const rb = [
      game("r1", roboOpening(0)),
      game("r2", roboOpening(2)),
      game("r3", roboOpening(4)),
      game("r4", roboOpening(6)),
      game("r5", roboOpening(8)),
    ];
    const c1 = buildCluster(sg);
    const c2 = buildCluster(rb);
    const n1 = deriveName("PvZ", c1, sg);
    const n2 = deriveName("PvZ", c2, rb);
    expect(n1.slug).not.toBe(n2.slug);
  });

  test("different matchups → different slugs for the same cluster", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const a = deriveName("PvZ", cluster, games);
    const b = deriveName("PvT", cluster, games);
    expect(a.slug).not.toBe(b.slug);
  });

  test("slug matches ^[a-zA-Z0-9._-]+$ (customBuild validator)", () => {
    const games = fiveStargateGames();
    const cluster = buildCluster(games);
    const r = deriveName("PvZ", cluster, games);
    expect(r.slug).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});
