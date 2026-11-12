import { describe, expect, it } from "vitest";
import { gradePracticeReplay, practiceGradeTarget } from "./practiceGrade";

const buildings = ["Pylon", "Gateway", "Assimilator", "CyberneticsCore", "Nexus", "Forge"];
const reference = { v: 1, source: "game", steps: buildings.map((name, i) => ({ action: `Build${name}`, t: i * 10, supply: null })) };
const replay = { myRace: "Protoss", buildLog: buildings.map((name, i) => `[0:${String(i * 10).padStart(2, "0")}] ${name}`), gameVersion: "5.0.17", gameBuild: null, date: "2026-11-11" };

describe("Practice Link replay grading", () => {
  it("accepts at least six recorded timed structures or upgrades by the chosen cutoff", () => {
    const extra = [{ action: "TrainZealot", t: 1, supply: null }, { action: "BuildGateway", t: null, supply: 16 }, { action: "BuildBarracks", t: 2, supply: null }];
    const target = practiceGradeTarget("Opening", { ...reference, steps: [...reference.steps, ...extra] }, "Protoss", 50);
    expect(target?.steps.map(step => step.name)).toEqual(buildings);
    expect(practiceGradeTarget("Opening", reference, "Protoss", 49)).toBeNull();
    expect(practiceGradeTarget("Opening", { ...reference, source: "paste" }, "Protoss", 60)).toBeNull();
  });

  it("grades the selected race and warns across patch eras", () => {
    const target = practiceGradeTarget("Opening", reference, "Protoss", 50)!;
    expect(gradePracticeReplay(target, "Protoss", "before", replay)).toMatchObject({ kind: "grade", result: { grade: "S" }, patchMismatch: true });
    expect(gradePracticeReplay(target, "Protoss", "after", replay)).toMatchObject({ kind: "grade", patchMismatch: false });
    expect(gradePracticeReplay(target, "Terran", "after", replay)).toEqual({ kind: "wrong_race" });
  });

  it("rejects fewer than half the steps without manufacturing a D", () => {
    const target = practiceGradeTarget("Opening", reference, "Protoss", 50)!;
    expect(gradePracticeReplay(target, "Protoss", "after", { ...replay, buildLog: replay.buildLog.slice(0, 2) })).toEqual({ kind: "wrong_build", patchMismatch: false });
    expect(gradePracticeReplay(target, "Protoss", "after", { ...replay, buildLog: replay.buildLog.slice(0, 3) })).toMatchObject({ kind: "grade", result: { grade: "C", matchedSteps: 3 } });
  });
});
