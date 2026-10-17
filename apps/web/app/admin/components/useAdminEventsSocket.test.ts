import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminEvent } from "./adminTypes";

const { ioMock, auth } = vi.hoisted(() => ({
  ioMock: vi.fn(), auth: { isLoaded: true, isSignedIn: true, userId: "admin-a", getToken: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => ioMock(...args) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.sc2tools.test" }));

import { useAdminEventsSocket } from "./useAdminEventsSocket";

type Connection = {
  listeners: Map<string, (payload?: unknown) => void>;
  options: { auth: (done: (value: { token?: string }) => void) => Promise<void> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
let connections: Connection[];

beforeEach(() => {
  vi.clearAllMocks();
  connections = [];
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: "admin-a" });
  auth.getToken.mockResolvedValue("current-token");
  ioMock.mockImplementation((_url: string, options: Connection["options"]) => {
    const connection: Connection = { options, listeners: new Map(), connect: vi.fn(), disconnect: vi.fn() };
    connections.push(connection);
    return { connected: false, connect: connection.connect, disconnect: connection.disconnect,
      on: (event: string, handler: (payload?: unknown) => void) => connection.listeners.set(event, handler) };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("admin activity socket lifecycle", () => {
  it("refreshes durable resources on the initial connect and reconnect with a fresh Clerk token", async () => {
    auth.getToken.mockResolvedValueOnce("initial-token").mockResolvedValueOnce("renewed-token");
    const onConnected = vi.fn();
    renderHook(() => useAdminEventsSocket(vi.fn(), onConnected));
    const connection = connections[0];
    const done = vi.fn();
    await connection.options.auth(done);
    act(() => connection.listeners.get("connect")?.());
    await connection.options.auth(done);
    act(() => connection.listeners.get("connect")?.());
    expect(done.mock.calls).toEqual([[{ token: "initial-token" }], [{ token: "renewed-token" }]]);
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it("disconnects on an account change and ignores delayed events from the old account", () => {
    const onEvent = vi.fn();
    const onConnected = vi.fn();
    const { rerender } = renderHook(() => useAdminEventsSocket(onEvent, onConnected));
    const old = connections[0];
    auth.userId = "admin-b";
    rerender();
    expect(old.disconnect).toHaveBeenCalledOnce();
    act(() => {
      old.listeners.get("admin:event")?.({ eventId: "stale" } as AdminEvent);
      old.listeners.get("connect")?.();
      connections[1].listeners.get("admin:event")?.({ eventId: "current" } as AdminEvent);
    });
    expect(onEvent.mock.calls).toEqual([[{ eventId: "current" }]]);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("retries namespace auth failures and stops retries on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useAdminEventsSocket(vi.fn()));
    const connection = connections[0];
    act(() => {
      connection.listeners.get("connect_error")?.();
      connection.listeners.get("connect_error")?.();
      vi.advanceTimersByTime(1000);
    });
    expect(connection.connect).toHaveBeenCalledOnce();
    act(() => connection.listeners.get("connect_error")?.());
    unmount();
    act(() => vi.runOnlyPendingTimers());
    expect(connection.connect).toHaveBeenCalledOnce();
    expect(connection.disconnect).toHaveBeenCalledOnce();
  });

  it("does not connect before an authenticated account is available", () => {
    auth.isSignedIn = false;
    renderHook(() => useAdminEventsSocket(vi.fn()));
    expect(ioMock).not.toHaveBeenCalled();
  });
});
