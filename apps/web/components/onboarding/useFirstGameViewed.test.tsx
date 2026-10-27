import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVATION_PATH, FIRST_GAME_VIEWED_PATH, type ActivationResponse } from "@/lib/activation";
import { useFirstGameViewed } from "./useFirstGameViewed";

const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, loaded: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: auth.loaded, isSignedIn: !!auth.owner, getToken: auth.getToken }) }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const answer = (): ActivationResponse => ({ identity: false, firstGameViewed: false, customBuild: false, checkIn: false, overlayLive: false, chatOn: false, goals: [], levelUpDismissedAt: null });
const admitted = (gameId: string) => ({ data: { gameId }, isPreviousData: false, isLoading: false, error: undefined as unknown });
let cache: Map<string, { data?: unknown }>;
let requests: { path: string; method: string; body: unknown; owner: string }[];
let transport: (init: RequestInit) => Promise<Response>;
function wrapper({ children }: { children: ReactNode }) { return <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig>; }
beforeEach(() => {
  auth.owner = "owner-a"; auth.loaded = true; auth.getToken.mockReset().mockImplementation(async () => `jwt-${auth.owner}`);
  cache = new Map(); requests = []; transport = async () => reply({ firstGameViewed: true });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ path: new URL(String(input)).pathname, method: init.method ?? "GET", body: JSON.parse(String(init.body ?? "null")), owner: String((init.headers as Record<string, string>)?.authorization) });
    return transport(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("successful private game admission", () => {
  it("marks one current game and patches only an existing owner activation answer", async () => {
    const key = unstable_serialize(["authenticated-api", "owner-a", ACTIVATION_PATH]);
    cache.set(key, { data: answer() });
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper });
    await waitFor(() => expect(view.result.current).toBe("recorded"));
    expect(requests).toEqual([{ path: FIRST_GAME_VIEWED_PATH, method: "PUT", body: { gameId: "game-1" }, owner: "Bearer jwt-owner-a" }]);
    expect(cache.get(key)?.data).toEqual({ ...answer(), firstGameViewed: true });
    expect([...cache.keys()]).toEqual([key]);
    view.rerender(); await act(async () => {}); expect(requests).toHaveLength(1);
  });
  it("does not fetch activation or fabricate its other five flags", async () => {
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper });
    await waitFor(() => expect(view.result.current).toBe("recorded"));
    expect(requests.map(row => row.path)).toEqual([FIRST_GAME_VIEWED_PATH]);
    expect(cache.size).toBe(0);
  });
  it.each([
    { data: undefined, isPreviousData: false, isLoading: true },
    { data: { gameId: "game-1" }, isPreviousData: true, isLoading: false },
    { data: { gameId: "other-game" }, isPreviousData: false, isLoading: false },
    { data: { gameId: "game-1" }, error: new Error("not found"), isPreviousData: false, isLoading: false },
  ])("does not mark loading, previous, mismatched or failed bodies: %j", async state => {
    renderHook(() => useFirstGameViewed("game-1", state), { wrapper });
    await act(async () => {}); expect(requests).toEqual([]); expect(auth.getToken).not.toHaveBeenCalled();
  });
  it("waits for loaded sign-in and skips a same-owner confirmed marker", async () => {
    auth.loaded = false;
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper });
    await act(async () => {}); expect(requests).toEqual([]);
    auth.loaded = true; auth.owner = null; view.rerender(); await act(async () => {}); expect(requests).toEqual([]);
    auth.owner = "owner-a"; cache.set(unstable_serialize(["authenticated-api", "owner-a", ACTIVATION_PATH]), { data: { ...answer(), firstGameViewed: true } });
    view.rerender(); await act(async () => {}); expect(requests).toEqual([]);
  });
  it("retires held JWTs across owner A→B→A without issuing the old write", async () => {
    const held = deferred<string>(); auth.getToken.mockImplementationOnce(() => held.promise);
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper });
    await waitFor(() => expect(auth.getToken).toHaveBeenCalledTimes(1));
    auth.owner = "owner-b"; view.rerender(); await waitFor(() => expect(requests).toHaveLength(1));
    auth.owner = "owner-a"; view.rerender(); await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => held.resolve("old-jwt-owner-a"));
    expect(requests.map(row => row.owner)).toEqual(["Bearer jwt-owner-b", "Bearer jwt-owner-a"]);
  });
  it("retires held response bodies across game1→game2→game1 before cache publication", async () => {
    const body = deferred<{ firstGameViewed: boolean }>();
    const key = unstable_serialize(["authenticated-api", "owner-a", ACTIVATION_PATH]); cache.set(key, { data: answer() });
    transport = vi.fn().mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => body.promise }) as Response).mockImplementation(async () => reply({ firstGameViewed: false }));
    const view = renderHook(({ id }) => useFirstGameViewed(id, admitted(id)), { wrapper, initialProps: { id: "game-1" } });
    await waitFor(() => expect(requests).toHaveLength(1));
    view.rerender({ id: "game-2" }); await waitFor(() => expect(view.result.current).toBe("unavailable"));
    view.rerender({ id: "game-1" }); await waitFor(() => expect(requests).toHaveLength(3)); await waitFor(() => expect(view.result.current).toBe("unavailable"));
    await act(async () => body.resolve({ firstGameViewed: true }));
    expect(view.result.current).toBe("unavailable"); expect(cache.get(key)?.data).toEqual(answer());
    expect(requests.map(row => row.body)).toEqual([{ gameId: "game-1" }, { gameId: "game-2" }, { gameId: "game-1" }]);
  });
  it("does not publish a body after unmount, even when transport ignores abort", async () => {
    const body = deferred<{ firstGameViewed: boolean }>(); transport = async () => ({ ok: true, status: 200, json: () => body.promise }) as Response;
    const key = unstable_serialize(["authenticated-api", "owner-a", ACTIVATION_PATH]); cache.set(key, { data: answer() });
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(1)); view.unmount();
    await act(async () => body.resolve({ firstGameViewed: true }));
    expect(cache.get(key)?.data).toEqual(answer());
  });
  it("bounds a held JWT and does not send it after the deadline", async () => {
    vi.useFakeTimers(); const held = deferred<string>(); auth.getToken.mockReturnValue(held.promise);
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(view.result.current).toBe("unavailable");
    await act(async () => held.resolve("late-jwt")); expect(requests).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("admits StrictMode replay without promising HTTP-once semantics", async () => {
    const strict = ({ children }: { children: ReactNode }) => <StrictMode><SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig></StrictMode>;
    const view = renderHook(() => useFirstGameViewed("game-1", admitted("game-1")), { wrapper: strict });
    await waitFor(() => expect(view.result.current).toBe("recorded"));
    expect(requests.length).toBeGreaterThanOrEqual(1); expect(requests.length).toBeLessThanOrEqual(2);
    expect(requests.every(row => row.path === FIRST_GAME_VIEWED_PATH && (row.body as { gameId: string }).gameId === "game-1")).toBe(true);
  });
});
