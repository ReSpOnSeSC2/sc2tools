import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRivals } from "../useRivals";
import { useRivalSummary } from "../useRivalSummary";

const auth = vi.hoisted(() => ({ userId: "owner-a", isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
const client = vi.hoisted(() => ({ apiCall: vi.fn(), mutate: vi.fn(), prefs: { keys: [] as string[] } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("../clientApi", () => ({ apiCall: (...args: unknown[]) => client.apiCall(...args), useApi: () => ({ data: client.prefs, mutate: client.mutate, isLoading: false, isPreviousData: false }) }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { auth.userId = "owner-a"; auth.getToken.mockReset().mockResolvedValue("token-a"); client.apiCall.mockReset(); client.mutate.mockReset().mockResolvedValue(undefined); client.prefs = { keys: [] }; });
afterEach(cleanup);

describe("rival preference owner boundaries", () => {
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
    expect(hook.result.current.keys).toEqual(["solo:a"]); expect(hook.result.current.error).toMatch(/Couldn't save/); expect(client.mutate).not.toHaveBeenCalled();
  });
});
describe("one scoped rival batch", () => {
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
