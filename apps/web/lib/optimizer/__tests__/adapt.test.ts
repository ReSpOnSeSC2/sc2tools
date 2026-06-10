import { describe, expect, it } from "vitest";
import {
  actionsFromCustomBuild,
  actionsFromSignature,
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
  referenceBuildsForRace,
} from "../adapt/adapt";
import { resolveProfile, validateProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import { threatCatalog, threatsForMatchup } from "../threats/store";
import type { AdaptRequest } from "../types";

const target = resolveProfile("5.0.16");

describe("reference build catalog", () => {
  it("every shipped step resolves against the patch profile", () => {
    validateProfile(target);
    for (const build of referenceBuilds()) {
      const { actions, unknownNames } = actionsFromSteps(target, build.steps);
      expect(unknownNames, `${build.id} has unknown steps`).toEqual([]);
      expect(actions.length, `${build.id} resolved empty`).toBeGreaterThan(5);
    }
  });

  it("covers all three races", () => {
    expect(referenceBuildsForRace("Protoss").length).toBeGreaterThanOrEqual(2);
    expect(referenceBuildsForRace("Terran").length).toBeGreaterThanOrEqual(2);
    expect(referenceBuildsForRace("Zerg").length).toBeGreaterThanOrEqual(2);
  });
});

describe("action resolution", () => {
  it("drops worker steps but keeps supply and order", () => {
    const { actions } = actionsFromSteps(target, [
      "Probe",
      "Pylon",
      "Gateway",
      "SCV",
      "Assimilator",
      "Drone",
      "Nexus",
    ]);
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Gateway",
      "Assimilator",
      "Nexus",
    ]);
  });

  it("maps morphs and research to the right action kinds", () => {
    const { actions } = actionsFromSteps(target, [
      "Barracks",
      "OrbitalCommand",
      "Stimpack",
    ]);
    expect(actions).toEqual([
      { kind: "build", name: "Barracks" },
      { kind: "morph", name: "OrbitalCommand" },
      { kind: "research", name: "Stimpack" },
    ]);
  });

  it("resolves rules-only builds (v3 editor format) via rulesToSignature", () => {
    const { actions } = actionsFromCustomBuild(target, {
      rules: [
        { type: "before", name: "Gateway", time_lt: 60 },
        { type: "count_min", name: "Zealot", time_lt: 180, count: 2 },
        { type: "before", name: "CyberneticsCore", time_lt: 150 },
        { type: "not_before", name: "Nexus", time_lt: 100 },
      ],
    });
    // pylon injected as the gateway's implied prerequisite
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Gateway",
      "CyberneticsCore",
      "Zealot",
      "Zealot",
    ]);
  });

  it("strips agent verb prefixes from rules names (BuildVoidRay)", () => {
    // the v3 editor stores the agent's event names — the user's
    // "DT into 3 Stargate Void Ray" build failed to resolve entirely
    const { actions, unknownNames } = actionsFromCustomBuild(target, {
      rules: [
        { type: "before", name: "BuildDarkShrine", time_lt: 324 },
        { type: "count_min", name: "BuildStargate", time_lt: 600, count: 3 },
        { type: "count_min", name: "BuildVoidRay", time_lt: 700, count: 2 },
      ],
    });
    expect(unknownNames).toEqual([]);
    const names = actions.map((a) => a.name);
    // milestones resolved with verb prefixes stripped…
    expect(names.filter((n) => n === "Stargate")).toHaveLength(3);
    expect(names.filter((n) => n === "VoidRay")).toHaveLength(2);
    // …and the implied tech chain injected before its dependents
    expect(names.indexOf("Gateway")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("CyberneticsCore")).toBeLessThan(
      names.indexOf("DarkShrine"),
    );
    expect(names.indexOf("TwilightCouncil")).toBeLessThan(
      names.indexOf("DarkShrine"),
    );
    expect(names.indexOf("CyberneticsCore")).toBeLessThan(
      names.indexOf("Stargate"),
    );
  });

  it("maps legacy 'warpgate' names from saved builds to Gateway", () => {
    const { actions, unknownNames } = actionsFromSteps(target, [
      "Pylon",
      "warpgate",
      "WarpGate",
    ]);
    expect(unknownNames).toEqual([]);
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Gateway",
      "Gateway",
    ]);
  });

  it("resolves saved-build signatures (lowercase icon names, by time)", () => {
    const { actions, unknownNames } = actionsFromSignature(target, [
      { unit: "gateway", count: 2, beforeSec: 40 },
      { unit: "pylon", count: 3, beforeSec: 20 },
      { unit: "cyberneticscore", count: 1, beforeSec: 90 },
      { unit: "notathing", count: 1, beforeSec: 5 },
    ]);
    expect(unknownNames).toEqual(["notathing"]);
    // earliest-seen first; counts expand to repeated ordered actions
    expect(actions.map((a) => a.name)).toEqual([
      "Pylon",
      "Pylon",
      "Pylon",
      "Gateway",
      "Gateway",
      "CyberneticsCore",
    ]);
  });
});

describe("adaptBuild — 12-worker builds re-timed for 5.0.16", () => {
  function adapt(referenceId: string, race: "Protoss" | "Terran" | "Zerg") {
    const reference = referenceBuilds().find((b) => b.id === referenceId)!;
    const { actions } = actionsFromSteps(target, reference.steps);
    const vsRace = race === "Zerg" ? "Terran" : "Zerg";
    const threats = threatsForMatchup(threatCatalog(null), race, vsRace).map(
      (threat) => ({ threat, probability: threat.priorProbability }),
    );
    const request: AdaptRequest = {
      baselineProfileId: "lotv-base",
      profileId: "5.0.16",
      race,
      actions,
      referenceName: reference.name,
      referenceId: reference.id,
      threats,
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 480,
    };
    return adaptBuild(request);
  }

  it("keeps the same buildings in the same order on both patches", () => {
    const result = adapt("p-gate-expand", "Protoss");
    expect(result.sim.unexecutedActions).toBe(0);
    const orderOf = (sim: typeof result.sim) =>
      sim.steps
        .filter((s) => result.actions.some((a) => a.name === s.name))
        .map((s) => s.name);
    // every reference action reached both sims, in reference order
    expect(result.comparison.every((r) => r.adaptedStartSec !== undefined)).toBe(
      true,
    );
    expect(result.comparison.every((r) => r.baselineStartSec !== undefined)).toBe(
      true,
    );
    expect(orderOf(result.sim).length).toBeGreaterThan(0);
  });

  it("re-times steps LATER on the 8-worker economy, not earlier", () => {
    const result = adapt("p-gate-expand", "Protoss");
    // The 8-worker start mines slower, so the early build steps must
    // shift later than their 12-worker stamps. (Allow tiny jitter on
    // the very first step which is bank-limited on both patches.)
    const deltas = result.comparison
      .map((r) => r.deltaSec)
      .filter((d): d is number => d !== undefined);
    expect(deltas.length).toBeGreaterThan(5);
    const laterCount = deltas.filter((d) => d > 2).length;
    expect(laterCount).toBeGreaterThanOrEqual(Math.floor(deltas.length * 0.7));
    // first reference step (gateway) lands noticeably later on 5.0.16
    const gateway = result.comparison.find((r) => r.name === "Gateway")!;
    expect(gateway.deltaSec!).toBeGreaterThan(5);
  });

  it("adapts terran (morphs/addons) and zerg (larva) builds cleanly", () => {
    const terran = adapt("t-reaper-111", "Terran");
    expect(terran.sim.unexecutedActions).toBe(0);
    expect(terran.sim.unitsAtEnd.OrbitalCommand).toBe(1);
    expect((terran.sim.completionTimes.Medivac ?? []).length).toBe(1);
    const zerg = adapt("z-hatch-first", "Zerg");
    expect(zerg.sim.unexecutedActions).toBe(0);
    expect((zerg.sim.completionTimes.Lair ?? []).length).toBe(1);
    expect(zerg.sim.unitsAtEnd.Queen).toBeGreaterThanOrEqual(2);
  });

  it("evaluates safety of the adapted build against matchup threats", () => {
    const result = adapt("p-gate-expand", "Protoss");
    expect(result.safety.threats.length).toBeGreaterThan(0);
    for (const report of result.safety.threats) {
      expect(["safe", "risky", "unsafe"]).toContain(report.verdict);
      expect(report.waves.length).toBeGreaterThan(0);
    }
  });

  it("warns when warpgate research occupies the only gateway (PTR)", () => {
    // The proxy warpgate rush researches off its only gateway ON
    // PURPOSE — the note fires so the trade is explicit. Standard
    // builds were reordered to research after gate #2 and stay quiet.
    const reorderedStandard = adapt("p-robo-expand", "Protoss");
    expect(
      reorderedStandard.adaptationNotes.some((n) =>
        n.includes("occupies your only Gateway"),
      ),
    ).toBe(false);
    const rushRef = referenceBuilds().find(
      (b) => b.id === "p-proxy-warpgate-rush",
    )!;
    const rushActions = actionsFromSteps(target, rushRef.steps).actions;
    const rush = adaptBuild({
      baselineProfileId: "5.0.16",
      profileId: "5.0.16",
      race: "Protoss",
      actions: rushActions,
      referenceName: rushRef.name,
      referenceId: rushRef.id,
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: false, allowWorkerPull: true },
      horizonSec: 480,
    });
    expect(
      rush.adaptationNotes.some((n) =>
        n.includes("occupies your only Gateway"),
      ),
    ).toBe(true);
    const result = adapt("p-robo-expand", "Protoss");
    // and the per-gateway transform economics note rides along
    expect(
      result.adaptationNotes.some((n) => n.includes("50/50 per gateway")),
    ).toBe(true);
    // the sim reflects reality: a gateway unit may only start during
    // the research if ANOTHER gateway has finished by then (the
    // researching one is fully occupied)
    const research = result.sim.steps.find(
      (s) => s.name === "WarpGateResearch",
    )!;
    const gatewayDone = (result.sim.completionTimes.Gateway ?? []).slice();
    const gatewayUnits = result.sim.steps.filter(
      (s) =>
        s.kind === "train" &&
        ["Zealot", "Adept", "Stalker", "Sentry"].includes(s.name),
    );
    for (const unit of gatewayUnits) {
      const during =
        unit.startSec > research.startSec + 0.01 &&
        unit.startSec < research.doneSec - 0.01;
      if (during) {
        const gatewaysAvailable = gatewayDone.filter(
          (t) => t <= unit.startSec,
        ).length;
        expect(gatewaysAvailable).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("standard protoss builds research warpgate after the second gateway", () => {
    // PTR meta: research occupies a gateway, so units come first and
    // research waits for gate #2 — except dedicated rush builds.
    for (const id of ["p-gate-expand", "p-stargate-oracle", "p-robo-expand"]) {
      const build = referenceBuilds().find((b) => b.id === id)!;
      const gateIndices = build.steps
        .map((s, i) => (s === "Gateway" ? i : -1))
        .filter((i) => i >= 0);
      const wgIndex = build.steps.indexOf("WarpGateResearch");
      expect(wgIndex, id).toBeGreaterThan(gateIndices[1]);
    }
  });

  it("adapts the patch-native proxy warpgate rush with transforms and warp-ins", () => {
    const reference = referenceBuilds().find(
      (b) => b.id === "p-proxy-warpgate-rush",
    )!;
    expect(reference.native).toBe("5.0.16");
    const { actions, unknownNames } = actionsFromSteps(target, reference.steps);
    expect(unknownNames).toEqual([]);
    expect(
      actions.filter((a) => a.kind === "transform-warpgate"),
    ).toHaveLength(3);
    const threats = threatsForMatchup(threatCatalog(null), "Protoss", "Protoss")
      .map((threat) => ({ threat, probability: threat.priorProbability }));
    const result = adaptBuild({
      baselineProfileId: "5.0.16", // native — no 12-worker ancestor
      profileId: "5.0.16",
      race: "Protoss",
      actions,
      referenceName: reference.name,
      referenceId: reference.id,
      threats,
      policies: defaultPolicies(),
      safety: { hasWall: false, allowWorkerPull: true },
      horizonSec: 480,
    });
    expect(result.sim.unexecutedActions).toBe(0);
    // research starts once the cybernetics core is done (5.0.16 gates
    // warpgate research on the core even though it runs at a gateway)
    const research = result.sim.steps.find(
      (s) => s.name === "WarpGateResearch",
    )!;
    const cyberDone = result.sim.completionTimes.CyberneticsCore[0];
    expect(research.startSec).toBeGreaterThanOrEqual(cyberDone - 0.01);
    // all six units execute; the ones after the transforms are warped
    // (warpInSec, not the 28s gateway time). The lookahead may train
    // a couple from gateways while research runs — that's real play.
    const units = result.sim.steps.filter((s) =>
      ["Zealot", "Adept"].includes(s.name),
    );
    expect(units).toHaveLength(6);
    const transformDone = result.sim.events
      .filter((e) => e.kind === "complete" && e.name === "WarpGate")
      .map((e) => e.time);
    expect(transformDone).toHaveLength(3);
    const warped = units.filter(
      (u) => u.startSec >= Math.min(...transformDone) - 0.01,
    );
    expect(warped.length).toBeGreaterThanOrEqual(2);
    for (const unit of warped) {
      expect(unit.doneSec - unit.startSec).toBeLessThanOrEqual(
        target.mechanics.warpgate.warpInSec + 0.1,
      );
    }
  });

  it("gas-heavy rules builds get collectors injected and run to their milestones", () => {
    // The user's "PvZ — DT into 3 Stargate Void Ray" shape: pure
    // milestones, heavy gas, latest rule at 10:00. Without injected
    // assimilators this froze at the cybernetics core forever.
    const resolved = actionsFromCustomBuild(target, {
      rules: [
        { type: "before", name: "BuildDarkShrine", time_lt: 324 },
        { type: "count_min", name: "BuildStargate", time_lt: 600, count: 3 },
        { type: "count_min", name: "BuildVoidRay", time_lt: 660, count: 2 },
      ],
    });
    expect(resolved.fromRules).toBe(true);
    expect(resolved.latestMilestoneSec).toBe(660);
    const gasCount = resolved.actions.filter(
      (a) => a.name === "Assimilator",
    ).length;
    expect(gasCount).toBe(2); // > 400 total gas → both geysers
    const result = adaptBuild({
      baselineProfileId: "lotv-base",
      profileId: "5.0.16",
      race: "Protoss",
      actions: resolved.actions,
      referenceName: "DT into 3 Stargate Void Ray",
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 750,
    });
    expect(result.sim.unexecutedActions).toBe(0);
    expect((result.sim.completionTimes.Stargate ?? []).length).toBe(3);
    expect((result.sim.completionTimes.VoidRay ?? []).length).toBe(2);
    expect((result.sim.completionTimes.DarkShrine ?? []).length).toBe(1);
  });

  it("is deterministic", () => {
    const a = adapt("z-pool-first", "Zerg");
    const b = adapt("z-pool-first", "Zerg");
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
