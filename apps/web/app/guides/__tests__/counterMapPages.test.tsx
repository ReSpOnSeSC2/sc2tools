import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchGuideCounter: vi.fn(),
  fetchGuideMap: vi.fn(),
  fetchPublishedGuidePaths: vi.fn(async (): Promise<ReadonlySet<string> | null> => null),
  permanentRedirect: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  }),
}));

vi.mock("@/lib/guides/api", () => ({
  fetchGuideCounter: mocks.fetchGuideCounter,
  fetchGuideMap: mocks.fetchGuideMap,
  fetchPublishedGuidePaths: mocks.fetchPublishedGuidePaths,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: mocks.permanentRedirect,
}));

import CounterGuidePage, { generateMetadata as counterMetadata } from "@/app/guides/[matchup]/counter/[strategy]/page";
import MapGuidePage, { generateMetadata as mapMetadata } from "@/app/guides/maps/[map]/page";
import { buildCounterIntro, buildMapIntro } from "@/lib/guides/guideCopy";
import { GuideUnavailableError } from "@/lib/guides/guideErrors";
import {
  FIXTURE_COUNTER_PUBLISHED,
  FIXTURE_COUNTER_UNPUBLISHED,
  FIXTURE_MAP,
  FIXTURE_MAP_UNPUBLISHED,
  FIXTURE_SITEMAP,
} from "@/lib/guides/__fixtures__";

const COUNTER_PARAMS = { params: Promise.resolve({ matchup: "pvz", strategy: "12-pool" }) };
const MAP_PARAMS = { params: Promise.resolve({ map: "old-sun-temple" }) };

function ok<T>(data: T) {
  return { kind: "ok" as const, data };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1"));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideCounter.mockReset();
  mocks.fetchGuideMap.mockReset();
  mocks.fetchPublishedGuidePaths.mockReset();
  mocks.fetchPublishedGuidePaths.mockResolvedValue(null);
  mocks.permanentRedirect.mockClear();
});

describe("/guides/[matchup]/counter/[strategy]", () => {
  it("titles the page from the payload and describes it with n and the stats date", async () => {
    mocks.fetchGuideCounter.mockResolvedValue(ok(FIXTURE_COUNTER_PUBLISHED));
    const md = await counterMetadata(COUNTER_PARAMS);
    const pct = `${(FIXTURE_COUNTER_PUBLISHED.overall.winRate * 100).toFixed(1)}%`;
    expect(md.title).toBe(
      `How to beat 12 Pool as Protoss — ${pct} win rate over 236 ladder games (12 workers) | SC2 Tools`,
    );
    expect(md.alternates?.canonical).toBe("/guides/pvz/counter/12-pool");
    expect(String(md.description)).toContain("236 PvZ ladder games");
    expect(String(md.description)).toContain("Sep 27, 2026");
    expect(md.robots).toBeUndefined();
  });

  it("ranks the openers with n and their catalog descriptions, plus the video", async () => {
    mocks.fetchGuideCounter.mockResolvedValue(ok(FIXTURE_COUNTER_PUBLISHED));
    const { container } = render(await CounterGuidePage(COUNTER_PARAMS));
    expect(screen.getByRole("heading", { level: 1, name: "How to beat 12 Pool" })).toBeTruthy();
    expect(screen.getByText(FIXTURE_COUNTER_PUBLISHED.description)).toBeTruthy();
    const list = screen.getByRole("heading", { level: 2, name: /Best Protoss openers against 12 Pool/ })
      .closest("section") as HTMLElement;
    const names = within(list).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(FIXTURE_COUNTER_PUBLISHED.openers.map((opener) => opener.name));
    const first = FIXTURE_COUNTER_PUBLISHED.openers[0];
    expect(within(list).getByRole("link", { name: first.name }).getAttribute("href")).toBe(
      `/guides/pvz/${first.buildSlug}`,
    );
    expect(list.textContent).toContain(`n = ${first.games} games from ${first.users} players`);
    for (const entry of buildCounterIntro(FIXTURE_COUNTER_PUBLISHED)) {
      expect(document.querySelector(`[data-copy-id="${entry.id}"]`)?.textContent).toBe(entry.text);
    }
    expect(screen.getByText("From the video by ReSpOnSe")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    const script = container.querySelector('script[type="application/ld+json"]');
    const types = (JSON.parse(script?.innerHTML ?? "[]") as Array<{ "@type": string }>).map((i) => i["@type"]);
    expect(types).toEqual(["BreadcrumbList", "VideoObject"]);
  });

  it("renders an unpublished counter as noindex 'Not enough games yet'", async () => {
    mocks.fetchGuideCounter.mockResolvedValue(ok(FIXTURE_COUNTER_UNPUBLISHED));
    expect((await counterMetadata(COUNTER_PARAMS)).robots).toMatchObject({ index: false });
    const { container } = render(await CounterGuidePage(COUNTER_PARAMS));
    expect(screen.getByRole("heading", { level: 1, name: "How to beat Lurker Contain" })).toBeTruthy();
    expect(screen.getByText("Not enough games yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "All Zerg openers" }).getAttribute("href")).toBe("/guides/pvz/counter");
    expect(container.textContent ?? "").not.toMatch(/\d+(\.\d+)?%/);
    expect(container.textContent ?? "").not.toMatch(/\d+ games/);
  });

  it("headlines the viewer race from the matchup", async () => {
    mocks.fetchGuideCounter.mockResolvedValue(ok({ ...FIXTURE_COUNTER_PUBLISHED, myRace: "P", oppRace: "Z" }));
    render(await CounterGuidePage(COUNTER_PARAMS));
    const pct = `${(FIXTURE_COUNTER_PUBLISHED.overall.winRate * 100).toFixed(1)}%`;
    expect(screen.getByTestId("guide-headline").textContent).toBe(
      `Protoss win rate against it: ${pct} over ${FIXTURE_COUNTER_PUBLISHED.overall.games} games`,
    );
  });

  it("throws (never caches) an outage and redirects a mixed-case URL before fetching", async () => {
    mocks.fetchGuideCounter.mockResolvedValue({ kind: "unavailable" });
    expect((await counterMetadata(COUNTER_PARAMS)).robots).toEqual({ index: false, follow: false });
    await expect(CounterGuidePage(COUNTER_PARAMS)).rejects.toBeInstanceOf(GuideUnavailableError);
    mocks.fetchGuideCounter.mockReset();
    const mixed = { params: Promise.resolve({ matchup: "PvZ", strategy: "12-Pool" }) };
    await expect(CounterGuidePage(mixed)).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.permanentRedirect).toHaveBeenCalledWith("/guides/pvz/counter/12-pool");
    expect(mocks.fetchGuideCounter).not.toHaveBeenCalled();
  });

  it("redirects aliases and 404s unknown strategies from generateMetadata", async () => {
    mocks.fetchGuideCounter.mockResolvedValue({ kind: "moved", path: "/guides/pvz/counter/new-pool" });
    await expect(counterMetadata(COUNTER_PARAMS)).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.permanentRedirect).toHaveBeenCalledWith("/guides/pvz/counter/new-pool");
    mocks.fetchGuideCounter.mockResolvedValue({ kind: "not_found" });
    await expect(counterMetadata(COUNTER_PARAMS)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/guides/maps/[map]", () => {
  it("titles the map page with its real game count", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP));
    const md = await mapMetadata(MAP_PARAMS);
    expect(md.title).toBe(
      "Old Sun Temple — best openers by matchup from 2,418 ladder games (12 workers) | SC2 Tools",
    );
    expect(md.alternates?.canonical).toBe("/guides/maps/old-sun-temple");
  });

  it("renders the matchup table and best openers per matchup", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP));
    const { container } = render(await MapGuidePage(MAP_PARAMS));
    expect(screen.getByRole("heading", { level: 1, name: "Old Sun Temple" })).toBeTruthy();
    expect(container.querySelector("[data-map-artwork]")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Win rate by matchup on this map" });
    expect(within(table).getByRole("link", { name: "PvZ" }).getAttribute("href")).toBe("/guides/pvz");
    const pvz = FIXTURE_MAP.matchups[0];
    expect(within(table).getByRole("link", { name: "PvZ" }).closest("tr")?.textContent).toContain(
      `${(pvz.winRate * 100).toFixed(1)}%`,
    );
    expect(screen.getByRole("link", { name: "3 CC Bio" }).getAttribute("href")).toBe("/guides/tvz/3-cc-bio");
    for (const entry of buildMapIntro(FIXTURE_MAP)) {
      expect(document.querySelector(`[data-copy-id="${entry.id}"]`)?.textContent).toBe(entry.text);
    }
  });

  it("renders an unpublished map as noindex 'Not enough games yet' and degrades when down", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP_UNPUBLISHED));
    expect((await mapMetadata(MAP_PARAMS)).robots).toMatchObject({ index: false });
    const { container } = render(await MapGuidePage(MAP_PARAMS));
    expect(screen.getByText("Not enough games yet")).toBeTruthy();
    expect(container.textContent ?? "").not.toMatch(/\d+(\.\d+)?%|\d+ (ladder )?games/);
    cleanup();
    mocks.fetchGuideMap.mockResolvedValue({ kind: "unavailable" });
    expect((await mapMetadata(MAP_PARAMS)).robots).toEqual({ index: false, follow: false });
    await expect(MapGuidePage(MAP_PARAMS)).rejects.toBeInstanceOf(GuideUnavailableError);
  });

  it("links only the openers whose build guide is published", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP));
    mocks.fetchPublishedGuidePaths.mockResolvedValue(new Set(FIXTURE_SITEMAP.entries.map((entry) => entry.path)));
    render(await MapGuidePage(MAP_PARAMS));
    const openers = screen.getByRole("heading", { level: 2, name: "Best openers per matchup" })
      .closest("section") as HTMLElement;
    expect(within(openers).getAllByRole("link").map((link) => link.getAttribute("href")).sort()).toEqual([
      "/guides/pvz/standard-blink-macro",
      "/guides/pvz/stargate-into-glaives",
    ]);
    // Cleared the cell floor on this map, but its build page is not published.
    expect(within(openers).getByText("3 CC Bio")).toBeTruthy();
    expect(within(openers).queryByRole("link", { name: "3 CC Bio" })).toBeNull();
  });

  it("redirects a mixed-case map URL to lowercase before fetching", async () => {
    await expect(mapMetadata({ params: Promise.resolve({ map: "Old-Sun-Temple" }) })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.permanentRedirect).toHaveBeenCalledWith("/guides/maps/old-sun-temple");
    expect(mocks.fetchGuideMap).not.toHaveBeenCalled();
  });
});
