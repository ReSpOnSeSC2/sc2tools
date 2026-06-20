import { describe, expect, it } from "vitest";
import { actionsFromSteps } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type { MacroPolicies, SimResult } from "../types";

const GREEDY = [
  "Pylon", "Gateway", "Assimilator", "Nexus", "CyberneticsCore", "Stalker",
];
// Nexus-heavy opener where minerals bind the expansion, so freeing worker
// minerals visibly pulls it forward.
const EXPAND_FIRST = ["Pylon", "Nexus", "Gateway"];

function run(steps: string[], policies: MacroPolicies): SimResult {
  const profile = resolveProfile("5.0.16");
  const { actions } = actionsFromSteps(profile, steps);
  return simulate(actions, profile, "Protoss", { horizonSec: 420, policies });
}

function probesBy(result: SimResult, t: number): number {
  return (result.completionTimes.Probe ?? []).filter((s) => s <= t).length;
}

function nexusStart(result: SimResult): number {
  return result.steps.find((s) => s.name === "Nexus")?.startSec ?? Infinity;
}

describe("probe-cut engine lever", () => {
  it("is inert by default (defaultPolicies carries no cut)", () => {
    expect(defaultPolicies().workerCut).toBeUndefined();
  });

  it("freezing the window frees minerals to pull the expansion earlier", () => {
    const base = run(EXPAND_FIRST, defaultPolicies());
    const cut = run(EXPAND_FIRST, {
      ...defaultPolicies(),
      workerCut: { fromSec: 40, untilSec: 80 },
    });
    // The frozen worker minerals pull the 400-mineral Nexus clearly forward.
    expect(nexusStart(cut)).toBeLessThan(nexusStart(base) - 3);
    // Fewer probes built during the window (the cut actually happened).
    expect(probesBy(cut, 80)).toBeLessThan(probesBy(base, 80));
  });

  it("recovers the economy by the macro horizon", () => {
    const base = run(GREEDY, defaultPolicies());
    const cut = run(GREEDY, {
      ...defaultPolicies(),
      workerCut: { fromSec: 55, untilSec: 110 },
    });
    // A short cut pulls the Nexus forward...
    expect(nexusStart(cut)).toBeLessThan(nexusStart(base));
    // ...and the worker economy is fully recovered by 5:00 (the earlier
    // Nexus can even put it ahead).
    expect(probesBy(cut, 300)).toBeGreaterThanOrEqual(probesBy(base, 300));
  });

  it("caps the freeze window so a long cut can't starve the economy", () => {
    const base = run(GREEDY, defaultPolicies());
    // An absurd 5-minute window is capped at MAX_CUT_WINDOW_SEC (30s).
    const capped = run(GREEDY, {
      ...defaultPolicies(),
      workerCut: { fromSec: 30, untilSec: 330 },
    });
    // Workers resume well before the requested window ends, so the long-run
    // economy is not wrecked (within a few probes of baseline by 5:00).
    expect(probesBy(capped, 300)).toBeGreaterThanOrEqual(probesBy(base, 300) - 4);
  });
});
