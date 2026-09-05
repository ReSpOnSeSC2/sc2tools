import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapReplay } from "../useMapReplay";

const harness = vi.hoisted(() => ({
  path: null as string | null,
  interval: 0,
  fullInterval: 0,
  statusData: undefined as Record<string, unknown> | undefined,
  statusMutate: vi.fn(),
  getRequest: vi.fn(),
  api: { data: null as unknown, isLoading: false, error: undefined,
    request: vi.fn(), mutate: vi.fn() },
}));
vi.mock("../clientApi", () => ({ useApi: (path: string | null, config: { refreshInterval: number }) => {
  harness.path = path;
  harness.interval = config.refreshInterval;
  if (path?.endsWith("/status")) return { ...harness.api,
    data: harness.statusData ?? { rebuild: (harness.api.data as { rebuild?: unknown } | null)?.rebuild ?? null },
    mutate: harness.statusMutate };
  harness.fullInterval = config.refreshInterval;
  return { ...harness.api, request: (init: RequestInit) => init.method === "GET"
    ? harness.getRequest(init) : harness.api.request(init) };
} }));

const payload = (positions = "tracker", rebuild?: Record<string, unknown>, complete = true, attacks = "observed") => ({
  v: 6, gameLength: 60, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  units: [{ owner: "me", name: "Probe", born: 0, died: null, wp: [0, 20, 20] }],
  fidelity: { positions, paths: "observed", creep: "estimated", complete, attacks },
  ...(rebuild ? { rebuild } : {}),
});

beforeEach(() => {
  harness.api.data = payload();
  harness.api.request.mockReset().mockResolvedValue({ requestId: "current" });
  harness.api.mutate.mockReset().mockImplementation(async (data) => {
    if (data !== undefined) harness.api.data = data;
    return harness.api.data;
  });
  harness.getRequest.mockReset().mockImplementation(async () => harness.api.data);
  harness.statusMutate.mockReset().mockResolvedValue(undefined);
  harness.statusData = undefined;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("shared map replay recording controller", () => {
  it("polls only lightweight status and downloads the completed record once", async () => {
    harness.api.data = payload("engine");
    harness.statusData = { rebuild: null };
    const hook = renderHook(() => useMapReplay("g1"));
    await act(async () => hook.result.current.refresh());
    for (const status of ["queued", "processing", "uploading"]) {
      harness.statusData = { rebuild: { requestId: "current", status } };
      hook.rerender();
      expect(harness.interval).toBe(3000);
      expect(harness.fullInterval).toBe(0);
      expect(harness.api.mutate).not.toHaveBeenCalled();
    }
    let finish!: (data: unknown) => void;
    harness.getRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    harness.statusData = { rebuild: { requestId: "current", status: "complete" } };
    hook.rerender();
    expect(harness.getRequest).toHaveBeenCalledTimes(1);
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(hook.result.current.completedRequestId).toBeNull();
    const fresh = payload("engine", undefined, false);
    await act(async () => finish(fresh));
    expect(hook.result.current.completedRequestId).toBe("current");
    expect(hook.result.current.refreshMessage).toContain("reduced detail");
    hook.rerender();
    expect(harness.api.mutate).toHaveBeenCalledTimes(1);
    expect(harness.api.mutate).toHaveBeenCalledWith(fresh, { revalidate: false });
    expect(harness.interval).toBe(0);
  });

  it("bounds full-record fallback reads when the API loses its job cache", async () => {
    vi.useFakeTimers();
    harness.statusData = { rebuild: null };
    const hook = renderHook(() => useMapReplay("g1"));
    await act(async () => hook.result.current.refresh());
    await act(async () => vi.advanceTimersByTime(59_999));
    expect(harness.api.mutate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(harness.api.mutate).toHaveBeenCalledTimes(1);
    for (const minutes of [4, 5, 7]) await act(async () => vi.advanceTimersByTime(minutes * 60_000));
    expect(harness.api.mutate).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTime(2 * 60_000));
    expect(harness.api.mutate).toHaveBeenCalledTimes(4);
    expect(hook.result.current.refreshing).toBe(false);
  });

  it("bounds failed completion downloads and never reports stale playback as ready", async () => {
    vi.useFakeTimers();
    harness.api.data = payload("engine");
    harness.statusData = { rebuild: null };
    const hook = renderHook(() => useMapReplay("g1"));
    await act(async () => hook.result.current.refresh());
    // Match SWR: revalidation can resolve OLD cached playback on a GET failure.
    // The controller must never call that path as proof of a fresh download.
    harness.api.mutate.mockResolvedValue(harness.api.data);
    harness.getRequest.mockRejectedValue(new Error("temporary download failure"));
    harness.statusData = { rebuild: { requestId: "current", status: "complete" } };
    await act(async () => hook.rerender());
    expect(harness.getRequest).toHaveBeenCalledTimes(1);
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(hook.result.current.completedRequestId).toBeNull();
    await act(async () => vi.advanceTimersByTime(30_000));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(harness.getRequest).toHaveBeenCalledTimes(3);
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(hook.result.current.refreshing).toBe(false);
    expect(hook.result.current.refreshMessage).toContain("could not be downloaded");
    expect(hook.result.current.completedRequestId).toBeNull();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(harness.getRequest).toHaveBeenCalledTimes(3);
  });

  it("ignores a completion download that settles after navigation", async () => {
    harness.api.data = payload("engine");
    harness.statusData = { rebuild: null };
    const hook = renderHook(({ gameId }) => useMapReplay(gameId), { initialProps: { gameId: "g1" } });
    await act(async () => hook.result.current.refresh());
    let finish!: (data: unknown) => void;
    harness.getRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    harness.statusData = { rebuild: { requestId: "current", status: "complete" } };
    hook.rerender({ gameId: "g1" });
    expect(harness.getRequest).toHaveBeenCalledTimes(1);
    harness.statusData = { rebuild: null };
    hook.rerender({ gameId: "g2" });
    await act(async () => finish(payload("engine")));
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(hook.result.current.completedRequestId).toBeNull();
    expect(hook.result.current.refreshing).toBe(false);
    expect(hook.result.current.refreshMessage).toBe("");
  });

  it("recovers a first recorded payload through a bounded fallback read", async () => {
    vi.useFakeTimers();
    harness.statusData = { rebuild: null };
    const hook = renderHook(() => useMapReplay("g1"));
    await act(async () => hook.result.current.refresh());
    harness.getRequest.mockResolvedValue(payload("engine"));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(hook.result.current.completedRequestId).toBe("current");
    expect(hook.result.current.refreshing).toBe(false);
    expect(harness.api.mutate).toHaveBeenCalledTimes(1);
  });

  it("disables data and actions while its host is closed", async () => {
    const hook = renderHook(() => useMapReplay(null));
    await act(async () => hook.result.current.refresh());
    expect(harness.path).toBeNull();
    expect(hook.result.current.playback).toBeNull();
    expect(hook.result.current.canRefresh).toBe(false);
    expect(hook.result.current.completedRequestId).toBeNull();
    expect(harness.api.request).not.toHaveBeenCalled();
  });

  it("waits for this upload to finish before completing shared analysis", async () => {
    harness.api.data = payload("engine", undefined, false);
    const hook = renderHook(() => useMapReplay("game/1"));
    await act(async () => hook.result.current.refresh());
    expect(harness.path).toBe("/v1/games/game%2F1/map-playback/status");
    expect(harness.fullInterval).toBe(0);
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(harness.api.request).toHaveBeenCalledWith({ method: "POST", body: '{"fidelity":"engine"}' });
    expect(harness.interval).toBe(3000);
    harness.api.data = payload("engine", { requestId: "old", status: "complete" });
    await act(async () => hook.rerender());
    expect(hook.result.current.completedRequestId).toBeNull();
    harness.api.data = payload("engine", { requestId: "current", status: "uploading" });
    hook.rerender();
    expect(hook.result.current.completedRequestId).toBeNull();
    expect(hook.result.current.refreshMessage).toContain("Uploading");
    harness.api.data = payload("engine", { requestId: "current", status: "complete" });
    await act(async () => hook.rerender());
    expect(hook.result.current.completedRequestId).toBe("current");
    expect(hook.result.current.refreshMessage).toBe("Recorded playback is ready.");
    expect(harness.interval).toBe(0);
  });

  it("recognizes a first complete recording after ACK if the API lost its job status", async () => {
    const hook = renderHook(() => useMapReplay("g1"));
    await act(async () => hook.result.current.refresh());
    harness.api.data = payload("engine");
    hook.rerender();
    expect(hook.result.current.completedRequestId).toBe("current");
    expect(hook.result.current.refreshing).toBe(false);
    expect(harness.interval).toBe(0);
  });

  it("completes reduced-detail recordings but never a recording without attacks", async () => {
    const hook = renderHook(() => useMapReplay("g1"));
    await act(async () => hook.result.current.refresh());
    harness.api.data = payload("engine", { requestId: "current", status: "complete" }, false);
    await act(async () => hook.rerender());
    expect(hook.result.current.completedRequestId).toBe("current");
    expect(hook.result.current.refreshMessage).toContain("reduced detail");
    harness.api.request.mockResolvedValue({ requestId: "next" });
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.completedRequestId).toBeNull();
    harness.api.data = payload("engine", { requestId: "next", status: "complete" }, true, "unavailable");
    await act(async () => hook.rerender());
    expect(hook.result.current.completedRequestId).toBeNull();
    expect(hook.result.current.refreshMessage).toContain("no attack data");
  });

  it("never exposes a previous game's completion on the first render after navigation", async () => {
    const seen: Array<{ gameId: string | null; completed: string | null; message: string }> = [];
    const hook = renderHook(({ gameId }) => {
      const controller = useMapReplay(gameId);
      seen.push({ gameId, completed: controller.completedRequestId, message: controller.refreshMessage });
      return controller;
    }, { initialProps: { gameId: "g1" as string | null } });
    await act(async () => hook.result.current.refresh());
    harness.api.data = payload("engine", { requestId: "current", status: "complete" });
    hook.rerender({ gameId: "g1" });
    expect(hook.result.current.completedRequestId).toBe("current");
    seen.length = 0;
    hook.rerender({ gameId: "g2" });
    hook.rerender({ gameId: null });
    hook.rerender({ gameId: "g1" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(render => render.completed === null && render.message === "")).toBe(true);
  });

  it("resumes a pending recording after closing and reopening without another POST", async () => {
    harness.api.data = payload("tracker", { requestId: "resumed", status: "processing", updatedAt: Date.now() });
    const hook = renderHook(({ gameId }) => useMapReplay(gameId), { initialProps: { gameId: "g1" as string | null } });
    expect(hook.result.current.refreshing).toBe(true);
    expect(harness.interval).toBe(3000);
    hook.rerender({ gameId: null });
    expect(hook.result.current.refreshing).toBe(false);
    expect(harness.interval).toBe(0);
    hook.rerender({ gameId: "g1" });
    expect(hook.result.current.refreshing).toBe(true);
    expect(harness.interval).toBe(3000);
    expect(harness.api.request).not.toHaveBeenCalled();
    harness.api.data = payload("engine", { requestId: "resumed", status: "complete" });
    await act(async () => hook.rerender({ gameId: "g1" }));
    expect(hook.result.current.completedRequestId).toBe("resumed");
  });

  it("does not restart polling a stale pending job after the time limit", async () => {
    vi.useFakeTimers();
    harness.api.data = payload("tracker", { requestId: "slow", status: "processing", updatedAt: Date.now() });
    const hook = renderHook(() => useMapReplay("g1"));
    expect(harness.interval).toBe(3000);
    await act(async () => vi.advanceTimersByTime(18 * 60 * 1000));
    hook.rerender();
    expect(harness.interval).toBe(0);
    expect(hook.result.current.refreshMessage).toContain("still processing");
    expect(hook.result.current.completedRequestId).toBeNull();
  });
});
