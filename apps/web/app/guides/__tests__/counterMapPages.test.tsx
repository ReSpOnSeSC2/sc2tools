import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchGuideCounter: vi.fn(),
  fetchGuideMap: vi.fn(),
  fetchGuideIndex: vi.fn(),
  fetchPublishedGuidePaths: vi.fn(async (): Promise<ReadonlySet<string> | null> => null),
  permanentRedirect: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  }),
}));

vi.mock("@/lib/guides/api", () => ({
  fetchGuideCounter: mocks.fetchGuideCounter,
  fetchGuideMap: mocks.fetchGuideMap,
  fetchGuideIndex: mocks.fetchGuideIndex,
  fetchPublishedGuidePaths: mocks.fetchPublishedGuidePaths,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/guides/pvz/stargate-into-glaives",
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
  FIXTURE_INDEX,
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

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
  mocks.fetchGuideIndex.mockResolvedValue({ kind: "unavailable" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideCounter.mockReset();
  mocks.fetchGuideMap.mockReset();
  mocks.fetchGuideIndex.mockReset();
  mocks.fetchPublishedGuidePaths.mockReset();
  mocks.fetchPublishedGuidePaths.mockResolvedValue(null);
  mocks.permanentRedirect.mockClear();
});

describe("/guides/[matchup]/counter/[strategy]", () => {
  it.each([
    [{ low: 0.55, high: 0.65 }, "Your race is favoured"],
    [{ low: 0.45, high: 0.55 }, "Too close to call"],
    [{ low: 0.35, high: 0.45 }, "Your race is behind"],
  ])("labels the counter headline from its likely range %j", async (ci, verdict) => {
    mocks.fetchGuideCounter.mockResolvedValue(ok({ ...FIXTURE_COUNTER_PUBLISHED, overall: { ...FIXTURE_COUNTER_PUBLISHED.overall, ci } }));
    render(await CounterGuidePage(COUNTER_PARAMS));
    expect(within(screen.getByTestId("guide-headline")).getByText(verdict)).toBeTruthy();
    expect(screen.getByText(/Based on 236 games from/)).toBeTruthy();
    expect(screen.getByTestId("guide-headline").textContent).not.toContain("games");
  });

  it("titles the page from the payload and describes it with n and the stats date", async () => {
    mocks.fetchGuideCounter.mockResolvedValue(ok(FIXTURE_COUNTER_PUBLISHED));
    const md = await counterMetadata(COUNTER_PARAMS);
    const pct = `${(FIXTURE_COUNTER_PUBLISHED.overall.winRate * 100).toFixed(1)}%`;
    expect(md.title).toEqual({
      absolute: `How to beat 12 Pool as Protoss — ${pct} win rate over 236 ladder games (12 workers) | SC2 Tools`,
    });
    expect(md.alternates?.canonical).toBe("/guides/pvz/counter/12-pool");
    expect(String(md.description)).toContain("236 PvZ ladder games");
    expect(String(md.description)).toContain("Sep 27, 2026");
    expect(md.robots).toBeUndefined();
  });

  it("ranks the openers with n and their catalog descriptions, plus the video", async () => {
    mocks.fetchGuideCounter.mockResolvedValue(ok(FIXTURE_COUNTER_PUBLISHED));
    const { container } = render(await CounterGuidePage(COUNTER_PARAMS));
    expect(container.querySelectorAll("[data-guide-stats-legend]")).toHaveLength(1);
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
    expect(list.textContent).toContain(`Based on ${first.games} games from ${first.users} players`);
    for (const entry of buildCounterIntro(FIXTURE_COUNTER_PUBLISHED)) {
      expect(document.querySelector(`[data-copy-id="${entry.id}"]`)?.textContent).toBe(entry.text);
    }
    expect(screen.getByText("From the video by ReSpOnSe")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    const script = container.querySelector('script[type="application/ld+json"]');
    const types = (JSON.parse(script?.innerHTML ?? "[]") as Array<{ "@type": string }>).map((i) => i["@type"]);
    expect(types).toEqual(["BreadcrumbList", "VideoObject"]);
    expect(container.querySelector("#eight-worker-videos")).toBeNull();
  });

  it("lists 8-worker patch videos against the opener collapsed at the foot", async () => {
    const [video] = FIXTURE_COUNTER_PUBLISHED.videos;
    mocks.fetchGuideCounter.mockResolvedValue(ok({
      ...FIXTURE_COUNTER_PUBLISHED, videos: [], eightWorkerVideos: [{ ...video, eightWorkerPatch: true }],
    }));
    const { container } = render(await CounterGuidePage(COUNTER_PARAMS));
    const details = container.querySelector("#eight-worker-videos details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Videos against this opener from the 8-worker patch (1)");
    expect(details.querySelector("a")?.getAttribute("href")).toBe(video.url);
    expect(screen.queryByText("From the video by ReSpOnSe")).toBeNull();
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
      `Protoss win rate against it: ${pct} Your race is favoured`,
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
    expect(md.title).toEqual({
      absolute: "Old Sun Temple — best openers by matchup from 2,418 ladder games (12 workers) | SC2 Tools",
    });
    expect(md.alternates?.canonical).toBe("/guides/maps/old-sun-temple");
  });

  it("enlarges the map and offers ordered neighbors without repeating the current map", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP));
    const maps = [
      { map: "First Map", slug: "first-map", games: 3000 },
      { map: FIXTURE_MAP.map, slug: FIXTURE_MAP.mapSlug, games: FIXTURE_MAP.games },
      { map: "Next Map", slug: "next-map", games: 1800 },
    ];
    mocks.fetchGuideIndex.mockResolvedValue(ok({ ...FIXTURE_INDEX, maps }));
    render(await MapGuidePage(MAP_PARAMS));
    const other = document.getElementById("other-maps")!;
    expect(within(other).queryByRole("link", { name: /Old Sun Temple/ })).toBeNull();
    expect(within(other).getByRole("link", { name: "Previous map: First Map" }).getAttribute("href")).toBe("/guides/maps/first-map");
    expect(within(other).getByRole("link", { name: "Next map: Next Map" }).getAttribute("href")).toBe("/guides/maps/next-map");
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enlarge map: Old Sun Temple" }));
    expect(await screen.findByRole("dialog", { name: "Old Sun Temple map preview" })).toBeTruthy();
  });

  it("keeps the map usable when its optional index fails and ranks opener cards in matrix order", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP));
    mocks.fetchGuideIndex.mockRejectedValue(new Error("index outage"));
    const { container } = render(await MapGuidePage(MAP_PARAMS));
    expect(screen.getByRole("table", { name: "Win rate by matchup on this map" })).toBeTruthy();
    expect(container.querySelector("#other-maps")).toBeNull();
    const section = document.getElementById("best-openers")!;
    expect(within(section).getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["PvZ", "TvZ", "ZvP"]);
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
  });

  it("renders the race matrix and best openers per matchup", async () => {
    mocks.fetchGuideMap.mockResolvedValue(ok(FIXTURE_MAP));
    mocks.fetchGuideIndex.mockResolvedValue(ok(FIXTURE_INDEX));
    const { container } = render(await MapGuidePage(MAP_PARAMS));
    expect(screen.getByRole("heading", { level: 1, name: "Old Sun Temple" })).toBeTruthy();
    expect(container.querySelector("[data-map-artwork]")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Win rate by matchup on this map" });
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Protoss", "Terran", "Zerg"]);
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["vs Protoss", "vs Terran", "vs Zerg"]);
    const pvz = FIXTURE_MAP.matchups[0];
    expect(within(table).getByRole("rowheader", { name: "Protoss" }).closest("tr")?.textContent).toContain(
      `${(pvz.winRate * 100).toFixed(1)}%`,
    );
    const mirror = within(table).getAllByRole("row")[1].querySelectorAll("td")[0];
    expect(mirror.textContent).toContain("208 gamesmirror");
    expect(mirror.textContent).not.toContain("%");
    expect(mirror.textContent).not.toMatch(/[▲●▼]/);
    expect(within(table).getAllByText("Not enough games").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-guide-stats-legend]")).toHaveLength(1);
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

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
