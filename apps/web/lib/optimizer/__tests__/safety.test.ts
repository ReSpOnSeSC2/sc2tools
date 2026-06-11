import { describe, expect, it } from "vitest";
import { resolveProfile } from "../patch/profiles";
import { evaluateSafety, evaluateThreat } from "../safety/evaluate";
import { defaultPolicies, simulate } from "../sim/engine";
import { threatCatalog } from "../threats/store";
import { deriveThreatFromBuild } from "../threats/derive";
import { referenceBuilds } from "../adapt/adapt";
import type { BuildAction, SafetyOptions, Threat } from "../types";

const profile = resolveProfile("5.0.16");
const catalog = threatCatalog(null);
const eightPool = catalog.find((t) => t.id === "z-8pool")!;
// proxy rax / oracle threats now derive from the reference catalog
const proxyRax = deriveThreatFromBuild(
  profile,
  referenceBuilds().find((b) => b.id === "terran-proxy-rax")!,
  "Terran",
)!;
const oracle = deriveThreatFromBuild(
  profile,
  referenceBuilds().find((b) => b.id === "protoss-stargate-opener")!,
  "Protoss",
)!;

const act = (kind: BuildAction["kind"], name: string): BuildAction => ({
  kind,
  name,
});

const noOptions: SafetyOptions = { hasWall: false, allowWorkerPull: false };
const defended: SafetyOptions = { hasWall: true, allowWorkerPull: true };

function sim(actions: BuildAction[], race: "Protoss" | "Terran" | "Zerg") {
  return simulate(actions, profile, race, {
    horizonSec: 360,
    policies: defaultPolicies(),
  });
}

describe("safety evaluation — 8-pool vs protoss", () => {
  it("greedy nexus-first with no units is unsafe", () => {
    const greedy = sim(
      [act("build", "Pylon"), act("build", "Nexus")],
      "Protoss",
    );
    const report = evaluateThreat(greedy, profile, eightPool, 0.9, noOptions);
    expect(report.verdict).toBe("unsafe");
    expect(report.worstMargin).toBeLessThan(0);
  });

  it("gateway units + cannon before the lings arrive is safe", () => {
    const defendedBuild = sim(
      [
        act("build", "Pylon"),
        act("build", "Forge"),
        act("build", "Gateway"),
        act("build", "PhotonCannon"),
        act("train", "Zealot"),
        act("train", "Zealot"),
      ],
      "Protoss",
    );
    const cannonDone = defendedBuild.completionTimes.PhotonCannon?.[0];
    expect(cannonDone).toBeDefined();
    expect(cannonDone!).toBeLessThan(eightPool.earliestArrivalSec + 30);
    const report = evaluateThreat(
      defendedBuild,
      profile,
      eightPool,
      0.9,
      defended,
    );
    expect(report.verdict).not.toBe("unsafe");
    expect(report.worstMargin).toBeGreaterThan(
      evaluateThreat(defendedBuild, profile, eightPool, 0.9, noOptions)
        .worstMargin,
    );
  });

  it("a wall + worker pull improves the margin vs melee waves", () => {
    const build = sim(
      [act("build", "Pylon"), act("build", "Gateway"), act("train", "Zealot")],
      "Protoss",
    );
    const bare = evaluateThreat(build, profile, eightPool, 0.9, noOptions);
    const walled = evaluateThreat(build, profile, eightPool, 0.9, defended);
    expect(walled.worstMargin).toBeGreaterThan(bare.worstMargin);
  });
});

describe("safety evaluation — proxy rax vs terran", () => {
  it("marines + bunker behind the wall holds proxy marines", () => {
    const build = sim(
      [
        act("build", "SupplyDepot"),
        act("build", "Barracks"),
        act("train", "Marine"),
        act("build", "Bunker"),
        act("train", "Marine"),
        act("build", "Barracks"),
        act("train", "Marine"),
        act("train", "Marine"),
        act("train", "Marine"),
      ],
      "Terran",
    );
    const report = evaluateThreat(build, profile, proxyRax, 0.8, defended);
    expect(report.verdict).not.toBe("unsafe");
  });

  it("a naked double-CC opening is punished", () => {
    const build = sim(
      [act("build", "SupplyDepot"), act("build", "CommandCenter")],
      "Terran",
    );
    const report = evaluateThreat(build, profile, proxyRax, 0.8, noOptions);
    expect(report.verdict).toBe("unsafe");
  });
});

describe("safety evaluation — air threats need anti-air", () => {
  it("zealots contribute nothing against oracles; stalkers do", () => {
    const meleeOnly = sim(
      [
        act("build", "Pylon"),
        act("build", "Gateway"),
        act("train", "Zealot"),
        act("train", "Zealot"),
        act("train", "Zealot"),
      ],
      "Protoss",
    );
    const withStalkers = sim(
      [
        act("build", "Pylon"),
        act("build", "Gateway"),
        act("build", "Assimilator"),
        act("build", "CyberneticsCore"),
        act("train", "Stalker"),
        act("train", "Stalker"),
      ],
      "Protoss",
    );
    const melee = evaluateThreat(meleeOnly, profile, oracle, 0.7, defended);
    const ranged = evaluateThreat(withStalkers, profile, oracle, 0.7, defended);
    expect(melee.verdict).toBe("unsafe");
    expect(ranged.worstMargin).toBeGreaterThan(melee.worstMargin);
  });
});

describe("grace window", () => {
  it("a defender finishing just after the wave half-counts", () => {
    const threat: Threat = {
      ...eightPool,
      waves: [{ timeSec: 100, units: { Zergling: 4 } }],
    };
    const build = sim(
      [act("build", "Pylon"), act("build", "Gateway"), act("train", "Zealot")],
      "Protoss",
    );
    const zealotDone = build.completionTimes.Zealot[0];
    // place the wave 5s before the zealot completes
    const tuned: Threat = {
      ...threat,
      waves: [{ timeSec: zealotDone - 5, units: { Zergling: 4 } }],
    };
    const before: Threat = {
      ...threat,
      waves: [{ timeSec: zealotDone - 30, units: { Zergling: 4 } }],
    };
    const graceReport = evaluateThreat(build, profile, tuned, 0.5, noOptions);
    const earlyReport = evaluateThreat(build, profile, before, 0.5, noOptions);
    expect(graceReport.worstMargin).toBeGreaterThan(earlyReport.worstMargin);
  });
});

describe("overall report", () => {
  it("aggregates the worst verdict across threats", () => {
    const build = sim(
      [act("build", "Pylon"), act("build", "Nexus")],
      "Protoss",
    );
    const report = evaluateSafety(
      build,
      profile,
      [
        { threat: eightPool, probability: 0.8 },
        { threat: oracle, probability: 0.2 },
      ],
      noOptions,
    );
    expect(report.overall).toBe("unsafe");
    expect(report.threats).toHaveLength(2);
    expect(report.threats[0].waves.length).toBe(eightPool.waves.length);
  });
});
