import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
import { useReviewPages } from "../useReviewPages";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const path = "/v1/reviews/mine?state=open";
function fixture() {
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => cache, dedupingInterval: 60_000, shouldRetryOnError: false, revalidateOnFocus: false }}>{children}</SWRConfig>;
  const render = () => renderHook(() => useReviewPages<{ privateOwner: string }>(path, true), { wrapper });
  const data = (owner: string) => cache.get(unstable_serialize(["my-review-pages", owner, path]))?.data;
  return { wrapper, render, data };
}
beforeEach(() => { h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true; h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("never puts B's private review page into A's SWRInfinite page cache after a held A JWT", async () => {
  const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const privateOwner = (init.headers as Record<string, string> | undefined)?.authorization === "Bearer B-token" ? "B" : "A";
    return new Response(JSON.stringify({ items: [{ privateOwner }], nextCursor: null }));
  }); vi.stubGlobal("fetch", fetcher);
  const f = fixture(), view = f.render();
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("B"));
  await act(async () => token.resolve("B-token"));
  expect(f.data("A")).toBeUndefined();
  h.auth.userId = "A"; view.rerender();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("A"));
});

it("rejects a held page body through A→B→A and keeps the latest A page", async () => {
  const body = deferred<{ items: { privateOwner: string }[]; nextCursor: null }>();
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => body.promise }).mockImplementation(async (_url, init: RequestInit) => {
    const privateOwner = (init.headers as Record<string, string>).authorization === "Bearer B-token" ? "B" : "A-new";
    return new Response(JSON.stringify({ items: [{ privateOwner }], nextCursor: null }));
  }); vi.stubGlobal("fetch", fetcher);
  const f = fixture(), view = f.render();
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender(); expect(view.result.current.items).toEqual([]);
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("B"));
  h.auth.userId = "A"; view.rerender();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("A-new"));
  await act(async () => body.resolve({ items: [{ privateOwner: "A-old" }], nextCursor: null }));
  expect(f.data("A")?.items).toEqual([{ privateOwner: "A-new" }]);
});

it("hides loaded private pages during auth loading and preserves warm same-owner pages on return", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [{ privateOwner: "A" }], nextCursor: null })));
  vi.stubGlobal("fetch", fetcher); const f = fixture(), view = f.render();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("A"));
  h.auth.isLoaded = false; view.rerender(); expect(view.result.current.items).toEqual([]);
  h.auth.isLoaded = true; view.rerender();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("A"));
  expect(fetcher).toHaveBeenCalledOnce();
});

it("does not send a held JWT after unmount and recovers on remount", async () => {
  const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [{ privateOwner: "A" }], nextCursor: null })));
  vi.stubGlobal("fetch", fetcher); const f = fixture(), view = f.render();
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce()); view.unmount();
  await act(async () => token.resolve("B-token")); expect(fetcher).not.toHaveBeenCalled(); expect(f.data("A")).toBeUndefined();
  const next = f.render(); await waitFor(() => expect(next.result.current.items[0]?.privateOwner).toBe("A"));
});

it("preserves cursor loading for the same owner and isolates a held next-page token", async () => {
  const token = deferred<string>();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const privateOwner = (init.headers as Record<string, string>).authorization === "Bearer B-token" ? "B" : "A";
    const nextPage = url.includes("cursor=");
    return new Response(JSON.stringify({ items: [{ privateOwner: `${privateOwner}-${nextPage ? 2 : 1}` }], nextCursor: nextPage || privateOwner === "B" ? null : "next" }));
  }); vi.stubGlobal("fetch", fetcher); const f = fixture(), view = f.render();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("A-1"));
  h.auth.getToken.mockReturnValueOnce(token.promise);
  act(() => { void view.result.current.loadMore(); });
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledTimes(2));
  h.auth.userId = "B"; view.rerender();
  await waitFor(() => expect(view.result.current.items[0]?.privateOwner).toBe("B-1"));
  await act(async () => token.resolve("B-token"));
  expect(fetcher.mock.calls.some(([url, init]) => url.includes("cursor=next") && (init.headers as Record<string, string>).authorization === "Bearer B-token")).toBe(false);
  expect(view.result.current.items).toEqual([{ privateOwner: "B-1" }]);
});
