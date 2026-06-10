import { describe, expect, it } from "vitest";
import { mulberry32 } from "@/lib/randomizer/engine";
import { resolveProfile } from "../patch/profiles";
import { mutate, repair } from "../search/mutate";
import { defaultPolicies, simulate } from "../sim/engine";
import type { BuildAction } from "../types";

/**
 * Regression tests for the degenerate "pure economy" outputs reported
 * against the first release: pylon spam from the supply-headroom
 * feedback loop, and assimilator spam surviving the repair pass.
 */

const profile = resolveProfile("5.0.16");

const act = (kind: BuildAction["kind"], name: string): BuildAction => ({
  kind,
  name,
});

describe("auto-supply headroom", () => {
  it("does not snowball pylons as non-producer structures pile up", () => {
    // Lots of structures, only one real producer (the gateway):
    // headroom must track producers, not pylons/forges/assimilators.
    const actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("build", "Assimilator"),
      act("build", "Forge"),
      act("build", "Nexus"),
      act("build", "Assimilator"),
    ];
    const result = simulate(actions, profile, "Protoss", {
      horizonSec: 400,
      policies: defaultPolicies(),
    });
    // Pre-fix this build banked 30+ free supply by the horizon as
    // every pylon raised the headroom that demanded the next pylon.
    const freeSupply = result.finalSupplyCap - result.finalSupplyUsed;
    expect(freeSupply).toBeLessThanOrEqual(16);
    const pylons = result.steps.filter((s) => s.name === "Pylon").length;
    expect(pylons).toBeLessThanOrEqual(8);
  });
});

describe("repair pass realism caps", () => {
  it("caps gas buildings at two per town hall", () => {
    const spam: BuildAction[] = [
      act("build", "Pylon"),
      ...Array.from({ length: 6 }, () => act("build", "Assimilator")),
      act("build", "Gateway"),
    ];
    const repaired = repair(spam, profile, "Protoss", 40);
    const gas = repaired.filter((a) => a.name === "Assimilator").length;
    expect(gas).toBeLessThanOrEqual(2);
  });

  it("allows more gas once expansions are in the plan", () => {
    const plan: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Assimilator"),
      act("build", "Assimilator"),
      act("build", "Nexus"),
      act("build", "Assimilator"),
      act("build", "Assimilator"),
    ];
    const repaired = repair(plan, profile, "Protoss", 40);
    const gas = repaired.filter((a) => a.name === "Assimilator").length;
    expect(gas).toBe(4);
  });

  it("holds the caps under sustained random mutation", () => {
    const rng = mulberry32(99);
    let actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("build", "Assimilator"),
      act("build", "Nexus"),
    ];
    for (let i = 0; i < 200; i += 1) {
      actions = repair(mutate(actions, "Protoss", rng), profile, "Protoss", 40);
    }
    const gas = actions.filter((a) => a.name === "Assimilator").length;
    const townHalls =
      1 + actions.filter((a) => a.name === "Nexus").length;
    expect(gas).toBeLessThanOrEqual(2 * townHalls);
    expect(actions.filter((a) => a.name === "Nexus").length).toBeLessThanOrEqual(3);
  });
});
