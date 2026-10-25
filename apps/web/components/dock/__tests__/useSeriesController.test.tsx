import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SERIES_SAMPLE } from "@/lib/streamSeries";
import { useSeriesController } from "../useSeriesController";
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let fetcher: ReturnType<typeof vi.fn>, invalid: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn().mockResolvedValue(response(null)); vi.stubGlobal("fetch", fetcher); invalid = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("boots once with no polling and sends revisioned explicit controls", async () => {
  fetcher.mockResolvedValueOnce(response(SERIES_SAMPLE));
  const { result } = renderHook(() => useSeriesController("one", undefined, invalid));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockResolvedValueOnce(response({ ...SERIES_SAMPLE, revision: 2 }));
  await act(async () => { expect(await result.current.act({ action: "adjust", side: "you", delta: -1 })).toBe(true); });
  const request = fetcher.mock.calls[1][1]; expect(request.method).toBe("POST"); expect(request.cache).toBe("no-store");
  expect(JSON.parse(request.body)).toEqual({ action: "adjust", side: "you", delta: -1, revision: 1 });
  expect(result.current.series?.revision).toBe(2);
});
it("a newer live event beats a held bootstrap and a stale bootstrap error", async () => {
  const held = deferred<Response>(); fetcher.mockReturnValueOnce(held.promise);
  const { result, rerender } = renderHook(({ event }) => useSeriesController("one", event, invalid), { initialProps: { event: undefined as unknown } });
  rerender({ event: { ...SERIES_SAMPLE, revision: 3 } }); await waitFor(() => expect(result.current.series?.revision).toBe(3));
  await act(async () => { held.resolve(new Response("unavailable", { status: 503 })); });
  expect(result.current.ready).toBe(true); expect(result.current.error).toBe("");
});
it("a held response cannot repaint A after A to B to A token changes", async () => {
  const body = deferred<unknown>();
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise })
    .mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response({ ...SERIES_SAMPLE, revision: 5 }));
  const { result, rerender } = renderHook(({ token }) => useSeriesController(token, undefined, invalid), { initialProps: { token: "A" } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  rerender({ token: "B" }); rerender({ token: "A" });
  await waitFor(() => expect(result.current.series?.revision).toBe(5));
  await act(async () => body.resolve({ ...SERIES_SAMPLE, revision: 1 }));
  expect(result.current.series?.revision).toBe(5);
});
it("keeps a newer socket revision when a manual response arrives later", async () => {
  fetcher.mockResolvedValueOnce(response(SERIES_SAMPLE));
  const held = deferred<Response>();
  const { result, rerender } = renderHook(({ event }) => useSeriesController("one", event, invalid), { initialProps: { event: undefined as unknown } });
  await waitFor(() => expect(result.current.ready).toBe(true));
  fetcher.mockReturnValueOnce(held.promise); let write!: Promise<boolean>;
  act(() => { write = result.current.act({ action: "adjust", side: "you", delta: -1 }); });
  rerender({ event: { ...SERIES_SAMPLE, revision: 4 } });
  await act(async () => { held.resolve(response({ ...SERIES_SAMPLE, revision: 2 })); await write; });
  expect(result.current.series?.revision).toBe(4); expect(result.current.busy).toBe(false);
});
it("a real deadline settles a held body and ignores its late completion", async () => {
  vi.useFakeTimers(); const body = deferred<unknown>(); fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise });
  const { result } = renderHook(() => useSeriesController("one", undefined, invalid));
  await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(20_001); });
  expect(result.current.ready).toBe(false); expect(result.current.error).not.toBe("");
  await act(async () => body.resolve(SERIES_SAMPLE)); expect(result.current.series).toBeNull();
});
it("an uncertain write requires refresh and never auto-retries or clears the recorded score", async () => {
  fetcher.mockResolvedValueOnce(response(SERIES_SAMPLE));
  const { result } = renderHook(() => useSeriesController("one", undefined, invalid));
  await waitFor(() => expect(result.current.ready).toBe(true));
  fetcher.mockRejectedValueOnce(new TypeError("Offline"));
  await act(async () => { expect(await result.current.act({ action: "adjust", side: "you", delta: 1 })).toBe(false); });
  expect(result.current.ready).toBe(false); expect(result.current.busy).toBe(false); expect(result.current.series).toEqual(SERIES_SAMPLE);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("terminal 401 uses the existing replaced-URL handler and stops further controls", async () => {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "overlay_token_replaced" } }), { status: 401 }));
  const { result } = renderHook(() => useSeriesController("one", undefined, invalid));
  await waitFor(() => expect(invalid).toHaveBeenCalledWith(true));
  expect(result.current.ready).toBe(false); expect(fetcher).toHaveBeenCalledOnce();
});
