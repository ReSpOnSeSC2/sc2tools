import { describe, expect, it } from "vitest";
import {
  ACTIVE_THRESHOLD,
  activeThreatSet,
  assessThreats,
} from "../scouting/infer";
import { threatCatalog, threatsForMatchup } from "../threats/store";

const catalog = threatCatalog(null);
const pvzThreats = threatsForMatchup(catalog, "Protoss", "Zerg");

function assessmentFor(id: string, observations: Parameters<typeof assessThreats>[1]) {
  const all = assessThreats(pvzThreats, observations);
  return all.find((a) => a.threatId === id)!;
}

describe("scouting inference", () => {
  it("starts every threat at its meta prior with no observations", () => {
    const assessments = assessThreats(pvzThreats, []);
    for (const a of assessments) {
      const threat = pvzThreats.find((t) => t.id === a.threatId)!;
      expect(a.probability).toBeCloseTo(threat.priorProbability, 1);
    }
  });

  it("early pool + few drones makes 8-pool the active threat", () => {
    const observations = [
      { tellId: "z8-early-pool", atSec: 40 },
      { tellId: "z8-few-drones", atSec: 60 },
    ];
    const eightPool = assessmentFor("z-8pool", observations);
    const twelvePool = assessmentFor("z-12pool", observations);
    expect(eightPool.active).toBe(true);
    expect(eightPool.probability).toBeGreaterThan(0.7);
    expect(eightPool.probability).toBeGreaterThan(twelvePool.probability);
  });

  it("ignores a tell observed outside its time window", () => {
    // "pool by 0:45" seen at 1:30 is NOT evidence of an 8-pool
    const late = assessmentFor("z-8pool", [
      { tellId: "z8-early-pool", atSec: 90 },
    ]);
    const prior = assessmentFor("z-8pool", []);
    expect(late.probability).toBeCloseTo(prior.probability, 2);
    expect(late.matchedTells).toHaveLength(0);
  });

  it("a contradicting tell suppresses the threat", () => {
    const suppressed = assessmentFor("z-8pool", [
      { tellId: "z8-late-pool", atSec: 100 },
    ]);
    expect(suppressed.probability).toBeLessThan(0.05);
    expect(suppressed.active).toBe(false);
    expect(suppressed.contradictedTells).toContain("z8-late-pool");
  });

  it("threat set always covers the whole matchup baseline", () => {
    // Even with zero scouting info, every threat participates at its
    // prior — an unscouted optimizer run must still defend the meta.
    const empty = activeThreatSet(pvzThreats, assessThreats(pvzThreats, []), new Set());
    expect(empty).toHaveLength(pvzThreats.length);
    for (const { threat, probability } of empty) {
      expect(probability).toBeCloseTo(threat.priorProbability, 1);
    }
  });

  it("scouting raises weights and pinning floors them", () => {
    const observations = [{ tellId: "z8-early-pool", atSec: 40 }];
    const assessments = assessThreats(pvzThreats, observations);
    const active = activeThreatSet(
      pvzThreats,
      assessments,
      new Set(["z-roach-rush"]),
    );
    const byId = new Map(active.map((a) => [a.threat.id, a]));
    expect(byId.get("z-8pool")!.probability).toBeGreaterThan(0.4);
    expect(byId.get("z-roach-rush")!.probability).toBeGreaterThanOrEqual(
      ACTIVE_THRESHOLD,
    );
    // unscouted, unpinned threats stay at their priors
    const flood = byId.get("z-speedling-flood")!;
    expect(flood.probability).toBeCloseTo(
      flood.threat.priorProbability,
      1,
    );
  });
});
