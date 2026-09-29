import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * The "Overlay by sc2tools.com" credit on the all-in-one overlay: only
 * while a widget is on screen (an idle scene stays fully transparent),
 * and never when the Browser Source URL carries ?credit=0.
 */

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, SocketHandler>();
  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler);
  }
  emit() {}
  disconnect() {}
  fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
}

let activeSocket: FakeSocket | null = null;

vi.mock("socket.io-client", () => ({
  io: () => {
    activeSocket = new FakeSocket();
    return activeSocket;
  },
}));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({
  useVoiceReadout: () => ({ needsGesture: false, onUserGesture: vi.fn() }),
}));

import { OverlayClient } from "../OverlayClient";

function startMatch(socket: FakeSocket): void {
  socket.fire("overlay:config", { enabledWidgets: ["opponent", "scouting"], voicePrefs: { enabled: false, events: {}, delayMs: 0 } });
  socket.fire("overlay:liveGame", {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 1,
    gameKey: "game-1",
    opponent: { name: "Maru", race: "Terran" },
  });
}

describe("OverlayClient credit", () => {
  beforeEach(() => {
    activeSocket = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("stays off an idle, transparent overlay", () => {
    render(<OverlayClient token="tok" />);
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
  });

  it("shows top-left while a widget is on screen", () => {
    render(<OverlayClient token="tok" />);
    act(() => startMatch(activeSocket as FakeSocket));
    const credit = screen.getByTestId("overlay-credit");
    expect(credit.textContent).toBe("Overlay by sc2tools.com");
    expect(credit.getAttribute("data-placement")).toBe("top-left");
  });

  it("is hidden by ?credit=0", () => {
    render(<OverlayClient token="tok" showCredit={false} />);
    act(() => startMatch(activeSocket as FakeSocket));
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
  });
});
