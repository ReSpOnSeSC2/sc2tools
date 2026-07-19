/**
 * Stream Studio widget family — render contracts.
 *
 * useStudioState and useMultiChat are module-mocked (the widgets'
 * data plumbing is covered by lib tests); tallyPollVotes runs for
 * real over a message fixture so the poll numbers on screen are the
 * genuine tally, not a mock echo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { MultiChatState } from "@/lib/multichat/useMultiChat";
import type { StudioState } from "@/lib/multichat/useStudioState";
import type { LiveGamePayload } from "@/components/overlay/types";
import type { SessionSummary } from "../SessionWidget";
import { ChatHighlightWidget } from "../ChatHighlightWidget";
import { ChatPollWidget } from "../ChatPollWidget";
import { ChatAlertsWidget } from "../ChatAlertsWidget";
import { StreamGoalsWidget } from "../StreamGoalsWidget";
import { SessionRecapWidget } from "../SessionRecapWidget";

let mockStudio: StudioState & { loaded: boolean };
let mockChat: MultiChatState;

vi.mock("@/lib/multichat/useStudioState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useStudioState")>();
  return { ...actual, useStudioState: () => mockStudio };
});

vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: () => mockChat,
}));

// The config loader inside MultiChatWidget fetches the token-authed
// relay — stub the hook so the poll/alerts widgets skip the network.
vi.mock("../MultiChatWidget", () => ({
  useMultichatConfig: () => ({
    platforms: { twitch: { enabled: true, channel: "me" } },
    appearance: {},
    tts: null,
    sound: null,
    loaded: true,
  }),
}));

const EMPTY_STUDIO: StudioState & { loaded: boolean } = {
  highlight: null,
  poll: null,
  goals: [],
  blockedUsers: [],
  recapSeq: 0,
  updatedAt: null,
  loaded: true,
};

beforeEach(() => {
  mockStudio = { ...EMPTY_STUDIO };
  mockChat = { messages: [], events: [], statuses: {}, active: true };
});

afterEach(() => {
  cleanup();
});

describe("ChatHighlightWidget", () => {
  it("renders the pinned text and author", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      highlight: {
        platform: "kick",
        user: "PogViewer",
        text: "that was the play of the year",
        atMs: 1000,
      },
    };
    render(<ChatHighlightWidget token="tok" />);
    expect(screen.getByText(/that was the play of the year/)).toBeTruthy();
    expect(screen.getByText("PogViewer")).toBeTruthy();
    expect(screen.getByText(/on Kick/)).toBeTruthy();
  });

  it("renders nothing when no highlight is pinned", () => {
    const { container } = render(<ChatHighlightWidget token="tok" />);
    expect(container.textContent).toBe("");
  });
});

describe("ChatPollWidget", () => {
  it("renders options with counts from the real tally over the feed", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      poll: {
        question: "Which matchup next?",
        options: ["ZvT", "ZvP"],
        startedAtMs: 1000,
        status: "open",
      },
    };
    mockChat = {
      ...mockChat,
      messages: [
        { platform: "twitch", id: "1", user: "a", text: "!1", badges: [], atMs: 2000 },
        { platform: "twitch", id: "2", user: "b", text: "2", badges: [], atMs: 2100 },
        { platform: "kick", id: "3", user: "c", text: "!vote 2", badges: [], atMs: 2200 },
        // Replacement: a's later vote moves from option 1 to 2.
        { platform: "twitch", id: "4", user: "a", text: "!2", badges: [], atMs: 2300 },
        // Pre-poll and out-of-range noise.
        { platform: "twitch", id: "5", user: "d", text: "!1", badges: [], atMs: 500 },
        { platform: "twitch", id: "6", user: "e", text: "!9", badges: [], atMs: 2400 },
      ],
    };
    render(<ChatPollWidget token="tok" />);
    expect(screen.getByText("Which matchup next?")).toBeTruthy();
    expect(screen.getByText(/1\. ZvT/)).toBeTruthy();
    expect(screen.getByText(/2\. ZvP/)).toBeTruthy();
    expect(screen.getByText("0 · 0%")).toBeTruthy();
    expect(screen.getByText("3 · 100%")).toBeTruthy();
    expect(screen.getByText("3 votes")).toBeTruthy();
    expect(screen.getByText(/vote with !1 \/ !2 in chat/)).toBeTruthy();
  });

  it("shows the FINAL tag when closed and renders nothing without a poll", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      poll: {
        question: "Done?",
        options: ["yes", "no"],
        startedAtMs: 1000,
        status: "closed",
      },
    };
    render(<ChatPollWidget token="tok" />);
    expect(screen.getByText("FINAL")).toBeTruthy();
    expect(screen.queryByText(/vote with/)).toBeNull();
    cleanup();

    mockStudio = { ...EMPTY_STUDIO };
    const { container } = render(<ChatPollWidget token="tok" />);
    expect(container.textContent).toBe("");
  });
});

describe("ChatAlertsWidget", () => {
  it("renders the newest event prominently", () => {
    mockChat = {
      ...mockChat,
      events: [
        {
          platform: "twitch",
          id: "e1",
          kind: "raid",
          user: "BigStreamer",
          detail: "raided with a party",
          amount: "250",
          atMs: 1000,
        },
        {
          platform: "youtube",
          id: "e2",
          kind: "superchat",
          user: "Fan99",
          detail: "sent a Super Chat",
          amount: "$5.00",
          atMs: 2000,
        },
      ],
    };
    render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("Fan99")).toBeTruthy();
    expect(screen.getByText("Super Chat")).toBeTruthy();
    expect(screen.getByText("$5.00")).toBeTruthy();
    // The older event sits in the faded stack.
    expect(screen.getByText("BigStreamer")).toBeTruthy();
  });

  it("renders nothing when no events have arrived", () => {
    const { container } = render(<ChatAlertsWidget token="tok" />);
    expect(container.textContent).toBe("");
  });
});

describe("StreamGoalsWidget", () => {
  it("renders goal bars with current / target numbers", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      goals: [
        { label: "Sub goal", current: 42, target: 100 },
        { label: "Follower goal", current: 900, target: 1000 },
      ],
    };
    render(<StreamGoalsWidget token="tok" />);
    expect(screen.getByText("Sub goal")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("/ 100")).toBeTruthy();
    expect(screen.getByText("Follower goal")).toBeTruthy();
    expect(screen.getByText("900")).toBeTruthy();
  });

  it("renders nothing when no goals are set", () => {
    const { container } = render(<StreamGoalsWidget token="tok" />);
    expect(container.textContent).toBe("");
  });
});

describe("SessionRecapWidget", () => {
  const session: SessionSummary = {
    wins: 7,
    losses: 3,
    games: 10,
    mmrStart: 4100,
    mmrCurrent: 4180,
    streak: { kind: "win", count: 3 },
  };

  it("stays hidden at the initial recapSeq and appears when it increments", () => {
    mockStudio = { ...EMPTY_STUDIO, recapSeq: 3 };
    const { container, rerender } = render(
      <SessionRecapWidget token="tok" session={session} />,
    );
    // recapSeq 3 was the value at boot — no recap fires.
    expect(container.textContent).toBe("");

    mockStudio = { ...EMPTY_STUDIO, recapSeq: 4 };
    rerender(<SessionRecapWidget token="tok" session={session} />);
    expect(screen.getByText("SESSION RECAP")).toBeTruthy();
    expect(screen.getByText(/7W/)).toBeTruthy();
    expect(screen.getByText(/3L/)).toBeTruthy();
    expect(screen.getByText("+80")).toBeTruthy();
    expect(screen.getByText("W3")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------
 * Settings Test fire — each widget renders its clearly-labelled demo
 * content when a test-stamped payload targets it, and ignores test
 * payloads addressed to a different widget.
 * ------------------------------------------------------------------ */

const testFire = (widget: string): LiveGamePayload => ({
  isTest: true,
  testWidget: widget,
});
/** A per-widget test aimed at a DIFFERENT source in the same room. */
const foreignTestFire: LiveGamePayload = {
  isTest: true,
  testWidget: "multichat",
};

describe("Stream Studio Test fire", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ChatHighlightWidget shows the sample highlight with a TEST tag", () => {
    render(
      <ChatHighlightWidget token="tok" live={testFire("chat-highlight")} />,
    );
    expect(
      screen.getByText(/Pinned messages from the Stream Dock appear exactly/),
    ).toBeTruthy();
    expect(screen.getByText("TestViewer")).toBeTruthy();
    expect(screen.getByText("TEST")).toBeTruthy();
  });

  it("ChatHighlightWidget ignores a test targeting a different widget", () => {
    const { container } = render(
      <ChatHighlightWidget token="tok" live={foreignTestFire} />,
    );
    expect(container.textContent).toBe("");
  });

  it("ChatPollWidget runs the sample poll and steps the scripted tally", () => {
    vi.useFakeTimers();
    render(<ChatPollWidget token="tok" live={testFire("chat-poll")} />);
    expect(screen.getByText("Test poll — which matchup next?")).toBeTruthy();
    expect(screen.getByText(/1\. PvT/)).toBeTruthy();
    expect(screen.getByText(/2\. PvZ/)).toBeTruthy();
    expect(screen.getByText(/3\. PvP/)).toBeTruthy();
    expect(screen.getByText("TEST")).toBeTruthy();
    // First scripted snapshot: nobody has voted yet.
    expect(screen.getByText("0 votes")).toBeTruthy();
    // Walk to the final snapshot — 7/11/4 of 22.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("22 votes")).toBeTruthy();
    expect(screen.getByText("11 · 50%")).toBeTruthy();
    expect(screen.getByText("7 · 32%")).toBeTruthy();
  });

  it("ChatPollWidget ignores a test targeting a different widget", () => {
    const { container } = render(
      <ChatPollWidget token="tok" live={foreignTestFire} />,
    );
    expect(container.textContent).toBe("");
  });

  it("ChatAlertsWidget feeds the sample events through the toaster", () => {
    vi.useFakeTimers();
    render(<ChatAlertsWidget token="tok" live={testFire("chat-alerts")} />);
    // First event lands immediately — the Twitch sub alert.
    expect(screen.getByText("TestSubscriber")).toBeTruthy();
    expect(screen.getByText("TEST")).toBeTruthy();
    expect(screen.queryByText("TestRaider")).toBeNull();
    // Next event arrives on the demo cadence.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("TestRaider")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("TestFan")).toBeTruthy();
    expect(screen.getByText("$5.00")).toBeTruthy();
  });

  it("ChatAlertsWidget ignores a test targeting a different widget", () => {
    const { container } = render(
      <ChatAlertsWidget token="tok" live={foreignTestFire} />,
    );
    expect(container.textContent).toBe("");
  });

  it("StreamGoalsWidget shows the sample goal bars", () => {
    render(<StreamGoalsWidget token="tok" live={testFire("stream-goals")} />);
    expect(screen.getByText("Test: Follower goal")).toBeTruthy();
    expect(screen.getByText("1168")).toBeTruthy();
    expect(screen.getByText("/ 1200")).toBeTruthy();
    expect(screen.getByText("Test: Sub goal")).toBeTruthy();
    expect(screen.getByText("TEST")).toBeTruthy();
  });

  it("StreamGoalsWidget ignores a test targeting a different widget", () => {
    const { container } = render(
      <StreamGoalsWidget token="tok" live={foreignTestFire} />,
    );
    expect(container.textContent).toBe("");
  });

  it("SessionRecapWidget treats a test fire like a recap trigger using the payload's session block", () => {
    render(
      <SessionRecapWidget
        token="tok"
        live={{
          ...testFire("session-recap"),
          session: {
            wins: 4,
            losses: 4,
            games: 8,
            mmrStart: 5320,
            mmrCurrent: 5343,
            streak: { kind: "win", count: 2 },
          },
        }}
      />,
    );
    expect(screen.getByText("SESSION RECAP")).toBeTruthy();
    expect(screen.getByText("TEST")).toBeTruthy();
    expect(screen.getByText(/4W/)).toBeTruthy();
    expect(screen.getByText(/4L/)).toBeTruthy();
    expect(screen.getByText("+23")).toBeTruthy();
    expect(screen.getByText("W2")).toBeTruthy();
  });

  it("SessionRecapWidget falls back to the demo session block when the payload has none", () => {
    render(
      <SessionRecapWidget token="tok" live={testFire("session-recap")} />,
    );
    expect(screen.getByText("SESSION RECAP")).toBeTruthy();
    expect(screen.getByText(/4W/)).toBeTruthy();
    expect(screen.getByText(/2L/)).toBeTruthy();
    expect(screen.getByText("+34")).toBeTruthy();
    expect(screen.getByText("W2")).toBeTruthy();
  });

  it("SessionRecapWidget ignores a test targeting a different widget", () => {
    const { container } = render(
      <SessionRecapWidget token="tok" live={foreignTestFire} />,
    );
    expect(container.textContent).toBe("");
  });
});
