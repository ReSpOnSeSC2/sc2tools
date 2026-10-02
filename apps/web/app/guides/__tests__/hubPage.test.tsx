import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchGuideIndex: vi.fn() }));

vi.mock("@/lib/guides/api", () => ({ fetchGuideIndex: mocks.fetchGuideIndex }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import GuidesHubPage, { dynamic as hubDynamic, generateMetadata as hubMetadata } from "@/app/guides/page";
import MapGuidesPage, { dynamic as mapsDynamic, generateMetadata as mapsMetadata } from "@/app/guides/maps/page";
import { FIXTURE_INDEX } from "@/lib/guides/__fixtures__";
import type { GuideIndexPayload } from "@/lib/guides/types";

function ok(data: GuideIndexPayload) {
  return { kind: "ok" as const, data };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "true"));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideIndex.mockReset();
});

describe("param-less guide routes", () => {
  it("render per request so a build without the API never freezes the outage page", () => {
    // Their API reads stay cached via the fetch's next.revalidate + "guides" tag.
    expect(hubDynamic).toBe("force-dynamic");
    expect(mapsDynamic).toBe("force-dynamic");
  });
});

describe("/guides hub", () => {
  it("titles the hub with the real number of published openers", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok(FIXTURE_INDEX));
    const md = await hubMetadata();
    // publishedBuilds: PvT 2 + PvZ 4 + TvZ 1 + ZvP 2 = 9.
    expect(md.title).toBe(
      "StarCraft II build order guides — 9 openers ranked by real ladder win rate (12 workers) | SC2 Tools",
    );
    expect(md.alternates?.canonical).toBe("/guides");
    expect(md.robots).toBeUndefined();
    expect(String(md.description)).toContain("Sep 27, 2026");
  });

  it("renders the 3×3 grid with this week's top openers, arrows and links", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok(FIXTURE_INDEX));
    render(await GuidesHubPage());
    expect(screen.getByRole("heading", { level: 1, name: "What's winning on the SC2 ladder" })).toBeTruthy();
    for (const race of ["Playing Protoss", "Playing Terran", "Playing Zerg"]) {
      expect(screen.getByRole("region", { name: race })).toBeTruthy();
    }
    const protoss = screen.getByRole("region", { name: "Playing Protoss" });
    const tiles = within(protoss).getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(tiles).toEqual(["PvP", "PvT", "PvZ"]);
    expect(within(protoss).getByText("6,840 games")).toBeTruthy();
    const top = FIXTURE_INDEX.matchups.find((row) => row.matchup === "PvZ")?.top ?? [];
    expect(top).toHaveLength(3);
    for (const build of top) {
      expect(screen.getByRole("link", { name: build.name }).getAttribute("href")).toBe(
        `/guides/pvz/${build.buildSlug}`,
      );
    }
    expect(screen.getAllByText("Not enough games yet.").length).toBeGreaterThan(0);
    expect(document.querySelector('[data-trend="down"]')).toBeTruthy();
  });

  it("shows the 12-worker videos with playlist and subscribe links, and the maps link", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok(FIXTURE_INDEX));
    const { container } = render(await GuidesHubPage());
    const row = screen.getByRole("heading", { level: 2, name: "12-worker build order videos" })
      .closest("section") as HTMLElement;
    expect(within(row).getByRole("link", { name: /Subscribe on YouTube/ }).getAttribute("href")).toBe(
      "https://www.youtube.com/@ReSpOnSeSC2",
    );
    expect(within(row).getByRole("link", { name: /Watch the playlist/ }).getAttribute("href")).toBe(
      FIXTURE_INDEX.playlists?.twelveWorker,
    );
    expect(within(row).getByRole("link", { name: /PvZ Carrier Rush/ }).getAttribute("href")).toBe(
      "https://www.youtube.com/watch?v=RYjRs_no8t4",
    );
    // 8-worker patch videos are not in the prominent row.
    expect(within(row).queryByRole("link", { name: /PvZ Cracking 8 Pools/ })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: /Browse map guides/ }).getAttribute("href")).toBe("/guides/maps");
  });

  it("lists the 8-worker patch videos last, collapsed, as plain links to YouTube", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok(FIXTURE_INDEX));
    const { container } = render(await GuidesHubPage());
    const section = container.querySelector("#eight-worker-videos") as HTMLElement;
    const sectionIds = Array.from(container.querySelectorAll("section[id]")).map((el) => el.id);
    expect(sectionIds).toEqual(["matchups", "channel", "maps", "eight-worker-videos"]);
    const details = section.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("8-worker patch videos (2)");
    expect(details.textContent).toContain("Recorded on patch 5.0.16, when games started with 8 workers.");
    expect(details.querySelector("img")).toBeNull();
    const links = Array.from(details.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "https://www.youtube.com/watch?v=YcTMc_Ee11w",
      "https://www.youtube.com/watch?v=A4x6gR7J-AY",
      FIXTURE_INDEX.playlists?.eightWorker,
    ]);
  });

  it("keeps the 12-worker section, with its links, while the channel has no 12-worker video yet", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok({ ...FIXTURE_INDEX, videos: [] }));
    render(await GuidesHubPage());
    const row = screen.getByRole("heading", { level: 2, name: "12-worker build order videos" })
      .closest("section") as HTMLElement;
    expect(row.textContent).toContain("Build order videos for the 12-worker game are on the way.");
    expect(within(row).getByRole("link", { name: /Subscribe on YouTube/ })).toBeTruthy();
    expect(within(row).getByRole("link", { name: /Watch the playlist/ })).toBeTruthy();
  });

  it("renders no video section without videos or a channel, and none of the new ones for an older API", async () => {
    const { eightWorkerVideos: _eight, playlists: _playlists, ...older } = FIXTURE_INDEX;
    mocks.fetchGuideIndex.mockResolvedValue(ok(older));
    const first = render(await GuidesHubPage());
    expect(screen.getByRole("heading", { level: 2, name: "12-worker build order videos" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Watch the playlist/ })).toBeNull();
    expect(first.container.querySelector("#eight-worker-videos")).toBeNull();
    first.unmount();
    mocks.fetchGuideIndex.mockResolvedValue(ok({ ...older, videos: [], channel: null }));
    render(await GuidesHubPage());
    expect(screen.queryByRole("heading", { level: 2, name: "12-worker build order videos" })).toBeNull();
  });

  it("404s when the flag is off and degrades when the API is down", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "0");
    await expect(hubMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(GuidesHubPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.fetchGuideIndex).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
    mocks.fetchGuideIndex.mockResolvedValue({ kind: "unavailable" });
    expect((await hubMetadata()).robots).toEqual({ index: false, follow: false });
    render(await GuidesHubPage());
    expect(screen.getByText("Build guides are temporarily unavailable")).toBeTruthy();
    mocks.fetchGuideIndex.mockResolvedValue({ kind: "not_found" });
    await expect(hubMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/guides/maps", () => {
  it("lists published maps with their game counts", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok(FIXTURE_INDEX));
    const md = await mapsMetadata();
    expect(md.title).toBe(
      "SC2 ladder map guides — 3 maps with openers ranked by win rate (12 workers) | SC2 Tools",
    );
    expect(md.alternates?.canonical).toBe("/guides/maps");
    render(await MapGuidesPage());
    const link = screen.getByRole("link", { name: /Old Sun Temple/ });
    expect(link.getAttribute("href")).toBe("/guides/maps/old-sun-temple");
    expect(link.textContent).toContain("2,418 games");
  });

  it("is noindex with an empty state when no map is published", async () => {
    mocks.fetchGuideIndex.mockResolvedValue(ok({ ...FIXTURE_INDEX, maps: [] }));
    expect((await mapsMetadata()).robots).toMatchObject({ index: false });
    render(await MapGuidesPage());
    expect(screen.getByText("No map guides yet")).toBeTruthy();
  });
});
