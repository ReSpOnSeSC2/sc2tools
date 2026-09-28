import { afterEach, describe, expect, test, vi } from "vitest";
import { guidesEnabled } from "@/lib/guides/flags";
import { isGuidesFlagOn } from "@/lib/guides/guidesFlag.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ON = ["1", "true", "yes", "on", "all", "TRUE", "On", "ALL", " 1", "true\n", "  ON  ", " all "];
const OFF = ["", " ", "0", "false", "off", "no", "enabled", "admins", "admin", "1 1", "tru e"];

describe("guidesEnabled", () => {
  test.each(ON)("on for %j", (value) => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", value);
    expect(guidesEnabled()).toBe(true);
  });

  test.each(OFF)("off for %j", (value) => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", value);
    expect(guidesEnabled()).toBe(false);
  });

  test("off when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", undefined);
    expect(guidesEnabled()).toBe(false);
  });
});

describe("isGuidesFlagOn (shared with next.config.mjs)", () => {
  test("agrees with guidesEnabled for every spelling", () => {
    for (const value of [...ON, ...OFF]) {
      vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", value);
      expect(isGuidesFlagOn(value)).toBe(guidesEnabled());
    }
  });

  test("rejects non-strings", () => {
    expect(isGuidesFlagOn(undefined)).toBe(false);
    expect(isGuidesFlagOn(null)).toBe(false);
  });
});
