"use strict";

/**
 * Tests for autoClassify/signature.
 *
 * Every test below uses a hand-built event list (the same shape
 * `parseBuildLogLines` emits — `time`, `name`, `is_building`,
 * `category`, `race`) so the suite is hermetic: no replay parsing,
 * no Mongo, no fixtures.
 *
 * Covers the three discovery-engine acceptance scenarios:
 *   1. A real Stargate→Phoenix opening produces a different
 *      signature than a Sentry-hallucinated Phoenix opening (same
 *      anti-hallucination filter buildRulesEvaluator uses).
 *   2. Two stylistically identical openings score distance < 0.15.
 *   3. A Stargate-first vs a Robo-first opening score distance > 0.5.
 *
 * Plus sanity tests for token canonicalisation, economy filtering,
 * deduplication, horizon truncation, bucket key shape and distance
 * bounds.
 */

const {
  extractSignature,
  signatureKey,
  signatureDistance,
  ECONOMY_NOISE_BARE,
  DEFAULT_HORIZON_SEC,
} = require("../src/services/autoClassify/signature");

/** @returns {{time:number, name:string, is_building?:boolean, category?:string, race?:string}} */
function ev(name, time, opts = {}) {
  return { time, name, ...opts };
}
function building(name, time) {
  return ev(name, time, { is_building: true, category: "building" });
}
function unit(name, time) {
  return ev(name, time, { category: "unit" });
}

describe("extractSignature — basics", () => {
  test("returns [] for non-array input or empty events", () => {
    expect(extractSignature(null)).toEqual([]);
    expect(extractSignature(undefined)).toEqual([]);
    expect(extractSignature([])).toEqual([]);
  });

  test("drops economy tokens (workers, supply, town halls, gas)", () => {
    const events = [
      building("Nexus", 0),
      building("Pylon", 18),
      unit("Probe", 5),
      building("Assimilator", 92),
      building("Gateway", 75),
      building("CyberneticsCore", 115),
    ];
    const sig = extractSignature(events);
    expect(sig.map((s) => s.token)).toEqual([
      "BuildGateway",
      "BuildCyberneticsCore",
    ]);
  });

  test("ECONOMY_NOISE_BARE exports the documented set", () => {
    for (const noun of [
      "Nexus",
      "CommandCenter",
      "Hatchery",
      "Pylon",
      "SupplyDepot",
      "Overlord",
      "Probe",
      "SCV",
      "Drone",
      "Assimilator",
      "Refinery",
      "Extractor",
    ]) {
      expect(ECONOMY_NOISE_BARE.has(noun)).toBe(true);
    }
    // Tech-signal upgrades are NOT filtered.
    expect(ECONOMY_NOISE_BARE.has("Lair")).toBe(false);
    expect(ECONOMY_NOISE_BARE.has("Hive")).toBe(false);
    expect(ECONOMY_NOISE_BARE.has("OrbitalCommand")).toBe(false);
  });

  test("collapses repeats to first occurrence with running count", () => {
    const events = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
      unit("Phoenix", 320),
      unit("Phoenix", 360),
    ];
    const sig = extractSignature(events);
    const byTok = Object.fromEntries(sig.map((s) => [s.token, s]));
    expect(byTok.BuildPhoenix.t).toBe(280);
    expect(byTok.BuildPhoenix.count).toBe(3);
    expect(byTok.BuildStargate.count).toBe(1);
    expect(byTok.BuildGateway.count).toBe(1);
  });

  test("drops events at or beyond horizonSec (default 8:00)", () => {
    expect(DEFAULT_HORIZON_SEC).toBe(480);
    const events = [
      building("Gateway", 75),
      building("Stargate", 200),
      building("TwilightCouncil", 470),
      // At / past the default 480 horizon — should NOT appear.
      building("FleetBeacon", 480),
      building("RoboticsFacility", 600),
    ];
    const tokens = extractSignature(events).map((s) => s.token);
    expect(tokens).toContain("BuildGateway");
    expect(tokens).toContain("BuildStargate");
    expect(tokens).toContain("BuildTwilightCouncil");
    expect(tokens).not.toContain("BuildFleetBeacon");
    expect(tokens).not.toContain("BuildRoboticsFacility");
  });

  test("respects a custom horizonSec", () => {
    const events = [
      building("Gateway", 75),
      building("Stargate", 200),
      building("TwilightCouncil", 250),
    ];
    const tokens = extractSignature(events, { horizonSec: 220 }).map(
      (s) => s.token,
    );
    expect(tokens).toContain("BuildStargate");
    expect(tokens).not.toContain("BuildTwilightCouncil");
  });

  test("output is ordered by first-occurrence time (input order doesn't matter)", () => {
    const events = [
      building("CyberneticsCore", 115),
      building("Gateway", 75),
      building("Stargate", 200),
    ];
    expect(extractSignature(events).map((s) => s.t)).toEqual([75, 115, 200]);
  });
});

describe("extractSignature — anti-hallucination filter", () => {
  test("hallucinated Phoenix without a Stargate is dropped", () => {
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
    const tokens = extractSignature(events).map((s) => s.token);
    expect(tokens).not.toContain("BuildPhoenix");
    // The real tech commits and the Sentry itself ARE kept.
    expect(tokens).toContain("BuildGateway");
    expect(tokens).toContain("BuildCyberneticsCore");
    expect(tokens).toContain("BuildTwilightCouncil");
    expect(tokens).toContain("BuildSentry");
  });

  test("real Phoenix with a Stargate is kept", () => {
    const events = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
    ];
    expect(extractSignature(events).map((s) => s.token)).toContain(
      "BuildPhoenix",
    );
  });

  test("Phoenix that appears BEFORE its Stargate is still dropped", () => {
    // Construction event time matters: the Stargate exists at 240,
    // but the Phoenix at 200 had no Stargate yet → hallucination.
    const events = [
      unit("Phoenix", 200),
      building("Stargate", 240),
    ];
    expect(extractSignature(events).map((s) => s.token)).not.toContain(
      "BuildPhoenix",
    );
  });
});

describe("signatureKey", () => {
  test("returns the first six tokens joined by '>'", () => {
    const events = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
      building("FleetBeacon", 310),
      unit("Tempest", 400),
      building("TwilightCouncil", 430),
    ];
    const key = signatureKey(extractSignature(events));
    expect(key).toBe(
      "BuildGateway>BuildCyberneticsCore>BuildStargate>BuildPhoenix>BuildFleetBeacon>BuildTempest",
    );
  });

  test("returns the full sequence when fewer than 6 entries exist", () => {
    const sig = [
      { token: "BuildGateway", t: 75, count: 1 },
      { token: "BuildStargate", t: 200, count: 1 },
    ];
    expect(signatureKey(sig)).toBe("BuildGateway>BuildStargate");
  });

  test("returns '' for empty / invalid input", () => {
    expect(signatureKey([])).toBe("");
    expect(signatureKey(null)).toBe("");
    expect(signatureKey(undefined)).toBe("");
  });
});

describe("signatureDistance — bounds", () => {
  test("returns 0 for content-identical signatures", () => {
    const events = [
      building("Gateway", 75),
      building("Stargate", 200),
      unit("Phoenix", 280),
    ];
    const a = extractSignature(events);
    const b = extractSignature(events);
    expect(signatureDistance(a, b)).toBe(0);
  });

  test("returns 0 when both signatures are empty", () => {
    expect(signatureDistance([], [])).toBe(0);
  });

  test("clamps to [0, 1] for fully disjoint sequences", () => {
    const a = [
      { token: "BuildGateway", t: 75, count: 1 },
      { token: "BuildStargate", t: 200, count: 1 },
    ];
    const b = [
      { token: "BuildBarracks", t: 80, count: 1 },
      { token: "BuildFactory", t: 200, count: 1 },
      { token: "BuildStarport", t: 300, count: 1 },
    ];
    const d = signatureDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(1);
  });
});

describe("signatureDistance — acceptance scenarios", () => {
  test("real Stargate→Phoenix vs Sentry-hallucinated Phoenix produce different signatures", () => {
    const realEvents = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
    ];
    const hallucEvents = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("TwilightCouncil", 200),
      unit("Sentry", 230),
      unit("Phoenix", 239), // hallucination
    ];

    const sigReal = extractSignature(realEvents);
    const sigHalluc = extractSignature(hallucEvents);

    // The tokens differ: one has BuildPhoenix and BuildStargate;
    // the other has BuildTwilightCouncil + BuildSentry instead.
    const tokReal = sigReal.map((s) => s.token);
    const tokHalluc = sigHalluc.map((s) => s.token);
    expect(tokReal).toContain("BuildPhoenix");
    expect(tokReal).toContain("BuildStargate");
    expect(tokHalluc).not.toContain("BuildPhoenix");
    expect(tokHalluc).not.toContain("BuildStargate");
    expect(tokHalluc).toContain("BuildTwilightCouncil");

    // ... and the distance reflects that.
    expect(signatureDistance(sigReal, sigHalluc)).toBeGreaterThan(0);
  });

  test("two stylistically identical openings score distance < 0.15", () => {
    // Same tokens, in the same order, with realistic per-token
    // timing wobble (~3–15 sec) — i.e. two playthroughs of the
    // same Phoenix+Tempest opener.
    const eventsA = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
      building("FleetBeacon", 310),
      unit("Tempest", 400),
    ];
    const eventsB = [
      building("Gateway", 78),
      building("CyberneticsCore", 120),
      building("Stargate", 210),
      unit("Phoenix", 295),
      building("FleetBeacon", 320),
      unit("Tempest", 415),
    ];
    const sigA = extractSignature(eventsA);
    const sigB = extractSignature(eventsB);
    const d = signatureDistance(sigA, sigB);
    expect(d).toBeLessThan(0.15);
  });

  test("Stargate-first vs Robo-first openings score distance > 0.5", () => {
    const stargateEvents = [
      building("Gateway", 75),
      building("CyberneticsCore", 115),
      building("Stargate", 200),
      unit("Phoenix", 280),
      building("FleetBeacon", 310),
      unit("Tempest", 400),
      building("TwilightCouncil", 430),
    ];
    const roboEvents = [
      building("Gateway", 78),
      building("CyberneticsCore", 118),
      building("RoboticsFacility", 200),
      unit("Immortal", 285),
      unit("Observer", 310),
      building("RoboticsBay", 330),
      unit("Colossus", 410),
      unit("Disruptor", 440),
    ];
    const sigA = extractSignature(stargateEvents);
    const sigB = extractSignature(roboEvents);
    const d = signatureDistance(sigA, sigB);
    expect(d).toBeGreaterThan(0.5);
  });
});
