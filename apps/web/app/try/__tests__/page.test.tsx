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
  published: vi.fn(async (): Promise<ReadonlySet<string> | null> => null),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/components/instant/TryPage", () => ({ TryPage: () => null }));
vi.mock("@/components/instant/TryExplainer", () => ({ TryExplainer: () => null }));
vi.mock("@/lib/guides/api", () => ({ fetchPublishedGuidePaths: mocks.published }));

/** The route's element tree as [TryPage props, whether the explainer renders]. */
function renderedParts(tree: { props: { children: unknown } }) {
  const [page, explainer] = tree.props.children as [{ props: unknown }, unknown];
  return { pageProps: page.props, explainer: Boolean(explainer) };
}

async function loadRoute(flag: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", flag);
  vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "off");
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
    await expect(route.default()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("renders the tool for everyone, indexable, when the flag is all", async () => {
    const route = await loadRoute("all");
    expect(route.metadata.title).toEqual({ absolute: "SC2 Replay Analyzer: free StarCraft II replay stats | SC2 Tools" });
    expect(route.metadata.alternates?.canonical).toBe("/try");
    expect(route.metadata.robots).toBeUndefined();
    expect(renderedParts(await route.default())).toEqual({ pageProps: { mode: "all", guideLinks: [] }, explainer: true });
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("renders but stays out of search results in admins mode", async () => {
    const route = await loadRoute("admins");
    expect(route.metadata.robots).toEqual({ index: false, follow: false });
    // The crawlable explainer stays off a page that is kept out of search.
    expect(renderedParts(await route.default())).toEqual({ pageProps: { mode: "admins", guideLinks: [] }, explainer: false });
  });

  it("passes only published guide targets without making the page query-dependent", async () => {
    const route = await loadRoute("all");
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    mocks.published.mockResolvedValue(new Set(["/guides/pvz/adept-glaives-robo"]));
    const parts = renderedParts(await route.default());
    expect(parts.pageProps).toMatchObject({ guideLinks: [{ name: "PvZ - Adept Glaives (Robo)", matchup: "PvZ" }] });
    expect(mocks.published).toHaveBeenCalledTimes(1);
  });
});
