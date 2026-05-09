import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, act } from "@testing-library/react";

/**
 * Render-with-mock-hook coverage for the dashboard panel. We mock
 * ``useLiveGame`` so the rendering logic is exercised against well-
 * defined snapshots without driving a real SSE stream — the hook
 * itself is covered by useLiveGame.test.tsx.
 */

const liveState = vi.hoisted(() => ({
  current: {
    live: null as unknown as Record<string, unknown> | null,
    lastUpdatedAt: null as number | null,
    connected: false,
  },
}));

vi.mock("@/lib/useLiveGame", () => ({
  useLiveGame: () => liveState.current,
}));

import { LiveGamePanel } from "../LiveGamePanel";

describe("LiveGamePanel", () => {
  beforeEach(() => {
    liveState.current = {
      live: null,
      lastUpdatedAt: null,
      connected: false,
    };
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when the hook has no live envelope", () => {
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent || "").toBe("");
  });

  it("renders the opponent + phase when an envelope is live", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_started",
        capturedAt: Date.now() / 1000,
        opponent: {
          name: "Reynor",
          race: "Zerg",
          profile: { mmr: 6850, league: "Grandmaster" },
        },
        displayTime: 35,
      },
      lastUpdatedAt: Date.now(),
      connected: true,
    };
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent).toContain("Reynor");
    expect(container.textContent).toContain("Zerg");
    expect(container.textContent).toContain("Match started");
    expect(container.textContent).toContain("6850 MMR");
    expect(container.textContent).toContain("Grandmaster");
  });

  it("falls back to 'in progress' when the opponent name isn't set yet", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: Date.now() / 1000,
      },
      lastUpdatedAt: Date.now(),
      connected: true,
    };
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent).toContain("Live game in progress");
    expect(container.textContent).toContain("Loading screen");
  });

  it("hides itself when the last envelope is older than 30s", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_in_progress",
        capturedAt: Date.now() / 1000,
        opponent: { name: "Cure", race: "Terran" },
      },
      lastUpdatedAt: Date.now() - 45_000,
      connected: true,
    };
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent || "").toBe("");
  });

  it("renders elapsed time as m:ss formatted from displayTime", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_in_progress",
        capturedAt: Date.now() / 1000,
        opponent: { name: "ByuN", race: "Terran" },
        displayTime: 192,
      },
      lastUpdatedAt: Date.now(),
      connected: true,
    };
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent).toMatch(/3:1\d/);
  });

  it("transitions to 'replay parsing' on match_ended phase", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_ended",
        capturedAt: Date.now() / 1000,
        opponent: { name: "Cure", race: "Terran" },
      },
      lastUpdatedAt: Date.now(),
      connected: true,
    };
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent).toContain("replay parsing");
  });

  it("re-renders to hide once the elapsed-time interval pushes past STALE_MS", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_in_progress",
        capturedAt: Date.now() / 1000,
        opponent: { name: "Maru", race: "Terran" },
        displayTime: 30,
      },
      lastUpdatedAt: Date.now() - 25_000,
      connected: true,
    };
    const { container } = render(<LiveGamePanel />);
    expect(container.textContent).toContain("Maru");
    // Tick the staleness clock past 30 s — without the interval re-
    // checking ``Date.now() - lastUpdatedAt`` the panel would stay up
    // until the next environment-driven re-render. The hook installs a
    // 1 s interval, so 6 s of fake-timer ticks should flip it.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(container.textContent || "").toBe("");
  });
});
