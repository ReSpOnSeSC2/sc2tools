import { runInNewContext } from "node:vm";
import { StrictMode, Suspense, startTransition, useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestAuthState = {
  userId: string | null; isLoaded: boolean; isSignedIn: boolean; getToken: () => Promise<string | null>;
};
const h = vi.hoisted(() => ({ auth: {
  userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>(),
}, authContext: null as import("react").Context<TestAuthState | null> | null }));
vi.mock("@clerk/nextjs", async () => {
  const React = await import("react");
  const context = React.createContext<TestAuthState | null>(null); h.authContext = context;
  return { useAuth: () => React.useContext(context) ?? h.auth };
});
// Deliberately do not mock clientApi/useOwnerRequestScope, request transport,
// DTO parsing, choice construction or selection retirement.
import { API_BASE } from "../clientApi";
import { usePrivateCommandSearch, type PrivateCommandSearchOptions } from "../usePrivateCommandSearch";
import { PRIVATE_COMMAND_SEARCH_BYTES, PRIVATE_COMMAND_SEARCH_TIMEOUT_MS } from "../privateCommandSearch";

// Verification is parent-owned; the drafting agent does not run this suite.
const PATH = "/v1/search/quick", URL = `${API_BASE.replace(/\/+$/, "")}${PATH}`;
const fetching = vi.fn<typeof fetch>();
function wire(label = "Private rival") {
  return { version: 2, groups: {
    opponents: { status: "ready", hasMore: false, items: [
      { pulseId: "owned-id", displayNameSample: label, race: null, lastSeen: null },
    ] },
    customBuilds: { status: "ready", hasMore: false, items: [] },
    maps: { status: "unavailable", hasMore: null, items: [], reason: "deferred" },
  } };
}
function response(value: unknown = wire(), options: {
  body?: BodyInit | null; headers?: Record<string, string>; status?: number; url?: string; redirected?: boolean;
} = {}) {
  const result = new Response(Object.hasOwn(options, "body") ? options.body : JSON.stringify(value), {
    status: options.status ?? 200, headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperties(result, { url: { value: options.url ?? URL }, redirected: { value: options.redirected ?? false } });
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function options(overrides: Partial<PrivateCommandSearchOptions> = {}): PrivateCommandSearchOptions {
  return { open: true, scope: "all", query: "Pr", ownerKey: "A", openingEpoch: {}, routeEpoch: {}, ...overrides };
}
function fixture(initial = options(), strict = false) {
  const wrapper = ({ children }: { children: ReactNode }) => strict ? <StrictMode>{children}</StrictMode> : <>{children}</>;
  return renderHook((props: PrivateCommandSearchOptions) => usePrivateCommandSearch(props), { initialProps: initial, wrapper });
}
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  });
}
function heldBody(bytes?: Uint8Array, rejectCancel = false) {
  const cancel = vi.fn(() => rejectCancel ? Promise.reject(new Error("private cancel detail")) : undefined);
  const body = new ReadableStream<Uint8Array>({ start(controller) { if (bytes) controller.enqueue(bytes); }, cancel });
  return { body, cancel };
}
const authorization = (init?: RequestInit) => new Headers(init?.headers).get("authorization");
type SearchResult = ReturnType<typeof usePrivateCommandSearch>;
const suspended = new Promise<never>(() => {});
function AuthBoundary({ value, children }: { value: TestAuthState; children: ReactNode }) {
  const Context = h.authContext;
  if (!Context) throw new Error("Missing test auth context");
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function ConcurrentConsumer({ config, blocked, publish }: {
  config: PrivateCommandSearchOptions; blocked: boolean; publish: (value: SearchResult) => void;
}) {
  const value = usePrivateCommandSearch(config);
  useLayoutEffect(() => { publish(value); }, [publish, value]);
  if (blocked) throw suspended;
  return <button type="button">Committed private search</button>;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`);
  fetching.mockReset().mockImplementation(async () => response()); vi.stubGlobal("fetch", fetching);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("actual owner-scoped private search admission", () => {
  it.each([
    { open: false }, { scope: "guides" as const }, { query: "a" }, { query: "😀" },
    { query: "ab\n" }, { query: "a\u0085b" }, { query: "a\ud800b" },
    { ownerKey: "B" }, { openingEpoch: null }, { routeEpoch: null },
  ])("does no JWT lookup or request for inactive/invalid scope %#", overrides => {
    const view = fixture(options(overrides));
    return advance(1000).then(() => {
      expect(view.result.current.phase).toBe("idle"); expect(view.result.current.data).toBeNull();
      expect(h.auth.getToken).not.toHaveBeenCalled(); expect(fetching).not.toHaveBeenCalled();
    });
  });
  it.each(["loading", "signed-out"])("withholds stale userId during %s", async mode => {
    if (mode === "loading") h.auth.isLoaded = false; else h.auth.isSignedIn = false;
    const view = fixture(); await advance(1000);
    expect(view.result.current.phase).toBe("idle"); expect(fetching).not.toHaveBeenCalled();
    expect(h.auth.getToken).not.toHaveBeenCalled();
  });
  it("debounces 200ms, preserves literal q and uses one fixed credential-free-cache POST", async () => {
    const json = vi.fn(); const answer = response(); Object.defineProperty(answer, "json", { value: json });
    fetching.mockResolvedValue(answer);
    const view = fixture(options({ query: "  É  [a].*  " }));
    await advance(199); expect(h.auth.getToken).not.toHaveBeenCalled(); expect(fetching).not.toHaveBeenCalled();
    await advance(1); expect(view.result.current.phase).toBe("ready"); expect(fetching).toHaveBeenCalledOnce();
    const [url, init] = fetching.mock.calls[0];
    expect(url).toBe(URL); expect(String(url)).not.toMatch(/É|%C3|q=/);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
      body: JSON.stringify({ q: "É  [a].*" }), signal: expect.any(AbortSignal) });
    expect(authorization(init)).toBe("Bearer A-token");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("cookie")).toBeNull(); expect(json).not.toHaveBeenCalled();
  });
  it("does not restart when runOwned/getToken functions get fresh render identities", async () => {
    const initial = options(), view = fixture(initial);
    for (let index = 0; index < 10; index += 1) {
      h.auth.getToken = vi.fn<() => Promise<string | null>>().mockResolvedValue("A-token"); view.rerender({ ...initial });
    }
    await advance(200); expect(fetching).toHaveBeenCalledOnce();
    for (let index = 0; index < 10; index += 1) view.rerender({ ...initial });
    await advance(1000); expect(fetching).toHaveBeenCalledOnce(); expect(view.result.current.phase).toBe("ready");
  });
  it("survives StrictMode effect replay without issuing two debounced reads", async () => {
    const view = fixture(options(), true); await advance(200);
    expect(view.result.current.phase).toBe("ready"); expect(fetching).toHaveBeenCalledOnce();
  });
  it("never sends an anonymous private request if the current scoped token is absent", async () => {
    h.auth.getToken.mockResolvedValue(null); const view = fixture(); await advance(200);
    expect(fetching).not.toHaveBeenCalled(); expect(view.result.current.error?.code).toBe("authentication_required");
  });
});

describe("token, header and body retirement without a private cache", () => {
  it("rejects held JWT through owner A→B→A without sending B credentials as A", async () => {
    const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
    const initial = options(), view = fixture(initial); await advance(200);
    expect(h.auth.getToken).toHaveBeenCalledOnce(); expect(fetching).not.toHaveBeenCalled();
    h.auth.userId = "B"; view.rerender({ ...initial, ownerKey: "B" });
    expect(view.result.current.data).toBeNull();
    h.auth.userId = "A"; view.rerender({ ...initial }); await advance(200);
    await act(async () => token.resolve("B-token")); await advance();
    expect(fetching).toHaveBeenCalledOnce(); expect(authorization(fetching.mock.calls[0][1])).toBe("Bearer A-token");
    expect(view.result.current.choices[0].label).toBe("Private rival");
  });
  it.each(["query", "route", "opening", "loading", "signed-out", "close"])(
    "retires a held JWT through %s A→B→A even if final strings match", async boundary => {
      const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
      const initial = options(), view = fixture(initial); await advance(200);
      if (boundary === "loading") h.auth.isLoaded = false;
      if (boundary === "signed-out") h.auth.isSignedIn = false;
      view.rerender({ ...initial, ...(boundary === "query" ? { query: "Other" } : {}),
        ...(boundary === "route" ? { routeEpoch: {} } : {}), ...(boundary === "opening" ? { openingEpoch: {} } : {}),
        ...(boundary === "close" ? { open: false } : {}) });
      expect(view.result.current.data).toBeNull();
      h.auth.isLoaded = true; h.auth.isSignedIn = true;
      view.rerender({ ...initial }); await advance(200);
      await act(async () => token.resolve("retired-token")); await advance();
      expect(fetching).toHaveBeenCalledOnce(); expect(authorization(fetching.mock.calls[0][1])).toBe("Bearer A-token");
      expect(view.result.current.phase).toBe("ready");
    },
  );
  it("clears ready answers immediately, including raw-query changes with identical trimmed q", async () => {
    const initial = options(), view = fixture(initial); await advance(200);
    expect(view.result.current.data).not.toBeNull();
    view.rerender({ ...initial, query: " Pr " });
    expect(view.result.current.data).toBeNull(); expect(view.result.current.choices).toEqual([]);
    await advance(199); expect(fetching).toHaveBeenCalledOnce();
    await advance(1); expect(fetching).toHaveBeenCalledTimes(2);
  });
  it("cancels a late retired header body without reading or publishing it", async () => {
    const headers = deferred<Response>(); fetching.mockReturnValueOnce(headers.promise);
    const initial = options(), view = fixture(initial); await advance(200);
    view.rerender({ ...initial, query: "New" }); await advance(200);
    expect(view.result.current.phase).toBe("ready");
    const oldBody = heldBody(undefined, true), old = response(null, { body: oldBody.body });
    await act(async () => headers.resolve(old)); await advance();
    expect(oldBody.cancel).toHaveBeenCalledOnce(); expect(old.body?.locked).toBe(false);
    expect(view.result.current.choices[0].label).toBe("Private rival");
  });
  it("retires an actual held stream through query ABA and catches rejecting cancellation", async () => {
    const old = heldBody(new TextEncoder().encode('{"version":'), true);
    fetching.mockResolvedValueOnce(response(null, { body: old.body })).mockImplementation(async () => response(wire("New answer")));
    const initial = options(), view = fixture(initial); await advance(200);
    const signal = fetching.mock.calls[0][1]?.signal;
    expect(view.result.current.phase).toBe("loading");
    view.rerender({ ...initial, query: "Other" }); view.rerender({ ...initial });
    expect(view.result.current.data).toBeNull(); await advance(200);
    expect(signal?.aborted).toBe(true); expect(old.cancel).toHaveBeenCalledOnce();
    expect(view.result.current.choices[0].label).toBe("New answer");
  });
  it("retires held JWT on unmount and does a fresh request on remount", async () => {
    const token = deferred<string>(); h.auth.getToken.mockReturnValueOnce(token.promise);
    const view = fixture(); await advance(200); view.unmount();
    await act(async () => token.resolve("retired-token")); await advance();
    expect(fetching).not.toHaveBeenCalled();
    const next = fixture(); await advance(200); expect(next.result.current.phase).toBe("ready");
    expect(fetching).toHaveBeenCalledOnce();
  });
  it.each(["JWT", "body"])("bounds a held %s, permits explicit Retry and ignores late settlement", async stage => {
    const token = deferred<string>(), old = heldBody(undefined, true);
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(token.promise);
    else fetching.mockResolvedValueOnce(response(null, { body: old.body }));
    const view = fixture(); await advance(200); await advance(PRIVATE_COMMAND_SEARCH_TIMEOUT_MS);
    expect(view.result.current.phase).toBe("error"); expect(view.result.current.error?.code).toBe("request_timeout");
    expect(view.result.current.choices).toEqual([]);
    act(() => view.result.current.retry()); expect(view.result.current.data).toBeNull();
    await advance(200); expect(view.result.current.phase).toBe("ready");
    await act(async () => token.resolve("retired-token")); await advance();
    expect(fetching).toHaveBeenCalledTimes(stage === "JWT" ? 1 : 2);
    expect(view.result.current.choices[0].label).toBe("Private rival");
    if (stage === "body") expect(old.cancel).toHaveBeenCalledOnce();
  });
});

describe("bounded raw transport before JSON/DTO admission", () => {
  it("accepts actual foreign-realm Uint8Array chunks without weakening the raw byte boundary", async () => {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(wire())));
    const foreign = runInNewContext("Uint8Array.from(bytes)", { bytes }) as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(ArrayBuffer.isView(foreign)).toBe(true);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(foreign); controller.close(); } });
    fetching.mockResolvedValueOnce(response(null, { body }));
    const view = fixture(); await advance(200);
    expect(view.result.current.phase).toBe("ready"); expect(view.result.current.choices[0].label).toBe("Private rival");
  });
  it("rejects a different view with a spoofed Uint8Array tag", async () => {
    const view = new DataView(new ArrayBuffer(8));
    Object.defineProperty(view, Symbol.toStringTag, { value: "Uint8Array" });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(view as unknown as Uint8Array); controller.close();
    } });
    fetching.mockResolvedValueOnce(response(null, { body }));
    const search = fixture(); await advance(200);
    expect(search.result.current.error?.code).toBe("invalid_response"); expect(search.result.current.data).toBeNull();
  });
  it.each([undefined, "8"])("rejects streamed overflow with absent/lying Content-Length=%s", async length => {
    const old = heldBody(new Uint8Array(PRIVATE_COMMAND_SEARCH_BYTES + 1));
    fetching.mockResolvedValueOnce(response(null, { body: old.body, headers: length ? { "content-length": length } : {} }));
    const view = fixture(); await advance(200);
    expect(view.result.current.error?.code).toBe("response_too_large");
    expect(view.result.current.data).toBeNull(); expect(old.cancel).toHaveBeenCalledOnce();
    expect(old.body.locked).toBe(false);
  });
  it("accepts exactly64KiB raw UTF-8 JSON, independently of the smaller canonical DTO", async () => {
    const body = JSON.stringify(wire()).padEnd(PRIVATE_COMMAND_SEARCH_BYTES, " ");
    expect(new TextEncoder().encode(body).byteLength).toBe(PRIVATE_COMMAND_SEARCH_BYTES);
    fetching.mockResolvedValueOnce(response(null, { body })); const view = fixture(); await advance(200);
    expect(view.result.current.phase).toBe("ready");
  });
  it.each([new Uint8Array([0xc3]), new Uint8Array([0xc0, 0xaf]), '{"version":', '{"version":1,"groups":{}}'])(
    "rejects fatal UTF-8, malformed JSON and malformed DTO %#", async body => {
      fetching.mockResolvedValueOnce(response(null, { body })); const view = fixture(); await advance(200);
      expect(view.result.current.phase).toBe("error"); expect(view.result.current.data).toBeNull();
      expect(view.result.current.choices).toEqual([]);
    },
  );
  it.each<NonNullable<Parameters<typeof response>[1]>>([
    { status: 503 }, { redirected: true }, { url: "https://foreign.test/search" },
    { headers: { "content-type": "text/html" } }, { headers: { "content-length": "65537" } },
    { headers: { "content-length": "-1" } },
  ])("rejects headers/redirects/non-JSON before reading an untrusted body %#", async headerOptions => {
    const old = heldBody();
    fetching.mockResolvedValueOnce(response(null, { ...headerOptions, body: old.body }));
    const view = fixture(); await advance(200);
    expect(view.result.current.phase).toBe("error"); expect(old.cancel).toHaveBeenCalledOnce();
    expect(view.result.current.error?.message).not.toMatch(/foreign|503|65537/i);
  });
  it("contains errors without keeping private query/IDs in storage, history or a previous result", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem"), read = vi.spyOn(Storage.prototype, "getItem");
    const push = vi.spyOn(history, "pushState"), replace = vi.spyOn(history, "replaceState");
    const initial = options(), view = fixture(initial); await advance(200);
    fetching.mockRejectedValueOnce(new Error("secret token and query"));
    act(() => view.result.current.retry()); await advance(200);
    expect(view.result.current.phase).toBe("error"); expect(view.result.current.data).toBeNull();
    expect(view.result.current.error?.message).not.toContain("secret");
    view.rerender({ ...initial, open: false }); view.rerender({ ...initial }); await advance(200);
    expect(fetching).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });
});

describe("only committed search lifetimes own requests and token callbacks", () => {
  it("keeps a held committed result current when a replacement query/route render suspends and is abandoned", async () => {
    const headers = deferred<Response>(); fetching.mockReturnValueOnce(headers.promise);
    const initial = options(), visible: { current: SearchResult | null } = { current: null };
    const publish = (value: SearchResult) => { visible.current = value; };
    const tree = (config: PrivateCommandSearchOptions, blocked: boolean) => <Suspense fallback={<p>Pending search</p>}>
      <ConcurrentConsumer config={config} blocked={blocked} publish={publish} />
    </Suspense>;
    const view = render(tree(initial, false)); await advance(200);
    expect(visible.current?.phase).toBe("loading");
    act(() => startTransition(() => view.rerender(tree({ ...initial, query: "Speculative", routeEpoch: {} }, true))));
    expect(screen.getByRole("button", { name: "Committed private search" })).toBeTruthy();
    await act(async () => headers.resolve(response(wire("Committed answer")))); await advance();
    expect(visible.current?.phase).toBe("ready");
    expect(visible.current?.choices[0].label).toBe("Committed answer"); expect(fetching).toHaveBeenCalledOnce();
    const draft = visible.current!.selectionDraft(visible.current!.choices[0]);
    expect(draft?.isCurrent()).toBe(true);
    view.rerender(tree(initial, false)); expect(draft?.isCurrent()).toBe(true);
  });
  it("does not expose a speculative JWT callback to the visible committed debounce", async () => {
    const committedGetter = vi.fn<() => Promise<string | null>>().mockResolvedValue("A-token");
    const speculativeGetter = vi.fn<() => Promise<string | null>>().mockResolvedValue("speculative-token");
    h.auth.getToken = committedGetter;
    const initial = options(), visible: { current: SearchResult | null } = { current: null };
    const publish = (value: SearchResult) => { visible.current = value; };
    const tree = (config: PrivateCommandSearchOptions, blocked: boolean) => <Suspense fallback={<p>Pending search</p>}>
      <ConcurrentConsumer config={config} blocked={blocked} publish={publish} />
    </Suspense>;
    const view = render(tree(initial, false));
    h.auth.getToken = speculativeGetter;
    act(() => startTransition(() => view.rerender(tree({ ...initial, query: "Speculative" }, true))));
    await advance(200);
    expect(visible.current?.phase).toBe("ready"); expect(committedGetter).toHaveBeenCalledOnce();
    expect(speculativeGetter).not.toHaveBeenCalled(); expect(fetching).toHaveBeenCalledOnce();
    expect(authorization(fetching.mock.calls[0][1])).toBe("Bearer A-token");
    expect(fetching.mock.calls[0][1]?.body).toBe(JSON.stringify({ q: "Pr" }));
  });
  it("does not retire the actual ownerScope for an uncommitted suspended account render", async () => {
    const token = deferred<string>(), committedGetter = vi.fn<() => Promise<string | null>>().mockReturnValue(token.promise);
    const speculativeGetter = vi.fn<() => Promise<string | null>>().mockResolvedValue("B-token");
    h.auth.getToken = committedGetter;
    const initial = options(), visible: { current: SearchResult | null } = { current: null };
    const publish = (value: SearchResult) => { visible.current = value; };
    const committedAuth: TestAuthState = { ...h.auth };
    const speculativeAuth: TestAuthState = { ...committedAuth, userId: "B", getToken: speculativeGetter };
    // Unlike the ordinary rerender cases, a concurrent auth transition needs
    // render-local context. Mutating the global fallback to B would also feed
    // B to A's urgent completion render, legitimately committing an idle A/B
    // mismatch instead of simulating an abandoned B tree.
    const tree = (config: PrivateCommandSearchOptions, blocked: boolean, auth = committedAuth) => <Suspense fallback={<p>Pending search</p>}>
      <AuthBoundary value={auth}><ConcurrentConsumer config={config} blocked={blocked} publish={publish} /></AuthBoundary>
    </Suspense>;
    const view = render(tree(initial, false)); await advance(200);
    expect(committedGetter).toHaveBeenCalledOnce(); expect(fetching).not.toHaveBeenCalled();
    act(() => startTransition(() => view.rerender(tree({ ...initial, ownerKey: "B" }, true, speculativeAuth))));
    await act(async () => token.resolve("A-token")); await advance();
    expect(visible.current?.phase).toBe("ready"); expect(speculativeGetter).not.toHaveBeenCalled();
    expect(fetching).toHaveBeenCalledOnce(); expect(authorization(fetching.mock.calls[0][1])).toBe("Bearer A-token");
    view.rerender(tree(initial, false)); expect(visible.current?.phase).toBe("ready");
  });
});

describe("selection drafts have the exact ready request's lifetime", () => {
  it.each(["query", "owner", "route", "opening", "close", "retry", "unmount"])(
    "immediately retires a draft on %s and rejects a copied choice object", async boundary => {
      const initial = options(), view = fixture(initial); await advance(200);
      const choice = view.result.current.choices[0], choose = view.result.current.selectionDraft;
      const draft = choose(choice); expect(draft?.isCurrent()).toBe(true);
      expect(choose({ ...choice })).toBeNull();
      expect(draft?.href).toBe("/app/opponents/owned-id");
      if (boundary === "owner") { h.auth.userId = "B"; view.rerender({ ...initial, ownerKey: "B" }); }
      else if (boundary === "retry") act(() => view.result.current.retry());
      else if (boundary === "unmount") view.unmount();
      else view.rerender({ ...initial, ...(boundary === "query" ? { query: "New" } : {}),
        ...(boundary === "route" ? { routeEpoch: {} } : {}), ...(boundary === "opening" ? { openingEpoch: {} } : {}),
        ...(boundary === "close" ? { open: false } : {}) });
      expect(draft?.isCurrent()).toBe(false); expect(choose(choice)).toBeNull();
    },
  );
});
