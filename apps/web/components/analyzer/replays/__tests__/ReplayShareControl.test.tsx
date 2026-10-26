import { useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig, useSWRConfig, type Middleware } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySharingResponse } from "../types";
import { ReplayShareControl } from "../ReplayShareControl";

type Gate<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type Request = { owner: string; method: string; body: unknown; signal: AbortSignal | null | undefined };
const h = vi.hoisted(() => ({
  owner: "owner-a" as string | null, token: vi.fn(), fetch: vi.fn(), copy: vi.fn(), success: vi.fn(), error: vi.fn(),
  server: {} as Record<string, ReplaySharingResponse>, requests: [] as Request[], revision: 0,
  cacheGate: undefined as Gate<void> | undefined, cacheAdmissions: 0,
  publish: undefined as ((owner: string, value: ReplaySharingResponse) => Promise<unknown>) | undefined,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: h.owner, isLoaded: true, isSignedIn: !!h.owner, getToken: h.token }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: h.success, error: h.error } }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(value: unknown, status = 200) {
  const result = new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  // Keep transport/body settlement deterministic while using real clientApi/SWR.
  Object.defineProperty(result, "json", { configurable: true, value: async () => structuredClone(value) });
  return result;
}
function record(input: RequestInfo | URL, init?: RequestInit): Request {
  expect(String(input)).toBe("http://localhost:8080/v1/me/replay-sharing");
  const authorization = new Headers(init?.headers).get("authorization") || "";
  expect(authorization).toMatch(/^Bearer synthetic-owner-[ab]$/);
  const request = { owner: authorization.slice("Bearer synthetic-".length), method: init?.method || "GET",
    body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal };
  expect(["GET", "PUT"]).toContain(request.method); h.requests.push(request); return request;
}
function commit(request: Request) {
  expect(Object.keys(request.body as object)).toEqual(["enabled"]);
  const enabled = (request.body as { enabled: boolean }).enabled;
  expect(typeof enabled).toBe("boolean");
  const next = { enabled, handle: enabled ? h.server[request.owner].handle || "fresh-" + request.owner : h.server[request.owner].handle,
    updatedAt: new Date(Date.UTC(2026, 9, 26, 0, 0, ++h.revision)).toISOString() };
  h.server[request.owner] = next; return next;
}
const writes = () => h.requests.filter(request => request.method === "PUT");
const reads = () => h.requests.filter(request => request.method === "GET");
const manualName = "Copy replay page link manually";
const href = (handle: string) => window.location.origin + "/players/" + encodeURIComponent(handle) + "/replays";

// Only cache-updater invocation can be held. The real SWR provider, GET fetcher,
// owner scope and mutation publication remain in use for every test.
const heldCache: Middleware = useNext => function useHeldCache(key, fetcher, config) {
  const result = useNext(key, fetcher, config);
  const mutate: typeof result.mutate = (...args) => {
    if (typeof args[0] === "function" && h.cacheGate) {
      h.cacheAdmissions++; const pending = h.cacheGate;
      return pending.promise.then(() => result.mutate(...args));
    }
    return result.mutate(...args);
  };
  return { ...result, mutate };
};
function CacheProbe({ children }: { children: ReactNode }) {
  const { mutate } = useSWRConfig();
  useLayoutEffect(() => {
    h.publish = (owner, value) => mutate(["authenticated-api", owner, "/v1/me/replay-sharing"], value, { revalidate: false });
    return () => { h.publish = undefined; };
  }, [mutate]);
  return children;
}
function mount() {
  const cache = new Map(), provider = () => cache;
  const content = (show = true) => <SWRConfig value={{ provider, dedupingInterval: 2000, use: [heldCache] }}>
    <CacheProbe>{show ? <ReplayShareControl /> : null}</CacheProbe>
  </SWRConfig>;
  const view = render(content());
  return { ...view, show: (show: boolean) => view.rerender(content(show)), update: () => view.rerender(content()) };
}
async function ready() { return screen.findByRole("button", { name: /^(Share|Sharing on)$/ }); }
async function settings() {
  const actions = screen.getByRole("group", { name: "Replay sharing actions" });
  const trigger = within(actions).getByRole("button", { name: /^(Share|Sharing on|Check sharing status)$/ });
  trigger.focus(); fireEvent.click(trigger);
  return screen.findByRole("dialog", { name: "Share your replay archive" });
}
async function enable() {
  const modal = await settings(); const button = within(modal).getByRole("button", { name: "Turn on and copy link" });
  button.focus(); fireEvent.click(button); return modal;
}
async function closeSettings() {
  const modal = screen.getByRole("dialog", { name: "Share your replay archive" });
  fireEvent.click(modal.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share your replay archive" })).toBeNull());
}
async function drain() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

beforeEach(() => {
  h.owner = "owner-a"; h.revision = 0; h.requests = []; h.cacheGate = undefined; h.cacheAdmissions = 0;
  h.server = { "owner-a": { enabled: false, handle: null, updatedAt: "2026-10-26T00:00:00.000Z" },
    "owner-b": { enabled: false, handle: null, updatedAt: "2026-10-26T00:00:00.000Z" } };
  h.token.mockReset().mockImplementation(async () => "synthetic-" + h.owner);
  h.copy.mockReset().mockResolvedValue(undefined); h.success.mockReset(); h.error.mockReset();
  h.fetch.mockReset().mockImplementation(async (input, init) => {
    const request = record(input, init);
    return response(request.method === "GET" ? h.server[request.owner] : commit(request));
  });
  vi.stubGlobal("fetch", h.fetch); vi.stubGlobal("navigator", { onLine: true, clipboard: { writeText: h.copy } });
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("replay consent and copy admission with real SWR", () => {
  it("describes an initial GET failure as a load error and retries without suggesting a prior write", async () => {
    h.fetch.mockImplementationOnce(async (input, init) => { record(input, init); return response({ message: "Synthetic unavailable" }, 503); });
    mount(); await screen.findByRole("button", { name: "Check sharing status" });
    h.fetch.mockImplementationOnce(async (input, init) => { record(input, init); return response({ message: "Synthetic unavailable" }, 503); });
    await settings(); await screen.findByText(/Sharing status could not be loaded/);
    expect(screen.queryByText(/earlier change may have completed/i)).toBeNull();
    expect(writes()).toHaveLength(0); expect(reads()).toHaveLength(2); expect(h.copy).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog", { name: "Share your replay archive" });
    fireEvent.click(within(modal).getByRole("button", { name: "Check sharing status" }));
    await screen.findByRole("button", { name: "Turn on and copy link" });
    expect(reads()).toHaveLength(3); expect(writes()).toHaveLength(0);
  });

  it("uses one fresh initial GET, no mount copy or PUT, and copies only the newly returned enabled handle", async () => {
    mount(); await ready(); expect(reads()).toHaveLength(1); expect(writes()).toHaveLength(0); expect(h.copy).not.toHaveBeenCalled();
    h.cacheGate = gate<void>(); await enable();
    await waitFor(() => expect(h.cacheAdmissions).toBe(1));
    expect(writes()).toHaveLength(1); expect(writes()[0].body).toEqual({ enabled: true }); expect(h.copy).not.toHaveBeenCalled();
    await act(async () => { h.cacheGate!.resolve(); });
    await waitFor(() => expect(h.copy).toHaveBeenCalledTimes(1));
    expect(h.copy).toHaveBeenCalledWith(href("fresh-owner-a"));
    expect(h.success).not.toHaveBeenCalledWith("Public replay page is live"); expect(h.success).toHaveBeenCalledWith("Replay page link copied");
    expect(reads()).toHaveLength(1); expect(writes()).toHaveLength(1);
  });

  it.each(["owner", "ABA", "close", "unmount"])("retires held JWT before any PUT after %s", async change => {
    const view = mount(); await ready(); const token = gate<string | null>(); h.token.mockReturnValueOnce(token.promise);
    await enable(); await waitFor(() => expect(h.token).toHaveBeenCalledTimes(2));
    if (change === "close") await closeSettings();
    else if (change === "unmount") view.unmount();
    else { h.owner = "owner-b"; view.update(); await ready(); if (change === "ABA") { h.owner = "owner-a"; view.update(); await ready(); } }
    await act(async () => { token.resolve("synthetic-owner-a"); });
    expect(writes()).toHaveLength(0); expect(h.copy).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: manualName })).toBeNull();
  });

  it.each(["owner", "ABA", "close", "unmount"])("suppresses held response-body cache, toast and copy after %s", async change => {
    const view = mount(); await ready(); const body = gate<ReplaySharingResponse>();
    h.fetch.mockImplementationOnce(async (input, init) => {
      const request = record(input, init), next = commit(request), result = response(next);
      Object.defineProperty(result, "json", { value: () => body.promise }); return result;
    });
    await enable(); await waitFor(() => expect(writes()).toHaveLength(1));
    if (change === "close") await closeSettings();
    else if (change === "unmount") view.unmount();
    else { h.owner = "owner-b"; view.update(); await ready(); if (change === "ABA") { h.owner = "owner-a"; view.update(); await ready(); } }
    await act(async () => { body.resolve(h.server["owner-a"]); });
    expect(h.copy).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: manualName })).toBeNull();
    if (change === "close") {
      expect(screen.getByRole("button", { name: "Check sharing status" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Copy public replay page link" })).toBeNull(); expect(reads()).toHaveLength(1);
    }
  });

  it("guards delayed cache-updater publication after close and checks unknown status only on next open", async () => {
    mount(); await ready(); h.cacheGate = gate<void>(); await enable();
    await waitFor(() => expect(h.cacheAdmissions).toBe(1)); await closeSettings();
    await act(async () => { h.cacheGate!.resolve(); });
    expect(h.copy).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
    expect(reads()).toHaveLength(1); expect(writes()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Check sharing status" })).toBeTruthy();
    await settings(); await screen.findByRole("button", { name: "Turn off sharing" });
    expect(reads()).toHaveLength(2); expect(writes()).toHaveLength(1); expect(h.copy).not.toHaveBeenCalled();
  });

  it("keeps unknown after a failed status GET despite warm OFF data, then allows an explicit retry", async () => {
    mount(); await ready(); h.cacheGate = gate<void>(); await enable();
    await waitFor(() => expect(h.cacheAdmissions).toBe(1)); await closeSettings(); await act(async () => { h.cacheGate!.resolve(); });
    h.fetch.mockImplementationOnce(async (input, init) => { record(input, init); return response({ message: "Synthetic unavailable" }, 503); });
    await settings(); await waitFor(() => expect(h.error).toHaveBeenCalledWith("Couldn't check replay sharing", expect.any(Object)));
    expect(reads()).toHaveLength(2); expect(writes()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Turn off sharing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on and copy link" })).toBeNull(); expect(h.copy).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog", { name: "Share your replay archive" });
    fireEvent.click(within(modal).getByRole("button", { name: "Check sharing status" }));
    await screen.findByRole("button", { name: "Turn off sharing" }); expect(reads()).toHaveLength(3); expect(writes()).toHaveLength(1);
  });

  it.each(["visibility", "owner"])("rejects a held unknown-status refresh after %s retirement", async change => {
    const view = mount(); await ready(); h.cacheGate = gate<void>(); await enable();
    await waitFor(() => expect(h.cacheAdmissions).toBe(1)); await closeSettings(); await act(async () => { h.cacheGate!.resolve(); });
    const pending = gate<Response>(); h.fetch.mockImplementationOnce(async (input, init) => { record(input, init); return pending.promise; });
    await settings(); await waitFor(() => expect(reads()).toHaveLength(2));
    if (change === "visibility") await closeSettings(); else {
      h.owner = "owner-b"; view.update(); await ready();
      expect(reads().map(request => request.owner)).toEqual(["owner-a", "owner-a", "owner-b"]);
    }
    await act(async () => { pending.resolve(response(h.server["owner-a"])); });
    expect(h.copy).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: manualName })).toBeNull();
    if (change === "visibility") {
      expect(screen.getByRole("button", { name: "Check sharing status" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Copy public replay page link" })).toBeNull();
      await settings(); await screen.findByRole("button", { name: "Turn off sharing" }); expect(reads()).toHaveLength(3);
    } else {
      expect(screen.queryByText(/earlier change may have completed/i)).toBeNull();
      expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
      expect(reads().map(request => request.owner)).toEqual(["owner-a", "owner-a", "owner-b"]);
    }
  });

  it("forces a fresh GET on a same-owner remount inside SWR's completed two-second dedupe window", async () => {
    vi.useFakeTimers(); const began = Date.now(), pendingPut = gate<Response>(), pendingGet = gate<Response>();
    const view = mount(); await drain(); expect(reads()).toHaveLength(1);
    h.fetch.mockImplementationOnce(async (input, init) => { record(input, init); return pendingPut.promise; });
    const header = screen.getByRole("button", { name: "Share" }); header.focus(); fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: "Turn on and copy link" })); await drain(); expect(writes()).toHaveLength(1);
    view.show(false); await drain();
    h.server["owner-a"] = { enabled: true, handle: "fresh-owner-a", updatedAt: "2026-10-26T00:00:01.000Z" };
    h.fetch.mockImplementationOnce(async (input, init) => { record(input, init); return pendingGet.promise; });
    view.show(true); await drain();
    expect(Date.now() - began).toBeLessThan(2000); expect(reads()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy public replay page link" })).toBeNull();
    await act(async () => { pendingGet.resolve(response(h.server["owner-a"])); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("button", { name: "Sharing on" })).toBeTruthy();
    await act(async () => { pendingPut.resolve(response(h.server["owner-a"])); await vi.advanceTimersByTimeAsync(0); });
    expect(reads()).toHaveLength(2); expect(writes()).toHaveLength(1); expect(h.copy).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
  });

  it("bounds an already-issued PUT body at twenty seconds without claiming it was rolled back", async () => {
    mount(); await ready(); vi.useFakeTimers(); const body = gate<ReplaySharingResponse>();
    h.fetch.mockImplementationOnce(async (input, init) => {
      const next = commit(record(input, init)), result = response(next); Object.defineProperty(result, "json", { value: () => body.promise }); return result;
    });
    const header = screen.getByRole("button", { name: "Share" }); header.focus(); fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: "Turn on and copy link" })); await drain();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(h.server["owner-a"].enabled).toBe(true); expect(writes()).toHaveLength(1); expect(reads()).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Check sharing status" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Turn on and copy link" })).toBeNull(); expect(h.copy).not.toHaveBeenCalled();
    await act(async () => { body.resolve(h.server["owner-a"]); await vi.advanceTimersByTimeAsync(0); });
    expect(h.success).not.toHaveBeenCalled(); expect(h.copy).not.toHaveBeenCalled();
  });

  it("keeps manual recovery nested and selected after first enable, then returns to the new modal copy action", async () => {
    mount(); await ready(); h.copy.mockRejectedValue(new Error("Denied")); await enable();
    const manual = await screen.findByRole("dialog", { name: manualName });
    const input = within(manual).getByRole("textbox", { name: manualName }) as HTMLInputElement;
    expect(input.value).toBe(href("fresh-owner-a")); expect(input.readOnly).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    fireEvent.keyDown(input, { key: "Escape" });
    const settingsModal = screen.getByRole("dialog", { name: "Share your replay archive" });
    await waitFor(() => expect(document.activeElement).toBe(within(settingsModal).getByRole("button", { name: "Copy link" })));
    expect(document.body.style.overflow).toBe("hidden"); expect(writes()).toHaveLength(1); expect(reads()).toHaveLength(1);
  });

  it("settles held clipboard recovery, returns to the outside action and retries without another consent write", async () => {
    h.server["owner-a"] = { enabled: true, handle: "original-a" };
    mount(); await ready(); vi.useFakeTimers(); const pending = gate<void>(); h.copy.mockReturnValueOnce(pending.promise);
    const trigger = screen.getByRole("button", { name: "Copy public replay page link" }); trigger.focus(); fireEvent.click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const manual = screen.getByRole("dialog", { name: manualName });
    const input = within(manual).getByRole("textbox", { name: manualName }) as HTMLInputElement;
    expect(input.value).toBe(href("original-a")); expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    fireEvent.click(within(manual).getByRole("button", { name: "Done" })); expect(document.activeElement).toBe(trigger);
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => { pending.resolve(); });
    expect(h.copy).toHaveBeenCalledTimes(2); expect(h.success).toHaveBeenCalledTimes(1);
    expect(reads()).toHaveLength(1); expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: manualName })).toBeNull();
  });

  it.each(["owner", "handle-ABA", "visibility", "unmount"])("retires held clipboard without recovery or success after %s", async change => {
    h.server["owner-a"] = { enabled: true, handle: "original-a", updatedAt: "2026-10-26T00:00:00.000Z" };
    const view = mount(); await ready(); const copy = gate<void>(); h.copy.mockReturnValueOnce(copy.promise);
    const trigger = screen.getByRole("button", { name: "Copy public replay page link" }); trigger.focus(); fireEvent.click(trigger);
    if (change === "unmount") view.unmount();
    else if (change === "owner") { h.owner = "owner-b"; view.update(); await ready(); }
    else if (change === "visibility") await settings();
    else {
      await act(async () => { await h.publish!("owner-a", { enabled: true, handle: "other-a" }); });
      await act(async () => { await h.publish!("owner-a", { enabled: true, handle: "original-a" }); });
    }
    await act(async () => { copy.resolve(); });
    expect(screen.queryByRole("dialog", { name: manualName })).toBeNull(); expect(h.success).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
});
