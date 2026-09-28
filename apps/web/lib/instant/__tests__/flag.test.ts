import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstantImportMode } from "../flag";

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true },
  api: { data: undefined as { isAdmin?: boolean } | undefined, isLoading: false },
  paths: [] as Array<string | null>,
}));

// Mocks: Clerk session state and the SWR-backed useApi hook.
vi.mock("@clerk/nextjs", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    mocks.paths.push(path);
    return mocks.api;
  },
}));

import { useInstantImport } from "../useInstantImport";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.auth = { isLoaded: true, isSignedIn: true };
  mocks.api = { data: undefined, isLoading: false };
  mocks.paths = [];
});

describe("getInstantImportMode", () => {
  it("parses the flag and defaults to off", () => {
    expect(getInstantImportMode("all")).toBe("all");
    expect(getInstantImportMode(" Admins ")).toBe("admins");
    expect(getInstantImportMode("off")).toBe("off");
    expect(getInstantImportMode("true")).toBe("off");
    expect(getInstantImportMode(undefined)).toBe("off");
  });

  it("reads NEXT_PUBLIC_INSTANT_IMPORT by default", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    expect(getInstantImportMode()).toBe("all");
  });
});

describe("useInstantImport", () => {
  it("is enabled for everyone in all mode without asking /v1/me", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    const { result } = renderHook(() => useInstantImport());
    expect(result.current).toEqual({ enabled: true, mode: "all", loading: false });
    expect(mocks.paths).toEqual([null]);
  });

  it("is disabled when off", () => {
    const { result } = renderHook(() => useInstantImport());
    expect(result.current).toEqual({ enabled: false, mode: "off", loading: false });
  });

  it("is enabled for admins only in admins mode", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "admins");
    mocks.api = { data: { isAdmin: true }, isLoading: false };
    expect(renderHook(() => useInstantImport()).result.current).toEqual({
      enabled: true,
      mode: "admins",
      loading: false,
    });
    expect(mocks.paths).toContain("/v1/me");
    mocks.api = { data: { isAdmin: false }, isLoading: false };
    expect(renderHook(() => useInstantImport()).result.current.enabled).toBe(false);
  });

  it("reports loading while the admin check resolves, and signed-out as disabled", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "admins");
    mocks.api = { data: undefined, isLoading: true };
    expect(renderHook(() => useInstantImport()).result.current).toMatchObject({ enabled: false, loading: true });
    mocks.auth = { isLoaded: true, isSignedIn: false };
    mocks.api = { data: undefined, isLoading: false };
    expect(renderHook(() => useInstantImport()).result.current).toEqual({
      enabled: false,
      mode: "admins",
      loading: false,
    });
  });
});
