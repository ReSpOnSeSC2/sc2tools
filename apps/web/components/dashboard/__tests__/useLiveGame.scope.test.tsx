import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useLiveGame } from "@/lib/useLiveGame";
const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: true, userId: "owner-a", sessionId: "session-a", getToken: vi.fn(async (): Promise<string | null> => "a") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
function stream() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel });
  return { response: new Response(body, { status: 200 }), cancel, push: (value: object) => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)) };
}
const envelope = (extra = {}) => ({ type: "liveGameState", phase: "match_loading", gameKey: "game-a", capturedAt: 1, opponent: { name: "Opponent" }, ...extra });
beforeEach(() => { Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: "owner-a", sessionId: "session-a", getToken: vi.fn(async () => "a") }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("live SSE owner and match boundaries", () => {
  it("discards a stalled old-owner token before any HTTP request", async () => {
    let release!: (value: string) => void; auth.getToken = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const current = stream(), fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => current.response); vi.stubGlobal("fetch", fetch);
    const view = renderHook(() => useLiveGame());
    auth.userId = "owner-b"; auth.sessionId = "session-b"; auth.getToken = vi.fn(async () => "b"); view.rerender();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); await act(async () => release("old-a"));
    expect(fetch).toHaveBeenCalledOnce(); expect((fetch.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe("Bearer b"); expect(view.result.current.live).toBeNull();
  });
  it("withholds an old private envelope synchronously and cancels its reader on account change", async () => {
    const first = stream(), fetch = vi.fn().mockResolvedValueOnce(first.response).mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
    const view = renderHook(() => useLiveGame()); await waitFor(() => expect(view.result.current.connected).toBe(true));
    act(() => first.push(envelope({ streamerHistory: { oppName: "Opponent", opponentNotes: { text: "private a" } } })));
    await waitFor(() => expect(view.result.current.live?.streamerHistory?.opponentNotes?.text).toBe("private a"));
    auth.userId = "owner-b"; auth.sessionId = "session-b"; view.rerender();
    expect(view.result.current.live).toBeNull(); expect(first.cancel).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("retains rich history across partial ticks only for the same match and opponent", async () => {
    const source = stream(); vi.stubGlobal("fetch", vi.fn(async () => source.response));
    const view = renderHook(() => useLiveGame()); await waitFor(() => expect(view.result.current.connected).toBe(true));
    act(() => source.push(envelope({ streamerHistory: { oppName: "Opponent", headToHead: { wins: 2, losses: 1 } } })));
    await waitFor(() => expect(view.result.current.live?.streamerHistory?.headToHead?.wins).toBe(2));
    act(() => source.push(envelope())); await waitFor(() => expect(view.result.current.live?.streamerHistory?.headToHead?.wins).toBe(2));
    act(() => source.push(envelope({ gameKey: "game-b", opponent: { name: "New opponent" } })));
    await waitFor(() => expect(view.result.current.live?.gameKey).toBe("game-b")); expect(view.result.current.live?.streamerHistory).toBeUndefined();
  });
  it("settles a held auth lookup after its deadline and retries at the bounded cadence", async () => {
    vi.useFakeTimers(); auth.getToken = vi.fn(() => new Promise<string>(() => {})); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    renderHook(() => useLiveGame()); await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(auth.getToken).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); }); expect(auth.getToken).toHaveBeenCalledTimes(2);
  });
  it("catches a rejected body cancellation when headers arrive after unmount", async () => {
    let finish!: (value: unknown) => void; const cancel = vi.fn().mockRejectedValue(new Error("Body already aborted"));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const view = renderHook(() => useLiveGame()); await waitFor(() => expect(auth.getToken).toHaveBeenCalled()); view.unmount();
    await act(async () => finish({ ok: true, body: { cancel } })); expect(cancel).toHaveBeenCalledOnce();
  });
});
