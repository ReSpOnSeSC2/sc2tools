// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpponentScoutingPreference } from "../useOpponentScoutingPreference";
const env = vi.hoisted(() => ({ auth: { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn() }, read: { data: { groupByPlayer: true }, isLoading: false, isPreviousData: false, error: null as unknown, mutate: vi.fn() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => env.auth }));
vi.mock("../clientApi", async importOriginal => ({ ...await importOriginal<typeof import("../clientApi")>(), useApi: () => env.read }));
beforeEach(() => {
  env.auth.userId = "A"; env.auth.isLoaded = true; env.auth.isSignedIn = true;
  env.auth.getToken.mockReset().mockResolvedValue("synthetic");
  env.read.data = { groupByPlayer: true }; env.read.isLoading = false; env.read.error = null; env.read.isPreviousData = false;
  env.read.mutate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ groupByPlayer: false }), { status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("owner-scoped grouping preference", () => {
  it("persists one strict boolean and updates the shared preference cache after acknowledgement", async () => {
    const { result } = renderHook(useOpponentScoutingPreference);
    await act(async () => { expect(await result.current.setGroupByPlayer(false)).toBe(true); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ groupByPlayer: false });
    expect(env.read.mutate).toHaveBeenCalledWith({ groupByPlayer: false }, false);
    expect(result.current.saving).toBe(false);
  });
  it("a held old token cannot send account A's setting under B or an A-B-A session", async () => {
    let finish!: (token: string) => void; env.auth.getToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(useOpponentScoutingPreference); let pending!: Promise<boolean>;
    act(() => { pending = view.result.current.setGroupByPlayer(false); });
    env.auth.userId = "B"; view.rerender(); env.auth.userId = "A"; view.rerender();
    await act(async () => { finish("late"); await pending; });
    expect(fetch).not.toHaveBeenCalled(); expect(env.read.mutate).not.toHaveBeenCalled(); expect(view.result.current.saving).toBe(false);
  });
  it("auth loading/sign-out hides cached preference and fences late bodies", async () => {
    let finish!: (body: string) => void;
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: () => new Promise(resolve => { finish = value => resolve(JSON.parse(value)); }) } as Response);
    const view = renderHook(useOpponentScoutingPreference); let pending!: Promise<boolean>;
    act(() => { pending = view.result.current.setGroupByPlayer(false); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    env.auth.isLoaded = false; view.rerender(); expect(view.result.current.groupByPlayer).toBe(false);
    env.auth.isLoaded = true; env.auth.isSignedIn = false; view.rerender(); expect(view.result.current.groupByPlayer).toBe(false);
    await act(async () => { finish('{"groupByPlayer":false}'); await pending; });
    expect(env.read.mutate).not.toHaveBeenCalled();
  });
  it("held token lookup settles at20 seconds and supports retry without late fetch", async () => {
    vi.useFakeTimers(); let finish!: (token: string) => void;
    env.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useOpponentScoutingPreference); let pending!: Promise<boolean>;
    act(() => { pending = result.current.setGroupByPlayer(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); expect(await pending).toBe(false); });
    expect(result.current.saving).toBe(false); expect(result.current.error).toMatch(/Couldn’t save/);
    await act(async () => { expect(await result.current.setGroupByPlayer(false)).toBe(true); });
    await act(async () => { finish("late"); await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("a held response body also settles at the deadline and duplicate writes stay blocked", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
    const { result } = renderHook(useOpponentScoutingPreference); let pending!: Promise<boolean>;
    act(() => { pending = result.current.setGroupByPlayer(false); });
    await act(async () => { expect(await result.current.setGroupByPlayer(true)).toBe(false); await vi.advanceTimersByTimeAsync(20_000); expect(await pending).toBe(false); });
    expect(result.current.saving).toBe(false); expect(env.read.mutate).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("read errors and loading prohibit writes, and unmount fences pending token work", async () => {
    env.read.error = new Error("synthetic unavailable");
    const view = renderHook(useOpponentScoutingPreference);
    await act(async () => { expect(await view.result.current.setGroupByPlayer(false)).toBe(false); });
    expect(fetch).not.toHaveBeenCalled();
    env.read.error = null; let finish!: (token: string) => void;
    env.auth.getToken.mockImplementation(() => new Promise(resolve => { finish = resolve; })); view.rerender();
    let pending!: Promise<boolean>; act(() => { pending = view.result.current.setGroupByPlayer(false); }); view.unmount();
    await act(async () => { finish("late"); await pending; }); expect(fetch).not.toHaveBeenCalled();
  });
});
