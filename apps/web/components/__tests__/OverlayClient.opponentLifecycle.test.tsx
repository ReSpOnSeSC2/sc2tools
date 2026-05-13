import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/**
 * Streamer-reported regression covered here: on the all-in-one
 * ``/overlay/<token>`` URL the opponent widget was effectively "one
 * game behind" — after a game ended, the next match's loading screen
 * never re-showed it because:
 *
 *   1. ``OverlayClient`` was passing only ``live`` to
 *      ``OpponentWidget`` (no ``liveGame``), so the pre/in-game render
 *      path inside the widget had no envelope to consume.
 *   2. ``useWidgetTimers`` only set the per-widget visibility flag in
 *      response to a fresh ``live`` payload. The
 *      ``useClearStalePostGameOnGameKeyChange`` effect nulls ``live``
 *      the moment a new ``gameKey`` shows up on the envelope, so the
 *      next match's active phase had nothing left to drive the timer.
 *
 * The per-widget ``OverlayWidgetClient`` already handled both paths
 * (see ``OverlayWidgetClient.visibility.test.tsx``). This file is the
 * matching coverage for the all-in-one client so a future refactor
 * can't silently regress it.
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

import { OverlayClient } from "../OverlayClient";

function enableAllWidgets(socket: FakeSocket): void {
  socket.fire("overlay:config", {
    enabledWidgets: [
      "opponent",
      "scouting",
      "match-result",
      "post-game",
      "mmr-delta",
      "streak",
      "cheese",
      "rematch",
      "rival",
      "rank",
      "meta",
      "topbuilds",
      "fav-opening",
      "best-answer",
      "session",
    ],
    voicePrefs: { enabled: false, events: {}, delayMs: 0 },
  });
}

describe("OverlayClient — opponent widget across match boundaries", () => {
  beforeEach(() => {
    activeSocket = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the live-envelope opponent during a match's loading screen", () => {
    const { container } = render(<OverlayClient token="tok-1" />);
    expect(activeSocket).not.toBeNull();
    const socket = activeSocket as FakeSocket;
    act(() => enableAllWidgets(socket));

    // Loading screen arrives — no post-game ``live`` yet (the replay
    // doesn't exist on disk). The widget MUST render off the live
    // envelope alone; otherwise the streamer sees a blank slot through
    // the entire pre-game / in-game window.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
        gameKey: "game-1",
        opponent: { name: "Maru", race: "Terran" },
      });
    });

    expect(container.textContent).toContain("Maru");
  });

  it("keeps the opponent pinned through the active phase past the natural 15 s timer", () => {
    const { container } = render(<OverlayClient token="tok-1" />);
    const socket = activeSocket as FakeSocket;
    act(() => enableAllWidgets(socket));
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_in_progress",
        capturedAt: 1,
        gameKey: "game-1",
        opponent: { name: "Maru", race: "Terran" },
      });
    });
    expect(container.textContent).toContain("Maru");

    // Way past the opponent widget's natural 15 s timer — pinned
    // because the agent's still reporting an active match phase.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.textContent).toContain("Maru");
  });

  it("swaps to the next opponent when a new gameKey arrives (the 'one game behind' fix)", () => {
    const { container } = render(<OverlayClient token="tok-1" />);
    const socket = activeSocket as FakeSocket;
    act(() => enableAllWidgets(socket));

    // Game 1 — loading screen for opponent A.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
        gameKey: "game-1",
        opponent: { name: "Maru", race: "Terran" },
      });
    });
    expect(container.textContent).toContain("Maru");

    // Post-game payload for game 1 lands ~30 s after match_ended.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_ended",
        capturedAt: 2,
        gameKey: "game-1",
        opponent: { name: "Maru", race: "Terran" },
      });
      socket.fire("overlay:live", {
        gameKey: "game-1",
        oppName: "Maru",
        oppRace: "Terran",
        myRace: "Protoss",
        matchup: "PvT",
        headToHead: { wins: 0, losses: 1 },
      });
    });
    expect(container.textContent).toContain("Maru");
    expect(container.textContent).toContain("0-1");

    // Game 2 — fresh loading screen against a different opponent. The
    // ``useClearStalePostGameOnGameKeyChange`` effect nulls ``live`` on
    // the gameKey rotation; the all-in-one client must then re-render
    // the opponent widget off the new envelope alone.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 3,
        gameKey: "game-2",
        opponent: { name: "Serral", race: "Zerg" },
      });
    });

    expect(container.textContent).toContain("Serral");
    // Crucial regression assertion: the prior opponent must NOT linger.
    expect(container.textContent).not.toContain("Maru");
  });

  it(
    "re-shows the opponent on game N+1 even when the prior natural " +
      "15 s timer already expired during game N",
    () => {
      const { container } = render(<OverlayClient token="tok-1" />);
      const socket = activeSocket as FakeSocket;
      act(() => enableAllWidgets(socket));

      // Game 1 post-game payload only — no live envelope yet (the
      // agent could have started AFTER the game ended, or the loading-
      // screen envelope was dropped). Opponent visible for 15 s.
      act(() => {
        socket.fire("overlay:live", {
          gameKey: "game-1",
          oppName: "Maru",
          oppRace: "Terran",
          myRace: "Protoss",
          matchup: "PvT",
          headToHead: { wins: 0, losses: 1 },
        });
      });
      expect(container.textContent).toContain("Maru");

      // Push past the natural opponent timer — the widget hides.
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(container.textContent).not.toContain("Maru");

      // Game 2 loading screen — the visibility effect must re-arm even
      // though ``live`` is still set (the gameKey-clear effect will run
      // a tick later, but we shouldn't depend on its ordering).
      act(() => {
        socket.fire("overlay:liveGame", {
          type: "liveGameState",
          phase: "match_loading",
          capturedAt: 3,
          gameKey: "game-2",
          opponent: { name: "Serral", race: "Zerg" },
        });
      });

      expect(container.textContent).toContain("Serral");
    },
  );
});
