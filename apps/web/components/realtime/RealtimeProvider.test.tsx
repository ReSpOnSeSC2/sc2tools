import { StrictMode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ioMock, auth, apiMe } = vi.hoisted(() => ({ ioMock: vi.fn(), apiMe: { agentPaired: true, agentLastSeenAt: "2026-10-23T12:00:00Z", games: { total: 10, latest: "2026-10-23T11:59:30Z" } }, auth: {
  isLoaded: true, isSignedIn: true, userId: "u1", getToken: vi.fn(),
} }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => ioMock(...args) }));
vi.mock("@/lib/clientApi", async () => { const { default: useSWR } = await import("swr"); return { API_BASE: "https://api.example.test", useApi: () => useSWR("/v1/me", async () => ({ ...apiMe }), { fallbackData: { ...apiMe } }) }; });
import { RealtimeProvider, useRealtimeState } from "./RealtimeProvider";
import { useUserSocket } from "@/lib/useUserSocket";
import { SyncStatus } from "@/components/SyncStatus";
import { AdminLiveStatus } from "@/app/admin/components/AdminLiveStatus";

type Options = { auth: (done: (value: unknown) => void) => Promise<void> };
type Connection = { connected: boolean; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; io: { on: ReturnType<typeof vi.fn> }; fire: (event: string, value?: unknown) => void; options: Options };
let sockets: Connection[];
beforeEach(() => {
  apiMe.games = { total: 10, latest: "2026-10-23T11:59:30Z" };
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); vi.clearAllMocks();
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: "u1" }); auth.getToken.mockResolvedValue("token");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); sockets = [];
  ioMock.mockImplementation((_url, options: Options) => {
    const handlers = new Map<string, (value?: unknown) => void>();
    const socket: Connection = { connected: false, options, connect: vi.fn(), disconnect: vi.fn(),
      on: vi.fn((event, handler) => { handlers.set(event, handler); return socket; }), off: vi.fn(() => handlers.clear()), io: { on: vi.fn() },
      fire(event, value) { if (event === "connect") socket.connected = true; if (event === "disconnect" || event === "connect_error") socket.connected = false; handlers.get(event)?.(value); },
    }; sockets.push(socket); return socket;
  });
});
afterEach(() => { cleanup(); act(() => vi.runOnlyPendingTimers()); vi.useRealTimers(); });

describe("shared authenticated realtime lifecycle", () => {
  it("shares one connection in StrictMode, retains it until the final consumer leaves, and reads current handlers", () => {
    const a = vi.fn(); const b = vi.fn();
    function Consumer({ second }: { second: boolean }) { useUserSocket({ ping: second ? b : a }); return null; }
    const view = render(<StrictMode><RealtimeProvider><Consumer second={false} /><Consumer second={false} /></RealtimeProvider></StrictMode>);
    expect(ioMock).toHaveBeenCalledTimes(1);
    act(() => sockets[0].fire("ping", 1)); expect(a).toHaveBeenCalledTimes(2);
    view.rerender(<StrictMode><RealtimeProvider><Consumer second /></RealtimeProvider></StrictMode>);
    act(() => sockets[0].fire("ping", 2)); expect(b).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledWith(2);
    expect(sockets[0].disconnect).not.toHaveBeenCalled(); expect(ioMock).toHaveBeenCalledTimes(1);
    view.unmount(); act(() => vi.advanceTimersByTime(0)); expect(sockets[0].disconnect).toHaveBeenCalledOnce();
  });

  it("uses fresh JWTs on each namespace auth and never treats Manager reconnect as Live", async () => {
    auth.getToken.mockResolvedValueOnce("first").mockResolvedValueOnce("renewed");
    const { result } = renderHook(() => useRealtimeState()); const socket = sockets[0]; const done = vi.fn();
    await socket.options.auth(done); act(() => socket.fire("connect_error", new Error("expired")));
    expect(result.current.status).toBe("reconnecting"); expect(socket.io.on).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000)); expect(socket.connect).toHaveBeenCalledOnce();
    await socket.options.auth(done); expect(done.mock.calls).toEqual([[{ token: "first" }], [{ token: "renewed" }]]);
    act(() => socket.fire("connect")); expect(result.current.status).toBe("connected"); expect(result.current.lastConnectedAt).toBe(Date.now());
  });

  it("caps namespace retries and exposes offline/online recovery without duplicate timers", () => {
    const { result, unmount } = renderHook(() => useRealtimeState()); const socket = sockets[0];
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      act(() => { socket.fire("connect_error"); socket.fire("connect_error"); vi.advanceTimersByTime(delay - 1); });
      const before = socket.connect.mock.calls.length;
      act(() => vi.advanceTimersByTime(1)); expect(socket.connect).toHaveBeenCalledTimes(before + 1);
    }
    expect(result.current).toMatchObject({ status: "offline", attempts: 7 });
    act(() => window.dispatchEvent(new Event("online"))); expect(result.current.status).toBe("reconnecting");
    act(() => socket.fire("connect")); expect(result.current.attempts).toBe(0);
    unmount(); act(() => vi.runOnlyPendingTimers()); expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it("drops delayed events and auth from the previous account and does not connect while signed out", async () => {
    let finish!: (value: string) => void; auth.getToken.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const event = vi.fn(); const view = renderHook(() => useUserSocket({ ping: event })); const old = sockets[0]; const done = vi.fn();
    const pending = old.options.auth(done);
    auth.userId = "u2"; view.rerender(); act(() => old.fire("ping", "old")); expect(event).not.toHaveBeenCalled();
    finish("old-token"); await pending; expect(done).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(0)); expect(old.disconnect).toHaveBeenCalledOnce();
    act(() => sockets[1].fire("ping", "current")); expect(event).toHaveBeenCalledTimes(1); expect(event).toHaveBeenCalledWith("current");
    auth.isSignedIn = false; view.rerender(); act(() => vi.advanceTimersByTime(0)); expect(sockets[1].disconnect).toHaveBeenCalledOnce();
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it("updates the shared SWR game count without another connection and ticks upload time", async () => {
    render(<RealtimeProvider><SyncStatus /></RealtimeProvider>);
    const socket = sockets[0]; await act(async () => socket.fire("connect"));
    expect(screen.getByRole("button", { name: /Agent online · 10 games/ })).toBeTruthy();
    act(() => socket.fire("games:changed", { count: 5, inserted: 0, bulk: true, reason: "reclassify" }));
    expect(screen.getByRole("button", { name: /10 games/ })).toBeTruthy(); expect(screen.getByText("Syncing — charts refresh every 30 s")).toBeTruthy();
    apiMe.games = { total: 12, latest: "2026-10-23T12:00:00Z" };
    await act(async () => socket.fire("games:changed", { count: 4, inserted: 2, reason: "ingest" }));
    expect(screen.getByRole("button", { name: /12 games/ })).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(30000));
    const pill = screen.getByRole("button", { name: /last upload 30s ago/ });
    expect(pill.querySelector("[title]")?.getAttribute("title")).toBe(new Date("2026-10-23T12:00:00Z").toLocaleString());
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it("renders all admin status states and refreshes durable data while disconnected", () => {
    const refresh = vi.fn(); const data = {};
    render(<RealtimeProvider><AdminLiveStatus onRefresh={refresh} data={data} /></RealtimeProvider>);
    expect(screen.getByText("↻ Reconnecting…")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Refresh" }).click()); expect(refresh).toHaveBeenCalledOnce();
    act(() => sockets[0].fire("connect")); expect(screen.getByText("● Live")).toBeTruthy(); expect(screen.queryByRole("button")).toBeNull();
    act(() => { window.dispatchEvent(new Event("offline")); vi.advanceTimersByTime(12000); }); expect(screen.getByText("Offline · updated 12s ago")).toBeTruthy();
  });
});
