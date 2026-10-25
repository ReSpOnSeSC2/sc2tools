import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDossierBusyRetry } from "../useDossierBusyRetry";
const busy = { status: 503, code: "opponent_profile_busy" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("retries busy admission with increasing delays and a four-attempt limit", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useDossierBusyRetry("opponent:scope", busy, retry));
  for (const delay of [1000, 2000, 4000, 8000]) await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
  expect(retry).toHaveBeenCalledTimes(4); expect(hook.result.current).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(retry).toHaveBeenCalledTimes(4);
});
it("waits for the in-flight attempt and cancels scheduled retries when the scope changes", async () => {
  let settle!: () => void;
  const retry = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  const hook = renderHook(({ key, error }) => useDossierBusyRetry(key, error, retry), { initialProps: { key: "first", error: busy as unknown } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(retry).toHaveBeenCalledOnce();
  hook.rerender({ key: "second", error: undefined });
  await act(async () => settle()); await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(retry).toHaveBeenCalledOnce(); expect(hook.result.current).toBe(false);
});
it("leaves network and not-found errors to their manual recovery states", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(({ error }) => useDossierBusyRetry("one", error, retry), { initialProps: { error: { status: 0 } } });
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  hook.rerender({ error: { status: 404 } }); await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(retry).not.toHaveBeenCalled();
});
