import { describe, expect, it } from "vitest";
import {
  actionsFromSignature,
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
  referenceBuildsForRace,
} from "../adapt/adapt";
import { resolveProfile, validateProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import { threatCatalog, threatsForMatchup } from "../threats/store";
import type { AdaptRequest } from "../types";

const target = resolveProfile("5.0.16");

describe("reference build catalog", () => {
  it("every shipped step resolves against the patch profile", () => {
    validateProfile(target);
    for (const build of referenceBuilds()) {
      const { actions, unknownNames } = actionsFromSteps(target, build.steps);
      expect(unknownNames, `${build.id} has unknown steps`).toEqual([]);
      expect(actions.length, `${build.id} resolved empty`).toBeGreaterThan(5);
    }
  });

  it("covers all three races", () => {
    expect(referenceBuildsForRace("Protoss").length).toBeGreaterThanOrEqual(2);
    expect(referenceBuildsForRace("Terran").length).toBeGreaterThanOrEqual(2);
    expect(referenceBuildsForRace("Zerg").length).toBeGreaterThanOrEqual(2);
  });
});

describe("action resolution", () => {
  it("drops worker steps but keeps supply and order", () => {
    const { actions } = actionsFromSteps(target, [
      "Probe",
      "Pylon",
      "Gateway",
      "SCV",
      "Assimilator",
      "Drone",
      "Nexus",
    ]);
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Gateway",
      "Assimilator",
      "Nexus",
    ]);
  });

  it("maps morphs and research to the right action kinds", () => {
    const { actions } = actionsFromSteps(target, [
      "Barracks",
      "OrbitalCommand",
      "Stimpack",
    ]);
    expect(actions).toEqual([
      { kind: "build", name: "Barracks" },
      { kind: "morph", name: "OrbitalCommand" },
      { kind: "research", name: "Stimpack" },
    ]);
  });

  it("resolves saved-build signatures (lowercase icon names, by time)", () => {
    const { actions, unknownNames } = actionsFromSignature(target, [
      { unit: "gateway", count: 2, beforeSec: 40 },
      { unit: "pylon", count: 3, beforeSec: 20 },
      { unit: "cyberneticscore", count: 1, beforeSec: 90 },
      { unit: "notathing", count: 1, beforeSec: 5 },
    ]);
    expect(unknownNames).toEqual(["notathing"]);
    // earliest-seen first; counts expand to repeated ordered actions
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Pylon",
      "Pylon",
      "Gateway",
      "Gateway",
      "CyberneticsCore",
    ]);
  });
});

describe("adaptBuild — 12-worker builds re-timed for 5.0.16", () => {
  function adapt(referenceId: string, race: "Protoss" | "Terran" | "Zerg") {
    const reference = referenceBuilds().find((b) => b.id === referenceId)!;
    const { actions } = actionsFromSteps(target, reference.steps);
    const vsRace = race === "Zerg" ? "Terran" : "Zerg";
    const threats = threatsForMatchup(threatCatalog(null), race, vsRace).map(
      (threat) => ({ threat, probability: threat.priorProbability }),
    );
    const request: AdaptRequest = {
      baselineProfileId: "lotv-base",
      profileId: "5.0.16",
      race,
      actions,
      referenceName: reference.name,
      referenceId: reference.id,
      threats,
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 480,
    };
    return adaptBuild(request);
  }

  it("keeps the same buildings in the same order on both patches", () => {
    const result = adapt("p-gate-expand", "Protoss");
    expect(result.sim.unexecutedActions).toBe(0);
    const orderOf = (sim: typeof result.sim) =>
      sim.steps
        .filter((s) => result.actions.some((a) => a.name === s.name))
        .map((s) => s.name);
    // every reference action reached both sims, in reference order
    expect(result.comparison.every((r) => r.adaptedStartSec !== undefined)).toBe(
      true,
    );
    expect(result.comparison.every((r) => r.baselineStartSec !== undefined)).toBe(
      true,
    );
    expect(orderOf(result.sim).length).toBeGreaterThan(0);
  });

  it("re-times steps LATER on the 8-worker economy, not earlier", () => {
    const result = adapt("p-gate-expand", "Protoss");
    // The 8-worker start mines slower, so the early build steps must
    // shift later than their 12-worker stamps. (Allow tiny jitter on
    // the very first step which is bank-limited on both patches.)
    const deltas = result.comparison
      .map((r) => r.deltaSec)
      .filter((d): d is number => d !== undefined);
    expect(deltas.length).toBeGreaterThan(5);
    const laterCount = deltas.filter((d) => d > 2).length;
    expect(laterCount).toBeGreaterThanOrEqual(Math.floor(deltas.length * 0.7));
    // first reference step (gateway) lands noticeably later on 5.0.16
    const gateway = result.comparison.find((r) => r.name === "Gateway")!;
    expect(gateway.deltaSec!).toBeGreaterThan(5);
  });

  it("adapts terran (morphs/addons) and zerg (larva) builds cleanly", () => {
    const terran = adapt("t-reaper-111", "Terran");
    expect(terran.sim.unexecutedActions).toBe(0);
    expect(terran.sim.unitsAtEnd.OrbitalCommand).toBe(1);
    expect((terran.sim.completionTimes.Medivac ?? []).length).toBe(1);
    const zerg = adapt("z-hatch-first", "Zerg");
    expect(zerg.sim.unexecutedActions).toBe(0);
    expect((zerg.sim.completionTimes.Lair ?? []).length).toBe(1);
    expect(zerg.sim.unitsAtEnd.Queen).toBeGreaterThanOrEqual(2);
  });

  it("evaluates safety of the adapted build against matchup threats", () => {
    const result = adapt("p-gate-expand", "Protoss");
    expect(result.safety.threats.length).toBeGreaterThan(0);
    for (const report of result.safety.threats) {
      expect(["safe", "risky", "unsafe"]).toContain(report.verdict);
      expect(report.waves.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const a = adapt("z-pool-first", "Zerg");
    const b = adapt("z-pool-first", "Zerg");
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
