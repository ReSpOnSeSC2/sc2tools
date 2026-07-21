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
import { StreamSceneWidget, formatCountdown } from "../StreamSceneWidget";
import { StatsTickerWidget } from "../StatsTickerWidget";
import { CountdownTimerWidget } from "../CountdownTimerWidget";
import { ChatOracleWidget } from "../ChatOracleWidget";
import {
  EMPTY_ENGAGEMENT,
  type EngagementSummary,
} from "@/lib/multichat/useEngagementState";

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

let mockEngagement: EngagementSummary;
let mockEngagementEvent: Record<string, unknown> | null;
vi.mock("@/lib/multichat/useEngagementState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useEngagementState")>();
  return {
    ...actual,
    useEngagementState: () => ({
      summary: mockEngagement,
      lastEvent: mockEngagementEvent,
    }),
  };
});

let mockFacts: Array<{ id: string; text: string }>;
vi.mock("@/lib/multichat/useTickerFacts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useTickerFacts")>();
  return { ...actual, useTickerFacts: () => mockFacts };
});

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
  scene: null,
  timer: null,
  streamStartMs: null,
  vodUrl: null,
  updatedAt: null,
  loaded: true,
};

beforeEach(() => {
  mockStudio = { ...EMPTY_STUDIO };
  mockChat = { messages: [], events: [], statuses: {}, active: true };
  mockEngagement = { ...EMPTY_ENGAGEMENT };
  mockEngagementEvent = null;
  mockFacts = [];
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

describe("StreamSceneWidget", () => {
  it("renders transparent while no scene is active", () => {
    const { container } = render(<StreamSceneWidget token="tok" />);
    expect(container.textContent).toBe("");
  });

  it("renders BRB with the streamer's message", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      scene: {
        mode: "brb",
        message: "Grabbing water, back in 5",
        countdownEndsAt: null,
        setAtMs: 1,
      },
    };
    render(<StreamSceneWidget token="tok" />);
    expect(screen.getByText("BE RIGHT BACK")).toBeTruthy();
    expect(screen.getByText("Grabbing water, back in 5")).toBeTruthy();
  });

  it("renders Starting Soon with a ticking countdown", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      scene: {
        mode: "starting",
        message: "",
        countdownEndsAt: Date.now() + 5 * 60_000,
        setAtMs: Date.now(),
      },
    };
    render(<StreamSceneWidget token="tok" />);
    expect(screen.getByText("STARTING SOON")).toBeTruthy();
    // 5:00 minus render latency — either boundary formats fine.
    expect(screen.getByText(/^0?5:00$|^0?4:5\d$/)).toBeTruthy();
  });

  it("shows STARTING NOW once the countdown hits zero", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      scene: {
        mode: "starting",
        message: "",
        countdownEndsAt: Date.now() - 1000,
        setAtMs: Date.now() - 10_000,
      },
    };
    render(<StreamSceneWidget token="tok" />);
    expect(screen.getByText("STARTING NOW")).toBeTruthy();
  });

  it("formatCountdown pads and rolls into hours", () => {
    expect(formatCountdown(5 * 60_000)).toBe("05:00");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatCountdown(500)).toBe("00:01");
  });
});

describe("CountdownTimerWidget", () => {
  it("stays transparent without a timer and ticks when one is set", () => {
    const { container } = render(<CountdownTimerWidget token="tok" />);
    expect(container.textContent).toBe("");
    cleanup();

    mockStudio = {
      ...EMPTY_STUDIO,
      timer: { label: "Next game in", endsAt: Date.now() + 5 * 60_000, setAtMs: 1 },
    };
    render(<CountdownTimerWidget token="tok" />);
    expect(screen.getByText("Next game in")).toBeTruthy();
    expect(screen.getByText(/^0?[45]:\d\d$/)).toBeTruthy();
  });

  it("shows TIME! once expired", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      timer: { label: "", endsAt: Date.now() - 1000, setAtMs: 1 },
    };
    render(<CountdownTimerWidget token="tok" />);
    expect(screen.getByText("TIME!")).toBeTruthy();
  });
});

describe("StatsTickerWidget", () => {
  it("stays transparent with nothing to show", () => {
    const { container } = render(<StatsTickerWidget token="tok" />);
    expect(container.textContent).toBe("");
  });

  it("composes segments from session, goals and engagement", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      goals: [{ label: "Follower goal", current: 1168, target: 1200 }],
    };
    mockEngagement = {
      ...EMPTY_ENGAGEMENT,
      wall: [
        { user: "Grinder", platform: "twitch", xp: 900, level: 3, rank: "Stalker" },
      ],
      prediction: {
        gameKey: "g1",
        opponent: "X",
        tally: { win: 3, loss: 1, total: 4 },
      },
    };
    render(
      <StatsTickerWidget
        token="tok"
        session={{
          wins: 4,
          losses: 2,
          games: 6,
          mmrStart: 4280,
          mmrCurrent: 4314,
        }}
      />,
    );
    // Segments render twice (seamless marquee) — assert via getAllBy.
    expect(screen.getAllByText(/SESSION 4–2 · \+34 MMR/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/FOLLOWER GOAL 1168 \/ 1200/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/chat is 75% WIN/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/TOP SUPPORTER: Grinder \(Stalker\)/).length).toBeGreaterThan(0);
    expect(screen.getByText("LIVE")).toBeTruthy();
  });

  it("adds opponent intel from the post-game payload", () => {
    render(
      <StatsTickerWidget
        token="tok"
        live={{
          result: "win",
          oppName: "Printf",
          matchup: "PvZ",
          oppRevealedName: "THERIDDLER",
          headToHead: { wins: 14, losses: 9 },
          rematch: { isRematch: true, lastResult: "loss" },
          cheeseProbability: 0.62,
          favOpening: { name: "Hatch First", share: 0.71, samples: 12 },
          bestAnswer: { build: "3 Gate Blink", winRate: 0.64, total: 11 },
          oppMmr: 4612,
          myMmr: 4530,
        }}
      />,
    );
    expect(screen.getAllByText(/HEAD-TO-HEAD vs Printf: 14–9/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BARCODE REVEALED: this is THERIDDLER/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/REMATCH: dropped the last one/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CHEESE WATCH: 62%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SCOUT: they open Hatch First 71%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BEST ANSWER: 3 Gate Blink — 64%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MMR GAP: opponent \+82 — upset material/).length).toBeGreaterThan(0);
  });

  it("reads live-opponent intel from the in-game envelope with NOW PLAYING", () => {
    render(
      <StatsTickerWidget
        token="tok"
        liveGame={{
          type: "liveGameState",
          phase: "match_in_progress",
          capturedAt: 1,
          streamerHistory: {
            oppName: "Serral",
            matchup: "PvZ",
            oppMmr: 6800,
            headToHead: { wins: 0, losses: 2 },
          },
        }}
      />,
    );
    expect(
      screen.getAllByText(/NOW PLAYING: vs Serral \(PvZ\) · 6,800 MMR/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/HEAD-TO-HEAD vs Serral: 0–2/).length).toBeGreaterThan(0);
  });

  it("drops the CALL IT prompt after the voting lock and shows the oracle recap", () => {
    mockEngagement = {
      ...EMPTY_ENGAGEMENT,
      prediction: {
        gameKey: "g1",
        opponent: "X",
        tally: { win: 3, loss: 1, total: 4 },
        locksAtMs: Date.now() - 1_000, // already locked
      },
      oracleRecap: {
        calls: 19,
        majorityRight: 12,
        last: {
          opponent: "Printf",
          result: "win",
          majority: "win",
          pct: 68,
          wasRight: true,
        },
      },
    };
    render(
      <StatsTickerWidget token="tok" session={{ wins: 1, losses: 0, games: 1 }} />,
    );
    expect(screen.queryByText(/CALL IT/)).toBeNull();
    expect(
      screen.getAllByText(/LAST CALL: chat said 68% WIN vs Printf — chat was RIGHT/)
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/CHAT ORACLE RECORD: majority right in 12 of 19 calls/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("appends a page of server facts to the loop", () => {
    mockFacts = [
      { id: "career-record", text: "CAREER: 100 W – 80 L (56%) over 190 tracked games" },
      { id: "peak-mmr", text: "PEAK MMR: 4,712 on NA (Aug 12, 2025) — 138 away right now" },
    ];
    render(
      <StatsTickerWidget token="tok" session={{ wins: 1, losses: 0, games: 1 }} />,
    );
    expect(screen.getAllByText(/CAREER: 100 W – 80 L/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/PEAK MMR: 4,712/).length).toBeGreaterThan(0);
  });
});

describe("ChatOracleWidget game-to-game transfer", () => {
  it("shows the reveal after a settle event", () => {
    mockEngagementEvent = {
      type: "prediction-settled",
      result: "win",
      tally: { win: 0, loss: 0, total: 0 },
      correctCount: 0,
      pointsEach: 10,
      topOracles: [],
    };
    render(<ChatOracleWidget token="tok" />);
    expect(screen.getByText(/Nobody called it — result: WIN/)).toBeTruthy();
  });

  it("the reveal auto-dismisses even when other events land mid-reveal", () => {
    // Regression: the 12s dismiss timer used to be keyed on lastEvent
    // — a level-up arriving during the reveal cancelled it via the
    // effect cleanup and "nobody called it" sat on stream forever.
    vi.useFakeTimers();
    try {
      mockEngagementEvent = {
        type: "prediction-settled",
        result: "win",
        tally: { win: 0, loss: 0, total: 0 },
        correctCount: 0,
        pointsEach: 10,
        topOracles: [],
      };
      const { rerender } = render(<ChatOracleWidget token="tok" />);
      expect(screen.getByText(/Nobody called it/)).toBeTruthy();
      // 2s in, an unrelated engagement event lands (XP level-up from
      // the same game) — the reveal must stay for now…
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      mockEngagementEvent = { type: "level-up", user: "A", level: 2 };
      rerender(<ChatOracleWidget token="tok" />);
      expect(screen.getByText(/Nobody called it/)).toBeTruthy();
      // …and still auto-dismiss on schedule.
      act(() => {
        vi.advanceTimersByTime(13_000);
      });
      expect(screen.queryByText(/Nobody called it/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new open window instantly outranks a leftover reveal", () => {
    // The settle event from game N is still the last event, but game
    // N+1's window is already open in the summary (streamer requeued
    // fast) — the CALL IT card must take over, not the stale reveal.
    mockEngagementEvent = {
      type: "prediction-settled",
      result: "win",
      tally: { win: 0, loss: 0, total: 0 },
      correctCount: 0,
      pointsEach: 10,
      topOracles: [],
    };
    mockEngagement = {
      ...EMPTY_ENGAGEMENT,
      prediction: {
        gameKey: "g-next",
        opponent: "NextOpp",
        tally: { win: 0, loss: 0, total: 0 },
        locksAtMs: Date.now() + 90_000,
      },
    };
    render(<ChatOracleWidget token="tok" />);
    expect(screen.queryByText(/Nobody called it/)).toBeNull();
    expect(screen.getByText(/Call it vs NextOpp/)).toBeTruthy();
  });
});

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

  it("StreamSceneWidget shows the Starting Soon demo with a TEST tag", () => {
    render(<StreamSceneWidget token="tok" live={testFire("stream-scene")} />);
    expect(screen.getByText("STARTING SOON")).toBeTruthy();
    expect(screen.getByText(/Test: ranked ladder grind/)).toBeTruthy();
    expect(screen.getByText("TEST")).toBeTruthy();
  });

  it("StreamSceneWidget ignores a test targeting a different widget", () => {
    const { container } = render(
      <StreamSceneWidget token="tok" live={foreignTestFire} />,
    );
    expect(container.textContent).toBe("");
  });

  it("StatsTickerWidget shows the demo strip with a TEST segment", () => {
    render(<StatsTickerWidget token="tok" live={testFire("stats-ticker")} />);
    expect(screen.getAllByText(/TEST · this is your stats ticker/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CALL IT: !win \/ !loss/).length).toBeGreaterThan(0);
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
