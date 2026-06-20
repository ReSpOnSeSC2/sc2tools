import { describe, expect, it } from "vitest";
import { actionsFromSteps, adaptBuild } from "../adapt/adapt";
import {
  applyFirstUnitDefenseGuard,
  earliestPressureArrivalSec,
} from "../adapt/defense";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import type { AdaptRequest, AdaptResult } from "../types";

function makeRequest(steps: string[]): AdaptRequest {
  const profile = resolveProfile("5.0.16");
  const { actions } = actionsFromSteps(profile, steps);
  return {
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: "defense-check",
    threats: [],
    policies: { ...defaultPolicies(), reserveWorkerCost: true },
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec: 420,
  };
}

function guarded(steps: string[], vsRace?: "Terran"): AdaptResult {
  const request = makeRequest(steps);
  return applyFirstUnitDefenseGuard(adaptBuild(request), request, vsRace);
}

describe("first-unit defense guard", () => {
  it("anchors on the 8-worker standard reaper at ~2:42", () => {
    const arrival = earliestPressureArrivalSec("5.0.16", "Terran");
    expect(arrival).not.toBeNull();
    expect(arrival!).toBeGreaterThanOrEqual(155);
    expect(arrival!).toBeLessThanOrEqual(170);
  });

  it("fixes a greedy nexus-first Adept opener with reorder + chrono + cut", () => {
    // Nexus + stargate before the first gateway unit. The guard techs the
    // core ahead of the expansion, chronos the unit, and cuts a probe to
    // land the Adept inside the defensive window — without adding a unit
    // before the expand (the source had zero).
    const r = guarded(
      [
        "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
        "Adept", "Stargate", "Phoenix",
      ],
      "Terran",
    );
    const names = r.actions.map((a) => a.name);
    expect(names.indexOf("CyberneticsCore")).toBeLessThan(
      names.indexOf("Nexus"),
    );
    expect(r.defense?.verdict).toBe("safe");
    expect(r.defense?.firstUnit?.doneSec).toBeLessThanOrEqual(
      r.defense!.deadlineSec,
    );
    expect(r.defense?.leversUsed).toContain("core-before-nexus");
  });

  it("improves but honestly flags an un-defendable greedy Stalker opener", () => {
    // A Stalker by 2:47 off a greedy nexus-first opener is infeasible on
    // the 8-worker economy (gas-gated). The guard still pulls it as early
    // as it can, but reports the build as exposed rather than pretending.
    const steps = [
      "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
      "Assimilator", "Pylon", "Stargate", "Stalker", "Phoenix",
    ];
    const request = makeRequest(steps);
    const baseDone = adaptBuild(request).sim.completionTimes.Stalker?.[0] ?? 0;
    const r = applyFirstUnitDefenseGuard(adaptBuild(request), request, "Terran");
    expect(r.defense?.verdict).not.toBe("safe");
    // Still pulled earlier than the untouched order.
    expect(r.defense!.firstUnit!.doneSec).toBeLessThan(baseDone);
    expect(r.adaptationNotes[0]).toMatch(/exposed|undefended/);
  });

  it("leaves the order alone (verdict safe) when the first unit is in time", () => {
    const request = makeRequest([
      "Pylon", "Gateway", "Zealot", "Assimilator", "Nexus",
      "CyberneticsCore", "Stalker",
    ]);
    const base = adaptBuild(request);
    const r = applyFirstUnitDefenseGuard(base, request, "Terran");
    // Order untouched and no new warning, but the verdict is recorded.
    expect(r.actions).toBe(base.actions);
    expect(r.adaptationNotes).toEqual(base.adaptationNotes);
    expect(r.defense?.verdict).toBe("safe");
  });

  it("still guards (vs the fastest standard pressure) when the matchup is unknown", () => {
    const request = makeRequest([
      "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
      "Stargate", "Stalker",
    ]);
    const base = adaptBuild(request);
    const r = applyFirstUnitDefenseGuard(base, request, undefined);
    // The guard runs instead of bailing out: it evaluates the greedy
    // order against the fastest standard pressure and warns, with a note
    // that's honest about the assumed matchup.
    expect(r).not.toBe(base);
    expect(
      r.adaptationNotes.some((n) => n.includes("no matchup set")),
    ).toBe(true);
  });

  it("flags a unit-less opening as undefended (exposed)", () => {
    const r = guarded(
      ["Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore"],
      "Terran",
    );
    expect(r.defense?.verdict).toBe("unsafe");
    expect(r.defense?.firstUnit).toBeNull();
    expect(
      r.adaptationNotes.some((n) => n.includes("undefended")),
    ).toBe(true);
  });
});
