import { describe, expect, it } from "vitest";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import { buildMotionVisualField, MOTION_REVEAL_MAX_CONTENDERS } from "./visualField";

function pool(size: number): RandomizerBuild[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `build-${index}`, name: `Build ${index}`, race: "Protoss", source: "catalog", weight: index + 1,
  }));
}

describe("motion reveal visual bracket", () => {
  it("caps a large pool without changing the full pool or its weighted winner", () => {
    const full = pool(500);
    const original = [...full];
    const winner = full[497];
    const shown = buildMotionVisualField(full, winner, 42);
    expect(shown).toHaveLength(MOTION_REVEAL_MAX_CONTENDERS);
    expect(shown.filter((build) => build.id === winner.id)).toEqual([winner]);
    expect(full).toEqual(original);
    expect(shown.every((build) => full.includes(build))).toBe(true);
    expect(shown.map((build) => full.indexOf(build))).toEqual(shown.map((build) => full.indexOf(build)).sort((a, b) => a - b));
  });

  it("is deterministic for a spin and does not rewrite build metadata", () => {
    const full = pool(80);
    const first = buildMotionVisualField(full, full[71], 19);
    expect(buildMotionVisualField(full, full[71], 19)).toEqual(first);
    expect(buildMotionVisualField(full, full[71], 20)).not.toEqual(first);
    expect(first.every((build) => build === full.find((item) => item.id === build.id))).toBe(true);
  });

  it("retains the same array when every contender fits", () => {
    const full = pool(MOTION_REVEAL_MAX_CONTENDERS);
    expect(buildMotionVisualField(full, full[5], 19)).toBe(full);
  });
});
