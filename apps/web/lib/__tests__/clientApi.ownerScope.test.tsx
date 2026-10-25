import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
import { apiCall, useApi } from "../clientApi";

type PrivateData = { privateOwner: string; revision?: string };
const path = "/v1/private-example";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const response = (privateOwner: string, revision?: string) => new Response(JSON.stringify({ privateOwner, revision }));
const authorization = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.authorization;
function fixture(timeoutMs?: number) {
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{
    provider: () => cache, dedupingInterval: 60_000, shouldRetryOnError: false,
    revalidateOnFocus: false, keepPreviousData: true,
  }}>{children}</SWRConfig>;
  const render = (initialPath: string | null = path) => renderHook(({ resource }: { resource: string | null }) => {
    const result = useApi<PrivateData>(resource, { revalidateIfStale: false }, { timeoutMs });
    // Read during render, as consumers do: SWR subscribes lazily to each field.
    return { data: result.data, error: result.error, request: result.request, mutate: result.mutate, isPreviousData: result.isPreviousData };
  }, { wrapper, initialProps: { resource: initialPath } });
  const data = (owner: string) => cache.get(unstable_serialize(["authenticated-api", owner, path]))?.data;
  return { cache, wrapper, render, data };
}

beforeEach(() => {
  h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("useApi actual SWR owner isolation", () => {
  it("loads under StrictMode effect replay without retaining the retired first operation", async () => {
    const fetcher = vi.fn(async () => response("A")); vi.stubGlobal("fetch", fetcher);
    const f = fixture();
    const view = renderHook(() => useApi<PrivateData>(path, { shouldRetryOnError: false }), {
      wrapper: ({ children }) => <StrictMode><f.wrapper>{children}</f.wrapper></StrictMode>,
    });
    await waitFor(() => expect(view.result.current.data?.privateOwner).toBe("A"));
  });

  it("never caches a held A JWT resolved with B credentials into A's key, including A→B→A", async () => {
    const token = deferred<string>();
    h.auth.getToken.mockReturnValueOnce(token.promise);
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => response(authorization(init) === "Bearer B-token" ? "B" : "A"));
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render();
    await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
    expect(fetcher).not.toHaveBeenCalled();
    h.auth.userId = "B"; view.rerender({ resource: path });
    expect(view.result.current.data).toBeUndefined();
    await waitFor(() => expect(view.result.current.data?.privateOwner).toBe("B"));
    await act(async () => token.resolve("B-token"));
    expect(f.data("A")).toBeUndefined();
    h.auth.userId = "A"; view.rerender({ resource: path });
    expect(view.result.current.data).toBeUndefined();
    await waitFor(() => expect(view.result.current.data?.privateOwner).toBe("A"));
    expect(fetcher.mock.calls.map(([, init]) => authorization(init))).toEqual(["Bearer B-token", "Bearer A-token"]);
  });

  it("rejects a held response body through A→B→A and leaves the new A answer intact", async () => {
    const body = deferred<PrivateData>(); let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementationOnce(async (_url, init: RequestInit) => {
      oldSignal = init.signal!;
      return { ok: true, json: () => body.promise };
    }).mockImplementation(async (_url, init: RequestInit) => response(authorization(init) === "Bearer B-token" ? "B" : "A", "new"));
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render();
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    h.auth.userId = "B"; view.rerender({ resource: path });
    await waitFor(() => expect(view.result.current.data?.privateOwner).toBe("B"));
    expect(oldSignal?.aborted).toBe(true);
    h.auth.userId = "A"; view.rerender({ resource: path });
    await waitFor(() => expect(view.result.current.data?.revision).toBe("new"));
    await act(async () => body.resolve({ privateOwner: "A", revision: "old" }));
    expect(view.result.current.data).toEqual({ privateOwner: "A", revision: "new" });
    expect(f.data("A")).toEqual({ privateOwner: "A", revision: "new" });
  });

  it("does not read late response headers or cache them after sign-out", async () => {
    const headers = deferred<Response>(); const json = vi.fn(async () => ({ privateOwner: "A" }));
    const fetcher = vi.fn().mockReturnValue(headers.promise); vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render();
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    h.auth.isSignedIn = false; h.auth.userId = null; view.rerender({ resource: path });
    await act(async () => headers.resolve({ ok: true, json } as unknown as Response));
    expect(json).not.toHaveBeenCalled(); expect(f.data("A")).toBeUndefined();
    expect(view.result.current.data).toBeUndefined();
  });

  it("invalidates a held JWT during auth loading even when the same owner returns", async () => {
    const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
    const fetcher = vi.fn(async () => response("A", "new")); vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render();
    await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
    h.auth.isLoaded = false; view.rerender({ resource: path });
    expect(view.result.current.data).toBeUndefined();
    await act(async () => {}); // The retired shared SWR promise has now settled.
    h.auth.isLoaded = true; view.rerender({ resource: path });
    await waitFor(() => expect(view.result.current.data?.revision).toBe("new"));
    await act(async () => token.resolve("retired-token"));
    expect(fetcher).toHaveBeenCalledOnce(); expect(f.data("A")).toEqual({ privateOwner: "A", revision: "new" });
  });

  it.each(["JWT", "body"])("aborts an unmounted held %s without populating SWR and recovers on remount", async stage => {
    const heldToken = deferred<string>(), heldBody = deferred<PrivateData>();
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(heldToken.promise);
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementationOnce(async (_url, init: RequestInit) => {
      signal = init.signal!; return stage === "body" ? { ok: true, json: () => heldBody.promise } : response("A", "new");
    }).mockImplementation(async () => response("A", "new"));
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render();
    await waitFor(() => expect(stage === "JWT" ? h.auth.getToken : fetcher).toHaveBeenCalledOnce());
    view.unmount();
    if (signal) expect(signal.aborted).toBe(true);
    await act(async () => { heldToken.resolve("A-token"); heldBody.resolve({ privateOwner: "A", revision: "retired" }); });
    expect(f.data("A")).toBeUndefined();
    if (stage === "JWT") expect(fetcher).not.toHaveBeenCalled();
    const next = f.render();
    await waitFor(() => expect(next.result.current.data?.revision).toBe("new"));
  });

  it("keeps valid same-owner cache, dedupes sibling consumers and performs an explicit refresh", async () => {
    const body = deferred<PrivateData>();
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => body.promise }).mockResolvedValue(response("A", "refreshed"));
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), pair = renderPair(f.wrapper);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await act(async () => body.resolve({ privateOwner: "A", revision: "cached" }));
    await waitFor(() => expect(pair.second().data?.revision).toBe("cached"));
    pair.rerender(false);
    expect(pair.second().data?.revision).toBe("cached"); expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => { await pair.second().mutate(); });
    expect(pair.second().data?.revision).toBe("refreshed"); expect(fetcher).toHaveBeenCalledTimes(2);
    h.auth.userId = "B"; pair.rerender(false);
    h.auth.userId = "A"; pair.rerender(false);
    expect(pair.second().data?.privateOwner).toBe("A");
  });

  it("recovers a deduped sibling with Retry when its initiating consumer retires", async () => {
    const body = deferred<PrivateData>();
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => body.promise }).mockResolvedValue(response("A", "retried"));
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), pair = renderPair(f.wrapper);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); pair.rerender(false);
    await waitFor(() => expect(pair.second().error).toMatchObject({ name: "AbortError" }));
    await act(async () => { await pair.second().mutate(); });
    expect(pair.second().data?.revision).toBe("retried");
    await act(async () => body.resolve({ privateOwner: "A", revision: "retired" }));
    expect(f.data("A")).toEqual({ privateOwner: "A", revision: "retried" });
  });

  it("does not fetch while auth is absent and preserves anonymous standalone apiCall", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response("public")); vi.stubGlobal("fetch", fetcher);
    h.auth.isSignedIn = false; h.auth.userId = null;
    const f = fixture(), view = f.render();
    expect(view.result.current.data).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled();
    await expect(apiCall(async () => null, "/v1/public")).resolves.toMatchObject({ privateOwner: "public" });
    expect(authorization(fetcher.mock.calls[0][1])).toBeUndefined();
  });

  it.each(["JWT", "body"])("keeps the opt-in deadline across a held %s and permits Retry", async stage => {
    const token = deferred<string>(), body = deferred<PrivateData>();
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(token.promise);
    let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementationOnce(async (_url, init: RequestInit) => {
      oldSignal = init.signal!;
      return stage === "body" ? { ok: true, json: () => body.promise } : response("A", "retried");
    }).mockResolvedValue(response("A", "retried"));
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(30), view = f.render();
    await waitFor(() => expect(view.result.current.error).toMatchObject({ code: "request_timeout" }));
    if (oldSignal) expect(oldSignal.aborted).toBe(true);
    await act(async () => { token.resolve("retired-token"); body.resolve({ privateOwner: "A", revision: "retired" }); });
    expect(f.data("A")).toBeUndefined();
    await act(async () => { await view.result.current.mutate(); });
    expect(view.result.current.data?.revision).toBe("retried");
    expect(fetcher).toHaveBeenCalledTimes(stage === "JWT" ? 1 : 2);
  });

  it("preserves a caller's explicit signed-in fallback and null-token transport behavior", async () => {
    h.auth.getToken.mockResolvedValue(null);
    const pending = deferred<Response>();
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => pending.promise); vi.stubGlobal("fetch", fetcher);
    const f = fixture();
    const view = renderHook(() => useApi<PrivateData>(path, { fallbackData: { privateOwner: "fallback" } }), { wrapper: f.wrapper });
    expect(view.result.current.data).toEqual({ privateOwner: "fallback" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(authorization(fetcher.mock.calls[0][1])).toBeUndefined();
    await act(async () => pending.resolve(response("public")));
    await waitFor(() => expect(view.result.current.data?.privateOwner).toBe("public"));
  });

  it.each(["JWT", "body"])("fences explicit request completion at held %s and rejects retained callbacks", async stage => {
    const token = deferred<string>(), body = deferred<PrivateData>();
    const fetcher = vi.fn(async () => ({ ok: true, json: () => body.promise })); vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render(null);
    view.rerender({ resource: path });
    // Finish the automatic read before exercising the explicit mutation.
    body.resolve({ privateOwner: "A" });
    await waitFor(() => expect(view.result.current.data?.privateOwner).toBe("A"));
    const heldBody = deferred<PrivateData>();
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(token.promise);
    else fetcher.mockResolvedValueOnce({ ok: true, json: () => heldBody.promise });
    const oldRequest = view.result.current.request;
    const pending = oldRequest({ method: "POST" });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(stage === "JWT" ? h.auth.getToken : fetcher).toHaveBeenCalledTimes(2));
    h.auth.isLoaded = false; view.rerender({ resource: path });
    await rejected;
    await act(async () => { token.resolve("B-token"); heldBody.resolve({ privateOwner: "B" }); });
    await expect(oldRequest({ method: "POST" })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(stage === "JWT" ? 1 : 2);
  });
});

function renderPair(Wrapper: ({ children }: { children: ReactNode }) => ReactNode) {
  let current!: { data: PrivateData | undefined; error: unknown; mutate: ReturnType<typeof useApi<PrivateData>>["mutate"] };
  function Consumer({ second = false }: { second?: boolean }) {
    const result = useApi<PrivateData>(path, { revalidateIfStale: false });
    const data = result.data, error = result.error;
    if (second) current = { data, error, mutate: result.mutate };
    return null;
  }
  const tree = (first: boolean) => <Wrapper>{first && <Consumer />}<Consumer second /></Wrapper>;
  const view = render(tree(true));
  return { second: () => current, rerender: (first: boolean) => view.rerender(tree(first)) };
}
