import { describe, expect, test } from "vitest";
import { ALL_MODES } from "../modes";
import { allRegistered } from "../ArcadeEngine";
import { DEPTH_TAGS } from "../types";

/**
 * Depth lint — every shipped mode must declare a depthTag, and every
 * declared depthTag must be one of the known DEPTH_TAGS enum members.
 *
 * Two checks: (1) the static .depthTag on each module export, and
 * (2) the runtime registerMode() registry. They must agree.
 */
describe("depth-tag lint", () => {
  test("every mode declares a known depthTag", () => {
    for (const m of ALL_MODES) {
      expect(typeof m.depthTag, `${m.id}.depthTag must be set`).toBe("string");
      expect(
        DEPTH_TAGS.includes(m.depthTag),
        `${m.id}.depthTag "${m.depthTag}" not in DEPTH_TAGS`,
      ).toBe(true);
    }
  });
  test("registry matches per-mode static depthTag", () => {
    const reg = allRegistered();
    for (const m of ALL_MODES) {
      expect(reg[m.id], `${m.id} not registered`).toBeDefined();
      expect(reg[m.id]).toBe(m.depthTag);
    }
  });
  test("the catalog has exactly 16 modes (10 quizzes + 6 games)", () => {
    expect(ALL_MODES.length).toBe(16);
    expect(ALL_MODES.filter((m) => m.kind === "quiz").length).toBe(10);
    expect(ALL_MODES.filter((m) => m.kind === "game").length).toBe(6);
  });
  test("no two modes share an id", () => {
    const seen = new Set<string>();
    for (const m of ALL_MODES) {
      expect(seen.has(m.id), `duplicate id ${m.id}`).toBe(false);
      seen.add(m.id);
    }
  });
});
