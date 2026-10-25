import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
import { usePublicApi } from "../usePublicApi";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type ViewerData = { viewer: string; voted: boolean };
const path = "/v1/reviews/example";
function fixture() {
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => cache, dedupingInterval: 60_000, shouldRetryOnError: false, revalidateOnFocus: false }}>{children}</SWRConfig>;
  const render = () => renderHook(() => {
    const result = usePublicApi<ViewerData>(path, { revalidateIfStale: false }, { personalized: true });
    return { data: result.data, error: result.error, mutate: result.mutate };
  }, { wrapper });
  const data = (viewer: string) => cache.get(unstable_serialize(["public-api", viewer, path]))?.data;
  return { wrapper, render, data };
}
beforeEach(() => { h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true; h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("never puts B's personalized votes into A's public cache after a held A JWT", async () => {
  const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const viewer = (init.headers as Record<string, string> | undefined)?.authorization === "Bearer B-token" ? "B" : "A";
    return new Response(JSON.stringify({ viewer, voted: viewer === "B" }));
  }); vi.stubGlobal("fetch", fetcher);
  const f = fixture(), view = f.render();
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender();
  await waitFor(() => expect(view.result.current.data?.viewer).toBe("B"));
  await act(async () => token.resolve("B-token"));
  expect(f.data("A")).toBeUndefined();
  h.auth.userId = "A"; view.rerender();
  await waitFor(() => expect(view.result.current.data?.viewer).toBe("A"));
});

it("rejects a held personalized body through A→B→A without overwriting the fresh A value", async () => {
  const body = deferred<ViewerData>();
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => body.promise }).mockImplementation(async (_url, init: RequestInit) => {
    const viewer = (init.headers as Record<string, string>).authorization === "Bearer B-token" ? "B" : "A";
    return new Response(JSON.stringify({ viewer, voted: false }));
  }); vi.stubGlobal("fetch", fetcher);
  const f = fixture(), view = f.render();
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender(); expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(view.result.current.data?.viewer).toBe("B"));
  h.auth.userId = "A"; view.rerender();
  await waitFor(() => expect(view.result.current.data?.viewer).toBe("A"));
  await act(async () => body.resolve({ viewer: "A", voted: true }));
  expect(f.data("A")).toEqual({ viewer: "A", voted: false });
});

it("starts anonymous reads before Clerk loads and never borrows the later signed-in JWT", async () => {
  h.auth.isLoaded = false;
  const anonymous = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(anonymous.promise).mockResolvedValue(new Response(JSON.stringify({ viewer: "A", voted: true })));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture(), view = f.render();
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(h.auth.getToken).not.toHaveBeenCalled(); expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  h.auth.isLoaded = true; view.rerender();
  await waitFor(() => expect(view.result.current.data?.viewer).toBe("A"));
  expect(h.auth.getToken).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[1][1].headers).toEqual({ authorization: "Bearer A-token" });
  await act(async () => anonymous.resolve(new Response(JSON.stringify({ viewer: "anonymous", voted: false }))));
  expect(f.data("anonymous")).toBeUndefined(); expect(view.result.current.data?.viewer).toBe("A");
});

it("keeps ordinary public reads tokenless across sign-in, owner changes and sign-out", async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ viewer: "anonymous", voted: false })));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  const view = renderHook(() => usePublicApi<ViewerData>(path, { revalidateIfStale: false }), { wrapper: f.wrapper });
  await waitFor(() => expect(view.result.current.data?.viewer).toBe("anonymous"));
  h.auth.userId = "B"; view.rerender();
  h.auth.userId = null; h.auth.isSignedIn = false; view.rerender();
  expect(view.result.current.data?.viewer).toBe("anonymous"); expect(h.auth.getToken).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1]?.headers).toBeUndefined();
});

it("retires a signed-in JWT on unmount and recovers the same viewer on remount", async () => {
  const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ viewer: "A", voted: false }))); vi.stubGlobal("fetch", fetcher);
  const f = fixture(), view = f.render();
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce()); view.unmount();
  await act(async () => token.resolve("B-token"));
  expect(fetcher).not.toHaveBeenCalled(); expect(f.data("A")).toBeUndefined();
  const next = f.render(); await waitFor(() => expect(next.result.current.data?.viewer).toBe("A"));
});

it("retains anonymous fallback, disabled paths and existing public error-envelope behavior", async () => {
  h.auth.isLoaded = false;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "review_hidden", message: "This review is hidden." } }), { status: 404 }));
  vi.stubGlobal("fetch", fetcher); const f = fixture();
  const view = renderHook(({ resource }: { resource: string | null }) => usePublicApi<ViewerData>(resource, { fallbackData: { viewer: "public-initial", voted: false } }), { wrapper: f.wrapper, initialProps: { resource: null as string | null } });
  expect(fetcher).not.toHaveBeenCalled(); expect(view.result.current.data?.viewer).toBe("public-initial");
  view.rerender({ resource: path });
  await waitFor(() => expect(view.result.current.error).toMatchObject({ status: 404, code: "review_hidden", message: "This review is hidden." }));
  expect(h.auth.getToken).not.toHaveBeenCalled();
});
