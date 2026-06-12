import { describe, expect, it } from "vitest";
import { actionsFromSteps, adaptBuild } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import type { AdaptResult } from "../types";

/**
 * reserveWorkerCost ("strict economy" / 11-pylon discipline): head
 * actions may never spend the minerals the town hall needs for its
 * next worker, so worker production stays perfectly gapless. With the
 * flag off the engine is greedy: structures start the moment the bank
 * covers them, accepting a few seconds of worker drift in exchange
 * for earlier tech.
 */

function run(reserveWorkerCost: boolean): AdaptResult {
  const profile = resolveProfile("5.0.16");
  const { actions } = actionsFromSteps(profile, [
    "Pylon",
    "Gateway",
    "Assimilator",
    "CyberneticsCore",
    "Pylon",
    "Adept",
  ]);
  return adaptBuild({
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: "econ-mode-check",
    threats: [],
    policies: { ...defaultPolicies(), reserveWorkerCost },
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec: 180,
  });
}

function probeStarts(result: AdaptResult): number[] {
  const buildTime = resolveProfile("5.0.16").units.Probe.buildTime;
  return (result.sim.completionTimes.Probe ?? []).map((t) => t - buildTime);
}

describe("reserveWorkerCost (strict economy mode)", () => {
  it("keeps worker production perfectly gapless while below saturation", () => {
    const strict = run(true);
    const starts = probeStarts(strict).slice(0, 10);
    const buildTime = resolveProfile("5.0.16").units.Probe.buildTime;
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeCloseTo(buildTime, 1);
    }
  });

  it("produces the later, supply-higher pylon (11) vs greedy (10)", () => {
    const strict = run(true);
    const greedy = run(false);
    const pylonOf = (r: AdaptResult) =>
      r.sim.steps.find((s) => s.name === "Pylon")!;
    expect(greedy.sim.steps.length).toBeGreaterThan(0);
    expect(pylonOf(greedy).supply).toBe(10);
    expect(pylonOf(strict).supply).toBeGreaterThanOrEqual(11);
    expect(pylonOf(strict).startSec).toBeGreaterThan(pylonOf(greedy).startSec);
  });

  it("is strictly more economical: more minerals mined by 2:00", () => {
    const mined = (r: AdaptResult) => {
      let total = 0;
      const samples = r.sim.samples;
      for (let i = 1; i < samples.length; i += 1) {
        const a = samples[i - 1];
        const b = samples[i];
        if (a.time >= 120) break;
        // mineralRate samples are per minute
        total += (a.mineralRate / 60) * (Math.min(b.time, 120) - a.time);
      }
      return total;
    };
    expect(mined(run(true))).toBeGreaterThan(mined(run(false)));
  });

  it("greedy mode still reaches tech earlier (the tempo trade-off)", () => {
    const gateOf = (r: AdaptResult) =>
      r.sim.steps.find((s) => s.name === "Gateway")!;
    expect(gateOf(run(false)).startSec).toBeLessThan(
      gateOf(run(true)).startSec,
    );
  });
});
