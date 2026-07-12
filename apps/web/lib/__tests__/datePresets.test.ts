import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESET,
  PATCH_5_0_16_RELEASE,
  longLabelFor,
  resolvePreset,
} from "../datePresets";

describe("5.0.16 date presets", () => {
  it("defaults new analyzer sessions to the 8-worker era", () => {
    expect(DEFAULT_PRESET).toBe("after_5_0_16");
  });

  it("splits before and after without overlap or a gap", () => {
    const before = resolvePreset("before_5_0_16");
    const after = resolvePreset("after_5_0_16");

    expect(after.since).toEqual(PATCH_5_0_16_RELEASE);
    expect(after.until).toBeUndefined();
    expect(before.since).toBeUndefined();
    expect(before.until?.getTime()).toBe(PATCH_5_0_16_RELEASE.getTime() - 1);
  });

  it("uses worker counts in the user-facing labels", () => {
    expect(longLabelFor("after_5_0_16")).toContain("8 workers");
    expect(longLabelFor("before_5_0_16")).toContain("12 workers");
  });
});
