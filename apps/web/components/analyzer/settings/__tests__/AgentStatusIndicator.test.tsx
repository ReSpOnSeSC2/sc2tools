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

const meState = vi.hoisted(() => ({
  current: { agentLastSeenAt: null as string | null },
}));

vi.mock("@/lib/useLiveGame", () => ({
  useLiveGame: () => liveState.current,
}));

// The indicator now also reads the agent heartbeat from /v1/me. useApi pulls
// Clerk's useAuth, which throws outside <ClerkProvider>, so mock the boundary.
vi.mock("@/lib/clientApi", () => ({
  API_BASE: "",
  useApi: () => ({ data: meState.current, error: undefined, isLoading: false }),
}));

import { AgentStatusIndicator } from "../AgentStatusIndicator";

describe("AgentStatusIndicator", () => {
  beforeEach(() => {
    liveState.current = {
      live: null,
      lastUpdatedAt: null,
      connected: false,
    };
    meState.current = { agentLastSeenAt: null };
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'Agent offline' when no envelope has ever been received", () => {
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent offline");
  });

  it("shows 'Agent connected · in game' when a fresh non-idle envelope is set", () => {
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
    expect(container.textContent).toContain("Agent connected · in game");
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

  it("uses the success colour for both connected states (green-while-connected UX)", () => {
    // Both `connected-live` and `connected-idle` should share the
    // success tint — the streamer's mental model is binary, the
    // in-game/no-game distinction is conveyed by the label.
    liveState.current = {
      live: null,
      lastUpdatedAt: Date.now() - 5_000,
      connected: true,
    };
    const { container, rerender } = render(<AgentStatusIndicator />);
    const idleSpan = container.querySelector("span[role='status']");
    expect(idleSpan?.className || "").toContain("text-success");

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
    rerender(<AgentStatusIndicator />);
    const liveSpan = container.querySelector("span[role='status']");
    expect(liveSpan?.className || "").toContain("text-success");
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
    expect(container.textContent).toContain("Agent connected · in game");
    // Advance fake timer past the 10 s "fresh-live" threshold but
    // still within the 60 s "any-recent" idle window. Label flips
    // from "in game" to "no game" while colour stays green.
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

  // The bug this fixes: the live bridge reads Blizzard's localhost API, which
  // only exists while SC2 is running. A healthy agent with the game closed
  // emitted nothing and was wrongly reported offline.
  it("shows connected when only the heartbeat is fresh (SC2 closed)", () => {
    meState.current = { agentLastSeenAt: new Date().toISOString() };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent connected · no game");
    expect(container.textContent).not.toContain("Agent offline");
  });

  it("goes offline once the heartbeat is older than the tolerance", () => {
    meState.current = {
      agentLastSeenAt: new Date(Date.now() - 200_000).toISOString(),
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent offline");
  });

  it("tolerates a single missed 60s heartbeat", () => {
    meState.current = {
      agentLastSeenAt: new Date(Date.now() - 90_000).toISOString(),
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent connected · no game");
  });

  it("ignores an unparseable heartbeat rather than throwing", () => {
    meState.current = { agentLastSeenAt: "not-a-date" };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent offline");
  });

  it("prefers the in-game envelope over the heartbeat", () => {
    meState.current = { agentLastSeenAt: new Date().toISOString() };
    liveState.current = {
      live: { phase: "in-game" } as unknown as Record<string, unknown>,
      lastUpdatedAt: Date.now(),
      connected: true,
    };
    const { container } = render(<AgentStatusIndicator />);
    expect(container.textContent).toContain("Agent connected · in game");
  });
});
