// @ts-nocheck
"use strict";

/**
 * Server half of the grading parity contract: the same cases run through
 * web/lib/ghostGrade.ts in apps/web/lib/__tests__/ghostGradeParity.test.ts.
 */
const fixture = require("../../web/lib/__tests__/fixtures/ghost-grade-parity.json");
const {
  NO_BUILD_LOG,
  decodeDrifts,
  ghostMatchupKey,
  gradeExecution,
  practiceRecord,
  targetHash,
} = require("../src/services/practiceGrade");

const step = (t, name, supply = null) => ({ supply, t, name });
const TARGET = { v: 1, name: "PvZ gate core", steps: [step(18, "Pylon", 14), step(40, "Gateway"), step(48, "Assimilator"), step(90, "CyberneticsCore")] };
const AT = new Date("2026-11-01T12:00:00Z");

describe("services/practiceGrade parity with lib/ghostGrade.ts", () => {
  test.each(fixture.cases.map((c) => [c.name, c]))("%s", (_name, c) => {
    expect(gradeExecution(c.target, c.buildLog)).toEqual(c.expected);
  });
});

describe("services/practiceGrade practiceRecord", () => {
  test("a graded game stores every step's drift and its five worst steps", () => {
    const record = practiceRecord({
      target: TARGET, hash: targetHash(TARGET), matchup: "PvZ", via: "ingest", gradedAt: AT,
      buildLog: ["[0:18] Pylon", "[0:50] Gateway", "[1:40] Cybernetics Core"],
    });
    expect(record).toEqual({
      v: 1,
      targetHash: targetHash(TARGET),
      targetName: "PvZ gate core",
      matchup: "PvZ",
      via: "ingest",
      gradedAt: AT,
      // Three of four steps (0.75) with a 6.7 s average drift.
      grade: "B",
      matched: 3,
      total: 4,
      avgDrift: 6.7,
      maxDrift: 10,
      firstDivergence: { i: 2, name: "Assimilator", expectedT: 48, actualT: null },
      // The cut step first, then by size of the drift; on-time steps never.
      worstSteps: [{ i: 2, name: "Assimilator", d: null }, { i: 1, name: "Gateway", d: 10 }, { i: 3, name: "CyberneticsCore", d: 10 }],
      drifts: "0,10,x,10",
    });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(512);
  });

  test("a game in the matchup without a build log is recorded as ungraded", () => {
    for (const buildLog of [undefined, [], ["garbage"]]) {
      expect(practiceRecord({ target: TARGET, hash: "h", matchup: "PvZ", via: "ingest", gradedAt: AT, buildLog })).toEqual({
        v: 1, targetHash: "h", targetName: "PvZ gate core", matchup: "PvZ", via: "ingest", gradedAt: AT, status: NO_BUILD_LOG,
      });
    }
  });

  test("stored drifts are clamped to three digits and decode back", () => {
    const long = { v: 1, name: "long", steps: [step(0, "Pylon"), step(10, "Gateway")] };
    const record = practiceRecord({ target: long, hash: "h", matchup: "PvT", via: "ingest", gradedAt: AT, buildLog: ["[30:00] Pylon"] });
    expect(record.drifts).toBe("999,x");
    expect(decodeDrifts(record.drifts)).toEqual([999, null]);
    expect(decodeDrifts(undefined)).toEqual([]);
  });
});

describe("services/practiceGrade identities", () => {
  test("the target hash follows the content, not the object", () => {
    const same = JSON.parse(JSON.stringify(TARGET));
    expect(targetHash(same)).toBe(targetHash(TARGET));
    expect(targetHash(same)).toMatch(/^[0-9a-f]{16}$/);
    expect(targetHash({ ...TARGET, name: "Renamed" })).not.toBe(targetHash(TARGET));
    expect(targetHash({ ...TARGET, steps: [...TARGET.steps.slice(0, 3), step(91, "CyberneticsCore")] })).not.toBe(targetHash(TARGET));
  });

  test("a matchup needs two concrete races, own race first", () => {
    expect(ghostMatchupKey("Protoss", "z")).toBe("PvZ");
    expect(ghostMatchupKey("T", "Terran")).toBe("TvT");
    expect(ghostMatchupKey("Random", "Zerg")).toBeNull();
    expect(ghostMatchupKey("Zerg", undefined)).toBeNull();
  });
});
