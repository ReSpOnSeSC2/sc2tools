import { describe, expect, it } from "vitest";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import {
  applyChronoToTask,
  completionWithChrono,
} from "../sim/production";
import type { BuildAction, SimOptions } from "../types";

const profile = resolveProfile("5.0.16");

function opts(overrides: Partial<SimOptions> = {}): SimOptions {
  return { horizonSec: 420, policies: defaultPolicies(), ...overrides };
}

const act = (
  kind: BuildAction["kind"],
  name: string,
  target?: string,
): BuildAction => ({ kind, name, target });

describe("chrono math", () => {
  it("a fully-covered task speeds up by the boost factor", () => {
    // 20s chrono at 1.5x covers 30s of work
    expect(completionWithChrono(100, 30, 120, 1.5)).toBeCloseTo(120, 5);
    expect(applyChronoToTask(100, 130, 20, 1.5)).toBeCloseTo(120, 5);
  });

  it("a partially-covered task saves only the boosted span", () => {
    // 40s of work, 20s boosted window does 30s of it, 10s remain after
    expect(applyChronoToTask(100, 140, 20, 1.5)).toBeCloseTo(130, 5);
  });

  it("an explicit chrono action shortens gateway production in-sim", () => {
    const base: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("train", "Zealot"),
    ];
    const boosted: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("train", "Zealot"),
      act("chrono", "Gateway"),
    ];
    const plain = simulate(base, profile, "Protoss", opts());
    const chrono = simulate(boosted, profile, "Protoss", opts());
    const plainZealot = plain.completionTimes.Zealot[0];
    const chronoZealot = chrono.completionTimes.Zealot[0];
    expect(chronoZealot).toBeLessThan(plainZealot - 5);
    expect(chrono.events.some((e) => e.kind === "chrono")).toBe(true);
  });
});

describe("zerg larva mechanics", () => {
  it("queen injects land after the configured delay and add larvae", () => {
    const actions: BuildAction[] = [
      act("build", "SpawningPool"),
      act("train", "Queen"),
    ];
    const result = simulate(actions, profile, "Zerg", opts());
    const queenDone = result.completionTimes.Queen[0];
    const injectLands = result.events.filter(
      (e) => e.kind === "inject" && e.name === "LarvaeSpawned",
    );
    expect(injectLands.length).toBeGreaterThan(0);
    // queen spawns with exactly one inject's energy: first landing is
    // one delay after the queen pops (policy tick adds ≤1s of slack)
    expect(injectLands[0].time).toBeGreaterThanOrEqual(
      queenDone + profile.mechanics.inject.delaySec - 0.01,
    );
    expect(injectLands[0].time).toBeLessThan(
      queenDone + profile.mechanics.inject.delaySec + 2,
    );
  });

  it("injects raise larva throughput (more lings by the horizon)", () => {
    const lingSpam = Array.from({ length: 20 }, () => act("train", "Zergling"));
    const withQueen = simulate(
      [act("build", "SpawningPool"), act("train", "Queen"), ...lingSpam],
      profile,
      "Zerg",
      opts(),
    );
    const without = simulate(
      [act("build", "SpawningPool"), ...lingSpam],
      profile,
      "Zerg",
      opts(),
    );
    const lastWith = (withQueen.completionTimes.Zergling ?? []).slice(-1)[0];
    const lastWithout = (without.completionTimes.Zergling ?? []).slice(-1)[0];
    // same 20 orders, but injected larvae finish them much sooner
    expect(lastWith).toBeLessThan(lastWithout - 30);
  });
});

describe("terran orbital mechanics", () => {
  it("MULEs fire once energy reaches the calldown cost", () => {
    const actions: BuildAction[] = [
      act("build", "SupplyDepot"),
      act("build", "Barracks"),
      act("morph", "OrbitalCommand"),
    ];
    const result = simulate(actions, profile, "Terran", opts());
    const orbitalDone = result.completionTimes.OrbitalCommand[0];
    const firstMule = result.events.find((e) => e.kind === "mule");
    expect(firstMule).toBeDefined();
    // orbital starts at 50 energy == exactly one MULE
    expect(firstMule!.time).toBeLessThan(orbitalDone + 2);
  });

  it("a reactor enables parallel marine production", () => {
    const single: BuildAction[] = [
      act("build", "SupplyDepot"),
      act("build", "Barracks"),
      ...Array.from({ length: 6 }, () => act("train", "Marine")),
    ];
    const reactored: BuildAction[] = [
      act("build", "SupplyDepot"),
      act("build", "Barracks"),
      act("build", "Refinery"),
      act("build", "BarracksReactor"),
      ...Array.from({ length: 6 }, () => act("train", "Marine")),
    ];
    const a = simulate(single, profile, "Terran", opts());
    const b = simulate(reactored, profile, "Terran", opts());
    const sixthA = a.completionTimes.Marine[5];
    const sixthB = b.completionTimes.Marine[5];
    expect(sixthB).toBeLessThan(sixthA);
  });

  it("tech-lab-gated units wait for the addon", () => {
    const actions: BuildAction[] = [
      act("build", "SupplyDepot"),
      act("build", "Barracks"),
      act("build", "Refinery"),
      act("build", "BarracksTechLab"),
      act("train", "Marauder"),
    ];
    const result = simulate(actions, profile, "Terran", opts());
    expect(result.unexecutedActions).toBe(0);
    const labDone = result.steps.find(
      (s) => s.name === "BarracksTechLab",
    )!.doneSec;
    const marauder = result.steps.find((s) => s.name === "Marauder")!;
    expect(marauder.startSec).toBeGreaterThanOrEqual(labDone - 0.01);
  });
});

describe("5.0.16 warpgate rework", () => {
  it("research occupies the gateway for its full 100s (PTR behavior)", () => {
    const actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("build", "Assimilator"),
      act("build", "CyberneticsCore"),
      act("research", "WarpGateResearch"),
      ...Array.from({ length: 2 }, () => act("train", "Zealot")),
    ];
    const result = simulate(actions, profile, "Protoss", opts({ horizonSec: 600 }));
    expect(result.unexecutedActions).toBe(0);
    const research = result.steps.find(
      (s) => s.name === "WarpGateResearch",
    )!;
    // PTR research time is 100s (5.0.16 delta over the 114s baseline)
    expect(research.doneSec - research.startSec).toBeCloseTo(100, 1);
    // the only gateway is researching — no unit can START inside the
    // research window (lookahead may legally train BEFORE it begins,
    // while the cybernetics core is still building)
    const zealots = result.steps.filter((s) => s.name === "Zealot");
    for (const z of zealots) {
      const inside =
        z.startSec > research.startSec + 0.01 &&
        z.startSec < research.doneSec - 0.01;
      expect(inside).toBe(false);
    }
    // a post-research zealot exists and runs at the 1.35x speed
    const boosted = zealots.find(
      (z) => z.startSec >= research.doneSec - 0.01,
    )!;
    expect(boosted).toBeDefined();
    expect(boosted.doneSec - boosted.startSec).toBeCloseTo(
      profile.units.Zealot.buildTime / 1.35,
      1,
    );
  });

  it("a second gateway keeps producing while the first researches", () => {
    const actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("build", "Gateway"),
      act("build", "Assimilator"),
      act("build", "CyberneticsCore"),
      act("research", "WarpGateResearch"),
      act("train", "Zealot"),
    ];
    const result = simulate(actions, profile, "Protoss", opts({ horizonSec: 600 }));
    expect(result.unexecutedActions).toBe(0);
    const research = result.steps.find(
      (s) => s.name === "WarpGateResearch",
    )!;
    const zealot = result.steps.find((s) => s.name === "Zealot")!;
    expect(zealot.startSec).toBeLessThan(research.doneSec);
  });

  it("transformed warpgates warp in on cooldown semantics", () => {
    const actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("build", "Assimilator"),
      act("build", "CyberneticsCore"),
      act("research", "WarpGateResearch"),
      act("transform-warpgate", "Gateway"),
      ...Array.from({ length: 7 }, () => act("train", "Zealot")),
    ];
    const result = simulate(actions, profile, "Protoss", opts({ horizonSec: 600 }));
    expect(result.unexecutedActions).toBe(0);
    const transformDone = result.events.find(
      (e) => e.kind === "complete" && e.name === "WarpGate",
    )!.time;
    const zealots = result.steps.filter((s) => s.name === "Zealot");
    // lookahead trains gateway zealots while the transform waits on
    // the research; the ones AFTER the transform are warped
    const warped = zealots.filter((z) => z.startSec >= transformDone - 0.01);
    expect(warped.length).toBeGreaterThanOrEqual(2);
    // warp-in is near-instant…
    expect(warped[0].doneSec - warped[0].startSec).toBeCloseTo(
      profile.mechanics.warpgate.warpInSec,
      1,
    );
    // …but the next warp waits out the 22s cooldown
    expect(warped[1].startSec - warped[0].startSec).toBeGreaterThanOrEqual(
      profile.mechanics.warpgate.cooldowns.Zealot - 0.01,
    );
  });
});

describe("build-order lookahead", () => {
  it("starts later mineral-only steps while the head waits on a producer", () => {
    // zealot #2 is stuck behind a busy gateway; a player would start
    // the forge in the meantime rather than freeze the build.
    const actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Gateway"),
      act("train", "Zealot"),
      act("train", "Zealot"),
      act("build", "Forge"),
    ];
    const result = simulate(actions, profile, "Protoss", opts());
    expect(result.unexecutedActions).toBe(0);
    const zealots = result.steps.filter((s) => s.name === "Zealot");
    const forge = result.steps.find((s) => s.name === "Forge")!;
    expect(forge.startSec).toBeLessThan(zealots[1].startSec);
  });

  it("never lets lookahead steal the head step's resources", () => {
    // head nexus is blocked purely on minerals (saving to 400) — the
    // forge behind it must NOT jump the queue and spend the savings.
    const actions: BuildAction[] = [
      act("build", "Pylon"),
      act("build", "Nexus"),
      act("build", "Forge"),
    ];
    const result = simulate(actions, profile, "Protoss", opts());
    const nexus = result.steps.find((s) => s.name === "Nexus")!;
    const forge = result.steps.find((s) => s.name === "Forge")!;
    expect(forge.startSec).toBeGreaterThanOrEqual(nexus.startSec);
  });
});
