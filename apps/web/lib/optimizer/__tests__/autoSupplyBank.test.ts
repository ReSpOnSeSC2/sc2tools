import { describe, expect, it } from "vitest";
import { actionsFromSteps, adaptBuild } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import type { AdaptResult } from "../types";

/**
 * Auto-supply bank discipline: the supply safety net may not spend
 * the minerals the build's pending step is saving unless a supply
 * block is genuinely imminent. Regression for the adapter emitting
 * "pylon -> nexus -> core" out of a "nexus -> core -> pylon" source:
 * the policy pylon was preempting the Nexus bank a minute before any
 * block.
 */

function run(steps: string[], horizonSec = 300): AdaptResult {
  const profile = resolveProfile("5.0.16");
  const { actions } = actionsFromSteps(profile, steps);
  return adaptBuild({
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: "supply-bank-check",
    threats: [],
    policies: { ...defaultPolicies(), reserveWorkerCost: true },
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec,
  });
}

describe("auto-supply respects the head action's bank", () => {
  it("keeps gas -> nexus -> core ahead of the build's second pylon", () => {
    const r = run([
      "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
      "Pylon", "Assimilator", "Stalker",
    ]);
    const names = r.sim.steps
      .filter((s) => s.name !== "Probe")
      .map((s) => s.name);
    const secondPylon = names.indexOf("Pylon", names.indexOf("Pylon") + 1);
    expect(names.indexOf("Nexus")).toBeLessThan(secondPylon);
    expect(names.indexOf("CyberneticsCore")).toBeLessThan(secondPylon);
    // and the discipline costs nothing: no supply block
    expect(r.sim.supplyBlockedSec).toBe(0);
  });

  it("still emergency-builds supply for builds that list none", () => {
    // No pylons in the action list at all: the safety net must kick
    // in (emergency path) rather than letting probes block forever.
    const r = run(["Gateway", "Nexus"], 240);
    const pylons = r.sim.steps.filter((s) => s.name === "Pylon");
    expect(pylons.length).toBeGreaterThan(0);
  });
});
