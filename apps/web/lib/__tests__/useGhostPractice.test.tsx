import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useGhostPractice } from "../useGhostPractice";
import { writeArmedGhostConfig, type GhostBuildConfig } from "../ghostBuild";
import { writeGhostPracticeCache } from "../ghostSyncModel";

const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "a", getToken: vi.fn() }, handlers: null as Record<string, (value: unknown) => void> | null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("../useUserSocket", () => ({ useUserSocket: (handlers: typeof h.handlers) => { h.handlers = handlers; } }));
const target = { v: 1 as const, name: "Account Blink", steps: [{ supply: null, t: 30, name: "Gateway" }] };
const account: GhostBuildConfig = { v: 2, slots: { PvT: target } };
function wrapper({ children }: { children: ReactNode }) { return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryCount: 0, revalidateOnFocus: false }}>{children}</SWRConfig>; }
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear(); h.auth = { isLoaded: true, isSignedIn: true, userId: "a", getToken: vi.fn().mockResolvedValue("token-a") };
  fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "PATCH" ? { v: 2, slots: {} } : account), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const patches = () => fetcher.mock.calls.filter(call => call[1]?.method === "PATCH");

describe("owner-scoped synced Ghost assignments", () => {
  it("uses the account target over unscoped browser data and refreshes on an owner advisory", async () => {
    writeArmedGhostConfig({ v: 2, slots: { PvT: { ...target, name: "Old browser" } } });
    const view = renderHook(() => useGhostPractice(), { wrapper });
    await waitFor(() => expect(view.result.current.config.slots.PvT?.name).toBe("Account Blink"));
    const before = fetcher.mock.calls.length;
    act(() => h.handlers?.["ghost:changed"](true));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
    await act(async () => { expect(await view.result.current.assign("PvT", null, target)).toBe(true); });
    expect(JSON.parse(patches()[0][1]!.body as string)).toEqual({ matchup: "PvT", target: null, expectedTarget: target });
  });
  it("withholds targets and prevents a held-token write while auth loads with a stale user id", async () => {
    const view = renderHook(() => useGhostPractice(), { wrapper });
    await waitFor(() => expect(view.result.current.hasConfig).toBe(true));
    let release!: (token: string) => void;
    h.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let pending!: Promise<boolean>; act(() => { pending = view.result.current.assign("PvT", null); });
    h.auth = { ...h.auth, isLoaded: false }; view.rerender();
    expect(view.result.current.config.slots).toEqual({});
    await act(async () => { release("old-token"); await pending; });
    expect(patches()).toHaveLength(0); expect(view.result.current.saving).toBe(false);
  });
  it("an unmounted action cannot later write through another account's token", async () => {
    const view = renderHook(() => useGhostPractice(), { wrapper });
    await waitFor(() => expect(view.result.current.hasConfig).toBe(true));
    const lateUndo = view.result.current.assign; view.unmount();
    h.auth = { ...h.auth, userId: "b", getToken: vi.fn().mockResolvedValue("token-b") };
    expect(await lateUndo("PvT", target)).toBe(false); expect(patches()).toHaveLength(0);
  });
  it.each(["token", "body"] as const)("a stalled %s settles at the real deadline and late work cannot publish", async held => {
    const view = renderHook(() => useGhostPractice(), { wrapper });
    await waitFor(() => expect(view.result.current.hasConfig).toBe(true));
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    if (held === "token") h.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    else fetcher.mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) }));
    let pending!: Promise<boolean>;
    await act(async () => { pending = view.result.current.assign("PvT", null); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); expect(await pending).toBe(false); });
    expect(view.result.current.saving).toBe(false); expect(view.result.current.error).toMatch(/Couldn't confirm/);
    await act(async () => { release(held === "token" ? "late-token" : { v: 2, slots: {} }); await Promise.resolve(); });
    expect(view.result.current.config.slots.PvT).toEqual(target);
    if (held === "token") expect(patches()).toHaveLength(0);
  });
  it("labels warm same-key data cached after a failed refresh and never crosses account caches", async () => {
    writeGhostPracticeCache("b", { v: 2, slots: {} });
    const view = renderHook(() => useGhostPractice(), { wrapper });
    await waitFor(() => expect(view.result.current.hasConfig).toBe(true));
    fetcher.mockImplementation(async () => new Response('{"error":{"code":"unavailable"}}', { status: 503 }));
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.offline).toBe(true));
    expect(view.result.current.config.slots.PvT).toEqual(target);
    h.auth = { ...h.auth, userId: "b" }; view.rerender();
    expect(view.result.current.config.slots).toEqual({});
  });
});
