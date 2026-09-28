/**
 * /try route — the rollout flag decides everything: "off" is a plain 404
 * with no /try metadata (the feature is not named), "admins" renders the
 * page but keeps it out of search results, "all" is indexable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/components/instant/TryPage", () => ({ TryPage: () => null }));

async function loadRoute(flag: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", flag);
  return import("../page");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("/try route", () => {
  it("404s with no /try metadata when the flag is off", async () => {
    const route = await loadRoute("");
    expect(route.metadata).toEqual({});
    expect(() => route.default()).toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("renders the tool for everyone, indexable, when the flag is all", async () => {
    const route = await loadRoute("all");
    expect(route.metadata.title).toBe("Analyze your replays in your browser — SC2 Tools");
    expect(route.metadata.alternates?.canonical).toBe("/try");
    expect(route.metadata.robots).toBeUndefined();
    expect(route.default().props).toEqual({ mode: "all" });
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("renders but stays out of search results in admins mode", async () => {
    const route = await loadRoute("admins");
    expect(route.metadata.robots).toEqual({ index: false, follow: false });
    expect(route.default().props).toEqual({ mode: "admins" });
  });
});
