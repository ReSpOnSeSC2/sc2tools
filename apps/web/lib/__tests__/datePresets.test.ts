import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESET,
  PATCH_5_0_16_RELEASE,
  PATCH_5_0_17_RELEASE,
  PRESETS,
  longLabelFor,
  normalizePresetId,
  patchEraFor,
  resolvePreset,
  shortLabelFor,
} from "../datePresets";

describe("patch era date presets", () => {
  it("defaults new analyzer sessions to the 12-worker patch 5.0.17", () => {
    expect(DEFAULT_PRESET).toBe("after_5_0_17");
    expect(PRESETS[0].id).toBe("after_5_0_17");
  });

  it("pins the 5.0.17 cut-over to midnight US Eastern on 30 Sep 2026", () => {
    // Must equal apps/api/src/util/patchEra.js PATCH_5_0_17_RELEASE.
    expect(PATCH_5_0_17_RELEASE.toISOString()).toBe("2026-09-30T04:00:00.000Z");
  });

  it("bounds the 12-worker presets by date, leaving the 5.0.16/5.0.17 split to the game's version", () => {
    const before = resolvePreset("before_5_0_16");
    const after = resolvePreset("after_5_0_17");

    expect(before.since).toBeUndefined();
    expect(before.until?.getTime()).toBe(PATCH_5_0_16_RELEASE.getTime() - 1);

    expect(after.since).toEqual(PATCH_5_0_17_RELEASE);
    expect(after.until).toBeUndefined();
  });

  it("selects the 8-worker patch by version alone, with no dates", () => {
    // The 5.0.16 PTR games (June, before the live release) and the 5.0.16
    // games played after the 5.0.17 notes both belong here: no start or
    // end date, the patch filter decides.
    expect(resolvePreset("patch_5_0_16")).toEqual({});
  });

  it("keeps every patch preset to its patch by version", () => {
    expect(patchEraFor("after_5_0_17")).toBe("after");
    expect(patchEraFor("patch_5_0_16")).toBe("before");
    // The 8-worker 5.0.16 PTR games predate the live release, so the date
    // alone would list them as 12-worker.
    expect(patchEraFor("before_5_0_16")).toBe("after");
    for (const id of ["all", "last_7d", "custom", "season:67", "current_season", undefined] as const) {
      expect(patchEraFor(id)).toBeUndefined();
    }
  });

  it("uses worker counts in the user-facing labels", () => {
    expect(longLabelFor("after_5_0_17")).toContain("12 workers");
    expect(longLabelFor("patch_5_0_16")).toBe("5.0.16 · 8 workers");
    expect(longLabelFor("before_5_0_16")).toContain("12 workers");
    expect(shortLabelFor("after_5_0_17")).toBe("12-worker patch");
    expect(shortLabelFor("patch_5_0_16")).toBe("8-worker patch");
    expect(shortLabelFor("before_5_0_16")).toBe("Before 5.0.16");
  });

  it("no longer offers the open-ended 8-worker preset", () => {
    expect(PRESETS.some((p) => (p.id as string) === "after_5_0_16")).toBe(false);
  });
});

describe("normalizePresetId", () => {
  it("moves the legacy live-patch id to the new live patch", () => {
    expect(normalizePresetId("after_5_0_16")).toBe("after_5_0_17");
  });

  it("keeps every valid id", () => {
    for (const id of [
      "after_5_0_17",
      "patch_5_0_16",
      "before_5_0_16",
      "all",
      "last_7d",
      "current_season",
      "season:67",
      "custom",
    ]) {
      expect(normalizePresetId(id)).toBe(id);
    }
  });

  it("falls back to the default for missing or garbage values", () => {
    for (const raw of [undefined, null, "", 42, "bogus", "season:", "season:abc", "constructor"]) {
      expect(normalizePresetId(raw)).toBe(DEFAULT_PRESET);
    }
  });
});
