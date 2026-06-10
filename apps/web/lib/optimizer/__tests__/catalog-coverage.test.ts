import { describe, expect, it } from "vitest";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import {
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
  stepsForMatchup,
} from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type { SimRace } from "../types";

/**
 * The /definitions catalog and the adaptable reference openers must
 * stay in sync: every detection rule that describes an OPENER has a
 * reference build covering it (directly or via definitionIds), so the
 * "standard openers" list always offers an adapted version of every
 * build the analyzer can detect. Pure compositions, fallback labels,
 * and the too-short markers are not openers and are excluded below.
 */
const NON_OPENER_DEFINITIONS = new Set([
  // mid/late-game compositions and transitions — no opening to adapt
  "protoss-chargelot-archon-comp",
  "protoss-robo-comp",
  "protoss-skytoss-transition",
  "terran-bio-comp",
  "terran-mech-comp",
  "terran-skyterran",
  "zerg-muta-ling-bane-comp",
  // fallback / unclassified labels
  "protoss-standard-play-unclassified",
  "terran-standard-play-unclassified",
  "zerg-standard-play-unclassified",
  "pvp-macro-transition-unclassified",
  "pvt-macro-transition-unclassified",
  "pvz-macro-transition-unclassified",
  // game-length markers
  "pvp-game-too-short",
  "pvt-game-too-short",
  "pvz-game-too-short",
  "tvp-game-too-short",
  "tvt-game-too-short",
  "tvz-game-too-short",
  "zvp-game-too-short",
  "zvt-game-too-short",
  "zvz-game-too-short",
]);

const target = resolveProfile("5.0.16");

describe("definitions catalog coverage", () => {
  const builds = referenceBuilds();
  const coveredIds = new Set(builds.flatMap((b) => b.definitionIds ?? []));
  const catalogIds = new Set(BUILD_DEFINITIONS.map((d) => d.id));

  it("every opener definition has an adaptable reference build", () => {
    const uncovered = BUILD_DEFINITIONS.filter(
      (d) => !NON_OPENER_DEFINITIONS.has(d.id) && !coveredIds.has(d.id),
    ).map((d) => d.id);
    expect(uncovered).toEqual([]);
  });

  it("every referenced definition id exists in the catalog", () => {
    const unknown = [...coveredIds].filter((id) => !catalogIds.has(id));
    expect(unknown).toEqual([]);
  });

  it("non-opener exclusions stay in the catalog (denylist hygiene)", () => {
    for (const id of NON_OPENER_DEFINITIONS) {
      expect(catalogIds.has(id), `${id} no longer exists`).toBe(true);
    }
  });
});

describe("protoss gas timing convention", () => {
  it("second assimilator waits for the cybernetics core outside PvP", () => {
    // PTR meta guidance: standard protoss is gas -> core -> second
    // gas; double gas before core is a PvP-specific pattern.
    for (const build of referenceBuilds()) {
      if (build.race !== "Protoss") continue;
      if (build.matchups.length === 1 && build.matchups[0] === "PvP") continue;
      const gasIndices = build.steps
        .map((s, i) => (s === "Assimilator" ? i : -1))
        .filter((i) => i >= 0);
      if (gasIndices.length < 2) continue;
      const coreIndex = build.steps.indexOf("CyberneticsCore");
      if (coreIndex < 0) continue;
      expect(
        gasIndices[1],
        `${build.id}: second assimilator before the core`,
      ).toBeGreaterThan(coreIndex);
    }
  });
});

describe("PvT first-defense rule (user's PTR guidance)", () => {
  // "For PvT we need a unit out as close to 2:42 as possible — 2:47
  // is fine." Proxied rushes are exempt (their units pop at the proxy
  // on their own schedule); the cannon rush counts its first cannon.
  const FIRST_DEFENSE_DEADLINE_SEC = 167; // 2:47
  const RUSH_EXEMPT = new Set(["p-proxy-4gate"]);

  function firstDefenseAt(buildId: string): { at: number; name: string } {
    const build = referenceBuilds().find((b) => b.id === buildId)!;
    const { actions } = actionsFromSteps(
      target,
      stepsForMatchup(build, "PvT"),
    );
    const sim = adaptBuild({
      baselineProfileId: build.native ?? "lotv-base",
      profileId: "5.0.16",
      race: "Protoss",
      actions,
      referenceName: build.name,
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec: 600,
    }).sim;
    let first = Infinity;
    let firstName = "";
    for (const [name, times] of Object.entries(sim.completionTimes)) {
      const def = target.units[name];
      const fights =
        def?.combat &&
        !def.isWorker &&
        ((def.combat.dpsGround ?? 0) > 0 || (def.combat.dpsAir ?? 0) > 0);
      if (fights && times[0] < first) {
        first = times[0];
        firstName = name;
      }
    }
    return { at: first, name: firstName };
  }

  it("every standard PvT protoss opener fields defense by 2:47", () => {
    const pvtBuilds = referenceBuilds().filter(
      (b) =>
        b.race === "Protoss" &&
        b.matchups.includes("PvT") &&
        !RUSH_EXEMPT.has(b.id),
    );
    expect(pvtBuilds.length).toBeGreaterThan(10);
    // Standard play never opens zealot; the scouted proxy-reaper
    // response is the lone exception (zealot beats the 2:15 reaper).
    for (const build of pvtBuilds) {
      const first = firstDefenseAt(build.id);
      expect(
        first.at,
        `${build.id} first defense too late`,
      ).toBeLessThanOrEqual(FIRST_DEFENSE_DEADLINE_SEC);
      if (build.id !== "p-proxy-reaper-response") {
        expect(
          first.name,
          `${build.id} opens with a zealot`,
        ).not.toBe("Zealot");
      }
    }
  });

  it("the proxy reaper response zealot beats the ~2:15 reaper", () => {
    const first = firstDefenseAt("p-proxy-reaper-response");
    expect(first.name).toBe("Zealot");
    expect(first.at).toBeLessThanOrEqual(135);
    // core first, then zealot, nexus delayed — and the second gas is
    // pushed back to pay for the zealot (after the nexus in the list)
    const build = referenceBuilds().find(
      (b) => b.id === "p-proxy-reaper-response",
    )!;
    const steps = build.steps;
    expect(steps.indexOf("CyberneticsCore")).toBeLessThan(
      steps.indexOf("Zealot"),
    );
    expect(steps.indexOf("Zealot")).toBeLessThan(steps.indexOf("Nexus"));
    const secondGas = steps.indexOf(
      "Assimilator",
      steps.indexOf("Assimilator") + 1,
    );
    expect(secondGas).toBeGreaterThan(steps.indexOf("Nexus"));
  });

  it("PvT variants go core before nexus; base steps stay nexus-first", () => {
    const gateExpand = referenceBuilds().find(
      (b) => b.id === "p-gate-expand",
    )!;
    const pvt = stepsForMatchup(gateExpand, "PvT");
    expect(pvt.indexOf("CyberneticsCore")).toBeLessThan(pvt.indexOf("Nexus"));
    const pvz = stepsForMatchup(gateExpand, "PvZ");
    expect(pvz.indexOf("Nexus")).toBeLessThan(pvz.indexOf("CyberneticsCore"));
  });
});

describe("5.0.16 warpgate meta (user's PTR guidance)", () => {
  // "You cannot start warpgate until you get your second gateway up"
  // — the research occupies a gateway, so every gateway listed before
  // it must be standing when it starts. The PvP proxy warpgate rush
  // researches off its lone first gateway on purpose and is covered
  // by the same rule (one listed gateway → no extra wait).

  function simSteps(steps: string[]) {
    const { actions } = actionsFromSteps(target, steps);
    return simulate(actions, target, "Protoss", {
      horizonSec: 600,
      policies: defaultPolicies(),
    });
  }

  it("research never starts before the gateways listed ahead of it", () => {
    const seen = new Set<string>();
    for (const build of referenceBuilds()) {
      if (build.race !== "Protoss") continue;
      for (const matchup of build.matchups) {
        const steps = stepsForMatchup(build, matchup);
        const key = steps.join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const wgrIndex = steps.indexOf("WarpGateResearch");
        if (wgrIndex < 0) continue;
        const prior = steps
          .slice(0, wgrIndex)
          .filter((s) => s === "Gateway").length;
        const sim = simSteps(steps);
        const research = sim.steps.find(
          (s) => s.name === "WarpGateResearch",
        )!;
        const gateDone = sim.steps
          .filter((s) => s.name === "Gateway")
          .map((s) => s.doneSec)
          .sort((a, b) => a - b);
        expect(
          research.startSec,
          `${build.id} (${matchup}): warpgate before gateway #${prior} finished`,
        ).toBeGreaterThanOrEqual(gateDone[prior - 1] - 0.01);
      }
    }
  });

  it("the proxy warpgate rush still researches off one gateway", () => {
    const rush = referenceBuilds().find(
      (b) => b.id === "p-proxy-warpgate-rush",
    )!;
    const sim = simSteps(rush.steps);
    const research = sim.steps.find((s) => s.name === "WarpGateResearch")!;
    const gateDone = sim.steps
      .filter((s) => s.name === "Gateway")
      .map((s) => s.doneSec)
      .sort((a, b) => a - b);
    expect(research.startSec).toBeLessThan(gateDone[1]);
  });

  it("the 12-worker baseline keeps researching at the core, ungated", () => {
    // Old patch: warpgate lives at the cybernetics core and occupies
    // no gateway, so the meta gate must not delay the baseline sim.
    const build = referenceBuilds().find((b) => b.id === "p-gate-expand")!;
    const baseline = resolveProfile(build.native ?? "lotv-base");
    const { actions } = actionsFromSteps(target, build.steps);
    const sim = simulate(actions, baseline, "Protoss", {
      horizonSec: 600,
      policies: defaultPolicies(),
    });
    const research = sim.steps.find((s) => s.name === "WarpGateResearch")!;
    const gateDone = sim.steps
      .filter((s) => s.name === "Gateway")
      .map((s) => s.doneSec)
      .sort((a, b) => a - b);
    expect(research.startSec).toBeLessThan(gateDone[1]);
  });
});

describe("stargate openers favor adepts (user's PTR guidance)", () => {
  // "You keep building adepts for most stargate builds — they're
  // lower gas and the phoenixes are your anti-air." The gas stays in
  // the stargate; gateway minerals buy 25-gas adepts. Exceptions:
  // Stargate into Blink (blink stalkers ARE the plan) and the PvP
  // 4 Stalker Oracle.
  const STALKER_EXCEPTIONS = new Set([
    "p-stargate-blink",
    "p-4stalker-oracle",
  ]);

  it("gateway production behind a stargate is adept-heavy", () => {
    let checked = 0;
    for (const build of referenceBuilds()) {
      if (build.race !== "Protoss") continue;
      if (STALKER_EXCEPTIONS.has(build.id)) continue;
      const lists = [
        build.steps,
        ...Object.values(build.stepsByMatchup ?? {}),
      ];
      for (const steps of lists) {
        if (!steps.includes("Stargate")) continue;
        checked += 1;
        const adepts = steps.filter((s) => s === "Adept").length;
        const stalkers = steps.filter((s) => s === "Stalker").length;
        expect(
          adepts,
          `${build.id}: stalkers should not crowd out adepts`,
        ).toBeGreaterThan(stalkers);
      }
    }
    expect(checked).toBeGreaterThan(8);
  });
});

describe("PvT shield battery coverage (user's PTR guidance)", () => {
  // "Not every standard build, but 80-90% get a safety battery."
  // All-ins, proxies and rushes spend every mineral on the punch.
  const NO_BATTERY_ARCHETYPES = new Set([
    "p-4gate",
    "p-proxy-4gate",
    "p-blink-allin",
    "p-7gate-blink",
    "p-cannon-rush",
    "p-chargelot-allin",
    "p-dt-rush",
    "p-proxy-stargate",
  ]);

  it("80-90% of standard PvT openers include a shield battery", () => {
    const standard = referenceBuilds().filter(
      (b) =>
        b.race === "Protoss" &&
        b.matchups.includes("PvT") &&
        !NO_BATTERY_ARCHETYPES.has(b.id),
    );
    expect(standard.length).toBeGreaterThan(10);
    const withBattery = standard.filter((b) =>
      stepsForMatchup(b, "PvT").includes("ShieldBattery"),
    );
    const fraction = withBattery.length / standard.length;
    expect(fraction).toBeGreaterThanOrEqual(0.8);
    // "not every" — a couple of openers legitimately skip it
    expect(withBattery.length).toBeLessThan(standard.length);
  });
});

describe("every reference build adapts cleanly to 5.0.16", () => {
  for (const build of referenceBuilds()) {
    it(`${build.id} resolves and simulates with no dead steps`, () => {
      const { actions, unknownNames } = actionsFromSteps(target, build.steps);
      expect(unknownNames).toEqual([]);
      expect(actions.length).toBeGreaterThan(5);
      const result = adaptBuild({
        baselineProfileId: build.native ?? "lotv-base",
        profileId: "5.0.16",
        race: build.race as SimRace,
        actions,
        referenceName: build.name,
        referenceId: build.id,
        threats: [],
        policies: defaultPolicies(),
        safety: { hasWall: true, allowWorkerPull: true },
        horizonSec: 600,
      });
      expect(result.sim.unexecutedActions, build.id).toBe(0);
      expect(result.baselineSim.unexecutedActions, `${build.id} baseline`).toBe(
        0,
      );
    });
  }
});
