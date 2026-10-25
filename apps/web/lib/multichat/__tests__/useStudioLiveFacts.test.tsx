import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioUpdates } from "../useStudioUpdates";
const sockets = vi.hoisted(() => [] as { events: Map<string, (value?: unknown) => void>; outgoing?: (event: string) => void; dispose: ReturnType<typeof vi.fn> }[]);
vi.mock("@/components/overlay/overlayResilience", () => ({ createOverlaySocket: () => {
  const connection = { events: new Map(), outgoing: undefined as ((event: string) => void) | undefined, dispose: vi.fn() }; sockets.push(connection);
  return { dispose: connection.dispose, socket: { on: (event: string, callback: (value?: unknown) => void) => connection.events.set(event, callback), off: vi.fn(), onAnyOutgoing: (callback: (event: string) => void) => { connection.outgoing = callback; }, offAnyOutgoing: vi.fn() } };
} }));
beforeEach(() => { sockets.length = 0; }); afterEach(cleanup);
const live = (extra = {}) => ({ type: "liveGameState", phase: "match_loading", capturedAt: 1, gameKey: "one", opponent: { name: "Opponent" }, ...extra });
describe("Dock live facts share the existing socket", () => {
  it("receives live/session, keeps same-match enrichment, and clears on terminal state", () => {
    const view = renderHook(() => useStudioUpdates("one", vi.fn())); const events = sockets[0].events;
    act(() => { events.get("overlay:liveGame")?.(live({ streamerHistory: { oppName: "Opponent", headToHead: { wins: 2, losses: 1 } } })); events.get("overlay:session")?.({ wins: 3, losses: 1, games: 4, mmrStart: 4000, mmrCurrent: 4020, private: "no" }); });
    expect(view.result.current.liveGame?.streamerHistory?.headToHead?.wins).toBe(2); expect(view.result.current.session).toEqual({ wins: 3, losses: 1, games: 4, mmrStart: 4000, mmrCurrent: 4020 });
    act(() => events.get("overlay:liveGame")?.(live())); expect(view.result.current.liveGame?.streamerHistory?.headToHead?.wins).toBe(2);
    act(() => events.get("overlay:liveGame")?.(live({ phase: "match_ended" }))); expect(view.result.current.liveGame).toBeNull(); expect(sockets).toHaveLength(1);
  });
  it("clears facts on outgoing resync, reconnect and token changes, fencing late callbacks", () => {
    const view = renderHook(({ token }) => useStudioUpdates(token, vi.fn()), { initialProps: { token: "one" } });
    const events = sockets[0].events, receive = events.get("overlay:liveGame");
    act(() => { receive?.(live()); events.get("overlay:session")?.({ wins: 1, losses: 0, games: 1 }); });
    act(() => sockets[0].outgoing?.("overlay:resync")); expect(view.result.current.liveGame).toBeNull(); expect(view.result.current.session).toBeNull();
    act(() => receive?.(live())); act(() => events.get("disconnect")?.()); expect(view.result.current.liveGame).toBeNull();
    act(() => receive?.(live())); view.rerender({ token: "two" }); expect(view.result.current.liveGame).toBeNull();
    act(() => receive?.(live())); expect(view.result.current.liveGame).toBeNull(); expect(sockets[0].dispose).toHaveBeenCalledOnce();
  });
  it("rejects invalid session counts and non-envelope messages", () => {
    const view = renderHook(() => useStudioUpdates("one", vi.fn()));
    act(() => { sockets[0].events.get("overlay:session")?.({ wins: -1, losses: 0, games: 0 }); sockets[0].events.get("overlay:liveGame")?.({ phase: "match_loading" }); });
    expect(view.result.current.liveGame).toBeNull(); expect(view.result.current.session).toBeNull();
  });
});
