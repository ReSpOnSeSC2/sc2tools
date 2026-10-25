import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCurrentMapPool } from "../useCurrentMapPool";
import { POOL_MAX_AGE_MS } from "../currentMapPool";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("ages a long-open pool locally and accepts a fresh refreshed timestamp without changing the sample window", () => {
  vi.useFakeTimers(); const started = new Date("2026-10-25T12:00:00Z").getTime(); vi.setSystemTime(started);
  const metadata = { mapPool: ["Alcyone"], mapPoolSource: "persisted" as const, mapPoolFetchedAt: started - POOL_MAX_AGE_MS + 30_000 };
  const view = renderHook(({ value }) => useCurrentMapPool(value), { initialProps: { value: metadata } });
  expect(view.result.current.fresh).toBe(true);
  act(() => { vi.advanceTimersByTime(60_000); }); expect(view.result.current.fresh).toBe(false);
  act(() => { vi.advanceTimersByTime(6 * 60 * 60_000); });
  view.rerender({ value: { ...metadata, mapPoolFetchedAt: Date.now() } });
  expect(view.result.current.fresh).toBe(true); expect(view.result.current.age).toBe(0);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
