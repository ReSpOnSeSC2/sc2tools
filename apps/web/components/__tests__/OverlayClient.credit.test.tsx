import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * The "Overlay by sc2tools.com" credit on the all-in-one overlay: only
 * while a widget is on screen (an idle scene stays fully transparent),
 * and never when the Browser Source URL carries ?credit=0.
 */

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  connect() {}
  off() {}
  handlers = new Map<string, SocketHandler>();
  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler); if (event === "overlay:multichat") handler({ gameWidgetsPaused: false });
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

function receiveCreditProfile(socket: FakeSocket, profileRevision: number, credit?: boolean): void {
  socket.fire("overlay:config", {
    profile: { v: 1, theme: {}, widgetOptions: {}, ...(credit === undefined ? {} : { credit }) },
    profileRevision,
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
    act(() => receiveCreditProfile(activeSocket!, 1, true));
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
  });

  it("waits for the profile, then shows top-left by default while a widget is on screen", () => {
    render(<OverlayClient token="tok" />);
    act(() => startMatch(activeSocket!));
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
    act(() => receiveCreditProfile(activeSocket!, 0));
    const credit = screen.getByTestId("overlay-credit");
    expect(credit.textContent).toBe("Overlay by sc2tools.com");
    expect(credit.getAttribute("data-placement")).toBe("top-left");
  });

  it("updates from the saved credit and ignores stale or partial config", () => {
    render(<OverlayClient token="tok" />);
    act(() => {
      startMatch(activeSocket!);
      receiveCreditProfile(activeSocket!, 1, false);
    });
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
    act(() => receiveCreditProfile(activeSocket!, 2, true));
    expect(screen.getByTestId("overlay-credit")).toBeTruthy();
    act(() => receiveCreditProfile(activeSocket!, 3, false));
    act(() => {
      receiveCreditProfile(activeSocket!, 2, true);
      activeSocket!.fire("overlay:config", { enabledWidgets: ["opponent"] });
    });
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
  });

  it("resets both the old snapshot and terminal status when switching tokens", () => {
    const view = render(<OverlayClient token="old-token" />);
    act(() => {
      startMatch(activeSocket!);
      receiveCreditProfile(activeSocket!, 1, true);
    });
    expect(screen.getByTestId("overlay-credit")).toBeTruthy();
    act(() => activeSocket!.fire("connect_error", new Error("invalid_overlay_token")));
    expect(screen.getByText("This overlay link no longer works")).toBeTruthy();
    view.rerender(<OverlayClient token="new-token" />);
    expect(screen.queryByText("This overlay link no longer works")).toBeNull();
    act(() => startMatch(activeSocket!));
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
    act(() => receiveCreditProfile(activeSocket!, 0));
    expect(screen.getByTestId("overlay-credit")).toBeTruthy();
  });

  it("keeps dedicated widget sources unbranded", () => {
    const previousUrl = window.location.href;
    window.history.replaceState(null, "", "?w=opponent");
    try {
      render(<OverlayClient token="tok" />);
      act(() => {
        startMatch(activeSocket!);
        receiveCreditProfile(activeSocket!, 1, true);
      });
      expect(screen.getByText("Maru")).toBeTruthy();
      expect(screen.queryByTestId("overlay-credit")).toBeNull();
    } finally {
      window.history.replaceState(null, "", previousUrl);
    }
  });

  it("is hidden by ?credit=0 even when the saved credit is on", () => {
    render(<OverlayClient token="tok" showCredit={false} />);
    act(() => {
      startMatch(activeSocket!);
      receiveCreditProfile(activeSocket!, 1, true);
    });
    expect(screen.queryByTestId("overlay-credit")).toBeNull();
  });
});
