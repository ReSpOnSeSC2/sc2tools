import { describe, expect, it } from "vitest";
import fixture from "./fixtures/ghost-grade-parity.json";
import { gradeExecution } from "@/lib/ghostGrade";
import type { GhostTarget } from "@/lib/ghostBuild";

/**
 * Browser half of the grading parity contract. The API grades every
 * ingested game in the practised matchup with services/practiceGrade.js,
 * and its suite (apps/api/__tests__/practiceGrade.test.js) runs these same
 * cases, so the stored grade and the one this browser computes cannot drift.
 */
describe("gradeExecution matches the shared server fixture", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result = gradeExecution(c.target as GhostTarget, c.buildLog as unknown as string[]);
    expect(result).toEqual(c.expected);
  });
});
