import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSegmentFixture } from "@/lib/__tests__/segmentedPlayback.fixture";

const auth = vi.hoisted(() => ({ userId: "admin", getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://local-api" }));
vi.mock("../ReplayStage", () => ({ ReplayStage: ({ playbackWindow, onPlaybackTimeChange, buffering }: {
  playbackWindow: { start: number; end: number }; onPlaybackTimeChange: (n: number) => void; buffering: boolean;
}) => <div data-testid="host" data-start={playbackWindow.start} data-buffering={buffering}>
  {[0, 60, 120, 180].map(time => <button key={time} onClick={() => onPlaybackTimeChange(time)}>Seek {time}</button>)}
</div> }));
vi.mock("../CompactReplayHost", () => ({ CompactReplayHost: () => <div data-testid="compact-host" /> }));
import { SegmentedReplayHost } from "../SegmentedReplayHost";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); auth.userId = "admin"; auth.getToken.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("lazy playback segment host", () => {
  it("fetches only the requested window, caches three, and fetches an evicted window again", async () => {
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
    expect(fetcher).toHaveBeenCalledTimes(5);
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
