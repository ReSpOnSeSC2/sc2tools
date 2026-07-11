import { describe, expect, it } from "vitest";
import { GHOST_BUILD_VERSION, type GhostTarget } from "@/lib/ghostBuild";
import { gradeExecution } from "@/lib/ghostGrade";

function target(
  steps: Array<{ t: number; name: string; supply?: number | null }>,
  name = "Test build",
): GhostTarget {
  return {
    v: GHOST_BUILD_VERSION,
    name,
    steps: steps.map((s) => ({ supply: s.supply ?? null, t: s.t, name: s.name })),
  };
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function logLine(t: number, name: string): string {
  return `[${clock(t)}] ${name}`;
}

const OPENER = target([
  { t: 17, name: "Pylon", supply: 14 },
  { t: 40, name: "Gateway", supply: 16 },
  { t: 65, name: "Assimilator", supply: 17 },
  { t: 95, name: "CyberneticsCore", supply: 20 },
  { t: 130, name: "Stargate", supply: 22 },
]);

describe("gradeExecution — grades", () => {
  it("grades a perfect run S", () => {
    const log = OPENER.steps.map((s) => logLine(s.t, s.name));
    const result = gradeExecution(OPENER, log);
    expect(result.grade).toBe("S");
    expect(result.matchedSteps).toBe(5);
    expect(result.targetSteps).toBe(5);
    expect(result.avgDriftSec).toBe(0);
    expect(result.maxDriftSec).toBe(0);
    expect(result.firstDivergence).toBeNull();
    expect(result.perStep).toHaveLength(5);
    expect(result.perStep.every((s) => s.matched && s.driftSec === 0)).toBe(true);
  });

  it("still grades S with tiny drift and interleaved extra events", () => {
    const log = [
      logLine(12, "Probe"),
      logLine(20, "Pylon"), // +3
      logLine(30, "Probe"),
      logLine(42, "Gateway"), // +2
      logLine(63, "Assimilator"), // -2
      logLine(99, "CyberneticsCore"), // +4
      logLine(132, "Stargate"), // +2
      logLine(140, "Zealot"), // extra army — ignored
    ];
    const result = gradeExecution(OPENER, log);
    expect(result.grade).toBe("S");
    expect(result.matchedSteps).toBe(5);
  });

  it("grades a late-everything run by its drift (B at ~20s late)", () => {
    const log = OPENER.steps.map((s) => logLine(s.t + 20, s.name));
    const result = gradeExecution(OPENER, log);
    // All matched (matchRate 1) but avg |drift| = 20 → B band.
    expect(result.matchedSteps).toBe(5);
    expect(result.avgDriftSec).toBe(20);
    expect(result.maxDriftSec).toBe(20);
    expect(result.grade).toBe("B");
    // Every step is late by exactly +20 (signed drift preserved).
    expect(result.perStep.every((s) => s.driftSec === 20)).toBe(true);
    // 20s ≤ DIVERGENCE_DRIFT_SEC → late but not "diverged".
    expect(result.firstDivergence).toBeNull();
  });

  it("a cut step is the first divergence and drops coverage to B", () => {
    // Execute everything on time except the Assimilator (index 2).
    const log = OPENER.steps
      .filter((s) => s.name !== "Assimilator")
      .map((s) => logLine(s.t, s.name));
    // 4/5 = 0.8 matchRate — under the 0.9 A-bar, inside the 0.75 B-bar.
    const result = gradeExecution(OPENER, log);
    expect(result.matchedSteps).toBe(4);
    expect(result.firstDivergence).toEqual({
      index: 2,
      name: "Assimilator",
      expectedT: 65,
      actualT: null,
    });
    expect(result.grade).toBe("B");
    expect(result.perStep[2].matched).toBe(false);
    expect(result.perStep[2].driftSec).toBeNull();
  });

  it("one cut step in a long build still grades A (not S)", () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      t: 20 + i * 15,
      name: `Step${i}`,
    }));
    const t = target(steps);
    const log = steps
      .filter((_, i) => i !== 10)
      .map((s) => logLine(s.t, s.name));
    const result = gradeExecution(t, log);
    expect(result.matchedSteps).toBe(19);
    // 19/20 = 0.95 with zero drift — S requires EVERY step matched.
    expect(result.grade).toBe("A");
    expect(result.firstDivergence?.index).toBe(10);
  });

  it("a badly mistimed (but matched) step is a divergence", () => {
    const log = [
      logLine(17, "Pylon"),
      logLine(40, "Gateway"),
      logLine(65, "Assimilator"),
      logLine(140, "CyberneticsCore"), // +45 — past DIVERGENCE_DRIFT_SEC
      logLine(175, "Stargate"), // +45
    ];
    const result = gradeExecution(OPENER, log);
    expect(result.firstDivergence).toEqual({
      index: 3,
      name: "CyberneticsCore",
      expectedT: 95,
      actualT: 140,
    });
    // avg |drift| = (0+0+0+45+45)/5 = 18 ≤ 20 with full coverage → B.
    expect(result.grade).toBe("B");
  });

  it("grades a garbage log D with divergence at the first step", () => {
    const result = gradeExecution(OPENER, [
      "complete nonsense",
      "[9:99 not-a-line",
      logLine(30, "Hatchery"), // wrong build entirely
    ]);
    expect(result.matchedSteps).toBe(0);
    expect(result.grade).toBe("D");
    expect(result.avgDriftSec).toBe(0);
    expect(result.firstDivergence?.index).toBe(0);
    expect(result.firstDivergence?.actualT).toBeNull();
  });

  it("grades an empty executed log D", () => {
    const result = gradeExecution(OPENER, []);
    expect(result.grade).toBe("D");
    expect(result.matchedSteps).toBe(0);
    expect(result.perStep.every((s) => !s.matched)).toBe(true);
  });

  it("an empty target grades S vacuously", () => {
    const empty: GhostTarget = { v: GHOST_BUILD_VERSION, name: "Empty", steps: [] };
    const result = gradeExecution(empty, [logLine(10, "Pylon")]);
    expect(result).toEqual({
      grade: "S",
      targetSteps: 0,
      matchedSteps: 0,
      avgDriftSec: 0,
      maxDriftSec: 0,
      firstDivergence: null,
      perStep: [],
    });
  });
});

describe("gradeExecution — alignment mechanics", () => {
  it("matches names through light normalization (spaces, case, underscores)", () => {
    const t = target([
      { t: 17, name: "SpawningPool" },
      { t: 60, name: "RoachWarren" },
    ]);
    const result = gradeExecution(t, [
      logLine(17, "Spawning Pool"),
      logLine(60, "roach_warren"),
    ]);
    expect(result.matchedSteps).toBe(2);
    expect(result.grade).toBe("S");
  });

  it("greedy in-order: out-of-order execution costs the swapped step", () => {
    const t = target([
      { t: 10, name: "A" },
      { t: 20, name: "B" },
      { t: 30, name: "C" },
    ]);
    // Executed B before A: A matches (cursor moves past B's event), B
    // can no longer look backwards → miss; C still matches.
    const result = gradeExecution(t, [
      logLine(10, "B"),
      logLine(20, "A"),
      logLine(30, "C"),
    ]);
    expect(result.perStep.map((s) => s.matched)).toEqual([true, false, true]);
    expect(result.firstDivergence?.name).toBe("B");
  });

  it("each executed event satisfies at most one target step", () => {
    const t = target([
      { t: 40, name: "Gateway" },
      { t: 80, name: "Gateway" },
    ]);
    // Only one gateway was ever built.
    const result = gradeExecution(t, [logLine(41, "Gateway")]);
    expect(result.matchedSteps).toBe(1);
    expect(result.perStep[0].matched).toBe(true);
    expect(result.perStep[1].matched).toBe(false);
  });

  it("duplicate target steps match successive executed events in order", () => {
    const t = target([
      { t: 40, name: "Gateway" },
      { t: 80, name: "Gateway" },
    ]);
    const result = gradeExecution(t, [
      logLine(45, "Gateway"),
      logLine(78, "Gateway"),
    ]);
    expect(result.perStep.map((s) => s.driftSec)).toEqual([5, -2]);
    expect(result.grade).toBe("S");
  });

  it("is deterministic — same inputs, same output object", () => {
    const log = OPENER.steps.map((s) => logLine(s.t + 7, s.name));
    expect(gradeExecution(OPENER, log)).toEqual(gradeExecution(OPENER, log));
  });

  it("rounds avgDriftSec to one decimal", () => {
    const t = target([
      { t: 10, name: "A" },
      { t: 20, name: "B" },
      { t: 30, name: "C" },
    ]);
    const result = gradeExecution(t, [
      logLine(11, "A"), // +1
      logLine(21, "B"), // +1
      logLine(32, "C"), // +2
    ]);
    expect(result.avgDriftSec).toBe(1.3);
  });
});
