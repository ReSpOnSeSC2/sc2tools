import { describe, expect, it } from "vitest";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import {
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
} from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
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

  function firstDefenseAt(buildId: string): number {
    const build = referenceBuilds().find((b) => b.id === buildId)!;
    const { actions } = actionsFromSteps(target, build.steps);
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
    for (const [name, times] of Object.entries(sim.completionTimes)) {
      const def = target.units[name];
      const fights =
        def?.combat &&
        !def.isWorker &&
        ((def.combat.dpsGround ?? 0) > 0 || (def.combat.dpsAir ?? 0) > 0);
      if (fights && times[0] < first) first = times[0];
    }
    return first;
  }

  it("every standard PvT protoss opener fields defense by 2:47", () => {
    const pvtBuilds = referenceBuilds().filter(
      (b) =>
        b.race === "Protoss" &&
        b.matchups.includes("PvT") &&
        !RUSH_EXEMPT.has(b.id),
    );
    expect(pvtBuilds.length).toBeGreaterThan(10);
    for (const build of pvtBuilds) {
      expect(
        firstDefenseAt(build.id),
        `${build.id} first defense too late`,
      ).toBeLessThanOrEqual(FIRST_DEFENSE_DEADLINE_SEC);
    }
  });

  it("the proxy reaper response has a zealot before the ~2:15 reaper", () => {
    expect(firstDefenseAt("p-proxy-reaper-response")).toBeLessThanOrEqual(135);
    // and it really is core-before-nexus
    const build = referenceBuilds().find(
      (b) => b.id === "p-proxy-reaper-response",
    )!;
    expect(build.steps.indexOf("CyberneticsCore")).toBeLessThan(
      build.steps.indexOf("Nexus"),
    );
    expect(build.steps.indexOf("Zealot")).toBeLessThan(
      build.steps.indexOf("Nexus"),
    );
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
