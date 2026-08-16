import { describe, expect, it } from "vitest";
import { STREAM_BACKGROUND_IDS } from "@/lib/streamBackgrounds";
import { isValidScene } from "@/components/overlay/scenes/sceneVariants";

describe("scene route allowlist", () => {
  it("includes every catalog background and preserves all legacy scenes", () => {
    for (const id of STREAM_BACKGROUND_IDS) {
      expect(isValidScene(id)).toBe(true);
    }
    for (const id of [
      "between-games",
      "starting-soon",
      "brb",
      "intermission",
      "manual",
    ]) {
      expect(isValidScene(id)).toBe(true);
    }
  });

  it("still rejects arbitrary path input", () => {
    expect(isValidScene("../../frontier-cantina")).toBe(false);
    expect(isValidScene("unknown-set")).toBe(false);
  });
});
