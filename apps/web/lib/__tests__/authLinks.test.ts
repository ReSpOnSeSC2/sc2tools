import { describe, expect, it } from "vitest";
import { signInHref, signUpHref } from "../authLinks";

describe("auth links", () => {
  it("bring the visitor back to a page on this site, encoded once", () => {
    expect(signInHref("/builds")).toBe("/sign-in?redirect_url=%2Fbuilds");
    expect(signUpHref("/builds/proxy-gate")).toBe("/sign-up?redirect_url=%2Fbuilds%2Fproxy-gate");
    expect(signInHref("/reviews?sort=new")).toBe("/sign-in?redirect_url=%2Freviews%3Fsort%3Dnew");
    expect(signInHref("/community/builds/pvz-glaives")).toBe(
      "/sign-in?redirect_url=%2Fcommunity%2Fbuilds%2Fpvz-glaives",
    );
    expect(signUpHref("/community?mine=1")).toBe("/sign-up?redirect_url=%2Fcommunity%3Fmine%3D1");
  });

  it("never build an open redirect", () => {
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "builds"]) {
      expect(signInHref(bad)).toBe("/sign-in");
      expect(signUpHref(bad)).toBe("/sign-up");
    }
  });
});
