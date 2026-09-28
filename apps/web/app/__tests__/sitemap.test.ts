import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), fetchGuideSitemap: vi.fn() }));

vi.mock("@/lib/serverApi", () => ({ getJson: mocks.getJson }));
vi.mock("@/lib/guides/api", () => ({ fetchGuideSitemap: mocks.fetchGuideSitemap }));

import sitemap, { revalidate } from "@/app/sitemap";
import { finalizeSitemap, guideSitemapRows, SITEMAP_MAX_URLS } from "@/lib/sitemapEntries";
import { FIXTURE_SITEMAP } from "@/lib/guides/__fixtures__";

const SITE = "https://sc2tools.com";
const COMMUNITY = {
  builds: [
    { slug: "build-0123456789abcdef0123456789abcdef", lastModified: "2026-09-20T10:00:00.000Z" },
    { slug: "../../admin", lastModified: "2026-09-20T10:00:00.000Z" },
  ],
  profiles: [
    { handle: "fixture-author", lastModified: "2026-09-21T10:00:00.000Z" },
    { handle: "bad handle", lastModified: "2026-09-21T10:00:00.000Z" },
  ],
};

function apiRoutes(routes: Record<string, unknown>) {
  mocks.getJson.mockImplementation(async (path: string) => routes[path] ?? null);
}

async function urls(): Promise<string[]> {
  return (await sitemap()).map((row) => row.url);
}

beforeEach(() => {
  apiRoutes({ "/v1/community/sitemap": COMMUNITY });
  mocks.fetchGuideSitemap.mockResolvedValue({ kind: "ok", data: FIXTURE_SITEMAP });
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.getJson.mockReset();
  mocks.fetchGuideSitemap.mockReset();
});

describe("sitemap", () => {
  it("regenerates at most hourly and never lists the retired /meta", async () => {
    expect(revalidate).toBe(3600);
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    expect(await urls()).not.toContain(`${SITE}/meta`);
  });

  it("lists published guide pages (API paths, hub included) when guides are on", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    const rows = await sitemap();
    const list = rows.map((row) => row.url);
    for (const entry of FIXTURE_SITEMAP.entries) expect(list).toContain(`${SITE}${entry.path}`);
    expect(list.filter((url) => url === `${SITE}/guides`)).toHaveLength(1);
    expect(rows.find((row) => row.url === `${SITE}/guides`)?.priority).toBe(0.8);
    const build = rows.find((row) => row.url === `${SITE}/guides/pvz/stargate-into-glaives`);
    expect(build?.lastModified).toEqual(new Date(FIXTURE_SITEMAP.entries[2].lastModified));
    expect(new Set(list).size).toBe(list.length);
  });

  it("omits the hub while the API doesn't list it (noindex: nothing published yet)", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    mocks.fetchGuideSitemap.mockResolvedValue({ kind: "ok", data: { computedAt: null, entries: [] } });
    expect((await urls()).some((url) => url.includes("/guides"))).toBe(false);
  });

  it("lists no guide URL (and never asks the API) while guides are off", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    expect((await urls()).some((url) => url.includes("/guides"))).toBe(false);
    expect(mocks.fetchGuideSitemap).not.toHaveBeenCalled();
  });

  it("lists community builds and author profiles, dropping malformed slugs and handles", async () => {
    const list = await urls();
    expect(list).toContain(`${SITE}/community/builds/build-0123456789abcdef0123456789abcdef`);
    expect(list).toContain(`${SITE}/p/fixture-author`);
    expect(list.some((url) => url.includes("admin") || url.includes("bad"))).toBe(false);
    expect(mocks.getJson).toHaveBeenCalledWith("/v1/community/sitemap", { revalidateSec: 3600 });
  });

  it("keeps the review board and indexable reviews while the exchange is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    apiRoutes({
      "/v1/community/sitemap": COMMUNITY,
      "/v1/reviews/sitemap": { items: [{ id: "e2eReviewFixture", lastModified: null }, { id: "short", lastModified: null }] },
    });
    const list = await urls();
    expect(list).toContain(`${SITE}/reviews`);
    expect(list).toContain(`${SITE}/reviews/e2eReviewFixture`);
    expect(list).not.toContain(`${SITE}/reviews/short`);
  });

  it("degrades to the static routes when the API is down", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    mocks.getJson.mockResolvedValue(null);
    mocks.fetchGuideSitemap.mockResolvedValue({ kind: "unavailable" });
    const list = await urls();
    expect(list).toContain(`${SITE}/`);
    expect(list).toContain(`${SITE}/reviews`);
    // No guide URL at all: the hub would render its noindex "unavailable" state.
    expect(list.some((url) => url.includes("/guides"))).toBe(false);
    expect(list.some((url) => url.includes("/community/builds/"))).toBe(false);
  });
});

describe("sitemap helpers", () => {
  it("accepts only well-formed guide paths", () => {
    const now = new Date("2026-09-28T00:00:00.000Z");
    const rows = guideSitemapRows(
      SITE,
      {
        computedAt: null,
        entries: [
          { path: "/guides/pvz/counter/8-pool", lastModified: "garbage" },
          { path: "https://evil.example/guides", lastModified: "2026-09-27T00:00:00.000Z" },
          { path: "/guides/../admin", lastModified: "2026-09-27T00:00:00.000Z" },
          { path: "/guides/pvz/a/b/c", lastModified: "2026-09-27T00:00:00.000Z" },
        ],
      },
      now,
    );
    expect(rows).toEqual([
      { url: `${SITE}/guides/pvz/counter/8-pool`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    ]);
  });

  it("caps the list at 45,000 URLs with a warning (counts only)", () => {
    expect(SITEMAP_MAX_URLS).toBe(45_000);
    const warn = vi.fn();
    const rows = Array.from({ length: 5 }, (_, index) => ({ url: `${SITE}/p/${index}` }));
    expect(finalizeSitemap([...rows, rows[0]], 3, warn).map((row) => row.url)).toEqual([
      `${SITE}/p/0`,
      `${SITE}/p/1`,
      `${SITE}/p/2`,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/5 URLs exceed the 3 cap; the last 2 were dropped/);
    expect(finalizeSitemap(rows, 10, warn)).toHaveLength(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
