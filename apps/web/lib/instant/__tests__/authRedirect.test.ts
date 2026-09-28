/**
 * safeAuthRedirect — only `/try?resume=1` survives; open-redirect attempts
 * (protocol-relative, absolute, extra params, encoded variants) are rejected.
 */
import { describe, expect, it } from "vitest";

import { TRY_RESUME_PATH, TRY_SIGN_IN_HREF, TRY_SIGN_UP_HREF, safeAuthRedirect } from "../authRedirect";

describe("safeAuthRedirect", () => {
  it("allows the /try resume path as-is", () => {
    expect(safeAuthRedirect("/try?resume=1")).toBe(TRY_RESUME_PATH);
  });

  it("allows the /try resume path percent-encoded once more", () => {
    expect(safeAuthRedirect("%2Ftry%3Fresume%3D1")).toBe(TRY_RESUME_PATH);
    expect(safeAuthRedirect("%2ftry%3fresume%3d1")).toBe(TRY_RESUME_PATH);
  });

  it("returns null for missing or empty values", () => {
    expect(safeAuthRedirect(null)).toBeNull();
    expect(safeAuthRedirect("")).toBeNull();
  });

  it.each([
    "//evil.com",
    "https://evil.com",
    "http://evil.com/try?resume=1",
    "https://sc2tools.com/try?resume=1",
    "/\\evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "/try?resume=1&x=//evil",
    "/try?resume=1#//evil.com",
    "/try?resume=2",
    "/try",
    "/try?resume=1 ",
    " /try?resume=1",
    "/app",
    "/welcome",
    "//evil.com/try?resume=1",
  ])("rejects %s", (value) => {
    expect(safeAuthRedirect(value)).toBeNull();
  });

  it.each([
    "%2F%2Fevil.com",
    "https%3A%2F%2Fevil.com",
    "%2Ftry%3Fresume%3D1%26x%3D%2F%2Fevil",
    "%252Ftry%253Fresume%253D1",
    "%2F%2Fevil.com%2Ftry%3Fresume%3D1",
    "%E0%A4%A",
  ])("rejects encoded variant %s", (value) => {
    expect(safeAuthRedirect(value)).toBeNull();
  });

  it("builds sign-up and sign-in links that round-trip through the allowlist", () => {
    for (const href of [TRY_SIGN_UP_HREF, TRY_SIGN_IN_HREF]) {
      const url = new URL(href, "https://sc2tools.test");
      expect(safeAuthRedirect(url.searchParams.get("redirect_url"))).toBe(TRY_RESUME_PATH);
    }
    expect(TRY_SIGN_UP_HREF).toBe("/sign-up?redirect_url=%2Ftry%3Fresume%3D1");
    expect(TRY_SIGN_IN_HREF).toBe("/sign-in?redirect_url=%2Ftry%3Fresume%3D1");
  });
});
