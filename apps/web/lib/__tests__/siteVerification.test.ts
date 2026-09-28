import { afterEach, describe, expect, it, vi } from "vitest";
import { siteVerification } from "../siteVerification";

afterEach(() => vi.unstubAllEnvs());

describe("siteVerification", () => {
  it("emits the Google token when NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION is set", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION", "  test-token-123  ");
    expect(siteVerification()).toEqual({ google: "test-token-123" });
  });

  it.each([undefined, "", "   "])("emits nothing for %j", (value) => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION", value);
    expect(siteVerification()).toBeUndefined();
  });
});
