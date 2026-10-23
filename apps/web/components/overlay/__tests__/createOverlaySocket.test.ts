import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOverlaySocket, hasActiveOverlayGame } from "../overlayResilience";

const factory = vi.hoisted(() => vi.fn());
vi.mock("socket.io-client", () => ({ io: factory }));
type Handler = (...args: unknown[]) => void;
class TestSocket {
  connected = false;
  handlers = new Map<string, Set<Handler>>();
  connect = vi.fn();
  disconnect = vi.fn(() => { this.connected = false; });
  on(event: string, handler: Handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event)!.add(handler); return this; }
  off(event: string, handler: Handler) { this.handlers.get(event)?.delete(handler); return this; }
  fire(event: string, ...args: unknown[]) { if (event === "connect") this.connected = true; if (event === "disconnect") this.connected = false; for (const handler of this.handlers.get(event) ?? []) handler(...args); }
}
let socket: TestSocket;
let dispose: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); socket = new TestSocket(); factory.mockReset().mockReturnValue(socket); });
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

it("does not call a finished or idle game live in the check badge", () => {
  for (const phase of ["idle", "menu", "match_ended"]) expect(hasActiveOverlayGame({ phase })).toBe(false);
  for (const phase of ["match_loading", "match_started", "match_in_progress"]) expect(hasActiveOverlayGame({ phase })).toBe(true);
  expect(hasActiveOverlayGame(null)).toBe(false);
});

it("retries refused handshakes with capped exponential backoff, then resets on connect", () => {
  const status = vi.fn();
  ({ dispose } = createOverlaySocket("private-token", { surface: "widget", widget: "opponent", onStatus: status }));
  expect(factory.mock.calls[0][1]).toMatchObject({ autoConnect: false, auth: { overlayToken: "private-token", surface: "widget", widget: "opponent" } });
  vi.advanceTimersByTime(0);
  expect(socket.connect).toHaveBeenCalledTimes(1);
  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
    socket.fire("connect_error", new Error("overlay_unsupported"));
    vi.advanceTimersByTime(delay - 1);
    expect(socket.connect).toHaveBeenCalledTimes(index + 1);
    vi.advanceTimersByTime(1);
    expect(socket.connect).toHaveBeenCalledTimes(index + 2);
  }
  socket.fire("connect");
  expect(status).toHaveBeenLastCalledWith("connected");
  socket.fire("disconnect");
  vi.advanceTimersByTime(1000);
  expect(socket.connect).toHaveBeenCalledTimes(9);
});

it("debounces the reconnect status for five seconds and retries immediately online", () => {
  const status = vi.fn();
  ({ dispose } = createOverlaySocket("token", { surface: "dock", onStatus: status }));
  vi.advanceTimersByTime(0); socket.fire("connect_error", new Error("resolver unavailable"));
  expect(status).toHaveBeenLastCalledWith("connecting");
  vi.advanceTimersByTime(4999);
  expect(status).not.toHaveBeenCalledWith("reconnecting");
  vi.advanceTimersByTime(1);
  expect(status).toHaveBeenLastCalledWith("reconnecting");
  socket.fire("connect_error", new Error("resolver unavailable"));
  const before = socket.connect.mock.calls.length;
  window.dispatchEvent(new Event("online"));
  expect(socket.connect).toHaveBeenCalledTimes(before + 1);
});

it("jitters retry delays by at most twenty percent", () => {
  vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(1);
  ({ dispose } = createOverlaySocket("token", { surface: "dock", onStatus: vi.fn() }));
  vi.advanceTimersByTime(0);
  socket.fire("connect_error", new Error("temporary"));
  vi.advanceTimersByTime(799); expect(socket.connect).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1); expect(socket.connect).toHaveBeenCalledTimes(2);
  socket.fire("connect_error", new Error("temporary"));
  vi.advanceTimersByTime(2399); expect(socket.connect).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1); expect(socket.connect).toHaveBeenCalledTimes(3);
});

it("stops permanently on an invalid token and clears every listener and timer", () => {
  const status = vi.fn();
  ({ dispose } = createOverlaySocket("token", { surface: "scene", onStatus: status }));
  vi.advanceTimersByTime(0); socket.fire("connect_error", new Error("invalid_overlay_token"));
  expect(status).toHaveBeenLastCalledWith("invalid");
  window.dispatchEvent(new Event("online")); vi.advanceTimersByTime(120000);
  expect(socket.connect).toHaveBeenCalledTimes(1);
  expect(socket.disconnect).toHaveBeenCalledTimes(1);
  dispose();
  expect([...socket.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("disposes a StrictMode probe before its first connection opens", () => {
  const first = createOverlaySocket("token", { surface: "all-in-one", onStatus: vi.fn() });
  first.dispose();
  const secondSocket = new TestSocket(); factory.mockReturnValue(secondSocket);
  ({ dispose } = createOverlaySocket("token", { surface: "all-in-one", onStatus: vi.fn() }));
  vi.advanceTimersByTime(0);
  expect(socket.connect).not.toHaveBeenCalled();
  expect(secondSocket.connect).toHaveBeenCalledTimes(1);
});
