import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_ALERT_MEDIA_GRANT,
  getAlertMediaGrant,
  setAlertMediaGrant,
} from "../mediaBase";
import { useOverlayAlertMediaGrant } from "../useAlertMediaGrant";

vi.mock("../../clientApi", () => ({ API_BASE: "https://api.example.test" }));

const MEDIA_PATH = "/alerts/sc2-3d/marine-skyfire-3d.webm";
const payload = {
  urls: { [MEDIA_PATH]: "https://media.example.test/fresh.webm" },
  expiresIn: 300,
};

function response(status: number, body: unknown = payload): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useOverlayAlertMediaGrant", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setAlertMediaGrant(EMPTY_ALERT_MEDIA_GRANT);
  });

  afterEach(() => {
    cleanup();
    setAlertMediaGrant(EMPTY_ALERT_MEDIA_GRANT);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("recovers from a 503 without reloading the OBS source", async () => {
    fetchMock.mockResolvedValueOnce(response(503)).mockResolvedValue(response(200));
    renderHook(() => useOverlayAlertMediaGrant("overlay-token"));
    await act(async () => {});

    expect(getAlertMediaGrant()).toBe(EMPTY_ALERT_MEDIA_GRANT);
    await act(() => vi.advanceTimersByTimeAsync(59_999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAlertMediaGrant().urls).toEqual(payload.urls);
    // A successful refresh restores the normal expiry-based fetch cadence.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an existing grant during a temporary storage outage", async () => {
    const current = {
      urls: { [MEDIA_PATH]: "https://media.example.test/current.webm" },
      expiresAt: Date.now() + 20_000,
    };
    setAlertMediaGrant(current);
    fetchMock.mockResolvedValueOnce(response(503)).mockResolvedValue(response(200));
    renderHook(() => useOverlayAlertMediaGrant("overlay-token"));
    await act(async () => {});

    expect(getAlertMediaGrant()).toBe(current);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(getAlertMediaGrant().urls).toEqual(payload.urls);
  });

  it("clears the grant and stops permanently when access is denied", async () => {
    setAlertMediaGrant({ urls: payload.urls, expiresAt: Date.now() + 20_000 });
    fetchMock.mockResolvedValue(response(403));
    renderHook(() => useOverlayAlertMediaGrant("overlay-token"));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));

    expect(getAlertMediaGrant()).toBe(EMPTY_ALERT_MEDIA_GRANT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries network failures at the same bounded cadence", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(response(200));
    renderHook(() => useOverlayAlertMediaGrant("overlay-token"));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAlertMediaGrant().urls).toEqual(payload.urls);
  });

  it("cancels a scheduled retry when the source unmounts", async () => {
    fetchMock.mockResolvedValue(response(503));
    const { unmount } = renderHook(() => useOverlayAlertMediaGrant("overlay-token"));
    await act(async () => {});
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an old token's late denial clear the new token's grant", async () => {
    const oldResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldResponse.promise).mockResolvedValue(response(200));
    const { rerender } = renderHook(
      ({ token }) => useOverlayAlertMediaGrant(token),
      { initialProps: { token: "old-token" } },
    );
    const oldSignal = fetchMock.mock.calls[0][1]?.signal;
    rerender({ token: "new-token" });
    await act(async () => {});
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => { oldResponse.resolve(response(403)); });
    expect(getAlertMediaGrant().urls).toEqual(payload.urls);
  });

  it("does not publish a grant after cleanup while its response body is pending", async () => {
    const body = deferred<unknown>();
    fetchMock.mockResolvedValue({ ...response(200), json: () => body.promise });
    const { unmount } = renderHook(() => useOverlayAlertMediaGrant("overlay-token"));
    await act(async () => {});
    const signal = fetchMock.mock.calls[0][1]?.signal;
    unmount();
    await act(async () => { body.resolve(payload); });

    expect(signal?.aborted).toBe(true);
    expect(getAlertMediaGrant()).toBe(EMPTY_ALERT_MEDIA_GRANT);
    expect(vi.getTimerCount()).toBe(0);
  });
});
