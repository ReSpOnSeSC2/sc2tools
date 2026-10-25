import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRivals } from "../useRivals";
import { useRivalSummary } from "../useRivalSummary";
import { RIVAL_REQUEST_TIMEOUT_MS } from "../rivalRequest";

const auth = vi.hoisted(() => ({ userId: "owner-a", isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
const client = vi.hoisted(() => ({ apiCall: vi.fn(), mutate: vi.fn(), prefs: { keys: [] as string[] } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("../clientApi", () => ({ apiCall: (...args: unknown[]) => client.apiCall(...args), useApi: () => ({ data: client.prefs, mutate: client.mutate, isLoading: false, isPreviousData: false }) }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { auth.userId = "owner-a"; auth.isLoaded = true; auth.isSignedIn = true; auth.getToken.mockReset().mockResolvedValue("token-a"); client.apiCall.mockReset(); client.mutate.mockReset().mockResolvedValue(undefined); client.prefs = { keys: [] }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("rival preference owner boundaries", () => {
  it("does not let a held cache mutation clear a newer save after an A→B→A transition", async () => {
    const mutate=deferred<void>(),newBody=deferred<{keys:string[]}>();
    client.apiCall.mockResolvedValueOnce({keys:["solo:first"]});client.mutate.mockReturnValueOnce(mutate.promise);
    const hook=renderHook(()=>useRivals());let oldSave!:Promise<void>,newSave!:Promise<void>;
    act(()=>{oldSave=hook.result.current.toggle(["solo:first"]);});await waitFor(()=>expect(client.mutate).toHaveBeenCalledTimes(1));
    auth.userId="owner-b";hook.rerender();auth.userId="owner-a";hook.rerender();
    client.apiCall.mockReturnValueOnce(newBody.promise);act(()=>{newSave=hook.result.current.toggle(["solo:second"]);});
    await waitFor(()=>expect(client.apiCall).toHaveBeenCalledTimes(2));expect(hook.result.current.saving).toBe(true);
    await act(async()=>{mutate.resolve();await oldSave;});expect(hook.result.current.saving).toBe(true);
    await act(async()=>{newBody.reject(new Error("offline"));await newSave;});expect(hook.result.current.saving).toBe(false);expect(hook.result.current.error).toMatch(/Couldn't confirm/);
  });
  it("does not start a write after an old owner's deferred token resolves", async () => {
    const token = deferred<string>(); auth.getToken.mockReturnValue(token.promise);
    const hook = renderHook(() => useRivals());
    let save!: Promise<void>; act(() => { save = hook.result.current.toggle(["acct:one"]); });
    auth.userId = "owner-b"; hook.rerender();
    await act(async () => { token.resolve("token-a"); await save; });
    expect(client.apiCall).not.toHaveBeenCalled(); expect(client.mutate).not.toHaveBeenCalled(); expect(hook.result.current.owner).toBe("owner-b");
  });
  it("ignores an already issued owner's late save response", async () => {
    const response = deferred<{ keys: string[] }>(); client.apiCall.mockReturnValue(response.promise);
    const hook = renderHook(() => useRivals());
    let save!: Promise<void>; act(() => { save = hook.result.current.toggle(["acct:one"]); });
    await waitFor(() => expect(client.apiCall).toHaveBeenCalledTimes(1));
    auth.userId = "owner-b"; hook.rerender();
    await act(async () => { response.resolve({ keys: ["acct:one"] }); await save; });
    expect(client.mutate).not.toHaveBeenCalled(); expect(hook.result.current.keys).toEqual([]);
  });
  it("removes all aliases of one saved star and enforces the50-player cap before authentication", async () => {
    client.prefs = { keys: ["solo:a", "acct:one", "solo:other"] }; client.apiCall.mockResolvedValue({ keys: ["solo:other"] });
    const hook = renderHook(() => useRivals());
    await act(async () => { await hook.result.current.toggle(["acct:one", "solo:a"]); });
    expect(JSON.parse(client.apiCall.mock.calls[0][2].body)).toEqual({ keys: ["solo:other"] });
    client.prefs = { keys: Array.from({ length:50 },(_,i) => `solo:${i}`) }; hook.rerender(); auth.getToken.mockClear();
    await act(async () => { await hook.result.current.toggle(["solo:another"]); });
    expect(auth.getToken).not.toHaveBeenCalled(); expect(hook.result.current.error).toMatch(/up to 50/);
  });
  it("keeps saved preferences intact on a failed write", async () => {
    client.prefs = { keys: ["solo:a"] }; client.apiCall.mockRejectedValue(new Error("offline"));
    const hook = renderHook(() => useRivals());
    await act(async () => { await hook.result.current.toggle(["solo:b"]); });
    expect(hook.result.current.keys).toEqual(["solo:a"]); expect(hook.result.current.error).toMatch(/Couldn't confirm/); expect(client.mutate).not.toHaveBeenCalled();
  });
  it.each(["isLoaded", "isSignedIn"] as const)("fences a stale same userId when%s becomes false, and hides saved state", async boundary => {
    const token = deferred<string>(); auth.getToken.mockReturnValue(token.promise); client.prefs={keys:["solo:a"]};
    const hook=renderHook(()=>useRivals()); let save!:Promise<void>;
    act(()=>{save=hook.result.current.toggle(["solo:b"]);});auth[boundary]=false;hook.rerender();
    expect(hook.result.current.keys).toEqual([]); expect(hook.result.current.owner).toBeNull(); expect(hook.result.current.saving).toBe(false);
    await act(async()=>{token.resolve("old-token");await save;});
    expect(client.apiCall).not.toHaveBeenCalled();expect(client.mutate).not.toHaveBeenCalled();
    auth.getToken.mockClear();await act(async()=>{await hook.result.current.toggle(["solo:c"]);});expect(auth.getToken).not.toHaveBeenCalled();
  });
  it.each(["token", "body"] as const)("settles a held%s at the real deadline, permits retry and ignores late completion", async held => {
    vi.useFakeTimers();const token=deferred<string>(),body=deferred<{keys:string[]}>();
    if(held==="token")auth.getToken.mockReturnValue(token.promise);else client.apiCall.mockReturnValue(body.promise);
    const hook=renderHook(()=>useRivals());let save!:Promise<void>;
    await act(async()=>{save=hook.result.current.toggle(["solo:first"]);await Promise.resolve();});
    expect(hook.result.current.saving).toBe(true);
    await act(async()=>{await vi.advanceTimersByTimeAsync(RIVAL_REQUEST_TIMEOUT_MS+1);await save;});
    expect(hook.result.current.saving).toBe(false);expect(hook.result.current.error).toMatch(/Couldn't confirm/);
    const before=client.apiCall.mock.calls.length;auth.getToken.mockResolvedValue("new-token");client.apiCall.mockResolvedValue({keys:["solo:retry"]});
    await act(async()=>{await hook.result.current.toggle(["solo:retry"]);});expect(client.apiCall).toHaveBeenCalledTimes(before+1);
    await act(async()=>{token.resolve("late-token");body.resolve({keys:["solo:first"]});await Promise.resolve();});
    expect(client.mutate).toHaveBeenCalledTimes(1);expect(client.mutate).toHaveBeenCalledWith({keys:["solo:retry"]},false);
  });
});
describe("one scoped rival batch", () => {
  it.each(["isLoaded", "isSignedIn"] as const)("withholds an existing answer during%s transition with the same stale userId", async boundary => {
    client.apiCall.mockResolvedValue({generatedAt:"answer",weekGames:{a:2},rivals:[]});
    const hook=renderHook(()=>useRivalSummary([],"",1,true));await waitFor(()=>expect(hook.result.current.data?.generatedAt).toBe("answer"));
    auth[boundary]=false;hook.rerender();expect(hook.result.current.data).toBeUndefined();expect(hook.result.current.error).toBe(false);
  });
  it.each(["token", "body"] as const)("settles a never-resolving%s, retries and rejects an old answer after timeout", async held => {
    vi.useFakeTimers();const token=deferred<string>(),body=deferred<unknown>();
    if(held==="token")auth.getToken.mockReturnValue(token.promise);else client.apiCall.mockReturnValue(body.promise);
    const hook=renderHook(()=>useRivalSummary([],"",1,true));
    await act(async()=>{await vi.advanceTimersByTimeAsync(RIVAL_REQUEST_TIMEOUT_MS+1);});
    expect(hook.result.current.loading).toBe(false);expect(hook.result.current.error).toBe(true);
    auth.getToken.mockResolvedValue("new-token");client.apiCall.mockResolvedValue({generatedAt:"new",weekGames:{b:2},rivals:[]});
    await act(async()=>{hook.result.current.retry();await Promise.resolve();});
    expect(hook.result.current.data?.generatedAt).toBe("new");
    await act(async()=>{token.resolve("late-token");body.resolve({generatedAt:"old",weekGames:{a:99}});await Promise.resolve();});
    expect(hook.result.current.data?.weekGames).toEqual({b:2});
  });
  it("fences a token that resolves after the selected filters change", async () => {
    const token = deferred<string>(); auth.getToken.mockReturnValue(token.promise);
    const hook = renderHook(({ query }) => useRivalSummary([], query, 1, true), { initialProps: { query: "?race=P" } });
    hook.rerender({ query: "?race=Z" });
    await act(async () => { token.resolve("token-a"); await Promise.resolve(); });
    await waitFor(() => expect(client.apiCall).toHaveBeenCalledTimes(1));
    expect(client.apiCall.mock.calls[0][1]).toBe("/v1/rivals/summary?race=Z");
  });
  it("never displays a late previous owner or filter response", async () => {
    const old = deferred<unknown>(); client.apiCall.mockReturnValueOnce(old.promise).mockResolvedValue({ generatedAt: "new", weekGames: { b:2 }, rivals: [] });
    const hook = renderHook(({ query }) => useRivalSummary([], query, 1, true), { initialProps: { query: "?race=P" } });
    await waitFor(() => expect(client.apiCall).toHaveBeenCalledTimes(1));
    auth.userId = "owner-b"; hook.rerender({ query: "?race=Z" });
    await waitFor(() => expect(hook.result.current.data?.generatedAt).toBe("new"));
    await act(async () => { old.resolve({ generatedAt: "old", weekGames: { a:99 } }); await Promise.resolve(); });
    expect(hook.result.current.data?.weekGames).toEqual({ b:2 });
  });
});
