"use strict";

/**
 * Anti-hallucination prerequisite tests for buildRulesEvaluator.
 *
 * The evaluator powers /v1/custom-builds/preview-matches and
 * /v1/custom-builds/reclassify. Without the prereq filter, a Sentry
 * hallucination of a Phoenix would satisfy a `count_min`/`before` rule
 * named "TrainPhoenix" or "BuildPhoenix" even when the user never
 * built a Stargate, mis-classifying 2-base Charge / Templar games.
 *
 * Every test below builds a hand-crafted event list (the same shape
 * `parseBuildLogLines` emits) so the suite is hermetic — no replay
 * parsing, no DB access.
 */

const {
  evaluateRule,
  evaluateRules,
  eventToken,
  UNIT_TECH_PREREQUISITES,
} = require("../src/services/buildRulesEvaluator");

/** @returns {{time: number, name: string, is_building?: boolean, category?: string, race?: string}} */
function ev(name, time, opts = {}) {
  return { time, name, ...opts };
}

function building(name, time) {
  return ev(name, time, { is_building: true, category: "building" });
}

function unit(name, time) {
  return ev(name, time, { category: "unit" });
}

describe("eventToken token map", () => {
  test("buildings produce Build<X>", () => {
    expect(eventToken(building("Stargate", 240))).toBe("BuildStargate");
  });

  test("units produce Build<X> by default (matches SPA writer)", () => {
    expect(eventToken(unit("Phoenix", 240))).toBe("BuildPhoenix");
  });
});

describe("evaluateRule prereq filter — Phoenix needs Stargate", () => {
  test("hallucinated Phoenix without Stargate fails count_min", () => {
    const events = [
      building("Nexus", 0),
      building("Pylon", 18),
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("TwilightCouncil", 200),
      // No Stargate ever built.
      unit("Sentry", 230),
      unit("Phoenix", 239), // Sentry hallucination
    ];
    const rule = {
      type: "count_min",
      name: "BuildPhoenix",
      time_lt: 420,
      count: 1,
    };
    const out = evaluateRule(rule, events);
    expect(out.pass).toBe(false);
    expect(out.reason).toMatch(/BuildPhoenix/);
  });

  test("real Phoenix with Stargate passes count_min", () => {
    const events = [
      building("Nexus", 0),
      building("Stargate", 200),
      unit("Phoenix", 280),
      unit("Phoenix", 320),
    ];
    const rule = {
      type: "count_min",
      name: "BuildPhoenix",
      time_lt: 420,
      count: 2,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });

  test("Phoenix appearing BEFORE Stargate is dropped, even though Stargate exists later", () => {
    const events = [
      building("Nexus", 0),
      unit("Phoenix", 200), // appears before any Stargate
      building("Stargate", 240),
    ];
    const rule = {
      type: "count_min",
      name: "BuildPhoenix",
      time_lt: 420,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(false);
  });

  test("destroyed Stargate still qualifies a later Phoenix", () => {
    // The construction event remains in the events list permanently;
    // the prereq is "was it ever started before the unit?", not
    // "is it still alive?".
    const events = [
      building("Nexus", 0),
      building("Stargate", 240), // started — assume killed off-screen
      unit("Phoenix", 420),
    ];
    const rule = {
      type: "count_min",
      name: "BuildPhoenix",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });

  test("non-unit rules (BuildStargate) ignore the prereq filter entirely", () => {
    const events = [building("Stargate", 240)];
    const rule = {
      type: "count_min",
      name: "BuildStargate",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });
});

describe("evaluateRule prereq filter — High Templar needs Templar Archives", () => {
  test("hallucinated HighTemplar without Templar Archives fails", () => {
    const events = [
      building("Nexus", 0),
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("TwilightCouncil", 200),
      // No TemplarArchive.
      unit("Sentry", 280),
      unit("HighTemplar", 290), // Sentry hallucination
    ];
    const rule = {
      type: "count_min",
      name: "BuildHighTemplar",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(false);
  });

  test("HighTemplar with Templar Archives passes", () => {
    const events = [
      building("Nexus", 0),
      building("TemplarArchive", 360),
      unit("HighTemplar", 420),
    ];
    const rule = {
      type: "count_min",
      name: "BuildHighTemplar",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });
});

describe("evaluateRule prereq filter — Carrier needs Stargate AND Fleet Beacon", () => {
  test("Stargate alone is not enough", () => {
    const events = [
      building("Nexus", 0),
      building("Stargate", 240),
      // No FleetBeacon.
      unit("Carrier", 540),
    ];
    const rule = {
      type: "count_min",
      name: "BuildCarrier",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(false);
  });

  test("Stargate + Fleet Beacon is enough", () => {
    const events = [
      building("Nexus", 0),
      building("Stargate", 240),
      building("FleetBeacon", 380),
      unit("Carrier", 540),
    ];
    const rule = {
      type: "count_min",
      name: "BuildCarrier",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });
});

describe("evaluateRule prereq filter — Archon (HT or DT path)", () => {
  test("Archon allowed via Templar Archives alone", () => {
    const events = [
      building("Nexus", 0),
      building("TemplarArchive", 360),
      unit("Archon", 420),
    ];
    const rule = {
      type: "count_min",
      name: "BuildArchon",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });

  test("Archon allowed via Dark Shrine alone", () => {
    const events = [
      building("Nexus", 0),
      building("DarkShrine", 360),
      unit("Archon", 420),
    ];
    const rule = {
      type: "count_min",
      name: "BuildArchon",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });

  test("Archon without either path is dropped (hallucination)", () => {
    const events = [
      building("Nexus", 0),
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      unit("Archon", 420),
    ];
    const rule = {
      type: "count_min",
      name: "BuildArchon",
      time_lt: 600,
      count: 1,
    };
    expect(evaluateRule(rule, events).pass).toBe(false);
  });
});

describe("evaluateRule — count_max / before / not_before honour the filter", () => {
  test("count_max=0 against hallucinated Phoenix passes (no real Phoenix)", () => {
    // A user-written rule asserting "no Phoenix by 6:00". A Sentry
    // hallucination must not break the assertion.
    const events = [
      building("Nexus", 0),
      building("CyberneticsCore", 115),
      unit("Sentry", 230),
      unit("Phoenix", 239),
    ];
    const rule = {
      type: "count_max",
      name: "BuildPhoenix",
      time_lt: 360,
      count: 0,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });

  test("not_before respects the prereq filter", () => {
    const events = [
      building("Nexus", 0),
      building("CyberneticsCore", 115),
      unit("Sentry", 230),
      unit("Phoenix", 239), // hallucinated
    ];
    const rule = {
      type: "not_before",
      name: "BuildPhoenix",
      time_lt: 600,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });

  test("before passes when a real Phoenix exists ahead of the cutoff", () => {
    const events = [
      building("Stargate", 200),
      unit("Phoenix", 280),
    ];
    const rule = {
      type: "before",
      name: "BuildPhoenix",
      time_lt: 420,
    };
    expect(evaluateRule(rule, events).pass).toBe(true);
  });
});

describe("evaluateRules end-to-end", () => {
  test("a Phoenix-Opener rule list rejects a hallucination-only PvT replay", () => {
    // The screenshot scenario, reproduced as a v3 rule list.
    const events = [
      building("Nexus", 0),
      building("Pylon", 18),
      building("Gateway", 75),
      building("Assimilator", 92),
      building("CyberneticsCore", 115),
      building("Nexus", 130),
      building("TwilightCouncil", 270),
      building("RoboticsFacility", 320),
      // No Stargate.
      unit("Stalker", 200),
      unit("Sentry", 230),
      unit("Phoenix", 239), // Sentry hallucination
    ];
    const rules = [
      { type: "before", name: "BuildStargate", time_lt: 420 },
      { type: "count_min", name: "BuildPhoenix", time_lt: 420, count: 1 },
    ];
    const out = evaluateRules(rules, events);
    expect(out.pass).toBe(false);
    // Either rule could surface as the failing one, depending on
    // ordering; both are legitimate "no Phoenix opener here" reasons.
    expect(["BuildStargate", "BuildPhoenix"]).toContain(out.failedRule.name);
  });

  test("a real Stargate Phoenix opener passes the same rule list", () => {
    const events = [
      building("Nexus", 0),
      building("Pylon", 18),
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 320),
    ];
    const rules = [
      { type: "before", name: "BuildStargate", time_lt: 420 },
      { type: "count_min", name: "BuildPhoenix", time_lt: 420, count: 1 },
    ];
    expect(evaluateRules(rules, events).pass).toBe(true);
  });
});

describe("UNIT_TECH_PREREQUISITES table sanity", () => {
  test("every alternative is a non-empty array of strings", () => {
    for (const [unitName, alts] of Object.entries(UNIT_TECH_PREREQUISITES)) {
      expect(Array.isArray(alts)).toBe(true);
      expect(alts.length).toBeGreaterThan(0);
      for (const reqSet of alts) {
        expect(Array.isArray(reqSet)).toBe(true);
        expect(reqSet.length).toBeGreaterThan(0);
        for (const req of reqSet) {
          expect(typeof req).toBe("string");
          expect(req.length).toBeGreaterThan(0);
        }
      }
      expect(unitName.length).toBeGreaterThan(0);
    }
  });

  test("Stargate-line units list Stargate as a prereq", () => {
    for (const u of ["Phoenix", "Oracle", "VoidRay", "Carrier", "Tempest", "Mothership"]) {
      const flat = UNIT_TECH_PREREQUISITES[u].flat();
      expect(flat).toContain("Stargate");
    }
  });
});
