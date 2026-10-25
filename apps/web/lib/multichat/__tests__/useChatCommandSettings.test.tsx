import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatCommandSettings } from "../useChatCommandSettings";
const env = vi.hoisted(() => ({ auth: { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn() }, read: { data: { builtins: [], custom: [] } as unknown, error: null as unknown, isLoading: false, isPreviousData: false, mutate: vi.fn() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => env.auth }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), useApi: () => env.read }));
beforeEach(() => {
  env.auth.userId = "A"; env.auth.isLoaded = true; env.auth.isSignedIn = true; env.auth.getToken.mockReset().mockResolvedValue("jwt-A");
  env.read.data = { builtins: [], custom: [] }; env.read.error = null; env.read.isPreviousData = false; env.read.mutate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: true, status: 200, json: async () => JSON.parse(init?.body as string) })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const ready = async () => { const view = renderHook(({ token }) => useChatCommandSettings(token), { initialProps: { token: "token-A" } }); await waitFor(() => expect(view.result.current.ready).toBe(true)); return view; };
const edit = (view: Awaited<ReturnType<typeof ready>>) => act(() => view.result.current.setDraft({ ...view.result.current.draft!, builtins: view.result.current.draft!.builtins.map(row => row.id === "mmr" ? { ...row, trigger: "rating" } : row) }));

it("keeps edits local until explicit Save and sends the complete bounded preference type", async () => {
  const view = await ready(); edit(view); expect(fetch).not.toHaveBeenCalled(); expect(view.result.current.dirty).toBe(true);
  await act(async () => { expect(await view.result.current.save()).toBe(true); });
  const init = vi.mocked(fetch).mock.calls[0][1]!; expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body as string).builtins.find((row: { id: string }) => row.id === "mmr").trigger).toBe("rating");
  expect(view.result.current.dirty).toBe(false); expect(env.read.mutate).toHaveBeenCalledTimes(1);
});
it("prevents unsaved previews and uses saved settings for an exact no-send preview", async () => {
  const view = await ready(); edit(view); await act(async () => { expect(await view.result.current.tryCommand("rating", "PvZ", "Viewer", "kick", true)).toBe(false); }); expect(fetch).not.toHaveBeenCalled();
  await act(async () => { await view.result.current.save(); });
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: "reply", text: "Exact reply 4–2 (n=6)", command: "mmr" }) } as Response);
  await act(async () => { await view.result.current.tryCommand("rating", "PvZ", "Viewer", "kick", true); });
  expect(view.result.current.preview?.text).toBe("Exact reply 4–2 (n=6)");
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({ token: "token-A", command: "rating", argument: "PvZ", user: "Viewer", platform: "kick", onStream: true });
});
it("fences a held token across A→B→A before any mutation is sent", async () => {
  let finish!: (value: string) => void; env.auth.getToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = await ready(); edit(view); let pending!: Promise<boolean>; act(() => { pending = view.result.current.save(); });
  env.auth.userId = "B"; view.rerender({ token: "token-B" }); env.auth.userId = "A"; view.rerender({ token: "token-A" });
  await act(async () => { finish("late-A"); await pending; }); expect(fetch).not.toHaveBeenCalled(); expect(env.read.mutate).not.toHaveBeenCalled(); expect(view.result.current.dirty).toBe(false);
});
it("ignores held response bodies/cache work after auth loading or unmount", async () => {
  let finish!: (value: unknown) => void; vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  const view = await ready(); edit(view); let pending!: Promise<boolean>; act(() => { pending = view.result.current.save(); }); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  env.auth.isLoaded = false; view.rerender({ token: "token-A" }); expect(view.result.current.ready).toBe(false); view.unmount();
  await act(async () => { finish({ builtins: [], custom: [] }); await pending; }); expect(env.read.mutate).not.toHaveBeenCalled();
});
it("a held token reaches the deadline, keeps the draft and permits retry", async () => {
  const view = await ready(); edit(view); vi.useFakeTimers(); let finish!: (value: string) => void;
  env.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); let pending!: Promise<boolean>;
  act(() => { pending = view.result.current.save(); }); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); expect(await pending).toBe(false); });
  expect(view.result.current.busy).toBe(""); expect(view.result.current.dirty).toBe(true); expect(view.result.current.error).toContain("draft is kept");
  await act(async () => { expect(await view.result.current.save()).toBe(true); }); await act(async () => finish("late")); expect(fetch).toHaveBeenCalledTimes(1);
});
it("read failures withhold editing rather than saving fabricated defaults", async () => {
  env.read.error = { status: 503 }; const view = renderHook(() => useChatCommandSettings("token-A"));
  expect(view.result.current.ready).toBe(false); await act(async () => { expect(await view.result.current.save()).toBe(false); }); expect(fetch).not.toHaveBeenCalled();
});
