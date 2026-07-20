import { describe, expect, test } from "vitest";
import { isUnclassifiedBuild } from "@/lib/unclassifiedBuilds";

describe("isUnclassifiedBuild", () => {
  test("matches the bare race-level sentinel", () => {
    expect(isUnclassifiedBuild("Unclassified - Protoss")).toBe(true);
    expect(isUnclassifiedBuild("Unclassified - BW Protoss")).toBe(true);
    expect(isUnclassifiedBuild("Unclassified-Zerg")).toBe(true);
    expect(isUnclassifiedBuild("unclassified - terran")).toBe(true);
  });

  test("matches the macro-phase catch-alls", () => {
    expect(isUnclassifiedBuild("PvP - Macro Transition (Unclassified)")).toBe(true);
    expect(isUnclassifiedBuild("PvT - Macro Transition (Unclassified)")).toBe(true);
    expect(isUnclassifiedBuild("PvZ - Macro Transition (Unclassified)")).toBe(true);
    expect(isUnclassifiedBuild("Protoss - Standard Play (Unclassified)")).toBe(true);
    expect(isUnclassifiedBuild("Terran - Standard Play (Unclassified)")).toBe(true);
    expect(isUnclassifiedBuild("Zerg - Standard Play (Unclassified)  ")).toBe(true);
  });

  test("keeps real builds, empty strings, and near-misses", () => {
    expect(isUnclassifiedBuild("PvT - Robo First")).toBe(false);
    expect(isUnclassifiedBuild("8 Pool")).toBe(false);
    expect(isUnclassifiedBuild("")).toBe(false);
    expect(isUnclassifiedBuild("   ")).toBe(false);
    // "(Unclassified)" mid-name is not the detector's terminal marker.
    expect(isUnclassifiedBuild("My (Unclassified) Opener")).toBe(false);
  });
});
