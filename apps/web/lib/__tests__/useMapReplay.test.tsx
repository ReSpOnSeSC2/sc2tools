import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapReplay } from "../useMapReplay";

const harness = vi.hoisted(() => ({
  path: null as string | null,
  interval: 0,
  api: { data: null as unknown, isLoading: false, error: undefined,
    request: vi.fn(), mutate: vi.fn() },
}));
vi.mock("../clientApi", () => ({ useApi: (path: string | null, config: { refreshInterval: number }) => {
  harness.path = path;
  harness.interval = config.refreshInterval;
  return harness.api;
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
  harness.api.mutate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("shared map replay recording controller", () => {
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
    expect(harness.path).toBe("/v1/games/game%2F1/map-playback");
    expect(harness.api.request).toHaveBeenCalledWith({ method: "POST", body: '{"fidelity":"engine"}' });
    expect(harness.interval).toBe(3000);
    harness.api.data = payload("engine", { requestId: "old", status: "complete" });
    hook.rerender();
    expect(hook.result.current.completedRequestId).toBeNull();
    harness.api.data = payload("engine", { requestId: "current", status: "uploading" });
    hook.rerender();
    expect(hook.result.current.completedRequestId).toBeNull();
    expect(hook.result.current.refreshMessage).toContain("Uploading");
    harness.api.data = payload("engine", { requestId: "current", status: "complete" });
    hook.rerender();
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
    hook.rerender();
    expect(hook.result.current.completedRequestId).toBe("current");
    expect(hook.result.current.refreshMessage).toContain("reduced detail");
    harness.api.request.mockResolvedValue({ requestId: "next" });
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.completedRequestId).toBeNull();
    harness.api.data = payload("engine", { requestId: "next", status: "complete" }, true, "unavailable");
    hook.rerender();
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

  it("resumes a pending recording after closing and reopening without another POST", () => {
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
    hook.rerender({ gameId: "g1" });
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
