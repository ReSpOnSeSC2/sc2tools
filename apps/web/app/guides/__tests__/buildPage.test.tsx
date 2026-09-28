import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchGuideBuild: vi.fn(),
  permanentRedirect: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${path};308;` });
  }),
}));

vi.mock("@/lib/guides/api", () => ({ fetchGuideBuild: mocks.fetchGuideBuild }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: mocks.permanentRedirect,
}));
vi.mock("@/components/guides/LazyCiBarChart", async () => ({
  LazyCiBarChart: (await import("@/components/guides/CiBarChart")).CiBarChart,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, error: undefined, isLoading: false }) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

import BuildGuidePage, { generateMetadata, revalidate } from "@/app/guides/[matchup]/[build]/page";
import { buildIntro, buildTimingsBlurb } from "@/lib/guides/guideCopy";
import { FIXTURE_BUILD_PUBLISHED, FIXTURE_BUILD_UNPUBLISHED, fixtureCell } from "@/lib/guides/__fixtures__";

const PARAMS = { params: Promise.resolve({ matchup: "pvz", build: "stargate-into-glaives" }) };
/** The payload's Diamond headline (82 of 145 decided games), formatted like the page. */
const HEADLINE_PCT = `${((FIXTURE_BUILD_PUBLISHED.headline?.winRate ?? Number.NaN) * 100).toFixed(1)}%`;

function ok<T>(data: T) {
  return { kind: "ok" as const, data };
}

async function renderPage() {
  return render(await BuildGuidePage(PARAMS));
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const script = container.querySelector('script[type="application/ld+json"]');
  return JSON.parse(script?.innerHTML ?? "[]") as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://sc2tools.com");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideBuild.mockReset();
  mocks.permanentRedirect.mockClear();
});

describe("/guides/[matchup]/[build] metadata", () => {
  it("revalidates every 6 hours", () => {
    expect(revalidate).toBe(21600);
  });

  it("titles a published guide with its real headline win rate and league", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    const md = await generateMetadata(PARAMS);
    expect(HEADLINE_PCT).toBe("56.5%");
    expect(md.title).toBe(
      `Stargate into Glaives PvZ — ${HEADLINE_PCT} win rate at Diamond (Patch 5.0.16) | SC2 Tools`,
    );
    expect(md.alternates?.canonical).toBe("/guides/pvz/stargate-into-glaives");
    expect(md.robots).toBeUndefined();
    expect(String(md.description)).toContain("412 ladder games");
    expect(String(md.description)).toContain("Sep 27, 2026");
    expect(md.openGraph).toMatchObject({ url: "https://sc2tools.com/guides/pvz/stargate-into-glaives" });
    expect(md.twitter).toMatchObject({ card: "summary_large_image" });
    expect(mocks.fetchGuideBuild).toHaveBeenCalledWith("pvz", "stargate-into-glaives");
  });

  it("falls back to the ladder win rate when the headline covers all games", async () => {
    const payload = {
      ...FIXTURE_BUILD_PUBLISHED,
      headline: { scope: "all" as const, value: null, label: null, games: 412, winRate: 0.539 },
    };
    mocks.fetchGuideBuild.mockResolvedValue(ok(payload));
    const md = await generateMetadata(PARAMS);
    expect(md.title).toBe("Stargate into Glaives PvZ — 53.9% ladder win rate (Patch 5.0.16) | SC2 Tools");
  });

  it("marks an unpublished guide noindex", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_UNPUBLISHED));
    const md = await generateMetadata(PARAMS);
    expect(md.robots).toMatchObject({ index: false });
    expect(md.alternates?.canonical).toBe("/guides/pvz/carrier-rush");
  });

  it("raises a real 404 from generateMetadata for an unknown slug or flag off", async () => {
    mocks.fetchGuideBuild.mockResolvedValue({ kind: "not_found" });
    await expect(generateMetadata(PARAMS)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(BuildGuidePage(PARAMS)).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    await expect(generateMetadata(PARAMS)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("permanently redirects an alias slug", async () => {
    mocks.fetchGuideBuild.mockResolvedValue({ kind: "moved", path: "/guides/pvz/new-slug" });
    await expect(generateMetadata(PARAMS)).rejects.toThrow("NEXT_REDIRECT");
    await expect(BuildGuidePage(PARAMS)).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.permanentRedirect).toHaveBeenCalledWith("/guides/pvz/new-slug");
  });

  it("serves a noindex unavailable state when the API is down", async () => {
    mocks.fetchGuideBuild.mockResolvedValue({ kind: "unavailable" });
    const md = await generateMetadata(PARAMS);
    expect(md.robots).toEqual({ index: false, follow: false });
    await renderPage();
    expect(screen.getByText("This guide is temporarily unavailable")).toBeTruthy();
  });
});

describe("/guides/[matchup]/[build] page", () => {
  it("renders the published guide from real payload numbers", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Stargate into Glaives" })).toBeTruthy();
    expect(screen.getByTestId("guide-headline").textContent).toBe(
      `${HEADLINE_PCT} win rate over 146 games vs Diamond opponents since patch 5.0.16`,
    );
    expect(screen.getByText(FIXTURE_BUILD_PUBLISHED.description)).toBeTruthy();
    expect(screen.getByText(/n = 412 games from 63 players · Stats updated Sep 27, 2026/)).toBeTruthy();
    for (const entry of [...buildIntro(FIXTURE_BUILD_PUBLISHED), ...buildTimingsBlurb(FIXTURE_BUILD_PUBLISHED)]) {
      expect(document.querySelector(`[data-copy-id="${entry.id}"]`)?.textContent).toContain(entry.text);
    }
  });

  it("orders the sections as the brief does", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    await renderPage();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Video guide",
      "Win rate by league and MMR",
      "Key timings",
      "Army at 6, 8 and 10 minutes",
      "What it beats and loses to",
      "When it wins",
      "Best and worst maps",
      "Common macro leaks",
      "Related",
      "Coach's notes",
    ]);
  });

  it("renders timings with started/done wording and the winners-vs-losers column", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    await renderPage();
    const table = screen.getByRole("table", { name: /Key timings from 356 recorded build orders/ });
    const glaives = within(table).getByRole("rowheader", { name: /Resonating Glaives done/ });
    const row = glaives.closest("tr");
    expect(row?.textContent).toContain("7:10"); // p25 430 s
    expect(row?.textContent).toContain("7:21"); // median 441 s
    expect(row?.textContent).toContain("7:38"); // p75 458 s
    expect(row?.textContent).toContain("7:16 vs 7:29"); // winners 436 s vs losers 449 s
    expect(within(table).getByRole("rowheader", { name: /Stargate started/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in to compare your timings" })).toBeTruthy();
  });

});

describe("/guides/[matchup]/[build] page sections", () => {
  it("shows unit icons, counter links, map links, related links and coach's notes", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    const { container } = await renderPage();
    const adeptIcon = container.querySelector('img[src="/icons/sc2/units/adept.png"]');
    expect(adeptIcon?.getAttribute("width")).toBe("28");
    expect(screen.getByRole("link", { name: "17 Hatch 18 Gas 17 Pool" }).getAttribute("href")).toBe(
      "/guides/pvz/counter/17-hatch-18-gas-17-pool",
    );
    expect(screen.queryByRole("link", { name: "Ling Bane Bust" })).toBeNull();
    expect(screen.getByRole("link", { name: "Old Sun Temple" }).getAttribute("href")).toBe(
      "/guides/maps/old-sun-temple",
    );
    expect(screen.getByRole("link", { name: "Standard Blink Macro" }).getAttribute("href")).toBe(
      "/guides/pvz/standard-blink-macro",
    );
    expect(screen.getByRole("link", { name: "PvZ - Stargate into Glaives" }).getAttribute("href")).toBe(
      "/community/builds/pvz-stargate-into-glaives-7f3k",
    );
    expect(screen.getByRole("link", { name: "FixturePlayer" }).getAttribute("href")).toBe(
      "/players/fixture-player/replays",
    );
    expect(screen.getByRole("heading", { level: 3, name: "Game plan" })).toBeTruthy();
    expect(screen.getByText("From the video by ReSpOnSe")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("emits BreadcrumbList, Article and VideoObject JSON-LD", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    const { container } = await renderPage();
    const [crumbs, article, video] = jsonLd(container);
    expect(crumbs["@type"]).toBe("BreadcrumbList");
    expect(crumbs.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Guides", item: "https://sc2tools.com/guides" },
      { "@type": "ListItem", position: 2, name: "PvZ", item: "https://sc2tools.com/guides/pvz" },
      {
        "@type": "ListItem",
        position: 3,
        name: "Stargate into Glaives",
        item: "https://sc2tools.com/guides/pvz/stargate-into-glaives",
      },
    ]);
    expect(article).toMatchObject({
      "@type": "Article",
      datePublished: FIXTURE_BUILD_PUBLISHED.firstPublishedAt,
      dateModified: FIXTURE_BUILD_PUBLISHED.computedAt,
      author: { "@type": "Organization", name: "SC2 Tools" },
    });
    expect(video).toMatchObject({
      "@type": "VideoObject",
      name: "PvZ Stargate into Glaive Adept Timing",
      embedUrl: "https://www.youtube-nocookie.com/embed/YcTMc_Ee11w",
      uploadDate: "2026-08-29T00:00:00.000Z",
    });
  });

});

describe("/guides/[matchup]/[build] page numbers", () => {
  it("ranks the vs-opener table by the Wilson lower bound, not the raw win rate", async () => {
    const [first] = FIXTURE_BUILD_PUBLISHED.vsStrategy;
    const thin = { ...first, strategyKey: "Zerg - Thin", strategySlug: "thin", name: "Thin", ...fixtureCell(30, 5, 20) };
    const solid = { ...first, strategyKey: "Zerg - Solid", strategySlug: "solid", name: "Solid", ...fixtureCell(400, 60, 240) };
    mocks.fetchGuideBuild.mockResolvedValue(ok({ ...FIXTURE_BUILD_PUBLISHED, vsStrategy: [thin, solid] }));
    await renderPage();
    const table = screen.getByRole("table", { name: "Win rate by opponent opener" });
    const names = within(table).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(names).toEqual(["Solid", "Thin"]);
  });

  it("prints interpolated army medians as they are, without rounding up", async () => {
    const army = FIXTURE_BUILD_PUBLISHED.army ?? {};
    const at6 = army["360"];
    if (!at6) throw new Error("fixture needs a 6:00 checkpoint");
    const units = at6.units.map((unit, index) => (index === 0 ? { ...unit, median: 5.5 } : unit));
    mocks.fetchGuideBuild.mockResolvedValue(ok({ ...FIXTURE_BUILD_PUBLISHED, army: { "360": { ...at6, units } } }));
    await renderPage();
    const section = screen.getByRole("heading", { level: 2, name: "Army at 6, 8 and 10 minutes" }).closest("section");
    expect(section?.textContent).toContain("×5.5");
    expect(section?.textContent).not.toContain("×6");
    expect(section?.textContent).not.toContain("At 8:00");
  });

  it("renders an unpublished guide as 'Not enough games yet' with its real content only", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_UNPUBLISHED));
    const { container } = await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Carrier Rush" })).toBeTruthy();
    expect(screen.getByText("Not enough games yet")).toBeTruthy();
    expect(screen.getByText(FIXTURE_BUILD_UNPUBLISHED.description)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign up free and track your games" }).getAttribute("href")).toBe(
      "/sign-up",
    );
    expect(screen.getByRole("button", { name: "Play PvZ Carrier Rush: Can Zerg Stop It? on YouTube" })).toBeTruthy();
    expect(container.textContent ?? "").not.toMatch(/\d+(\.\d+)?%/);
    const types = jsonLd(container).map((item) => item["@type"]);
    expect(types).toEqual(["BreadcrumbList", "VideoObject"]);
  });
});
