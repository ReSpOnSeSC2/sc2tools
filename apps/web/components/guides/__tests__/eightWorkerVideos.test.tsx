import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { GuideVideoSection } from "@/components/guides/GuideVideoSection";
import { safePlaylistUrl } from "@/components/guides/youtubeUrls";
import {
  FIXTURE_PLAYLISTS,
  VIDEO_PVZ_CARRIER_RUSH,
  VIDEO_PVZ_CRACKING_8_POOLS,
  VIDEO_PVZ_STARGATE_GLAIVES,
  asEightWorkerPatch,
} from "@/lib/guides/__fixtures__";

afterEach(cleanup);

const EIGHT_WORKER = [VIDEO_PVZ_STARGATE_GLAIVES, VIDEO_PVZ_CRACKING_8_POOLS].map(asEightWorkerPatch);

describe("GuideEightWorkerVideos", () => {
  it("is a collapsed list of plain links, with the count and what the videos are", () => {
    const { container } = render(<GuideEightWorkerVideos videos={EIGHT_WORKER} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary h2")?.textContent).toBe("8-worker patch videos");
    expect(details.querySelector("summary")?.textContent).toBe("8-worker patch videos (2)");
    expect(details.textContent).toContain("Their build orders and timings differ from the 12-worker game.");
    const items = Array.from(details.querySelectorAll("li"));
    expect(items.map((li) => li.querySelector("a")?.getAttribute("href"))).toEqual(EIGHT_WORKER.map((v) => v.url));
    expect(items[0].textContent).toContain("PvZ Stargate into Glaive Adept Timing");
    expect(items[0].textContent).toContain("Aug 29, 2026");
    for (const link of Array.from(details.querySelectorAll("a"))) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    // No thumbnails and no player: the 12-worker videos stay the prominent ones.
    expect(container.querySelector("img, iframe, button")).toBeNull();
  });

  it("takes a title and links the 8-worker playlist only when it is a YouTube playlist URL", () => {
    const { container, rerender } = render(
      <GuideEightWorkerVideos title="PvZ videos from the 8-worker patch" videos={EIGHT_WORKER} playlistUrl={FIXTURE_PLAYLISTS.eightWorker} />,
    );
    expect(container.querySelector("summary h2")?.textContent).toBe("PvZ videos from the 8-worker patch");
    expect(screen.getByRole("link", { name: /8-worker build order playlist on YouTube/, hidden: true }).getAttribute("href"))
      .toBe(FIXTURE_PLAYLISTS.eightWorker);
    rerender(<GuideEightWorkerVideos videos={EIGHT_WORKER} playlistUrl="https://evil.example/playlist?list=PLBBBBBBBBBBBBBBBB" />);
    expect(screen.queryByRole("link", { name: /playlist on YouTube/, hidden: true })).toBeNull();
  });

  it("renders nothing without videos, and drops a video whose URL is not a YouTube watch URL", () => {
    const empty = render(<GuideEightWorkerVideos videos={[]} playlistUrl={FIXTURE_PLAYLISTS.eightWorker} />);
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    const missing = render(<GuideEightWorkerVideos videos={undefined} />);
    expect(missing.container.innerHTML).toBe("");
    missing.unmount();
    const bad = { ...EIGHT_WORKER[0], url: "https://evil.example/watch?v=YcTMc_Ee11w" };
    const { container } = render(<GuideEightWorkerVideos videos={[bad, EIGHT_WORKER[1]]} />);
    expect(container.querySelector("summary")?.textContent).toBe("8-worker patch videos (1)");
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("omits the date of a video without one", () => {
    const { container } = render(<GuideEightWorkerVideos videos={[{ ...EIGHT_WORKER[0], publishedAt: null }]} />);
    expect(container.querySelector("li")?.textContent).not.toContain("·");
  });
});

describe("safePlaylistUrl", () => {
  it("accepts only the canonical youtube.com playlist URL", () => {
    expect(safePlaylistUrl(FIXTURE_PLAYLISTS.twelveWorker)).toBe(FIXTURE_PLAYLISTS.twelveWorker);
    for (const bad of [
      null,
      undefined,
      "",
      "PLAAAAAAAAAAAAAAAA",
      "http://www.youtube.com/playlist?list=PLAAAAAAAAAAAAAAAA",
      "https://youtube.com/playlist?list=PLAAAAAAAAAAAAAAAA",
      "https://www.youtube.com/playlist?list=PLAAAAAAAAAAAAAAAA&si=x",
      "https://www.youtube.com/playlist?list=short",
      "javascript:alert(1)",
    ]) {
      expect(safePlaylistUrl(bad)).toBeNull();
    }
  });
});

describe("8-worker patch videos in the main video blocks", () => {
  it("a pinned 8-worker video is labelled in the video guide and its 'More videos' list", () => {
    render(<GuideVideoSection videos={[asEightWorkerPatch(VIDEO_PVZ_STARGATE_GLAIVES), asEightWorkerPatch(VIDEO_PVZ_CARRIER_RUSH)]} />);
    expect(screen.getByText("Recorded on the 8-worker patch 5.0.16")).toBeTruthy();
    const more = screen.getByRole("link", { name: VIDEO_PVZ_CARRIER_RUSH.title });
    expect(more.parentElement?.textContent).toContain("· 8-worker patch");
  });

  it("12-worker videos carry no label", () => {
    render(<GuideVideoSection videos={[VIDEO_PVZ_STARGATE_GLAIVES, { ...VIDEO_PVZ_CARRIER_RUSH, eightWorkerPatch: false }]} />);
    expect(screen.queryByText(/8-worker patch/)).toBeNull();
  });

  it("a video row shows its empty text only when one is passed", () => {
    const { container, rerender } = render(<GuideVideoRow title="12-worker build order videos" videos={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<GuideVideoRow title="12-worker build order videos" videos={[]} emptyText="On the way." actions={<a href="/x">Subscribe</a>} />);
    expect(screen.getByRole("heading", { level: 2, name: "12-worker build order videos" })).toBeTruthy();
    expect(screen.getByText("On the way.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Subscribe" })).toBeTruthy();
  });
});
