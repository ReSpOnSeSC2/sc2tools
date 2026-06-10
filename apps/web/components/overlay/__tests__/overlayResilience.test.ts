import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachOverlayResilience } from "../overlayResilience";
import type { Socket } from "socket.io-client";

/**
 * Loop-guard coverage for the heartbeat drift detector.
 *
 * Regression context: the cloud's heartbeat reply carries the live
 * envelope's gameKey, while the cached post-game payload can be
 * stamped with its gameId fallback. When the client's latest key came
 * from that payload, every heartbeat mismatched, every mismatch
 * resynced, and every resync replayed the same post-game payload —
 * widgets re-fired on stream every 30 s and their auto-hide timers
 * never expired. The guard allows ONE resync per distinct mismatched
 * cloud key.
 */

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  connected = true;
  handlers = new Map<string, Handler>();
  emitted: Array<{ event: string; payload?: unknown }> = [];

  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
  }

  fire(event: string, ...args: unknown[]) {
    const fn = this.handlers.get(event);
    if (fn) fn(...args);
  }

  countEmits(event: string): number {
    return this.emitted.filter((e) => e.event === event).length;
  }
}

describe("attachOverlayResilience — heartbeat drift loop guard", () => {
  let socket: FakeSocket;
  let latestKey: string | null;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    latestKey = null;
    detach = attachOverlayResilience(socket as unknown as Socket, {
      latestGameKey: () => latestKey,
    });
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it("resyncs once on a mismatched cloud key, then stops repeating", () => {
    latestKey = "post-game-id";
    socket.fire("overlay:heartbeat", { gameKey: "envelope-key" });
    expect(socket.countEmits("overlay:resync")).toBe(1);

    // Same structural mismatch on every subsequent heartbeat — the
    // pre-fix behaviour resynced (and re-fired widgets) every time.
    socket.fire("overlay:heartbeat", { gameKey: "envelope-key" });
    socket.fire("overlay:heartbeat", { gameKey: "envelope-key" });
    socket.fire("overlay:heartbeat", { gameKey: "envelope-key" });
    expect(socket.countEmits("overlay:resync")).toBe(1);
  });

  it("resyncs again when the cloud moves on to a NEW game key", () => {
    latestKey = "stale";
    socket.fire("overlay:heartbeat", { gameKey: "game-1" });
    socket.fire("overlay:heartbeat", { gameKey: "game-1" });
    expect(socket.countEmits("overlay:resync")).toBe(1);

    socket.fire("overlay:heartbeat", { gameKey: "game-2" });
    expect(socket.countEmits("overlay:resync")).toBe(2);
  });

  it("resets the guard once the keys agree, allowing future genuine drift recovery", () => {
    latestKey = "stale";
    socket.fire("overlay:heartbeat", { gameKey: "game-1" });
    expect(socket.countEmits("overlay:resync")).toBe(1);

    // The resync delivered the envelope — keys agree now.
    latestKey = "game-1";
    socket.fire("overlay:heartbeat", { gameKey: "game-1" });
    expect(socket.countEmits("overlay:resync")).toBe(1);

    // Later the client genuinely misses events for the same key
    // (page backgrounded mid-match) — one more recovery is allowed.
    latestKey = "fell-behind";
    socket.fire("overlay:heartbeat", { gameKey: "game-1" });
    expect(socket.countEmits("overlay:resync")).toBe(2);
  });

  it("a null cloud key (no live game) never triggers a resync", () => {
    latestKey = "anything";
    socket.fire("overlay:heartbeat", { gameKey: null });
    socket.fire("overlay:heartbeat", undefined);
    expect(socket.countEmits("overlay:resync")).toBe(0);
  });

  it("skips heartbeat emits while the socket is disconnected", () => {
    socket.connected = false;
    vi.advanceTimersByTime(95_000);
    expect(socket.countEmits("overlay:heartbeat")).toBe(0);

    socket.connected = true;
    vi.advanceTimersByTime(35_000);
    expect(socket.countEmits("overlay:heartbeat")).toBe(1);
  });

  it("still resyncs on every (re-)connect", () => {
    socket.fire("connect");
    expect(socket.countEmits("overlay:resync")).toBe(1);
    socket.fire("reconnect");
    expect(socket.countEmits("overlay:resync")).toBe(2);
  });
});
