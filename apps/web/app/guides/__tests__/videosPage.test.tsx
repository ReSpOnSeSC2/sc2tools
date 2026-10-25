import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchGuideVideos: vi.fn(), replace: vi.fn(), query: "" }));

vi.mock("@/lib/guides/api", () => ({ fetchGuideVideos: mocks.fetchGuideVideos }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: mocks.replace }),
  usePathname: () => "/guides/videos",
  useSearchParams: () => new URLSearchParams(mocks.query),
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

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1"); mocks.query = ""; mocks.replace.mockClear(); });
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
    expect(metadata.title).toEqual({ absolute: "StarCraft II build order videos | SC2 Tools" });
    expect(metadata.alternates?.canonical).toBe("/guides/videos");
    expect(metadata.description).toContain("all build order videos");
    expect(metadata.robots).toBeUndefined();
  });

  it("shows every video beyond both the eight-card preview and twelve-video limit", async () => {
    const data = payload();
    mocks.fetchGuideVideos.mockResolvedValue(ok(data));
    const { container } = render(await GuideVideosPage({}));
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
    const { container } = render(await GuideVideosPage({}));
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

  it("counts only nonempty matchup chips, filters them and preserves other URL parameters", async () => {
    mocks.query = "source=channel";
    const videos = libraryVideos(4).map((video, index) => ({ ...video, matchup: index < 2 ? "PvZ" as const : index === 2 ? "TvP" as const : null }));
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos })));
    render(await GuideVideosPage({}));
    const chips = screen.getByRole("group", { name: "Filter videos by matchup" });
    expect(within(chips).getAllByRole("button").map((button) => button.textContent)).toEqual(["All (4)", "PvZ (2)", "TvP (1)", "Other (1)"]);
    fireEvent.click(within(chips).getByRole("button", { name: "PvZ (2)" }));
    expect(screen.getByRole("status").textContent).toBe("2 videos found.");
    expect(screen.queryByRole("link", { name: /Library build order 3 / })).toBeNull();
    expect(mocks.replace).toHaveBeenLastCalledWith("/guides/videos?source=channel&matchup=pvz", { scroll: false });
    fireEvent.click(within(chips).getByRole("button", { name: "Other (1)" }));
    expect(screen.getByRole("link", { name: /Library build order 4 / })).toBeTruthy();
    fireEvent.click(within(chips).getByRole("button", { name: "All (4)" }));
    expect(mocks.replace).toHaveBeenLastCalledWith("/guides/videos?source=channel", { scroll: false });
  });

  it("renders a shared matchup link filtered on the server, while JSON-LD includes the complete library", async () => {
    const videos = libraryVideos(30).map((video, index) => ({ ...video, matchup: index === 29 ? "PvZ" as const : "TvP" as const }));
    mocks.query = "matchup=pvz";
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos, eightWorkerVideos: [] })));
    const page = await GuideVideosPage({ searchParams: Promise.resolve({ matchup: "pvz" }) });
    const html = renderToString(page);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll("[data-guide-video-watch]")).toHaveLength(1);
    expect(dom.querySelector("[data-guide-video-watch]")?.textContent).toContain("Library build order 30");
    const structured = JSON.parse(dom.querySelector('[type="application/ld+json"]')?.textContent ?? "[]");
    expect(structured.filter((item: { "@type": string }) => item["@type"] === "VideoObject")).toHaveLength(30);
    render(page);
    expect(screen.getByRole("button", { name: "PvZ (1)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("searches titles without case or diacritics, clears empty results and retains older-API paging", async () => {
    const videos = libraryVideos(50);
    videos[49] = { ...videos[49], title: "ÉCONOMIE — Glaïves" };
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos, eightWorkerVideos: [] })));
    const { container } = render(await GuideVideosPage({}));
    expect(screen.queryByRole("group", { name: "Filter videos by matchup" })).toBeNull();
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "Show more (26 left)" }));
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(48);
    expect(document.activeElement).toBe(container.querySelectorAll("[data-guide-video-watch]")[24]);
    const search = screen.getByRole("searchbox", { name: "Search video titles" });
    fireEvent.change(search, { target: { value: "economie" } });
    expect(screen.getByRole("status").textContent).toBe("1 video found.");
    expect(screen.getByRole("link", { name: /ÉCONOMIE/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(24);
    fireEvent.change(search, { target: { value: "no such video" } });
    expect(screen.getByText("No videos match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search).toHaveProperty("value", "");
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(24);
  });

  it("reacts to external matchup navigation and resets the expanded window", async () => {
    const videos = libraryVideos(30).map((video, index) => ({ ...video, matchup: index === 29 ? "TvP" as const : "PvZ" as const }));
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos, eightWorkerVideos: [] })));
    const page = await GuideVideosPage({});
    const { rerender, container } = render(page);
    fireEvent.click(screen.getByRole("button", { name: "Show more (6 left)" }));
    mocks.query = "matchup=tvp";
    rerender(await GuideVideosPage({ searchParams: Promise.resolve({ matchup: "tvp" }) }));
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "TvP (1)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("focuses the first new playable card when an earlier malformed URL was omitted", async () => {
    const videos = libraryVideos(26);
    videos[0] = { ...videos[0], url: "https://example.com/not-youtube" };
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos, eightWorkerVideos: [] })));
    const { container } = render(await GuideVideosPage({}));
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(23);
    fireEvent.click(screen.getByRole("button", { name: "Show more (2 left)" }));
    expect(document.activeElement?.textContent).toContain("Library build order 25");
  });

  it("adds a separate same-tab guide link only for safe matched build metadata", async () => {
    const videos = libraryVideos(5).map((video, index) => ({ ...video, matchup: "PvZ" as const, buildSlug: ["stargate-into-glaives", null, "../admin", "bad?slug", ""][index] }));
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos, eightWorkerVideos: [] })));
    const { container } = render(await GuideVideosPage({}));
    const guideLinks = screen.getAllByRole("link", { name: /Read the guide/ });
    expect(guideLinks).toHaveLength(1);
    expect(guideLinks[0].getAttribute("href")).toBe("/guides/pvz/stargate-into-glaives");
    expect(guideLinks[0].hasAttribute("target")).toBe(false);
    expect(guideLinks[0].closest("a a")).toBeNull();
    expect(container.querySelectorAll("[data-guide-video-watch]")).toHaveLength(5);
  });

  it("shows an empty state with channel actions and noindexes an empty library", async () => {
    mocks.fetchGuideVideos.mockResolvedValue(ok(payload({ videos: [], eightWorkerVideos: [] })));
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
    const { container } = render(await GuideVideosPage({}));
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
    render(await GuideVideosPage({}));
    expect(screen.getByText("Build order videos are temporarily unavailable")).toBeTruthy();
  });

  it("404s with the guides flag off before fetching", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "0");
    await expect(generateMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(GuideVideosPage({})).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.fetchGuideVideos).not.toHaveBeenCalled();
  });

  it("404s a missing library and redirects a moved library consistently", async () => {
    mocks.fetchGuideVideos.mockResolvedValue({ kind: "not_found" });
    await expect(generateMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(GuideVideosPage({})).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.fetchGuideVideos.mockResolvedValue({ kind: "moved", path: "/guides" });
    await expect(generateMetadata()).rejects.toMatchObject({ path: "/guides" });
    await expect(GuideVideosPage({})).rejects.toMatchObject({ path: "/guides" });
  });
});

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
