import { describe, expect, it } from "vitest";
import { actionsFromSteps, adaptBuild } from "../adapt/adapt";
import { applyFirstUnitDefenseGuard } from "../adapt/defense";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import type { AdaptRequest, BuildAction, PatchProfile } from "../types";

const profile = resolveProfile("5.0.16");

function makeRequest(steps: string[]): AdaptRequest {
  const { actions } = actionsFromSteps(profile, steps);
  return {
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: "orchestration",
    threats: [],
    policies: { ...defaultPolicies(), reserveWorkerCost: true },
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec: 420,
  };
}

function guard(steps: string[]) {
  const request = makeRequest(steps);
  const base = adaptBuild(request);
  return { request, base, r: applyFirstUnitDefenseGuard(base, request, "Terran") };
}

function combatUnitsBeforeNexus(actions: BuildAction[], p: PatchProfile): number {
  const nexusIdx = actions.findIndex((a) => a.kind === "build" && a.name === "Nexus");
  const limit = nexusIdx < 0 ? actions.length : nexusIdx;
  let n = 0;
  for (let i = 0; i < limit; i += 1) {
    const a = actions[i];
    const d = p.units[a.name];
    if (
      (a.kind === "train" || a.kind === "morph") &&
      d &&
      !d.isStructure &&
      !d.isWorker &&
      d.combat &&
      d.supply > 0
    ) {
      n += 1;
    }
  }
  return n;
}

function probesBy(times: number[] | undefined, t: number): number {
  return (times ?? []).filter((s) => s <= t).length;
}

const ADEPT_GREEDY = [
  "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
  "Adept", "Stargate", "Phoenix",
];
const STALKER_GREEDY = [
  "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
  "Assimilator", "Pylon", "Stargate", "Stalker", "Phoenix",
];

describe("defense guard orchestration", () => {
  it("the greedy fixtures are genuinely late before guarding", () => {
    for (const steps of [ADEPT_GREEDY, STALKER_GREEDY]) {
      const sim = adaptBuild(makeRequest(steps)).sim;
      const first = Math.min(
        sim.completionTimes.Adept?.[0] ?? Infinity,
        sim.completionTimes.Stalker?.[0] ?? Infinity,
      );
      expect(first).toBeGreaterThan(167); // past the 2:47 deadline
    }
  });

  it("preserves the source's pre-expand unit count (never jams a unit before the expand)", () => {
    for (const steps of [ADEPT_GREEDY, STALKER_GREEDY]) {
      const { request, r } = guard(steps);
      expect(combatUnitsBeforeNexus(r.actions, profile)).toBe(
        combatUnitsBeforeNexus(request.actions, profile),
      );
      // these fixtures expand before any unit, so it stays zero
      expect(combatUnitsBeforeNexus(r.actions, profile)).toBe(0);
    }
  });

  it("the probe-cut it chooses keeps a solid economy at the 5:00 horizon", () => {
    const { base, r } = guard(ADEPT_GREEDY);
    // The Adept fix is allowed to probe-cut...
    expect(r.defense?.verdict).toBe("safe");
    expect(r.defense?.leversUsed.some((l) => l.startsWith("probe-cut"))).toBe(true);
    // ...but the economic weighting keeps the long-run economy intact: the
    // worker count by 5:00 is within a few probes of the un-guarded build.
    const baseWorkers = probesBy(base.sim.completionTimes.Probe, 300);
    const fixedWorkers = probesBy(r.sim.completionTimes.Probe, 300);
    expect(fixedWorkers).toBeGreaterThanOrEqual(baseWorkers - 3);
  });

  it("doesn't probe-cut a build that simpler levers can't even defend", () => {
    // The Stalker opener can't be defended by any lever, so the guard must
    // NOT burn probes on it (cuts are only for builds a cut makes safe).
    const { r } = guard(STALKER_GREEDY);
    expect(r.defense?.verdict).not.toBe("safe");
    expect(r.defense?.leversUsed.some((l) => l.startsWith("probe-cut"))).toBe(
      false,
    );
  });
});
