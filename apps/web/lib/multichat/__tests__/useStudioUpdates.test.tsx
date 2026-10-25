import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DEFAULT_STUDIO_STATE, type StudioState } from "../useStudioState";
import { newestStudioSnapshot, useStudioUpdates } from "../useStudioUpdates";

const sockets = vi.hoisted(() => [] as Array<{
  receive?: (value: unknown) => void;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}>);
const socketFactory = vi.hoisted(() => vi.fn());
vi.mock("socket.io-client", () => ({ io: socketFactory }));

function Probe({ token, onUpdate }: { token: string; onUpdate: (state: StudioState) => void }) {
  useStudioUpdates(token, onUpdate);
  return null;
}
beforeEach(() => {
  sockets.length = 0;
  socketFactory.mockReset().mockImplementation(() => {
    const socket = { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), receive: undefined as ((value: unknown) => void) | undefined };
    socket.on.mockImplementation((event, callback) => { if (event === "overlay:multichat") socket.receive = callback; });
    sockets.push(socket);
    return socket;
  });
});
afterEach(cleanup);

describe("useStudioUpdates", () => {
  it("uses overlay-token auth and sanitizes a saved studio update", () => {
    const onUpdate = vi.fn();
    render(<Probe token="test-token" onUpdate={onUpdate} />);
    expect(socketFactory.mock.calls[0][1]).toMatchObject({ auth: { overlayToken: "test-token", timezone: expect.any(String) }, transports: ["websocket", "polling"], reconnection: true });
    act(() => sockets[0].receive?.({ buildProfile: { title: "Test profile", ratings: { aggressiveness: "5", micro: 4 }, visible: true }, updatedAt: "2026-10-14T12:01:00.000Z" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const state = onUpdate.mock.calls[0][0] as StudioState;
    expect(state.buildProfile.ratings.aggressiveness).toBeNull();
    expect(state.buildProfile.ratings.micro).toBe(4);
    expect(state.buildProfile.visible).toBe(false);
  });

  it("uses the latest callback without reconnecting while the token is unchanged", () => {
    const first = vi.fn(), second = vi.fn();
    const view = render(<Probe token="test-token" onUpdate={first} />);
    view.rerender(<Probe token="test-token" onUpdate={second} />);
    act(() => sockets[0].receive?.({}));
    expect(socketFactory).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ignores late callbacks after token changes or unmount and cleans up its connection", () => {
    const onUpdate = vi.fn();
    const view = render(<Probe token="old-token" onUpdate={onUpdate} />);
    const oldReceive = sockets[0].receive;
    view.rerender(<Probe token="new-token" onUpdate={onUpdate} />);
    act(() => oldReceive?.({ updatedAt: "2026-10-14T12:03:00.000Z" }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(sockets[0].off).toHaveBeenCalledWith("overlay:multichat", oldReceive);
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
    act(() => sockets[1].receive?.({ updatedAt: "2026-10-14T12:01:00.000Z" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const latestReceive = sockets[1].receive;
    view.unmount();
    act(() => latestReceive?.({}));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(sockets[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed messages without calling its consumer", () => {
    const onUpdate = vi.fn();
    render(<Probe token="test-token" onUpdate={onUpdate} />);
    act(() => { for (const raw of [null, [], "bad payload", 42]) sockets[0].receive?.(raw); });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("newestStudioSnapshot", () => {
  it("rejects older and unversioned states but allows distinct same-millisecond writes", () => {
    const current = { ...DEFAULT_STUDIO_STATE, updatedAt: "2026-10-14T12:01:00.000Z" };
    const older = { ...current, updatedAt: "2026-10-14T12:00:00.000Z" };
    const sameTime = { ...current, buildProfile: { ...current.buildProfile, title: "A later test write" } };
    expect(newestStudioSnapshot(current, older)).toBe(current);
    expect(newestStudioSnapshot(current, DEFAULT_STUDIO_STATE)).toBe(current);
    expect(newestStudioSnapshot(current, sameTime)).toBe(sameTime);
    expect(newestStudioSnapshot(null, current)).toBe(current);
  });
});
