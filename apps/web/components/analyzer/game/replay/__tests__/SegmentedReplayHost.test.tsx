import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSegmentFixture } from "@/lib/__tests__/segmentedPlayback.fixture";
import type { LoadClipSections } from "@/lib/usePlaybackSegments";

const clip = vi.hoisted(() => ({ load: undefined as LoadClipSections | undefined }));

const auth = vi.hoisted(() => ({ userId: "admin", getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://local-api" }));
vi.mock("../ReplayStage", () => ({ ReplayStage: ({ playbackWindow, onPlaybackTimeChange, buffering, castMarkers, loadClipSections }: {
  playbackWindow: { start: number; end: number }; onPlaybackTimeChange: (n: number) => void; buffering: boolean;
  castMarkers?: { t: number }[];
  loadClipSections?: LoadClipSections;
}) => {
  clip.load = loadClipSections;
  return <div data-testid="host" data-start={playbackWindow.start} data-buffering={buffering}>
  {[0, 40, 60, 120, 180].map(time => <button key={time} onClick={() => onPlaybackTimeChange(time)}>Seek {time}</button>)}
  <span data-testid="casts">{castMarkers?.map(marker => marker.t).join(",")}</span>
</div>;
} }));
vi.mock("../CompactReplayHost", () => ({ CompactReplayHost: () => <div data-testid="compact-host" /> }));
import { SegmentedReplayHost } from "../SegmentedReplayHost";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); auth.userId = "admin"; auth.getToken.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("lazy playback segment host", () => {
  it("prefetches ahead of the boundary, switches cached frames without a loading overlay and keeps game-wide cast markers", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    for (let index = 0; index < bytes.length; index++) {
      const raw = JSON.parse(new TextDecoder().decode(bytes[index]));
      raw.playback.casts = [{ a: "PsiStorm", o: 0, t: index * 60 + 20 }];
      bytes[index] = new TextEncoder().encode(JSON.stringify(raw));
      manifest.segments[index].sizeBytes = bytes[index].length;
      manifest.segments[index].sha256 = createHash("sha256").update(bytes[index]).digest("hex");
    }
    const fetcher = vi.fn(async (url: string) => new Response(bytes[Number(url.split("/").pop())]));
    vi.stubGlobal("fetch", fetcher);
    render(<SegmentedReplayHost gameId="prefetch" manifest={manifest} />);
    await screen.findByTestId("host");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Seek 40" }));
    await waitFor(() => expect(screen.getByTestId("casts").textContent).toBe("20,80"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Seek 60" }));
    expect(screen.getByTestId("host").getAttribute("data-start")).toBe("60");
    expect(screen.getByTestId("host").getAttribute("data-buffering")).toBe("false");
    expect(screen.queryByText(/Loading.*replay/)).toBeNull();
    expect(screen.getByTestId("casts").textContent).toBe("20,80");
  });

  it("keeps the mounted frame under a corner status on a miss and aborts an obsolete prefetch on seek", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const index = Number(url.split("/").pop());
      if (index === 1) {
        signals.push(options.signal as AbortSignal);
        return new Promise<Response>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
      return new Response(bytes[index]);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SegmentedReplayHost gameId="slow" manifest={manifest} />);
    const frame = await screen.findByTestId("host");
    fireEvent.click(screen.getByRole("button", { name: "Seek 40" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Seek 60" }));
    expect(frame.isConnected).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Loading next replay section");
    expect(screen.getByRole("status").className).not.toContain("inset-0");
    expect(signals[0].aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Seek 180" }));
    await waitFor(() => expect(frame.getAttribute("data-start")).toBe("180"));
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("loads only authenticated, verified sections that intersect the clip range without changing the replay clock", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    const fetcher = vi.fn(async (url: string, _options: RequestInit) => new Response(bytes[Number(url.split("/").pop())]));
    vi.stubGlobal("fetch", fetcher);
    render(<SegmentedReplayHost gameId="clip" manifest={manifest} clip="owner" />);
    const stage = await screen.findByTestId("host");
    const signal = new AbortController().signal;
    await act(async () => {
      const sections = await clip.load!({ start: 59, end: 120 }, signal).catch(() => null);
      expect(sections).toBeNull(); // Longer than 60 seconds.
      const withinCap = await clip.load!({ start: 59, end: 119 }, signal);
      expect(withinCap.map(({ start, end }) => [start, end])).toEqual([[0, 60], [60, 120]]);
      expect(withinCap.every(section => section.playback.fidelity?.complete)).toBe(true);
    });
    expect(fetcher.mock.calls.map(([url]) => url.split("/").pop())).toEqual(["0", "1"]);
    expect(fetcher.mock.calls[1][1].headers).toEqual({ authorization: "Bearer test-token" });
    expect(stage.getAttribute("data-start")).toBe("0");
  });

  it("retains small decoded windows within the byte budget, including older visited windows", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    const fetcher = vi.fn(async (url: string) => new Response(bytes[Number(url.split("/").pop())]));
    vi.stubGlobal("fetch", fetcher);
    render(<SegmentedReplayHost gameId="g1" manifest={manifest} />);
    await screen.findByTestId("host"); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain(`/artifacts/${manifest.artifactId}/segments/0`);
    for (const time of [60, 120, 180]) {
      fireEvent.click(screen.getByRole("button", { name: `Seek ${time}` }));
      await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe(String(time)));
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Seek 120" }));
    await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe("120"));
    expect(fetcher).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Seek 0" }));
    await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe("0"));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("starts directly at a seek time and resets clock/cache on replay or account changes", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    const fetcher = vi.fn(async (url: string) => new Response(bytes[Number(url.split("/").pop())]));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<SegmentedReplayHost gameId="g1" manifest={manifest} initialTimeSec={130} />);
    await screen.findByTestId("host"); expect(fetcher.mock.calls[0][0]).toContain("/segments/2");
    fireEvent.click(screen.getByRole("button", { name: "Seek 180" }));
    await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe("180"));
    view.rerender(<SegmentedReplayHost gameId="g2" manifest={manifest} initialTimeSec={10} />);
    await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe("0"));
    expect(fetcher.mock.calls.at(-1)![0]).toContain("/games/g2/");
    const priorCount = fetcher.mock.calls.length;
    auth.userId = "other-admin"; view.rerender(<SegmentedReplayHost gameId="g2" manifest={manifest} initialTimeSec={10} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(priorCount + 1));
    await screen.findByTestId("host");
  });
  it("aborts stale downloads and never displays their result after navigation", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    let finish!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementation(async (url: string) => new Response(bytes[Number(url.split("/").pop())]));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<SegmentedReplayHost gameId="g1" manifest={manifest} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<SegmentedReplayHost gameId="g2" manifest={manifest} initialTimeSec={130} />);
    expect(signal.aborted).toBe(true);
    await screen.findByTestId("host");
    await act(async () => finish(new Response(bytes[0])));
    expect(screen.getByTestId("host").getAttribute("data-start")).toBe("120");
  });
  it("shows an explicit retry after integrity failure without fetching other segments", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    const damaged = bytes[0].slice(); damaged[50] ^= 1;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(damaged)).mockResolvedValueOnce(new Response(bytes[0]));
    vi.stubGlobal("fetch", fetcher);
    render(<SegmentedReplayHost gameId="g1" manifest={manifest} />);
    await screen.findByRole("alert"); expect(screen.queryByTestId("host")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await screen.findByTestId("host"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("shared-game segment delivery", () => {
  it("reads a segment from its short-lived storage link, then falls back to the API for the rest of the visit", async () => {
    const { manifest, bytes } = makeSegmentFixture();
    const base = "/v1/shares/AbCdEfGhIjKlMnOp/map-playback/artifacts";
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      const index = Number(/segments\/(\d+)/.exec(url)?.[1] ?? /storage\.test\/(\d+)/.exec(url)?.[1]);
      if (url.endsWith("/link")) return new Response(JSON.stringify({ url: `https://storage.test/${index}.json`, expiresIn: 60 }));
      if (url.startsWith("https://storage.test/")) {
        if (index === 0) return new Response(bytes[0]);
        throw new TypeError("Failed to fetch");
      }
      return new Response(bytes[index]);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SegmentedReplayHost gameId="share" manifest={manifest} anonymous
      segmentPath={(artifactId, index) => `${base}/${artifactId}/segments/${index}`}
      segmentLinkPath={(artifactId, index) => `${base}/${artifactId}/segments/${index}/link`} />);
    await screen.findByTestId("host");
    expect(calls).toEqual([`http://local-api${base}/${manifest.artifactId}/segments/0/link`, "https://storage.test/0.json"]);
    expect(auth.getToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Seek 60" }));
    await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe("60"));
    expect(calls.slice(2, 5)).toEqual([
      `http://local-api${base}/${manifest.artifactId}/segments/1/link`,
      "https://storage.test/1.json",
      `http://local-api${base}/${manifest.artifactId}/segments/1`,
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Seek 120" }));
    await waitFor(() => expect(screen.getByTestId("host").getAttribute("data-start")).toBe("120"));
    expect(calls.filter((url) => url.includes("/segments/2"))).toEqual([`http://local-api${base}/${manifest.artifactId}/segments/2`]);
  });
});
