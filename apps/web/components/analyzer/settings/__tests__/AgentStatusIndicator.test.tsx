import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render } from "@testing-library/react";

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

import { AgentStatusIndicator } from "../AgentStatusIndicator";

describe("AgentStatusIndicator", () => {
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

  it("shows 'Agent offline' when no envelope has ever been received", () => {
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent offline");
  });

  it("shows 'Agent connected' when a fresh non-idle envelope is set", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_started",
        capturedAt: Date.now() / 1000,
        opponent: { name: "Maru" },
      },
      lastUpdatedAt: Date.now(),
      connected: true,
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent connected");
    expect(container.textContent).not.toContain("no game");
  });

  it("shows 'Agent connected · no game' when only a stale-but-recent idle envelope is set", () => {
    // No active live envelope — but the cloud reported activity within
    // the past 60 s, so the agent IS alive; it's just sitting on a
    // menu screen.
    liveState.current = {
      live: null,
      lastUpdatedAt: Date.now() - 5_000,
      connected: true,
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent connected · no game");
  });

  it("falls back to 'Agent offline' when even idle envelopes are too old", () => {
    liveState.current = {
      live: null,
      lastUpdatedAt: Date.now() - 90_000,
      connected: false,
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent offline");
  });

  it("re-renders to flip status as the staleness clock advances", () => {
    liveState.current = {
      live: {
        type: "liveGameState",
        phase: "match_started",
        capturedAt: Date.now() / 1000,
        opponent: { name: "Cure" },
      },
      lastUpdatedAt: Date.now() - 5_000,
      connected: true,
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent connected");
    // Advance fake timer past the 10 s "fresh-live" threshold but
    // still within the 60 s "any-recent" idle window. Status flips
    // from "connected" to "connected · no game".
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(container.textContent).toContain("Agent connected · no game");
    // Push past 60 s — the indicator falls back to offline.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.textContent).toContain("Agent offline");
  });
});
