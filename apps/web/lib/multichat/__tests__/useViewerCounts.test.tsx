import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerCounts } from "../useViewerCounts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function viewerResponse(viewers: number) {
  return {
    ok: true,
    json: async () => ({
      platforms: [{ platform: "twitch", viewers, live: true }],
      total: viewers,
      partial: false,
    }),
  } as Response;
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
});
