import { describe, expect, it } from "vitest";
import { signInHref, signUpHref } from "@/lib/authLinks";

describe("authLinks", () => {
  it("carries a site path back as redirect_url, encoded once", () => {
    expect(signInHref("/community/builds/pvz-glaives")).toBe(
      "/sign-in?redirect_url=%2Fcommunity%2Fbuilds%2Fpvz-glaives",
    );
    expect(signUpHref("/community?mine=1")).toBe("/sign-up?redirect_url=%2Fcommunity%3Fmine%3D1");
  });

  it("drops anything that isn't a same-site path", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "community"]) {
      expect(signInHref(bad)).toBe("/sign-in");
      expect(signUpHref(bad)).toBe("/sign-up");
    }
  });
});
