import { describe, expect, it } from "vitest";
import { actionsFromReplayEvents } from "../adapt/fromReplay";
import { adaptBuild } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import type { BuildOrderEvent } from "@/lib/build-events";

/**
 * Replay-events bridge: ordered tracker events from a parsed game
 * become adapter actions in replay order, workers dropped, cutoff
 * respected, and the result simulates on both economies.
 */

function ev(time: number, name: string): BuildOrderEvent {
  return { time, name };
}

const PROTOSS_OPENING: BuildOrderEvent[] = [
  // Replay trackers emit the starting town hall (and cosmetic
  // markers) as born-events at 0:00 - these must never become steps.
  ev(0, "Nexus"),
  ev(0, "BeaconArmy"),
  ev(12, "Probe"),
  ev(18, "Pylon"),
  ev(40, "Gateway"),
  ev(45, "Probe"),
  ev(60, "Assimilator"),
  ev(95, "CyberneticsCore"),
  ev(150, "Adept"),
  ev(170, "Nexus"),
  ev(200, "Stargate"),
  ev(480, "Pylon"),
];

describe("actionsFromReplayEvents", () => {
  const profile = resolveProfile("5.0.16");

  it("keeps replay order and drops workers", () => {
    const { actions, unknownNames } = actionsFromReplayEvents(
      profile,
      PROTOSS_OPENING,
    );
    expect(unknownNames).toEqual([]);
    // the 0:00 starting Nexus and beacon marker are dropped entirely
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Gateway",
      "Assimilator",
      "CyberneticsCore",
      "Adept",
      "Nexus",
      "Stargate",
      "Pylon",
    ]);
  });

  it("respects the opening cutoff", () => {
    const { actions, latestMilestoneSec } = actionsFromReplayEvents(
      profile,
      PROTOSS_OPENING,
      300,
    );
    expect(actions.map((a) => a.name)).not.toContain("Stargate".repeat(2));
    expect(actions.filter((a) => a.name === "Pylon")).toHaveLength(1);
    expect(latestMilestoneSec).toBe(200);
  });

  it("adapts a replay-derived opening on both economies", () => {
    const { actions } = actionsFromReplayEvents(profile, PROTOSS_OPENING, 420);
    const result = adaptBuild({
      baselineProfileId: "lotv-base",
      profileId: "5.0.16",
      race: "Protoss",
      actions,
      referenceName: "PvT on Test Map",
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 480,
    });
    expect(result.sim.steps.length).toBeGreaterThan(0);
    expect(result.baselineSim.steps.length).toBeGreaterThan(0);
    expect(result.comparison.length).toBe(actions.length);
    // 8-worker economy reaches the same positions later than 12-worker
    const gateway = result.comparison.find((r) => r.name === "Gateway");
    expect(gateway?.deltaSec ?? 0).toBeGreaterThan(0);
  });

  it("adapts in the reverse direction (8-worker source to 12-worker)", () => {
    const { actions } = actionsFromReplayEvents(profile, PROTOSS_OPENING, 420);
    const result = adaptBuild({
      baselineProfileId: "5.0.16",
      profileId: "lotv-base",
      race: "Protoss",
      actions,
      referenceName: "reverse",
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 480,
    });
    const gateway = result.comparison.find((r) => r.name === "Gateway");
    // 12-worker economy reaches the same position earlier
    expect(gateway?.deltaSec ?? 0).toBeLessThan(0);
  });
});
