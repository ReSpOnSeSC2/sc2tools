import { afterEach, describe, expect, test, vi } from "vitest";
import { guidesEnabled } from "@/lib/guides/flags";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("guidesEnabled", () => {
  test.each(["1", "true"])("on for %s", (value) => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", value);
    expect(guidesEnabled()).toBe(true);
  });

  test.each(["", "0", "false", "yes", "TRUE", " 1"])("off for %j", (value) => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", value);
    expect(guidesEnabled()).toBe(false);
  });

  test("off when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", undefined);
    expect(guidesEnabled()).toBe(false);
  });
});
