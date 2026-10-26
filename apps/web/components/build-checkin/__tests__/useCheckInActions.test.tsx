import { StrictMode, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameIntentState } from "@/lib/buildIntent";

const h = vi.hoisted(() => ({
  owner: "owner-a" as string | null,
  loaded: true,
  getToken: vi.fn<() => Promise<string | null>>(),
  bump: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  userId: h.owner, isSignedIn: !!h.owner, isLoaded: h.loaded, getToken: h.getToken,
}) }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: h.toast }) }));
vi.mock("../BuildCheckInProvider", () => ({ useBuildCheckInRevision: () => ({ revision: 0, bump: h.bump }) }));

// Keep real owner scopes, token handling, fetch/response parsing and build-intent
// helpers. A held adapter deliberately ignores abort in the lifecycle cases.
import { useCheckInActions, type CheckInActions, type CheckInOutcome } from "../useCheckInActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const state = (gameId = "game-a") => ({ gameId, applied: true, build: { name: "Correct plan" } }) as GameIntentState;
const response = (value: unknown = state()) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  h.owner = "owner-a"; h.loaded = true;
  h.getToken.mockReset().mockResolvedValue("token-a");
  h.bump.mockReset(); h.toast.success.mockReset(); h.toast.error.mockReset();
  transport = vi.fn<typeof fetch>().mockImplementation(async () => response());
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const invoke = (actions: CheckInActions, kind: string) => kind === "confirm"
  ? actions.confirm("catalog:correct", "Correct plan", "note", { opponentBuildKey: "catalog:opponent" })
  : kind === "skip" ? actions.skip()
  : kind === "opponent" ? actions.setOpponent("catalog:opponent", "Opponent plan")
  : actions.saveNotes("Updated note");

describe("scoped build check-in writes", () => {
  it.each(["confirm", "skip", "opponent", "notes"])("dispatches %s through real authenticated helpers and reports one success", async kind => {
    const updated = vi.fn();
    const { result } = renderHook(() => useCheckInActions("game-a", updated), { wrapper: strict });
    let outcome: CheckInOutcome | undefined;
    await act(async () => { outcome = await invoke(result.current, kind); });
    expect(outcome?.state?.gameId).toBe("game-a");
    const [url, init] = transport.mock.calls[0];
    expect(url).toMatch(/\/v1\/games\/game-a\/build-intent$/);
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ authorization: "Bearer token-a" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body.action).toBe(kind);
    expect(body).not.toHaveProperty("signal");
    if (kind === "confirm") expect(body).toMatchObject({ buildKey: "catalog:correct", notes: "note", opponentBuildKey: "catalog:opponent" });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(result.current.busy).toBeNull();
  });

  it("shares synchronous pending state across duplicate cards while unrelated games remain usable", async () => {
    const held = deferred<Response>();
    transport.mockReturnValueOnce(held.promise);
    const { result } = renderHook(() => [useCheckInActions("game-a"), useCheckInActions("game-a"), useCheckInActions("game-b")] as const);
    let first!: Promise<CheckInOutcome>;
    let duplicate!: Promise<CheckInOutcome>;
    act(() => {
      first = result.current[0].confirm("catalog:a", "Plan A");
      duplicate = result.current[1].saveNotes("Do not race the first request");
    });
    expect(await duplicate).toEqual({ state: null, errorCode: null });
    expect(result.current[0].busy).toBe("confirm");
    expect(result.current[1].busy).toBe("confirm");
    expect(result.current[2].busy).toBeNull();
    await act(async () => { await result.current[2].skip(); });
    expect(transport).toHaveBeenCalledTimes(2);
    await act(async () => { held.resolve(response()); await first; });
    expect(result.current[1].busy).toBeNull();
    await act(async () => { await result.current[1].saveNotes("Now allowed"); });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each(["owner", "game"])("retires deferred JWTs and stale action handlers through %s A→B→A", async axis => {
    const token = deferred<string>();
    h.getToken.mockReturnValueOnce(token.promise);
    const updated = vi.fn();
    const { result, rerender } = renderHook(({ gameId }) => useCheckInActions(gameId, updated), { initialProps: { gameId: "game-a" } });
    const stale = result.current;
    let pending!: Promise<CheckInOutcome>;
    act(() => { pending = stale.confirm("catalog:a", "Plan A"); });
    await waitFor(() => expect(h.getToken).toHaveBeenCalledTimes(1));
    if (axis === "owner") h.owner = "owner-b";
    rerender({ gameId: axis === "game" ? "game-b" : "game-a" });
    h.owner = "owner-a";
    rerender({ gameId: "game-a" });
    await act(async () => {
      expect(await stale.skip()).toEqual({ state: null, errorCode: null });
      expect(await pending).toEqual({ state: null, errorCode: null });
      token.resolve("late-token-a");
    });
    expect(transport).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
    expect(h.bump).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
    await act(async () => { await result.current.saveNotes("Current scope"); });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["confirm", "skip", "opponent", "notes"])("settles %s quietly on unmount without waiting for a stalled JWT", async kind => {
    const token = deferred<string>();
    h.getToken.mockReturnValueOnce(token.promise);
    const updated = vi.fn();
    const first = renderHook(() => useCheckInActions("game-a", updated));
    let pending!: Promise<CheckInOutcome>;
    act(() => { pending = invoke(first.result.current, kind); });
    first.unmount();
    await expect(pending).resolves.toEqual({ state: null, errorCode: null });
    const next = renderHook(() => useCheckInActions("game-a"));
    await act(async () => { await next.result.current.skip(); token.resolve("too-late"); });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(updated).not.toHaveBeenCalled();
    // Only the fresh mounted card may announce or refresh.
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it.each(["owner", "game"])("drops a deferred JSON body after a %s change and cannot unlock its replacement", async axis => {
    const body = deferred<GameIntentState>();
    const readBody = vi.fn(() => body.promise);
    transport.mockResolvedValueOnce({ ok: true, status: 200, json: readBody } as unknown as Response);
    const replacement = deferred<Response>();
    transport.mockReturnValueOnce(replacement.promise);
    const oldUpdated = vi.fn(); const nextUpdated = vi.fn();
    const { result, rerender } = renderHook(({ gameId, onUpdated }) => useCheckInActions(gameId, onUpdated), {
      initialProps: { gameId: "game-a", onUpdated: oldUpdated },
    });
    let old!: Promise<CheckInOutcome>;
    act(() => { old = result.current.skip(); });
    await waitFor(() => expect(readBody).toHaveBeenCalledTimes(1));
    const oldSignal = transport.mock.calls[0][1]?.signal;
    if (axis === "owner") h.owner = "owner-b";
    rerender({ gameId: axis === "game" ? "game-b" : "game-a", onUpdated: nextUpdated });
    h.owner = "owner-a";
    rerender({ gameId: "game-a", onUpdated: nextUpdated });
    let current!: Promise<CheckInOutcome>;
    act(() => { current = result.current.confirm("catalog:new", "Current plan"); });
    await act(async () => { body.resolve(state()); expect(await old).toEqual({ state: null, errorCode: null }); });
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current.busy).toBe("confirm");
    expect(result.current.message).toBeNull();
    expect(oldUpdated).not.toHaveBeenCalled(); expect(nextUpdated).not.toHaveBeenCalled();
    expect(h.bump).not.toHaveBeenCalled(); expect(h.toast.error).not.toHaveBeenCalled();
    await act(async () => { replacement.resolve(response()); await current; });
    expect(nextUpdated).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
  });

  it.each(["token", "body"])("bounds a stalled %s and releases the shared gate; late completion stays silent", async stage => {
    vi.useFakeTimers();
    const token = deferred<string>(); const body = deferred<GameIntentState>();
    if (stage === "token") h.getToken.mockReturnValueOnce(token.promise);
    else transport.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise } as unknown as Response);
    const updated = vi.fn();
    const { result } = renderHook(() => useCheckInActions("game-a", updated));
    let pending!: Promise<CheckInOutcome>;
    act(() => { pending = result.current.skip(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await pending).toEqual({ state: null, errorCode: "request_timeout" });
    });
    expect(result.current.busy).toBeNull();
    expect(result.current.message?.text).toMatch(/Refresh the game/);
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    await act(async () => { token.resolve("late"); body.resolve(state()); });
    expect(updated).not.toHaveBeenCalled(); expect(h.bump).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
    await act(async () => { await result.current.skip(); });
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it("requires a current signed-in owner and nonempty token before dispatch", async () => {
    h.owner = null;
    const { result, rerender } = renderHook(() => useCheckInActions("game-a"));
    await act(async () => { expect(await result.current.skip()).toEqual({ state: null, errorCode: null }); });
    expect(h.getToken).not.toHaveBeenCalled();
    h.owner = "owner-a"; rerender();
    h.getToken.mockResolvedValueOnce(null);
    await act(async () => { expect((await result.current.skip()).errorCode).toBe("unauthenticated"); });
    expect(transport).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
  });

  it("releases failures for retry and respects caller cancellation without an error toast", async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "unknown_build", message: "Unavailable" } }), { status: 400 }));
    const { result } = renderHook(() => useCheckInActions("game-a"));
    await act(async () => { expect((await result.current.skip()).errorCode).toBe("unknown_build"); });
    expect(result.current.busy).toBeNull();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    const token = deferred<string>();
    h.getToken.mockReturnValueOnce(token.promise);
    const controller = new AbortController();
    let pending!: Promise<CheckInOutcome>;
    act(() => { pending = result.current.confirm("catalog:a", "A", undefined, { signal: controller.signal }); });
    await act(async () => { controller.abort(); expect(await pending).toEqual({ state: null, errorCode: null }); token.resolve("late"); });
    expect(result.current.busy).toBeNull();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to a replacement callback when a success toast synchronously switches owner", async () => {
    const original = vi.fn(); const replacement = vi.fn();
    const { result, rerender } = renderHook(({ onUpdated }) => useCheckInActions("game-a", onUpdated), { initialProps: { onUpdated: original } });
    h.toast.success.mockImplementationOnce(() => {
      h.owner = "owner-b";
      flushSync(() => rerender({ onUpdated: replacement }));
    });
    await act(async () => {
      expect(await result.current.skip()).toEqual({ state: null, errorCode: null });
    });
    expect(original).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(result.current.message).toBeNull();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("notifies other surfaces before a queue callback unmounts and then returns a retired outcome", async () => {
    let unmount!: () => void;
    const updated = vi.fn(() => unmount());
    const hook = renderHook(() => useCheckInActions("game-a", updated));
    unmount = hook.unmount;
    await act(async () => {
      expect(await hook.result.current.skip()).toEqual({ state: null, errorCode: null });
    });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.bump.mock.invocationCallOrder[0]).toBeLessThan(updated.mock.invocationCallOrder[0]);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.error).not.toHaveBeenCalled();
    const fresh = renderHook(() => useCheckInActions("game-a"));
    await act(async () => { expect((await fresh.result.current.skip()).state).toBeTruthy(); });
  });

  it.each(["copy", "toast"])("retires quietly when the failure %s callback synchronously unmounts", async external => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "unknown_build", message: "Unavailable" } }), { status: 400 }));
    const updated = vi.fn();
    const { result, unmount } = renderHook(() => useCheckInActions("game-a", updated));
    const failure = vi.fn(() => {
      if (external === "copy") unmount();
      return { title: "Could not save", description: "Try again", inline: "Try again" };
    });
    if (external === "toast") h.toast.error.mockImplementationOnce(unmount);
    await act(async () => {
      expect(await result.current.confirm("catalog:a", "A", undefined, { copy: { failure } })).toEqual({ state: null, errorCode: null });
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(h.toast.error).toHaveBeenCalledTimes(external === "copy" ? 0 : 1);
    expect(updated).not.toHaveBeenCalled(); expect(h.bump).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});
