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

  it("pulls a greedy build's first unit ahead of later tech", () => {
    // Phoenix-opener shape: stargate (and more) before the first
    // gateway unit. The stalker should be pulled to right after the
    // cybernetics core.
    const r = guarded(
      [
        "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore",
        "Assimilator", "Pylon", "Stargate", "Stalker", "Phoenix",
      ],
      "Terran",
    );
    const names = r.actions.map((a) => a.name);
    expect(names.indexOf("Stalker")).toBeLessThan(names.indexOf("Stargate"));
    expect(names.indexOf("Stalker")).toBeGreaterThan(
      names.indexOf("CyberneticsCore"),
    );
    expect(r.adaptationNotes.some((n) => n.includes("Pulled your first"))).toBe(
      true,
    );
  });

  it("leaves a build alone when its first unit is already in time", () => {
    const request = makeRequest([
      "Pylon", "Gateway", "Zealot", "Assimilator", "Nexus",
      "CyberneticsCore", "Stalker",
    ]);
    const base = adaptBuild(request);
    const r = applyFirstUnitDefenseGuard(base, request, "Terran");
    expect(r).toBe(base);
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

  it("warns (without reordering) when the unit is already earliest but late", () => {
    const r = guarded(
      ["Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore", "Stalker"],
      "Terran",
    );
    const names = r.actions.map((a) => a.name);
    // order unchanged: stalker already right after its tech
    expect(names.indexOf("Stalker")).toBe(names.length - 1);
    expect(
      r.adaptationNotes.some(
        (n) => n.includes("pressure") || n.includes("Greedy"),
      ),
    ).toBe(true);
  });
});
