// @ts-nocheck
"use strict";

/**
 * Cloud half of the custom-rule parity contract.
 *
 * A v3 custom build is evaluated twice: on the desktop by the replay
 * engine (`check_custom_rules`, against the replay's events) and here
 * (`evaluateRules`, against the uploaded build log and the agent's proxy
 * stamp). Both suites read the same cases from
 * apps/replay-engine/tests/fixtures/custom_rule_parity.json:
 *
 *   - apps/replay-engine/tests/test_custom_rule_parity.py feeds each
 *     case's `events` to the engine and checks that `build_log` /
 *     `proxies` are exactly what the agent uploads for them;
 *   - this file feeds `build_log` / `proxies` through the pipeline the
 *     reclassifier uses (parseBuildLogLines → eventsToStartTime →
 *     evaluateRules).
 *
 * Both assert the case's `expected` verdict, so a rule cannot match in
 * the cloud and miss on the desktop (or the reverse) without one suite
 * failing. build_durations.json pins the duration tables the same way.
 */

const fs = require("fs");
const path = require("path");

const { evaluateRules } = require("../src/services/buildRulesEvaluator");
const {
  parseBuildLogWithProxies,
  eventsToStartTime,
} = require("../src/services/perGameCompute");
const durations = require("../src/services/buildDurations");
const { PROXY_ELIGIBLE_BUILDING_NAMES } = require("../src/services/knownBuildings");
const {
  PROXY_CLASSIFICATION_VERSION,
  PROXY_DISTANCE_DEFAULT,
  PROXY_DISTANCE_EXPANSION,
  EXPANSION_PROXY_BUILDING_NAMES,
  ownerMain,
  proxyDistanceFor,
  proxyEvidence,
} = require("../src/services/proxyClassification");

const FIXTURES = path.resolve(__dirname, "../../replay-engine/tests/fixtures");

/** @param {string} name */
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

const parity = fixture("custom_rule_parity.json");
const cases = parity.cases.map((c) => [c.name, c]);

/**
 * Evaluate one case the way the reclassifier does for a stored game.
 * @param {any} c fixture case
 * @param {Record<string, any>} spatial the game's stored spatial block
 * @param {"my"|"opp"} [side]
 */
function cloudVerdict(c, spatial, side = "my") {
  const game = { gameVersion: c.game_version, spatial };
  const events = eventsToStartTime(
    // No catalog: the deployed API classifies names from knownBuildings.
    parseBuildLogWithProxies(c.build_log, null, game.spatial, side),
    game,
  );
  return evaluateRules(c.rules, events);
}

/** The spatial block a current agent uploads for a case. */
function currentStamp(c, side = "my") {
  return {
    [`${side}_proxy_classification_v`]: parity.proxy.classification_version,
    // The agent omits the list when nothing is proxied.
    ...(c.proxies.length > 0 ? { [`${side}_proxies`]: c.proxies } : {}),
  };
}

/** Building rows of a case's events, as stored in spatial.buildings. */
function buildingRows(c) {
  return c.events
    .filter((e) => e.type === "building")
    .map(({ name, time, x, y }) => ({ name, time, x, y }));
}

/**
 * What an agent older than the per-structure radius uploaded: every
 * proxy-eligible structure more than a flat 50 units from the main.
 */
function versionOneStamp(c, side = "my") {
  const rows = buildingRows(c);
  const main = ownerMain(rows);
  const proxies = rows.filter((row) => (
    PROXY_ELIGIBLE_BUILDING_NAMES.has(row.name)
    && Math.hypot(row.x - main.x, row.y - main.y) > 50
  ));
  return {
    [`${side}_proxy_classification_v`]: 1,
    ...(proxies.length > 0 ? { [`${side}_proxies`]: proxies } : {}),
    // Only the user's own buildings are stored.
    ...(side === "my" ? { buildings: rows } : {}),
  };
}

describe("custom-rule parity with the desktop evaluator", () => {
  test.each(cases)("%s", (_name, c) => {
    const result = cloudVerdict(c, currentStamp(c));
    expect(result.unavailable).not.toBe(true);
    expect(result.pass).toBe(c.expected);
  });

  test.each(cases)("opponent perspective: %s", (_name, c) => {
    const result = cloudVerdict(c, currentStamp(c, "opp"), "opp");
    expect(result.unavailable).not.toBe(true);
    expect(result.pass).toBe(c.expected);
  });

  test("the cases cover both verdicts, both patch eras and proxy rules", () => {
    expect(new Set(parity.cases.map((c) => c.expected))).toEqual(
      new Set([true, false]),
    );
    expect(new Set(parity.cases.map((c) => c.game_version)).size)
      .toBeGreaterThan(1);
    expect(parity.cases.some((c) => c.rules.some((r) => r.proxy === true)))
      .toBe(true);
    expect(parity.cases.some((c) => c.proxies.length > 0)).toBe(true);
  });
});

describe("shared snapshots", () => {
  test("build-duration tables match the engine's", () => {
    const snapshot = fixture("build_durations.json");
    expect(durations.STRUCTURE_MORPHS).toEqual(snapshot.structure_morph_seconds);
    expect(durations.STRUCTURE_BUILD_SECONDS)
      .toEqual(snapshot.structure_build_seconds);
    expect(durations.UNIT_BUILD_SECONDS).toEqual(snapshot.unit_build_seconds);
    expect(durations.UPGRADE_BUILD_SECONDS)
      .toEqual(snapshot.upgrade_build_seconds);
    expect(durations.EIGHT_WORKER_BUILD_SECONDS)
      .toEqual(snapshot.eight_worker_build_seconds);
  });

  test("proxy geometry matches the engine's", () => {
    expect(PROXY_CLASSIFICATION_VERSION)
      .toBe(parity.proxy.classification_version);
    expect(PROXY_DISTANCE_DEFAULT).toBe(parity.proxy.default_distance);
    expect(PROXY_DISTANCE_EXPANSION).toBe(parity.proxy.expansion_distance);
    expect([...EXPANSION_PROXY_BUILDING_NAMES].sort())
      .toEqual(parity.proxy.expansion_buildings);
    expect(proxyDistanceFor("Hatchery")).toBe(80);
    expect(proxyDistanceFor("SpineCrawler")).toBe(80);
    expect(proxyDistanceFor("Barracks")).toBe(50);
    expect(proxyDistanceFor("Pylon")).toBe(50);
  });
});

describe("games stamped by an older agent (flat 50 units)", () => {
  const thirdHatch = parity.cases.find(
    (c) => c.name === "third Hatchery 51.9 units out is not a proxy",
  );
  const proxyHatch = parity.cases.find(
    (c) => c.name === "Hatchery 81 units out is a proxy",
  );
  const proxyBarracks = parity.cases.find(
    (c) => c.name === "Barracks 51 units out is a proxy",
  );

  test("the old stamp did list the third Hatchery", () => {
    // Non-vacuous: this is the row the re-test has to remove.
    expect(versionOneStamp(thirdHatch).my_proxies).toEqual([
      { name: "Hatchery", time: 178, x: 46, y: 98 },
    ]);
  });

  test.each(cases)("own side is re-tested from the stored main: %s", (_name, c) => {
    const result = cloudVerdict(c, versionOneStamp(c));
    expect(result.unavailable).not.toBe(true);
    expect(result.pass).toBe(c.expected);
  });

  test.each(cases)("opponent side never gives the wrong verdict: %s", (_name, c) => {
    const result = cloudVerdict(c, versionOneStamp(c, "opp"), "opp");
    if (result.unavailable !== true) expect(result.pass).toBe(c.expected);
  });

  test("opponent side: a listed town hall is unknown, not a proxy", () => {
    const third = cloudVerdict(thirdHatch, versionOneStamp(thirdHatch, "opp"), "opp");
    expect(third).toMatchObject({ pass: false, unavailable: true });
    // A real proxy Hatchery is just as undecidable without the main.
    const real = cloudVerdict(proxyHatch, versionOneStamp(proxyHatch, "opp"), "opp");
    expect(real).toMatchObject({ pass: false, unavailable: true });
  });

  test("opponent side: 50-unit structures keep their verdict", () => {
    const result = cloudVerdict(
      proxyBarracks, versionOneStamp(proxyBarracks, "opp"), "opp",
    );
    expect(result.unavailable).not.toBe(true);
    expect(result.pass).toBe(true);
  });

  test("an undecided town hall does not block rules about other structures", () => {
    const stamp = versionOneStamp(thirdHatch, "opp");
    const verdict = (rules) => cloudVerdict({ ...thirdHatch, rules }, stamp, "opp");
    expect(verdict([
      { type: "not_before", name: "BuildSpawningPool", time_lt: 300, proxy: true },
    ])).toMatchObject({ pass: true });
    // ...nor a rule whose window closes before the undecided structure.
    expect(verdict([
      { type: "not_before", name: "BuildHatchery", time_lt: 170, proxy: true },
    ])).toMatchObject({ pass: true });
    expect(verdict([
      { type: "not_before", name: "BuildHatchery", time_lt: 179, proxy: true },
    ])).toMatchObject({ pass: false, unavailable: true });
  });
});

describe("proxyEvidence", () => {
  const rows = [{ name: "Barracks", time: 90, x: 80, y: 80 }];

  test("an unstamped side is unknown", () => {
    expect(proxyEvidence({ my_proxies: rows }, "my"))
      .toEqual({ rows, known: false });
    expect(proxyEvidence(undefined, "my")).toEqual({ rows: undefined, known: false });
    expect(proxyEvidence({ my_proxy_classification_v: 3, my_proxies: rows }, "my").known)
      .toBe(false);
  });

  test("a current stamp is trusted as uploaded", () => {
    const hatch = [{ name: "Hatchery", time: 178, x: 46, y: 98 }];
    expect(proxyEvidence(
      { my_proxy_classification_v: 2, my_proxies: hatch }, "my",
    )).toEqual({ rows: hatch, known: true });
    expect(proxyEvidence({ opp_proxy_classification_v: 2 }, "opp"))
      .toEqual({ rows: undefined, known: true });
  });

  test("a version-1 stamp keeps malformed rows for the fail-closed check", () => {
    const malformed = [{ name: "Hatchery", time: 178, x: "46", y: 98 }];
    expect(proxyEvidence(
      { my_proxy_classification_v: 1, my_proxies: malformed }, "my",
    )).toEqual({ rows: malformed, known: true });
    expect(proxyEvidence(
      { my_proxy_classification_v: 1, my_proxies: null }, "my",
    )).toEqual({ rows: null, known: true });
  });

  test("ownerMain picks the earliest town hall, first listed on a tie", () => {
    expect(ownerMain([
      { name: "Barracks", time: 0, x: 1, y: 1 },
      { name: "OrbitalCommand", time: 114, x: 0, y: 0 },
      { name: "CommandCenter", time: 0, x: 139, y: 163 },
      { name: "CommandCenter", time: 0, x: 20, y: 20 },
    ])).toEqual({ x: 139, y: 163 });
    expect(ownerMain([{ name: "Barracks", time: 0, x: 1, y: 1 }])).toBeNull();
    expect(ownerMain(undefined)).toBeNull();
    // A town hall the engine could not have ordered, or its (0, 0)
    // "no main" sentinel, leaves the main unknown.
    expect(ownerMain([
      { name: "Hatchery", x: 60, y: 48 },
      { name: "Hatchery", time: 57, x: 45, y: 64 },
    ])).toBeNull();
    expect(ownerMain([{ name: "Nexus", time: 0, x: 0, y: 0 }])).toBeNull();
  });
});
