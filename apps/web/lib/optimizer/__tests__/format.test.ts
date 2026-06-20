import { describe, expect, it } from "vitest";
import { actionsFromSteps, adaptBuild } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import { displaySteps } from "../sim/format";
import type { AdaptRequest } from "../types";

function adapt(steps: string[]) {
  const profile = resolveProfile("5.0.16");
  const { actions } = actionsFromSteps(profile, steps);
  const request: AdaptRequest = {
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: "format-check",
    threats: [],
    policies: { ...defaultPolicies(), reserveWorkerCost: true },
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec: 420,
  };
  return adaptBuild(request);
}

describe("displaySteps", () => {
  it("exposes both a start time and a (later) done time the UI can show", () => {
    const result = adapt([
      "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore", "Stalker",
    ]);
    const steps = displaySteps(result.sim);
    const stalker = steps.find((s) => s.name === "Stalker");
    expect(stalker).toBeDefined();
    // start ("14 Stalker 2:45") and finish ("on the field 3:12") are both
    // populated, and the finish strictly trails the start.
    expect(stalker!.time).toMatch(/^\d+:\d{2}$/);
    expect(stalker!.doneTime).toMatch(/^\d+:\d{2}$/);
    const toSec = (mmss: string) => {
      const [m, s] = mmss.split(":").map(Number);
      return m * 60 + s;
    };
    expect(toSec(stalker!.time)).toBe(Math.round(stalker!.startSec));
    expect(toSec(stalker!.doneTime)).toBeGreaterThan(toSec(stalker!.time));
  });
});
