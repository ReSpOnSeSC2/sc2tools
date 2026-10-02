import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { GHOST_BUILD_VERSION, ghostMatchupKey, normalizeGhostName } from "@/lib/ghostBuild";
import { gradeExecution } from "@/lib/ghostGrade";
import {
  buildGhostTargetFromGuide,
  ghostRacesForMatchup,
  ghostStepName,
  GUIDE_GHOST_MIN_STEPS,
} from "@/lib/guides/ghost";
import {
  FIXTURE_BUILD_PUBLISHED,
  FIXTURE_BUILD_UNPUBLISHED,
  FIXTURE_PVZ_MILESTONES,
} from "@/lib/guides/__fixtures__";
import type { GuideBuildPublished, GuideMilestone } from "@/lib/guides/types";

function withMilestones(milestones: GuideMilestone[]): GuideBuildPublished {
  return {
    ...FIXTURE_BUILD_PUBLISHED,
    timings: { samples: 356, users: 58, milestones },
  };
}

function zergMilestone(key: string, median: number): GuideMilestone {
  return {
    key,
    label: key,
    event: "start",
    games: 300,
    users: 50,
    presence: 0.9,
    p25: median - 4,
    median,
    p75: median + 6,
  };
}

/** The API's milestone catalog (CommonJS, dependency-free). */
interface ApiMilestone {
  key: string;
  label: string;
  names: ReadonlyArray<string>;
  event: string;
}

function loadApiMilestones(): ApiMilestone[] {
  const load = createRequire(import.meta.url);
  const mod = load(resolve(process.cwd(), "../api/src/config/guideMilestones.js")) as {
    GUIDE_MILESTONES: Record<string, ReadonlyArray<ApiMilestone>>;
  };
  return Object.values(mod.GUIDE_MILESTONES).flat();
}

describe("ghostStepName", () => {
  test("every API milestone key maps to its canonical wire name (names[0])", () => {
    const milestones = loadApiMilestones();
    expect(milestones.length).toBeGreaterThan(0);
    for (const milestone of milestones) {
      expect(normalizeGhostName(ghostStepName(milestone.key)), milestone.key).toBe(
        normalizeGhostName(milestone.names[0]),
      );
    }
  });

  test("fixture milestones mirror the API catalog", () => {
    const byKey = new Map(loadApiMilestones().map((m) => [m.key, m]));
    for (const milestone of FIXTURE_PVZ_MILESTONES) {
      const api = byKey.get(milestone.key);
      expect(api, milestone.key).toBeDefined();
      expect(milestone.label).toBe(api?.label);
      expect(milestone.event).toBe(api?.event);
    }
  });

  test("strips occurrence suffixes only", () => {
    expect(ghostStepName("Nexus#2")).toBe("Nexus");
    expect(ghostStepName("Hatchery#3")).toBe("Hatchery");
    expect(ghostStepName("BlinkTech")).toBe("BlinkTech");
    expect(ghostStepName("AdeptPiercingAttack")).toBe("AdeptPiercingAttack");
  });

  test("the Lurker Den key maps to the name build logs carry", () => {
    expect(ghostStepName("LurkerDenMP")).toBe("LurkerDen");
  });
});

describe("buildGhostTargetFromGuide", () => {
  test("wire-name steps ordered by recorded median", () => {
    const target = buildGhostTargetFromGuide(FIXTURE_BUILD_PUBLISHED);
    expect(target).not.toBeNull();
    expect(target!.v).toBe(GHOST_BUILD_VERSION);
    expect(target!.name).toBe("Stargate into Glaives (PvZ guide)");
    expect(target!.steps).toEqual([
      { supply: null, t: 18, name: "Pylon" },
      { supply: null, t: 40, name: "Gateway" },
      { supply: null, t: 51, name: "Assimilator" },
      { supply: null, t: 84, name: "Nexus" },
      { supply: null, t: 97, name: "CyberneticsCore" },
      { supply: null, t: 172, name: "Stargate" },
      { supply: null, t: 246, name: "WarpGateResearch" },
      { supply: null, t: 281, name: "Nexus" },
      { supply: null, t: 290, name: "TwilightCouncil" },
      { supply: null, t: 441, name: "AdeptPiercingAttack" },
    ]);
  });

  test("grades a real-shaped build log against the target", () => {
    const target = buildGhostTargetFromGuide(FIXTURE_BUILD_PUBLISHED)!;
    const log = [
      "[0:00] Nexus",
      "[0:00] Probe",
      "[0:18] Pylon",
      "[0:40] Gateway",
      "[0:51] Assimilator",
      "[1:24] Nexus",
      "[1:37] CyberneticsCore",
      "[2:52] Stargate",
      "[4:06] WarpGateResearch",
      "[4:41] Nexus",
      "[4:50] TwilightCouncil",
      "[7:21] AdeptPiercingAttack",
    ];
    const grade = gradeExecution(target, log);
    expect(grade.matchedSteps).toBe(target.steps.length);
    expect(grade.grade).toBe("S");
  });

  test("hatch-first: a 0:00 starting-Hatchery step keeps the grader aligned", () => {
    const payload = withMilestones([
      zergMilestone("SpawningPool", 62),
      zergMilestone("Hatchery#2", 49),
      zergMilestone("Extractor", 58),
      zergMilestone("Hatchery#3", 150),
    ]);
    const target = buildGhostTargetFromGuide(payload)!;
    expect(target.steps.map((step) => [step.name, step.t])).toEqual([
      ["Hatchery", 0],
      ["Hatchery", 49],
      ["Extractor", 58],
      ["SpawningPool", 62],
      ["Hatchery", 150],
    ]);
    const grade = gradeExecution(target, [
      "[0:00] Hatchery",
      "[0:00] Drone",
      "[0:49] Hatchery",
      "[0:58] Extractor",
      "[1:02] SpawningPool",
      "[2:30] Hatchery",
    ]);
    expect(grade.maxDriftSec).toBe(0);
    expect(grade.grade).toBe("S");
  });

  test("a Lurker Den step is graded against the LurkerDen build-log line", () => {
    const payload = withMilestones([
      zergMilestone("SpawningPool", 62),
      zergMilestone("HydraliskDen", 357),
      zergMilestone("LurkerDenMP", 430),
    ]);
    const target = buildGhostTargetFromGuide(payload)!;
    expect(target.steps.map((step) => step.name)).toEqual([
      "SpawningPool",
      "HydraliskDen",
      "LurkerDen",
    ]);
    const grade = gradeExecution(target, [
      "[0:00] Hatchery",
      "[1:02] SpawningPool",
      "[5:57] HydraliskDen",
      "[7:10] LurkerDen",
    ]);
    expect(grade.matchedSteps).toBe(target.steps.length);
    expect(grade.maxDriftSec).toBe(0);
  });

  test("no anchor when the earliest step is not a later town hall", () => {
    const payload = withMilestones([
      zergMilestone("SpawningPool", 30),
      zergMilestone("Hatchery#2", 49),
      zergMilestone("Extractor", 58),
    ]);
    const target = buildGhostTargetFromGuide(payload)!;
    expect(target.steps[0]).toEqual({ supply: null, t: 30, name: "SpawningPool" });
    expect(target.steps).toHaveLength(3);
  });

  test("ties keep payload order", () => {
    const payload = withMilestones([
      zergMilestone("Extractor", 58),
      zergMilestone("SpawningPool", 58),
      zergMilestone("Hatchery#2", 90),
    ]);
    expect(buildGhostTargetFromGuide(payload)!.steps.map((step) => step.name)).toEqual([
      "Extractor",
      "SpawningPool",
      "Hatchery",
    ]);
  });

  test("null below the step floor, without timings or unpublished", () => {
    const few = FIXTURE_PVZ_MILESTONES.slice(0, GUIDE_GHOST_MIN_STEPS - 1);
    expect(buildGhostTargetFromGuide(withMilestones(few))).toBeNull();
    const withBadMedian = [
      ...few,
      { ...FIXTURE_PVZ_MILESTONES[5], median: Number.NaN },
    ];
    expect(buildGhostTargetFromGuide(withMilestones(withBadMedian))).toBeNull();
    expect(buildGhostTargetFromGuide({ ...FIXTURE_BUILD_PUBLISHED, timings: null })).toBeNull();
    expect(buildGhostTargetFromGuide(FIXTURE_BUILD_UNPUBLISHED)).toBeNull();
    expect(buildGhostTargetFromGuide(null)).toBeNull();
  });
});

describe("ghostRacesForMatchup", () => {
  test("concrete race letters that armGhostTargetForMatchup accepts", () => {
    expect(ghostRacesForMatchup("PvZ")).toEqual({ myRace: "P", opponentRace: "Z" });
    expect(ghostRacesForMatchup("TvT")).toEqual({ myRace: "T", opponentRace: "T" });
    const { myRace, opponentRace } = ghostRacesForMatchup("ZvP");
    expect(ghostMatchupKey(myRace, opponentRace)).toBe("ZvP");
  });
});
