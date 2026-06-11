import { describe, expect, it } from "vitest";
import { resolveProfile } from "../patch/profiles";
import {
  deriveThreatFromBuild,
  deriveThreatsForMatchup,
} from "../threats/derive";
import { referenceBuilds } from "../adapt/adapt";

const profile = resolveProfile("5.0.16");

describe("threats derived from catalog openers", () => {
  it("derives waves from the attacker's simulated army production", () => {
    const twelvePool = referenceBuilds().find((b) => b.id === "zerg-12-pool")!;
    const threat = deriveThreatFromBuild(profile, twelvePool, "Protoss")!;
    expect(threat).not.toBeNull();
    expect(threat.id).toBe("ref:zerg-12-pool");
    expect(threat.waves.length).toBeGreaterThan(0);
    // lings can't arrive before they exist plus map travel
    const firstWave = threat.waves[0];
    expect(firstWave.units.Zergling).toBeGreaterThanOrEqual(2);
    expect(threat.earliestArrivalSec).toBeGreaterThan(100);
    // melee-only first wave → wall recommended
    expect(threat.defenderHints.wallRecommended).toBe(true);
  });

  it("covers the matchup with every catalog opener the enemy can play", () => {
    const threats = deriveThreatsForMatchup("5.0.16", "Protoss", "Zerg");
    expect(threats.length).toBeGreaterThanOrEqual(8);
    // arrival-sorted
    for (let i = 1; i < threats.length; i += 1) {
      expect(threats[i].earliestArrivalSec).toBeGreaterThanOrEqual(
        threats[i - 1].earliestArrivalSec,
      );
    }
    // a cheesy opener arrives before a macro opener
    const ids = threats.map((t) => t.id);
    expect(ids.indexOf("ref:zerg-12-pool")).toBeLessThan(
      ids.indexOf("ref:zerg-3-base-macro-hatch-first"),
    );
  });

  it("re-times threats per patch (8-worker arrivals are later)", () => {
    const onNew = deriveThreatsForMatchup("5.0.16", "Protoss", "Zerg");
    const onOld = deriveThreatsForMatchup("lotv-base", "Protoss", "Zerg");
    const newPool = onNew.find((t) => t.id === "ref:zerg-12-pool")!;
    const oldPool = onOld.find((t) => t.id === "ref:zerg-12-pool")!;
    expect(newPool.earliestArrivalSec).toBeGreaterThan(
      oldPool.earliestArrivalSec,
    );
  });

  it("derives air threats with flying first waves (anti-air masking)", () => {
    const threats = deriveThreatsForMatchup("5.0.16", "Zerg", "Terran");
    const bcRush = threats.find((t) => t.id === "ref:terran-bc-rush");
    expect(bcRush).toBeDefined();
    const allUnits = bcRush!.waves.flatMap((w) => Object.keys(w.units));
    expect(allUnits).toContain("Battlecruiser");
  });
});
