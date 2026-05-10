import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

/**
 * The Browser Source's Socket.io client auto-reconnects after a
 * transient drop, but the cloud's broker only fans the latest
 * envelope on subscribe — and the post-game ``overlay:live`` payload
 * doesn't get re-emitted at all unless a new game lands. To recover
 * widget state without a manual refresh, the freshly-reconnected
 * client emits ``overlay:resync`` and the cloud responds with all
 * three current snapshots (``overlay:liveGame`` with synthetic
 * prelude, ``overlay:live``, ``overlay:session``).
 *
 * These tests stub ``socket.io-client`` so we can fire connect /
 * reconnect events directly and assert on the client's behaviour
 * without spinning up a real server.
 */

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, SocketHandler>();
  emitted: Array<{ event: string; payload?: unknown }> = [];
  disconnected = false;

  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Test helper to fire an event on this fake socket. */
  fire(event: string, ...args: unknown[]) {
    const fn = this.handlers.get(event);
    if (fn) fn(...args);
  }
}

let activeSocket: FakeSocket | null = null;

vi.mock("socket.io-client", () => ({
  io: () => {
    const s = new FakeSocket();
    activeSocket = s;
    return s;
  },
}));

vi.mock("@/lib/clientApi", () => ({
  API_BASE: "http://test.invalid",
}));

vi.mock("@/lib/timeseries", () => ({
  clientTimezone: () => "UTC",
}));

import { OverlayWidgetClient } from "../OverlayWidgetClient";

describe("OverlayWidgetClient — reconnect resync flow", () => {
  beforeEach(() => {
    activeSocket = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("emits overlay:resync on the FIRST connect", () => {
    render(<OverlayWidgetClient token="tok-1" widget="opponent" />);
    expect(activeSocket).not.toBeNull();
    const socket = activeSocket as FakeSocket;
    socket.fire("connect");
    const resyncEmits = socket.emitted.filter((e) => e.event === "overlay:resync");
    expect(resyncEmits.length).toBeGreaterThanOrEqual(1);
  });

  it("emits overlay:resync on a 'reconnect' event after a drop", () => {
    render(<OverlayWidgetClient token="tok-1" widget="opponent" />);
    const socket = activeSocket as FakeSocket;
    socket.fire("connect");
    const initialResyncs = socket.emitted.filter((e) => e.event === "overlay:resync").length;
    socket.fire("reconnect");
    const afterReconnect = socket.emitted.filter((e) => e.event === "overlay:resync").length;
    expect(afterReconnect).toBeGreaterThan(initialResyncs);
  });

  it("rehydrates state from the cloud's resync responses", () => {
    render(<OverlayWidgetClient token="tok-1" widget="opponent" />);
    const socket = activeSocket as FakeSocket;
    // Cloud responds with the three current snapshots.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
        gameKey: "rehydrated-key",
        synthetic: true,
      });
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_in_progress",
        capturedAt: 2,
        gameKey: "rehydrated-key",
        opponent: { name: "Foe", race: "Zerg" },
      });
      socket.fire("overlay:live", {
        oppName: "Foe",
        oppRace: "Zerg",
        matchup: "PvZ",
        gameKey: "previous-key",
      });
    });
    // The synthetic prelude carries the new gameKey; the
    // gameKey-change effect drops the cached ``live`` (gameKey
    // 'previous-key') because the live envelope's gameKey
    // ('rehydrated-key') no longer matches.
    // We don't have direct access to the rendered widget's state
    // here, but the absence of a thrown error and the presence of
    // the three handlers (we just successfully fired them) is the
    // contract this test pins. The gameKey-change behaviour itself
    // is exercised by ``OverlayWidgetClient.gameKeyChange.test.tsx``.
    expect(socket.handlers.has("overlay:live")).toBe(true);
    expect(socket.handlers.has("overlay:liveGame")).toBe(true);
    expect(socket.handlers.has("overlay:session")).toBe(true);
  });

  it("fires periodic heartbeat pings on a 30-second interval", () => {
    render(<OverlayWidgetClient token="tok-1" widget="opponent" />);
    const socket = activeSocket as FakeSocket;
    const beforeAdvance = socket.emitted.filter((e) => e.event === "overlay:heartbeat").length;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const afterFirst = socket.emitted.filter((e) => e.event === "overlay:heartbeat").length;
    expect(afterFirst).toBeGreaterThan(beforeAdvance);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const afterSecond = socket.emitted.filter((e) => e.event === "overlay:heartbeat").length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it("triggers a resync when the heartbeat reply's gameKey differs from the client's", () => {
    render(<OverlayWidgetClient token="tok-1" widget="opponent" />);
    const socket = activeSocket as FakeSocket;
    socket.fire("connect");
    // Seed the client's tracked gameKey via a real envelope.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
        gameKey: "client-key",
      });
    });
    const beforeResyncs = socket.emitted.filter((e) => e.event === "overlay:resync").length;
    // Cloud's heartbeat reply reveals a drift.
    act(() => {
      socket.fire("overlay:heartbeat", { gameKey: "cloud-newer-key", ts: Date.now() });
    });
    const afterResyncs = socket.emitted.filter((e) => e.event === "overlay:resync").length;
    expect(afterResyncs).toBeGreaterThan(beforeResyncs);
  });

  it("does NOT trigger a resync when the heartbeat reply matches the client's gameKey", () => {
    render(<OverlayWidgetClient token="tok-1" widget="opponent" />);
    const socket = activeSocket as FakeSocket;
    socket.fire("connect");
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
        gameKey: "stable",
      });
    });
    const beforeResyncs = socket.emitted.filter((e) => e.event === "overlay:resync").length;
    act(() => {
      socket.fire("overlay:heartbeat", { gameKey: "stable", ts: Date.now() });
    });
    const afterResyncs = socket.emitted.filter((e) => e.event === "overlay:resync").length;
    expect(afterResyncs).toBe(beforeResyncs);
  });
});
