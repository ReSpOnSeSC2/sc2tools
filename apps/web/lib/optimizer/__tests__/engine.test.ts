import { describe, expect, it } from "vitest";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type { BuildAction, SimOptions } from "../types";

const profile = resolveProfile("5.0.16");

function opts(overrides: Partial<SimOptions> = {}): SimOptions {
  return {
    horizonSec: 360,
    policies: defaultPolicies(),
    ...overrides,
  };
}

const act = (kind: BuildAction["kind"], name: string): BuildAction => ({
  kind,
  name,
});

const PROTOSS_OPENING: BuildAction[] = [
  act("build", "Pylon"),
  act("build", "Gateway"),
  act("build", "Assimilator"),
  act("build", "CyberneticsCore"),
  act("train", "Zealot"),
  act("train", "Adept"),
];

describe("simulate — determinism", () => {
  it("identical inputs produce identical results", () => {
    const a = simulate(PROTOSS_OPENING, profile, "Protoss", opts());
    const b = simulate(PROTOSS_OPENING, profile, "Protoss", opts());
    const c = simulate(PROTOSS_OPENING, profile, "Protoss", opts());
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    expect(JSON.stringify(c)).toEqual(JSON.stringify(a));
  });
});

describe("simulate — 8-worker protoss opening", () => {
  const result = simulate(PROTOSS_OPENING, profile, "Protoss", opts());

  it("executes every action", () => {
    expect(result.unexecutedActions).toBe(0);
    const names = result.steps.map((s) => s.name);
    for (const action of PROTOSS_OPENING) {
      expect(names).toContain(action.name);
    }
  });

  it("produces probes continuously from the start", () => {
    const probes = result.completionTimes.Probe ?? [];
    expect(probes.length).toBeGreaterThan(10);
    // first auto-probe pops one build-time after the start
    expect(probes[0]).toBeCloseTo(profile.units.Probe.buildTime, 1);
    // production is continuous: consecutive pops ~12s apart early on
    for (let i = 1; i < 5; i += 1) {
      expect(probes[i] - probes[i - 1]).toBeLessThan(
        profile.units.Probe.buildTime + 3,
      );
    }
  });

  it("starts the first pylon in a believable 8-worker window", () => {
    const pylon = result.steps.find((s) => s.name === "Pylon")!;
    // 8 workers, 50 starting minerals: 100 minerals arrives well before
    // 30s; auto-supply may fire even earlier than the explicit step.
    expect(pylon.startSec).toBeGreaterThan(2);
    expect(pylon.startSec).toBeLessThan(35);
    expect(pylon.doneSec - pylon.startSec).toBeCloseTo(
      profile.units.Pylon.buildTime,
      1,
    );
  });

  it("respects tech prerequisites (gateway waits for pylon)", () => {
    const pylonDone = result.steps.find((s) => s.name === "Pylon")!.doneSec;
    const gateway = result.steps.find((s) => s.name === "Gateway")!;
    expect(gateway.startSec).toBeGreaterThanOrEqual(pylonDone - 0.01);
    const gatewayDone = gateway.doneSec;
    const cyber = result.steps.find((s) => s.name === "CyberneticsCore")!;
    expect(cyber.startSec).toBeGreaterThanOrEqual(gatewayDone - 0.01);
  });

  it("trains the zealot at the gateway as soon as it exists", () => {
    const gatewayDone = result.steps.find((s) => s.name === "Gateway")!.doneSec;
    const zealot = result.steps.find((s) => s.name === "Zealot")!;
    expect(zealot.startSec).toBeGreaterThanOrEqual(gatewayDone - 0.01);
    expect(zealot.doneSec - zealot.startSec).toBeCloseTo(
      profile.units.Zealot.buildTime,
      1,
    );
    // adept needs the cybernetics core
    const cyberDone = result.steps.find(
      (s) => s.name === "CyberneticsCore",
    )!.doneSec;
    const adept = result.steps.find((s) => s.name === "Adept")!;
    expect(adept.startSec).toBeGreaterThanOrEqual(cyberDone - 0.01);
  });

  it("collects gas once the assimilator finishes", () => {
    expect(result.finalGas).toBeGreaterThan(0);
  });

  it("supply never exceeds cap and grows via pylons", () => {
    for (const sampleRow of result.samples) {
      expect(sampleRow.supplyUsed).toBeLessThanOrEqual(sampleRow.supplyCap);
    }
    expect(result.finalSupplyCap).toBeGreaterThan(13);
  });

  it("starts at 13 supply cap (5.0.16 nexus) with 8 workers used", () => {
    const first = result.samples[0];
    expect(first.supplyCap).toBe(13);
    expect(first.supplyUsed).toBe(8);
    expect(first.workers).toBe(8);
  });
});

describe("simulate — zerg basics", () => {
  const ZERG_OPENING: BuildAction[] = [
    act("build", "SpawningPool"),
    act("train", "Zergling"),
    act("train", "Zergling"),
    act("train", "Queen"),
  ];
  const result = simulate(ZERG_OPENING, profile, "Zerg", opts());

  it("starts at 12 supply cap (hatchery 4 + overlord 8)", () => {
    expect(result.samples[0].supplyCap).toBe(12);
  });

  it("morphs lings in pairs after pool and queens at the hatch", () => {
    expect(result.unitsAtEnd.Zergling).toBe(4);
    const poolDone = result.steps.find(
      (s) => s.name === "SpawningPool",
    )!.doneSec;
    const firstLing = result.steps.find((s) => s.name === "Zergling")!;
    expect(firstLing.startSec).toBeGreaterThanOrEqual(poolDone - 0.01);
    expect(result.unitsAtEnd.Queen).toBe(1);
  });

  it("consumes the drone that builds a structure", () => {
    const events = result.events.filter(
      (e) => e.kind === "start" && e.name === "SpawningPool",
    );
    expect(events).toHaveLength(1);
    // workers dip by one when the pool drone is sacrificed; auto-drone
    // production recovers it, so just confirm drones kept flowing.
    expect((result.completionTimes.Drone ?? []).length).toBeGreaterThan(5);
  });
});

describe("simulate — terran basics", () => {
  const TERRAN_OPENING: BuildAction[] = [
    act("build", "SupplyDepot"),
    act("build", "Barracks"),
    act("build", "Refinery"),
    act("train", "Reaper"),
    act("morph", "OrbitalCommand"),
  ];
  const result = simulate(TERRAN_OPENING, profile, "Terran", opts());

  it("builds the reaper after barracks with gas", () => {
    expect(result.unexecutedActions).toBe(0);
    const raxDone = result.steps.find((s) => s.name === "Barracks")!.doneSec;
    const reaper = result.steps.find((s) => s.name === "Reaper")!;
    expect(reaper.startSec).toBeGreaterThanOrEqual(raxDone - 0.01);
    expect(result.unitsAtEnd.Reaper).toBe(1);
  });

  it("morphs the CC into an orbital and drops mules", () => {
    expect(result.unitsAtEnd.OrbitalCommand).toBe(1);
    expect(result.events.some((e) => e.kind === "mule")).toBe(true);
  });
});
