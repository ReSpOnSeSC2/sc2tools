import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
import { useApi } from "../clientApi";
import {
  ConditionalApiProvider, createConditionalLoader, useConditionalApiScope,
} from "../conditionalApiScope";

type Data = { value: string };
const path = "/v1/timeseries?map=Old#1";
const tag = `W/"uc1-${"a".repeat(64)}"`;
const tag2 = `W/"uc1-${"b".repeat(64)}"`;
const response = (value: string, etag = tag) => new Response(JSON.stringify({ value }), {
  headers: { etag, "cache-control": "private, no-cache" },
});
const same = (etag = tag) => new Response(null, { status: 304, headers: { etag } });
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function heldFailure(status: number) {
  const began = deferred<void>(), body = deferred<string>(), reply = new Response(null, { status });
  Object.defineProperty(reply, "text", { value: () => { began.resolve(); return body.promise; } });
  return { reply, began: began.promise,
    release: () => body.resolve('{"error":{"code":"revoked","message":"Sign in again."}}') };
}
function fixture(withProvider = true) {
  const cache = new Map();
  function Wrapper({ children }: { children: ReactNode }) {
    const owner = h.auth.isLoaded && h.auth.isSignedIn ? h.auth.userId : null;
    const content = <SWRConfig value={{
      provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false,
      revalidateOnFocus: false, revalidateOnReconnect: false,
    }}>{children}</SWRConfig>;
    return withProvider ? <ConditionalApiProvider owner={owner}>{content}</ConditionalApiProvider> : content;
  }
  const render = (resource = path) => renderHook(({ resource }) => {
    const query = useApi<Data>(resource);
    return { data: query.data, error: query.error, mutate: query.mutate, scope: useConditionalApiScope() };
  }, { wrapper: Wrapper, initialProps: { resource } });
  const cached = (resource: string, owner = "A") => cache.get(unstable_serialize(["authenticated-api", owner, resource]))?.data;
  return { Wrapper, render, cached };
}
async function loadEnhancement() {
  // Resolve the actual import begun by capability discovery; this does no API warmup.
  await act(async () => { await import("../conditionalApiResponses"); await Promise.resolve(); });
}
beforeEach(() => {
  h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const conditionalResources = [path, "/v1/summary", "/v1/macro/summary", "/v1/timeseries/mmr",
    "/v1/timeseries/my-builds", "/v1/timeseries/opp-strategies",
    "/v1/matchups", "/v1/maps", "/v1/maps/matchups", "/v1/build-vs-strategy", "/v1/streak", "/v1/macro/report",
    "/v1/mmr-by-matchup", "/v1/mmr-by-matchup/opponents", "/v1/random-summary"];

describe("useApi actual SWR manual conditional integration", () => {
  it.each(conditionalResources)("%s discovers capability with one ordinary read, retains the next200 and reconstructs304", async resource => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      header(init, "If-None-Match") ? same() : response("private"));
    vi.stubGlobal("fetch", fetcher);
    const view = fixture().render(resource);
    await waitFor(() => expect(view.result.current.data).toEqual({ value: "private" }));
    expect(fetcher).toHaveBeenCalledOnce(); expect(header(fetcher.mock.calls[0][1], "If-None-Match")).toBeNull();
    await loadEnhancement();
    await act(async () => { await view.result.current.mutate(); });
    await act(async () => { await view.result.current.mutate(); });
    expect(fetcher.mock.calls.map(([, init]) => header(init, "If-None-Match"))).toEqual([null, null, tag]);
    expect(view.result.current.data).toEqual({ value: "private" }); expect(view.result.current.error).toBeUndefined();
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it.each(["outside provider", "nonallowlisted", "legacy OFF"] as const)("performs one baseline read for %s", async mode => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => mode === "legacy OFF"
      ? new Response('{"value":"baseline"}', { headers: { etag: 'W/"native"' } }) : response("baseline"));
    vi.stubGlobal("fetch", fetcher);
    const view = fixture(mode !== "outside provider").render(mode === "nonallowlisted" ? "/v1/timeseries/matchups#1" : path);
    await waitFor(() => expect(view.result.current.data?.value).toBe("baseline"));
    await act(async () => { await view.result.current.mutate(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => !header(init, "If-None-Match"))).toBe(true);
  });

  it("reports an explicit Retry protocol error after exactly one unconditional missing-body304 recovery", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response("old")).mockResolvedValueOnce(response("old"))
      .mockResolvedValueOnce(same(tag2)).mockResolvedValueOnce(same(tag2));
    vi.stubGlobal("fetch", fetcher);
    const view = fixture().render();
    await waitFor(() => expect(view.result.current.data?.value).toBe("old"));
    await loadEnhancement(); await act(async () => { await view.result.current.mutate(); });
    await act(async () => { await view.result.current.mutate().catch(() => undefined); });
    await waitFor(() => expect(view.result.current.error).toMatchObject({
      status: 304, code: "conditional_body_missing", message: expect.stringContaining("Retry"),
    }));
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map(([, init]) => header(init, "If-None-Match"))).toEqual([null, null, tag, null]);
    expect(view.result.current.data).toEqual({ value: "old" });
  });

  it.each([
    [401, "200"], [401, "304"], [403, "200"], [403, "304"],
  ] as const)("ordinary capacity HTTP%s retires held old%s before its error body and survives rediscovery", async (status, mode) => {
    const oldBody = deferred<string>(), oldReply = deferred<Response>(), oldBegan = deferred<void>();
    const blocks = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const blockPaths = ["/v1/timeseries?map=Block1#1", "/v1/timeseries?map=Block2#1", "/v1/timeseries?map=Block3#1"];
    const deniedPath = "/v1/timeseries?map=Denied#1", probePath = "/v1/timeseries?map=Probe#1";
    const failure = heldFailure(status); let phase = "warm", blockReads = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const index = blockPaths.findIndex(resource => url.endsWith(resource));
      if (index >= 0) { blockReads += 1; return blocks[index].promise; }
      if (url.endsWith(deniedPath)) return failure.reply;
      if (url.endsWith(probePath)) return response("rediscovered", tag2);
      if (phase === "hold") {
        phase = "held";
        if (mode === "304") { oldBegan.resolve(); return oldReply.promise; }
        const res = response("held-old");
        Object.defineProperty(res, "text", { value: () => { oldBegan.resolve(); return oldBody.promise; } });
        return res;
      }
      return phase === "warm" ? response("old") : header(init, "If-None-Match") ? same(tag2) : response("fresh", tag2);
    });
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = renderHook(({ blocked, denied, probe }) => {
      const main = useApi<Data>(path);
      useApi<Data>(blocked ? blockPaths[0] : null);
      useApi<Data>(blocked ? blockPaths[1] : null);
      useApi<Data>(blocked ? blockPaths[2] : null);
      const rejection = useApi<Data>(denied ? deniedPath : null), rediscovered = useApi<Data>(probe ? probePath : null);
      return { data: main.data, refresh: main.mutate, error: rejection.error, probe: rediscovered.data,
        scope: useConditionalApiScope() };
    }, { wrapper: f.Wrapper, initialProps: { blocked: false, denied: false, probe: false } });
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await waitFor(() => expect(view.result.current.data?.value).toBe("old"));
      await loadEnhancement(); await act(async () => { await view.result.current.refresh(); });
      const generation = view.result.current.scope!.retention;
      phase = "hold"; act(() => { pending = view.result.current.refresh().catch(error => error); }); await oldBegan.promise;
      view.rerender({ blocked: true, denied: false, probe: false });
      await waitFor(() => expect(blockReads).toBe(3)); // One old read plus three siblings occupy all four permits.
      view.rerender({ blocked: true, denied: true, probe: false }); await failure.began;
      expect(view.result.current.scope!.capabilities).toBe(0);
      expect(view.result.current.scope!.retention).not.toBe(generation);
      expect(view.result.current.scope!.retired).toBe(false); expect(view.result.current.error).toBeUndefined();
      const deniedCalls = fetcher.mock.calls.filter(([url]) => url.endsWith(deniedPath));
      expect(deniedCalls).toHaveLength(1); expect(header(deniedCalls[0][1], "If-None-Match")).toBeNull();
      view.rerender({ blocked: true, denied: true, probe: true });
      await waitFor(() => expect(view.result.current.probe?.value).toBe("rediscovered"));
      expect(view.result.current.scope!.capabilities).not.toBe(0);
      phase = "released";
      await act(async () => {
        failure.release(); oldBody.resolve('{"value":"held-old"}'); oldReply.resolve(same());
        blocks.forEach(gate => gate.resolve(response("sibling-old"))); await pending;
      });
      await waitFor(() => expect(view.result.current.error).toMatchObject({ status }));
      expect(view.result.current.data?.value).toBe(mode === "200" ? "held-old" : "fresh");
      await act(async () => { await view.result.current.refresh(); });
      expect(header(fetcher.mock.calls.at(-1)?.[1], "If-None-Match")).toBeNull();
      await act(async () => { await view.result.current.refresh(); });
      expect(header(fetcher.mock.calls.at(-1)?.[1], "If-None-Match")).toBe(tag2);
      expect(view.result.current.data?.value).toBe("fresh");
    } finally {
      failure.release(); oldBody.resolve('{"value":"held-old"}'); oldReply.resolve(same());
      blocks.forEach(gate => gate.resolve(response("sibling-old")));
      await act(async () => { await pending.catch(() => undefined); }); view.unmount();
    }
  });

  it("unconditional304 recovery HTTP401 retires all pairs before its error body settles", async () => {
    const siblingPath = "/v1/momentum?window=7#1", failure = heldFailure(401);
    let phase = "warm", recoveryReads = 0;
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith(siblingPath)) return response(phase === "warm" ? "sibling-old" : "sibling-fresh");
      if (phase === "reject") return recoveryReads++ === 0 ? same(tag2) : failure.reply;
      return response("old");
    });
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = renderHook(() => {
      const main = useApi<Data>(path), sibling = useApi<Data>(siblingPath);
      return { data: main.data, error: main.error, refresh: main.mutate,
        sibling: sibling.data, refreshSibling: sibling.mutate, scope: useConditionalApiScope() };
    }, { wrapper: f.Wrapper });
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await waitFor(() => { expect(view.result.current.data?.value).toBe("old"); expect(view.result.current.sibling?.value).toBe("sibling-old"); });
      await loadEnhancement();
      await act(async () => { await Promise.all([view.result.current.refresh(), view.result.current.refreshSibling()]); });
      const generation = view.result.current.scope!.retention;
      phase = "reject"; act(() => { pending = view.result.current.refresh().catch(error => error); }); await failure.began;
      expect(recoveryReads).toBe(2); expect(view.result.current.scope!.capabilities).toBe(0);
      expect(view.result.current.scope!.retention).not.toBe(generation); expect(view.result.current.error).toBeUndefined();
      const attempts = fetcher.mock.calls.filter(([url]) => url.endsWith(path)).slice(-2);
      expect(attempts.map(([, init]) => header(init, "If-None-Match"))).toEqual([tag, null]);
      await act(async () => { failure.release(); await pending; });
      await waitFor(() => expect(view.result.current.error).toMatchObject({ status: 401 }));
      phase = "fresh"; await act(async () => { await view.result.current.refreshSibling(); });
      expect(header(fetcher.mock.calls.at(-1)?.[1], "If-None-Match")).toBeNull();
      expect(view.result.current.sibling?.value).toBe("sibling-fresh");
    } finally {
      failure.release(); await act(async () => { await pending.catch(() => undefined); }); view.unmount();
    }
  });

  it("does not retire a sibling's old SWR key when the initiating mounted hook switches path/revision", async () => {
    const held = deferred<string>(), began = deferred<void>();
    let hold = false;
    const newPath = "/v1/timeseries?map=New#2";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(newPath)) return header(init, "If-None-Match") ? same(tag2) : response("new", tag2);
      if (hold) {
        hold = false; const res = response("old");
        Object.defineProperty(res, "text", { value: () => { began.resolve(); return held.promise; } });
        return res;
      }
      return header(init, "If-None-Match") ? same() : response("old");
    });
    vi.stubGlobal("fetch", fetcher);
    const f = fixture();
    const view = renderHook(({ resource }) => {
      const first = useApi<Data>(resource), sibling = useApi<Data>(path);
      return { first: first.data, sibling: sibling.data, refresh: first.mutate, siblingRefresh: sibling.mutate };
    }, { wrapper: f.Wrapper, initialProps: { resource: path } });
    await waitFor(() => expect(view.result.current.first?.value).toBe("old"));
    await loadEnhancement(); await act(async () => { await view.result.current.refresh(); });
    hold = true;
    let pending!: Promise<unknown>;
    act(() => { pending = view.result.current.refresh(); });
    await began.promise;
    view.rerender({ resource: newPath });
    await waitFor(() => expect(view.result.current.first?.value).toBe("new"));
    await act(async () => { held.resolve('{"value":"old"}'); await pending; });
    expect(view.result.current.sibling?.value).toBe("old");
    expect(f.cached(path)).toEqual({ value: "old" }); expect(f.cached(newPath)).toEqual({ value: "new" });
    await act(async () => { await view.result.current.siblingRefresh(); });
    expect(header(fetcher.mock.calls.at(-1)?.[1], "If-None-Match")).toBe(tag);
  });

  it("rejects held A body through A→B→A without refilling the new provider's ledger", async () => {
    let hold = false, generation = "first";
    const body = deferred<string>(), began = deferred<void>();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (hold) {
        hold = false; const res = response("old");
        Object.defineProperty(res, "text", { value: () => { began.resolve(); return body.promise; } });
        return res;
      }
      return response(`${header(init, "authorization")}:${generation}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render();
    await waitFor(() => expect(view.result.current.data?.value).toBe("Bearer A-token:first"));
    await loadEnhancement(); await act(async () => { await view.result.current.mutate(); });
    const oldScope = view.result.current.scope!;
    hold = true; let pending!: Promise<unknown>;
    act(() => { pending = view.result.current.mutate().catch(error => error); }); await began.promise;
    h.auth.userId = "B"; view.rerender({ resource: path });
    await waitFor(() => expect(view.result.current.data?.value).toBe("Bearer B-token:first"));
    generation = "new"; h.auth.userId = "A"; view.rerender({ resource: path });
    await waitFor(() => expect(view.result.current.data?.value).toBe("Bearer A-token:new"));
    expect(view.result.current.scope).not.toBe(oldScope); expect(oldScope.retired).toBe(true);
    await act(async () => { body.resolve('{"value":"late-old-A"}'); await pending; });
    expect(f.cached(path)).toEqual({ value: "Bearer A-token:new" });
    expect(view.result.current.data?.value).toBe("Bearer A-token:new");
    const lastA = fetcher.mock.calls.filter(([, init]) => header(init, "authorization") === "Bearer A-token").at(-1);
    expect(header(lastA?.[1], "If-None-Match")).toBeNull();
  });

  it("sends no request for a held JWT retired by an auth transition", async () => {
    const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
    const fetcher = vi.fn(async () => response("current")); vi.stubGlobal("fetch", fetcher);
    const f = fixture(), view = f.render(); await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
    expect(fetcher).not.toHaveBeenCalled();
    h.auth.userId = "B"; view.rerender({ resource: path });
    await waitFor(() => expect(view.result.current.data?.value).toBe("current"));
    await act(async () => { token.resolve("B-token"); });
    expect(fetcher).toHaveBeenCalledOnce(); expect(f.cached(path, "A")).toBeUndefined();
  });

  it("survives StrictMode effect replay but retires ledger authority on real unmount", async () => {
    const fetcher = vi.fn(async () => response("strict")); vi.stubGlobal("fetch", fetcher);
    const f = fixture();
    const view = renderHook(() => {
      const query = useApi<Data>(path);
      return { data: query.data, scope: useConditionalApiScope() };
    }, { wrapper: ({ children }) => <StrictMode><f.Wrapper>{children}</f.Wrapper></StrictMode> });
    await waitFor(() => expect(view.result.current.data?.value).toBe("strict"));
    const authority = view.result.current.scope!;
    expect(authority.active).toBe(true); expect(authority.retired).toBe(false);
    view.unmount(); await act(async () => {});
    expect(authority.active).toBe(false); expect(authority.retired).toBe(true);
  });

  it("background import failure stays an unavailable enhancement without retrying load or an API operation", async () => {
    const load = vi.fn(async () => { throw new Error("chunk unavailable"); });
    const loader = createConditionalLoader(load), ordinary = vi.fn(async () => "ordinary");
    const read = async () => { if (!loader.get()) { loader.start(); return ordinary(); } throw new Error("unexpected ready"); };
    expect(await read()).toBe("ordinary"); await Promise.resolve();
    expect(await read()).toBe("ordinary");
    expect(load).toHaveBeenCalledOnce(); expect(ordinary).toHaveBeenCalledTimes(2); expect(loader.get()).toBeUndefined();
  });
});
