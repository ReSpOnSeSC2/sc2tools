import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchGuideVideos: vi.fn() }));

vi.mock("@/lib/guides/api", () => ({ fetchGuideVideos: mocks.fetchGuideVideos }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: (path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  },
}));

import GuideVideosPage, { dynamic, generateMetadata } from "@/app/guides/videos/page";
import { asEightWorkerPatch, FIXTURE_INDEX } from "@/lib/guides/__fixtures__";
import type { GuideVideo, GuideVideosPayload } from "@/lib/guides/types";

function libraryVideos(count: number): GuideVideo[] {
  return Array.from({ length: count }, (_, index) => {
    const youtubeId = `library-${String(index).padStart(3, "0")}`;
    return {
      ...FIXTURE_INDEX.videos[0],
      youtubeId,
      title: `Library build order ${index + 1}`,
      url: `https://www.youtube.com/watch?v=${youtubeId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
    };
  });
}

function payload(overrides: Partial<GuideVideosPayload> = {}): GuideVideosPayload {
  return {
    videos: libraryVideos(17),
    eightWorkerVideos: FIXTURE_INDEX.eightWorkerVideos ?? [],
    channel: FIXTURE_INDEX.channel,
    playlists: FIXTURE_INDEX.playlists ?? null,
    ...overrides,
  };
}

function ok(data: GuideVideosPayload) {
  return { kind: "ok" as const, data };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1"));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideVideos.mockReset();
});

describe("/guides/videos", () => {
  it("renders per request and gives the full library its own canonical metadata", async () => {
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload()));
    expect(dynamic).toBe("force-dynamic");
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("StarCraft II build order videos | SC2 Tools");
    expect(metadata.alternates?.canonical).toBe("/guides/videos");
    expect(metadata.description).toContain("all build order videos");
    expect(metadata.robots).toBeUndefined();
  });

  it("shows every video beyond both the eight-card preview and twelve-video limit", async () => {
    const data = payload();
    mocks.fetchGuideVideos.mockResolvedValue(ok(data));
    const { container } = render(await GuideVideosPage());
    expect(screen.getByRole("heading", { level: 1, name: "All build order videos" })).toBeTruthy();
    expect(screen.getByText("17 videos for the 12-worker game, newest first.")).toBeTruthy();
    const section = screen.getByRole("heading", { name: "12-worker build order videos" })
      .closest("section") as HTMLElement;
    const grid = within(section).getByRole("list");
    expect(within(grid).getAllByRole("listitem")).toHaveLength(17);
    expect(grid.classList.contains("lg:grid-cols-4")).toBe(true);
    expect(within(grid).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      data.videos.map((video) => video.url),
    );
    expect(within(section).getByRole("link", { name: /Library build order 17 / })).toBeTruthy();
    expect(within(section).getByRole("link", { name: /Subscribe on YouTube/ }).getAttribute("href")).toBe(
      data.channel?.url,
    );
    expect(within(section).getByRole("link", { name: /Watch the playlist/ }).getAttribute("href")).toBe(
      data.playlists?.twelveWorker,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: "Guides" }).getAttribute("href")).toBe("/guides");
  });

  it("keeps the complete 8-worker archive separate and collapsed", async () => {
    const archive = libraryVideos(15).map((video) => asEightWorkerPatch({
      ...video,
      title: `8-worker ${video.title}`,
    }));
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ eightWorkerVideos: archive })));
    const { container } = render(await GuideVideosPage());
    const section = container.querySelector("#eight-worker-videos") as HTMLElement;
    const details = section.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("8-worker patch videos (15)");
    expect(details.querySelectorAll("li")).toHaveLength(15);
    expect(Array.from(details.querySelectorAll("li a")).map((link) => link.getAttribute("href"))).toEqual(
      archive.map((video) => video.url),
    );
    expect(details.querySelector("img")).toBeNull();
    expect(container.querySelector("#channel")?.textContent).not.toContain(archive[0].title);
  });

  it("shows an empty state with channel actions and noindexes an empty library", async () => {
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos: [], eightWorkerVideos: [] })));
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
    const { container } = render(await GuideVideosPage());
    expect(screen.getByText("No 12-worker build order videos yet. Check back for new videos.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Subscribe on YouTube/ })).toBeTruthy();
    expect(container.querySelector("#eight-worker-videos")).toBeNull();
  });

  it("keeps an archive-only library indexable", async () => {
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos: [] })));
    expect((await generateMetadata()).robots).toBeUndefined();
  });

  it("uses the unavailable state and noindex metadata during an API outage", async () => {
    mocks.fetchGuideVideos.mockResolvedValue({ kind: "unavailable" });
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates?.canonical).toBe("/guides/videos");
    render(await GuideVideosPage());
    expect(screen.getByText("Build order videos are temporarily unavailable")).toBeTruthy();
  });

  it("404s with the guides flag off before fetching", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "0");
    await expect(generateMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(GuideVideosPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.fetchGuideVideos).not.toHaveBeenCalled();
  });

  it("404s a missing library and redirects a moved library consistently", async () => {
    mocks.fetchGuideVideos.mockResolvedValue({ kind: "not_found" });
    await expect(generateMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(GuideVideosPage()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.fetchGuideVideos.mockResolvedValue({ kind: "moved", path: "/guides" });
    await expect(generateMetadata()).rejects.toMatchObject({ path: "/guides" });
    await expect(GuideVideosPage()).rejects.toMatchObject({ path: "/guides" });
  });
});
