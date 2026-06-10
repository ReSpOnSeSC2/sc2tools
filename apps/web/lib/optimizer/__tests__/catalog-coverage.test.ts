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
