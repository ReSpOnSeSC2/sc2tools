import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../events";
import {
  applyRaidViewerBoosts,
  raidPartySize,
  RAID_VIEWER_BOOST_MS,
  useViewerCounts,
} from "../useViewerCounts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function viewerResponse(
  viewers: number,
  platform: "twitch" | "kick" = "twitch",
  observedAtMs?: number,
) {
  return {
    ok: true,
    json: async () => ({
      platforms: [{
        platform,
        viewers,
        live: true,
        ...(observedAtMs === undefined ? {} : { observedAtMs }),
      }],
      total: viewers,
      partial: false,
    }),
  } as Response;
}

function raidEvent(
  overrides: Partial<ChatEvent> & Pick<ChatEvent, "id" | "platform">,
): ChatEvent {
  return {
    kind: "raid",
    user: "RaidLeader",
    detail: "raiding with 42 viewers",
    amount: "42",
    atMs: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  // jsdom starts as "prerender"; the real dock is visible when it
  // mounts, so make that browser state explicit for these hook tests.
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useViewerCounts", () => {
  it("does not let an older slow response replace a newer lower count", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useViewerCounts("dock-token"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(viewerResponse(12));
      await second.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.total).toBe(12));

    await act(async () => {
      first.resolve(viewerResponse(640));
      await first.promise;
      await Promise.resolve();
    });
    expect(result.current.total).toBe(12);
  });

  it("clears the previous token's audience while the new one loads", async () => {
    const next = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(viewerResponse(50))
      .mockReturnValueOnce(next.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ token }) => useViewerCounts(token),
      { initialProps: { token: "first-token" } },
    );
    await waitFor(() => expect(result.current.total).toBe(50));

    rerender({ token: "second-token" });
    await waitFor(() => expect(result.current.loaded).toBe(false));
    expect(result.current.total).toBe(0);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("second-token");

    await act(async () => {
      next.resolve(viewerResponse(8));
      await next.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.total).toBe(8));
  });

  it("immediately adds one Twitch raid party, dedupes its id, and does not fetch-loop", async () => {
    const fetchMock = vi.fn().mockResolvedValue(viewerResponse(100));
    vi.stubGlobal("fetch", fetchMock);
    const nowMs = Date.now();
    const raid = raidEvent({ id: "tw-raid-1", platform: "twitch", atMs: nowMs });

    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await waitFor(() => expect(result.current.total).toBe(100));

    rerender({ events: [raid] });
    await waitFor(() => expect(result.current.total).toBe(142));
    expect(result.current.platforms[0]).toMatchObject({
      platform: "twitch",
      viewers: 142,
      raidAdjusted: true,
    });
    expect(result.current.settlingRaid).toBe(true);
    // Initial poll + one event-driven refresh.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // A reconnect/rerender can deliver the same normalized event again. Its
    // stable platform:id identity must neither add 42 again nor start polling.
    rerender({ events: [{ ...raid }] });
    await act(async () => Promise.resolve());
    expect(result.current.total).toBe(142);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the whole raid when it arrives before the first viewer snapshot", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const raidAtMs = Date.now();
    const raid = raidEvent({
      id: "opening-raid",
      platform: "twitch",
      atMs: raidAtMs,
    });

    const { result } = renderHook(() => useViewerCounts("dock-token", [raid]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Before a base count exists, the party is still a truthful minimum.
    await waitFor(() => expect(result.current.total).toBe(42));

    await act(async () => {
      // Both requests can legitimately receive the same pre-raid server cache.
      first.resolve(viewerResponse(100, "twitch", raidAtMs - 1));
      second.resolve(viewerResponse(100, "twitch", raidAtMs - 1));
      await Promise.all([first.promise, second.promise]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.total).toBe(142));
    expect(result.current.platforms[0].raidAdjusted).toBe(true);
  });

  it("keeps a raid when the first in-flight snapshot completes after it", async () => {
    const first = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise);
    vi.stubGlobal("fetch", fetchMock);
    const raidAtMs = Date.now();
    const raid = raidEvent({
      id: "inflight-opening-raid",
      platform: "twitch",
      atMs: raidAtMs,
    });

    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Model a dock becoming hidden while its boot request is still in flight.
    // The raid is accepted, but its immediate event-driven refresh is skipped,
    // so the original request remains the one whose response updates state.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    rerender({ events: [raid] });
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.total).toBe(42);

    await act(async () => {
      // Completion-time metadata is after the raid, but the upstream number
      // can still be the pre-raid count while the platform catches up.
      first.resolve(viewerResponse(100, "twitch", raidAtMs + 100));
      await first.promise;
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.total).toBe(142));
    expect(result.current.settlingRaid).toBe(true);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  it("does not add a party twice when a post-raid snapshot already includes it", async () => {
    const raidAtMs = Date.now();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(viewerResponse(100, "twitch", raidAtMs - 1_000))
      .mockResolvedValueOnce(viewerResponse(142, "twitch", raidAtMs + 10))
      .mockResolvedValueOnce(viewerResponse(142, "twitch", raidAtMs + 10));
    vi.stubGlobal("fetch", fetchMock);
    const raid = raidEvent({
      id: "already-counted",
      platform: "twitch",
      atMs: raidAtMs,
    });

    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await waitFor(() => expect(result.current.total).toBe(100));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.total).toBe(142));

    // The event reaches React after the newer platform observation. The prior
    // sample proves the 42-viewer rise already happened, so no 184 spike.
    rerender({ events: [raid] });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(result.current.total).toBe(142);
    expect(result.current.settlingRaid).toBeUndefined();
  });

  it("does not double-count two raids delivered after one snapshot includes both", async () => {
    const firstRaidAtMs = Date.now();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        viewerResponse(100, "twitch", firstRaidAtMs - 1_000),
      )
      .mockResolvedValueOnce(
        viewerResponse(192, "twitch", firstRaidAtMs + 100),
      )
      .mockResolvedValueOnce(
        viewerResponse(192, "twitch", firstRaidAtMs + 100),
      );
    vi.stubGlobal("fetch", fetchMock);
    const first = raidEvent({
      id: "already-counted-a",
      platform: "twitch",
      amount: "42",
      atMs: firstRaidAtMs,
    });
    const second = raidEvent({
      id: "already-counted-b",
      platform: "twitch",
      amount: "50",
      atMs: firstRaidAtMs + 1,
    });

    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await waitFor(() => expect(result.current.total).toBe(100));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.total).toBe(192));

    rerender({ events: [first, second] });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(result.current.total).toBe(192);
    expect(result.current.settlingRaid).toBeUndefined();
  });

  it("expires staggered raid parties independently", async () => {
    vi.useFakeTimers();
    const startMs = 1_000_000;
    vi.setSystemTime(startMs);
    const fetchMock = vi.fn().mockResolvedValue(viewerResponse(100));
    vi.stubGlobal("fetch", fetchMock);
    const first = raidEvent({
      id: "staggered-first",
      platform: "twitch",
      amount: "50",
      atMs: startMs,
    });
    const second = raidEvent({
      id: "staggered-second",
      platform: "twitch",
      amount: "10",
      atMs: startMs + 80_000,
    });

    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.total).toBe(100);

    rerender({ events: [first] });
    await act(async () => Promise.resolve());
    expect(result.current.total).toBe(150);

    await act(async () => {
      vi.advanceTimersByTime(80_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender({ events: [first, second] });
    await act(async () => Promise.resolve());
    expect(result.current.total).toBe(160);

    // The second raid must not move the first raid's deadline. The combined
    // floor remains until just before the first event's own 90-second expiry.
    await act(async () => {
      vi.advanceTimersByTime(9_999);
      await Promise.resolve();
    });
    expect(result.current.total).toBe(160);

    await act(async () => {
      vi.advanceTimersByTime(2);
      await Promise.resolve();
    });
    expect(result.current.total).toBe(110);
    expect(result.current.platforms[0]).toMatchObject({
      viewers: 110,
      raidAdjusted: true,
    });

    // The remaining ten-viewer party keeps its original, later deadline too.
    await act(async () => {
      vi.advanceTimersByTime(79_998);
      await Promise.resolve();
    });
    expect(result.current.total).toBe(110);

    await act(async () => {
      vi.advanceTimersByTime(2);
      await Promise.resolve();
    });
    expect(result.current.total).toBe(100);
    expect(result.current.settlingRaid).toBeUndefined();
  });

  it("covers Kick StreamHostEvent raids and reconciles to later official counts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(viewerResponse(100, "kick"))
      .mockResolvedValueOnce(viewerResponse(100, "kick"))
      .mockResolvedValueOnce(viewerResponse(142, "kick"))
      .mockResolvedValueOnce(viewerResponse(90, "kick"));
    vi.stubGlobal("fetch", fetchMock);
    const host = raidEvent({
      id: "kick-host-1",
      platform: "kick",
      amount: "42",
      detail: "raiding with 42 viewers",
    });

    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await waitFor(() => expect(result.current.total).toBe(100));
    rerender({ events: [host] });
    await waitFor(() => expect(result.current.total).toBe(142));

    // A later official snapshot reaches the raid floor. Removing the boost is
    // visually seamless, and a subsequent decline proves it was not retained
    // or added on top of an already-counted party.
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.settlingRaid).toBeUndefined());
    expect(result.current.total).toBe(142);

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(result.current.total).toBe(90));
  });

  it("ignores stale, replayed, zero-size, and malformed raid events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(viewerResponse(25));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ events }) => useViewerCounts("dock-token", events),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    await waitFor(() => expect(result.current.total).toBe(25));
    rerender({
      events: [
        raidEvent({
          id: "stale",
          platform: "twitch",
          atMs: Date.now() - 31_000,
        }),
        raidEvent({ id: "replayed", platform: "kick", replayed: true }),
        raidEvent({ id: "zero", platform: "twitch", amount: "0" }),
        raidEvent({ id: "junk", platform: "kick", amount: "everyone" }),
      ],
    });
    await act(async () => Promise.resolve());
    expect(result.current.total).toBe(25);
    expect(result.current.settlingRaid).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("raid viewer reconciliation helpers", () => {
  it("reads both normalized Twitch/Kick amounts and a legacy host detail", () => {
    expect(raidPartySize(raidEvent({ id: "tw", platform: "twitch" }))).toBe(42);
    expect(
      raidPartySize(
        raidEvent({
          id: "kick",
          platform: "kick",
          amount: undefined,
          detail: "hosting with 1,204 viewers",
        }),
      ),
    ).toBe(1204);
  });

  it("uses a floor instead of re-adding a party and always expires", () => {
    const nowMs = 1_000_000;
    const base = {
      platforms: [{ platform: "twitch" as const, viewers: 100, live: true }],
      total: 100,
      partial: false,
      loaded: true,
    };
    const boosts = {
      twitch: { floor: 142, expiresAtMs: nowMs + RAID_VIEWER_BOOST_MS },
    };
    expect(applyRaidViewerBoosts(base, boosts, nowMs).total).toBe(142);
    expect(
      applyRaidViewerBoosts(
        { ...base, platforms: [{ ...base.platforms[0], viewers: 150 }], total: 150 },
        boosts,
        nowMs,
      ).total,
    ).toBe(150);
    expect(
      applyRaidViewerBoosts(base, boosts, nowMs + RAID_VIEWER_BOOST_MS).total,
    ).toBe(100);
  });
});
