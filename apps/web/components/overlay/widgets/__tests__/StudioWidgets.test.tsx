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
import { DEFAULT_APPEARANCE } from "@/lib/multichat/appearance";
import { DEFAULT_ALERTS, type AlertConfig } from "@/lib/multichat/alerts";
import {
  DEFAULT_BROLL_CONFIG,
  type StudioState,
} from "@/lib/multichat/useStudioState";
import type { LiveGamePayload } from "@/components/overlay/types";
import type { SessionSummary } from "../SessionWidget";
import { ChatHighlightWidget } from "../ChatHighlightWidget";
import { ChatPollWidget } from "../ChatPollWidget";
import { appendAlertQueue, ChatAlertsWidget } from "../ChatAlertsWidget";
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

let mockStudio: StudioState & { loaded: boolean; snapshotReady: boolean };
let mockChat: MultiChatState;
let mockAppearance = { ...DEFAULT_APPEARANCE };
let mockAlerts: AlertConfig = {
  ...DEFAULT_ALERTS,
  eventVisuals: { ...DEFAULT_ALERTS.eventVisuals },
};
const mockMultiChatArgs: Array<{ config?: unknown }> = [];
const eventSoundSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/multichat/useEventSounds", () => ({
  useEventSounds: (...args: unknown[]) => eventSoundSpy(...args),
}));

vi.mock("@/lib/multichat/useStudioState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useStudioState")>();
  return { ...actual, useStudioState: () => mockStudio };
});

// BrollPlayer's YouTube lifecycle has its own focused suite. These render
// contracts only need to prove when StreamSceneWidget mounts the player.
vi.mock("../BrollPlayer", () => ({
  BrollPlayer: ({
    clips,
    audioOwner,
    videoFormat,
  }: {
    clips: Array<{ id: string }>;
    audioOwner: boolean;
    videoFormat: "horizontal" | "vertical";
  }) => (
    <div
      data-testid="broll-player"
      data-clip-count={clips.length}
      data-audio-owner={String(audioOwner)}
      data-video-format={videoFormat}
    />
  ),
}));

vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: (args: { config?: unknown }) => {
    mockMultiChatArgs.push(args);
    return mockChat;
  },
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
    appearance: mockAppearance,
    tts: null,
    sound: null,
    alerts: mockAlerts,
    loaded: true,
  }),
}));

const EMPTY_STUDIO: StudioState & {
  loaded: boolean;
  snapshotReady: boolean;
} = {
  highlight: null,
  poll: null,
  goals: [],
  blockedUsers: [],
  recapSeq: 0,
  scene: null,
  timer: null,
  broll: DEFAULT_BROLL_CONFIG,
  streamStartMs: null,
  vodUrl: null,
  updatedAt: null,
  loaded: true,
  snapshotReady: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  mockStudio = { ...EMPTY_STUDIO };
  mockChat = { messages: [], events: [], statuses: {}, active: true };
  mockAppearance = { ...DEFAULT_APPEARANCE };
  mockAlerts = {
    ...DEFAULT_ALERTS,
    eventVisuals: { ...DEFAULT_ALERTS.eventVisuals },
  };
  mockMultiChatArgs.length = 0;
  mockEngagement = { ...EMPTY_ENGAGEMENT };
  mockEngagementEvent = null;
  mockFacts = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
  it("opens the chat feed only while voting is open", () => {
    const view = render(<ChatPollWidget token="tok" />);
    expect(mockMultiChatArgs[mockMultiChatArgs.length - 1]?.config).toBeNull();

    mockStudio = {
      ...EMPTY_STUDIO,
      poll: {
        question: "Choose",
        options: ["One", "Two"],
        startedAtMs: 1000,
        status: "open",
      },
    };
    view.rerender(<ChatPollWidget token="tok" />);
    expect(mockMultiChatArgs[mockMultiChatArgs.length - 1]?.config).toEqual({
      twitch: { enabled: true, channel: "me" },
    });

    mockStudio = {
      ...mockStudio,
      poll: mockStudio.poll ? { ...mockStudio.poll, status: "closed" } : null,
    };
    view.rerender(<ChatPollWidget token="tok" />);
    expect(mockMultiChatArgs[mockMultiChatArgs.length - 1]?.config).toBeNull();
  });

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
  it("renders alerts but disables event sound in an audio=0 copy", () => {
    window.history.replaceState(
      {},
      "",
      "/overlay/tok/widget/chat-alerts?audio=0",
    );
    mockChat = {
      ...mockChat,
      events: [{
        platform: "twitch",
        id: "silent-alert",
        kind: "follow",
        user: "SeenFollower",
        detail: "followed",
        atMs: Date.now(),
      }],
    };

    render(<ChatAlertsWidget token="tok" />);

    expect(screen.getByText("SeenFollower")).toBeTruthy();
    expect(eventSoundSpy.mock.calls.at(-1)?.[1]).toMatchObject({
      eventSoundsEnabled: false,
    });
  });

  it("queues events oldest-first so every supporter becomes prominent", () => {
    vi.useFakeTimers();
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
    expect(screen.getByText("BigStreamer")).toBeTruthy();
    expect(screen.queryByText("Fan99")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByText("Fan99")).toBeTruthy();
    expect(screen.getByText("Super Chat")).toBeTruthy();
    expect(screen.getByText("$5.00")).toBeTruthy();
    // The already-shown event sits in the faded stack.
    expect(screen.getByText("BigStreamer")).toBeTruthy();
    vi.useRealTimers();
  });

  it("dispatches each event kind through its configured visual preset", () => {
    vi.useFakeTimers();
    mockAlerts = {
      ...DEFAULT_ALERTS,
      durationSec: 3,
      motion: "maximum",
      eventVisuals: {
        ...DEFAULT_ALERTS.eventVisuals,
        follow: "frog-sip",
        raid: "raid-boss",
      },
    };
    mockChat = {
      ...mockChat,
      events: [
        {
          platform: "twitch",
          id: "preset-follow",
          kind: "follow",
          user: "FrogFollower",
          detail: "followed",
          atMs: Date.now(),
        },
        {
          platform: "twitch",
          id: "preset-raid",
          kind: "raid",
          user: "BossRaider",
          detail: "raided",
          amount: "99",
          atMs: Date.now() + 1,
        },
      ],
    };

    const { container } = render(<ChatAlertsWidget token="tok" />);
    expect(
      container.querySelector('[data-alert-preset="frog-sip"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-alert-motion="maximum"]'),
    ).toBeTruthy();

    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText("BossRaider")).toBeTruthy();
    expect(
      container.querySelector('[data-alert-preset="raid-boss"]'),
    ).toBeTruthy();
    vi.useRealTimers();
  });

  it("hides the faded alert history when showHistory is disabled", () => {
    vi.useFakeTimers();
    mockAlerts = {
      ...DEFAULT_ALERTS,
      durationSec: 3,
      showHistory: false,
      eventVisuals: { ...DEFAULT_ALERTS.eventVisuals },
    };
    mockChat = {
      ...mockChat,
      events: [
        {
          platform: "twitch",
          id: "history-first",
          kind: "follow",
          user: "FirstSupporter",
          detail: "followed",
          atMs: Date.now(),
        },
        {
          platform: "youtube",
          id: "history-second",
          kind: "member",
          user: "CurrentSupporter",
          detail: "became a member",
          atMs: Date.now() + 1,
        },
      ],
    };

    render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("FirstSupporter")).toBeTruthy();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText("CurrentSupporter")).toBeTruthy();
    expect(screen.queryByText("FirstSupporter")).toBeNull();
    vi.useRealTimers();
  });

  it("renders nothing when no events have arrived", () => {
    const { container } = render(<ChatAlertsWidget token="tok" />);
    expect(container.textContent).toBe("");
  });

  it("holds alerts and audio until moderation has an authoritative snapshot", () => {
    const event = {
      platform: "twitch" as const,
      id: "waiting-for-moderation",
      kind: "follow" as const,
      user: "PossiblyBlockedFollower",
      detail: "followed",
      atMs: Date.now(),
    };
    mockStudio = { ...EMPTY_STUDIO, snapshotReady: false };
    mockChat = { ...mockChat, events: [event] };

    const view = render(<ChatAlertsWidget token="tok" />);

    expect(screen.queryByText(event.user)).toBeNull();
    expect(eventSoundSpy.mock.calls.at(-1)?.[0]).toEqual([]);

    mockStudio = { ...EMPTY_STUDIO, snapshotReady: true };
    view.rerender(<ChatAlertsWidget token="tok" />);

    expect(screen.getByText(event.user)).toBeTruthy();
    expect(eventSoundSpy.mock.calls.at(-1)?.[0]).toEqual([event]);
  });

  it("filters Settings and Stream Dock blocked users before queue and audio", () => {
    mockAppearance = {
      ...DEFAULT_APPEARANCE,
      blockedUsers: " @SettingsBlocked ",
    };
    mockStudio = {
      ...EMPTY_STUDIO,
      blockedUsers: [" @DockBlocked "],
    };
    const allowed = {
      platform: "twitch" as const,
      id: "allowed-follow",
      kind: "follow" as const,
      user: "FriendlyFollower",
      detail: "followed",
      atMs: Date.now(),
    };
    mockChat = {
      ...mockChat,
      events: [
        { ...allowed, id: "settings-blocked", user: "SETTINGSBLOCKED" },
        { ...allowed, id: "dock-blocked", user: "dockblocked" },
        allowed,
      ],
    };

    render(<ChatAlertsWidget token="tok" />);

    expect(screen.getByText("FriendlyFollower")).toBeTruthy();
    expect(screen.queryByText("SETTINGSBLOCKED")).toBeNull();
    expect(screen.queryByText("dockblocked")).toBeNull();
    expect(eventSoundSpy.mock.calls.at(-1)?.[0]).toEqual([allowed]);
  });

  it("prunes a newly blocked prominent and queued alert without resurrecting it", () => {
    const first = {
      platform: "twitch" as const,
      id: "first-alert",
      kind: "raid" as const,
      user: "FirstRaider",
      detail: "raided",
      atMs: Date.now(),
    };
    const second = {
      ...first,
      id: "second-alert",
      user: "QueuedRaider",
      atMs: Date.now() + 1,
    };
    mockChat = { ...mockChat, events: [first, second] };
    const view = render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("FirstRaider")).toBeTruthy();

    mockStudio = {
      ...EMPTY_STUDIO,
      blockedUsers: [" firsTRAIDER ", "@QUEUEDRAIDER"],
    };
    view.rerender(<ChatAlertsWidget token="tok" />);

    expect(screen.queryByText("FirstRaider")).toBeNull();
    expect(screen.queryByText("QueuedRaider")).toBeNull();
    expect(eventSoundSpy.mock.calls.at(-1)?.[0]).toEqual([]);

    // Retained relay history stays seen while blocked. Unblocking does not
    // enqueue or ring either event a second time.
    mockStudio = { ...EMPTY_STUDIO };
    view.rerender(<ChatAlertsWidget token="tok" />);
    expect(screen.queryByText("FirstRaider")).toBeNull();
    expect(screen.queryByText("QueuedRaider")).toBeNull();
    expect(eventSoundSpy.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it("keeps a 50-recipient gift burst so every supporter is shown", () => {
    vi.useFakeTimers();
    mockChat = {
      ...mockChat,
      events: Array.from({ length: 50 }, (_, index) => ({
        platform: "youtube" as const,
        id: `gift-${index}`,
        kind: "member" as const,
        user: `GiftRecipient${index}`,
        detail: "received a gifted membership",
        atMs: 1_000 + index,
      })),
    };

    render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("GiftRecipient0")).toBeTruthy();
    for (let index = 1; index < 50; index += 1) {
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.getByText(`GiftRecipient${index}`)).toBeTruthy();
    }
    vi.useRealTimers();
  });

  it("carries an existing overflow total into later alert bursts", () => {
    const supporter = (index: number) => ({
      platform: "twitch" as const,
      id: `overflow-supporter-${index}`,
      kind: "giftsub" as const,
      user: `Supporter${index}`,
      detail: "received a gift sub",
      atMs: 1_000 + index,
    });
    const first = appendAlertQueue(
      [],
      Array.from({ length: 61 }, (_, index) => supporter(index)),
    );
    expect(first).toHaveLength(60);
    expect(first.at(-1)?.user).toBe("2 more supporters");

    const next = appendAlertQueue(
      first,
      Array.from({ length: 3 }, (_, index) => supporter(61 + index)),
    );
    expect(next).toHaveLength(60);
    expect(next.at(-1)?.user).toBe("5 more supporters");
    expect(next.at(-1)?.amount).toBe("5 events");
  });

  it("keeps replayed events in chat without firing an old alert again", () => {
    mockChat = {
      ...mockChat,
      events: [
        {
          platform: "tiktok",
          id: "replayed-gift",
          kind: "gift",
          user: "EarlierSupporter",
          detail: "sent a Rose",
          atMs: 1_000,
          replayed: true,
        },
      ],
    };
    const { container } = render(<ChatAlertsWidget token="tok" />);
    expect(container.textContent).toBe("");
  });

  it("alerts a near-live replay when the alert surface joined seconds late", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    mockChat = {
      ...mockChat,
      events: [
        {
          platform: "tiktok",
          id: "near-live-gift",
          kind: "gift",
          user: "JustNowSupporter",
          detail: "sent a Rose",
          atMs: 10_000,
          replayed: true,
        },
      ],
    };
    render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("JustNowSupporter")).toBeTruthy();
    vi.useRealTimers();
  });

  it("updates one Jewels combo card instead of queueing cumulative totals", () => {
    const first = {
      platform: "youtube" as const,
      id: "jewel-1:combo:1",
      updateKey: "jewels:jewel-1",
      updateVersion: 1,
      kind: "gift" as const,
      user: "JewelFan",
      detail: "sent Galaxy",
      amount: "100 Jewels",
      atMs: Date.now(),
    };
    mockChat = { ...mockChat, events: [first] };
    const view = render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("100 Jewels")).toBeTruthy();

    mockChat = {
      ...mockChat,
      events: [
        {
          ...first,
          id: "jewel-1:combo:3",
          updateVersion: 3,
          detail: "sent Galaxy x3",
          amount: "300 Jewels",
          atMs: Date.now() + 1_000,
        },
      ],
    };
    view.rerender(<ChatAlertsWidget token="tok" />);
    expect(screen.queryByText("100 Jewels")).toBeNull();
    expect(screen.getByText("300 Jewels")).toBeTruthy();
    expect(screen.getAllByText("JewelFan")).toHaveLength(1);
  });

  it("clears the alert and faded history after the visibility window", () => {
    vi.useFakeTimers();
    mockChat = {
      ...mockChat,
      events: [
        {
          platform: "twitch",
          id: "e1",
          kind: "raid",
          user: "OlderRaider",
          detail: "raided with a party",
          atMs: 1000,
        },
        {
          platform: "youtube",
          id: "e2",
          kind: "superchat",
          user: "NewestFan",
          detail: "sent a Super Chat",
          atMs: 2000,
        },
      ],
    };

    const { container } = render(<ChatAlertsWidget token="tok" />);
    expect(screen.getByText("OlderRaider")).toBeTruthy();
    expect(screen.queryByText("NewestFan")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(screen.getByText("NewestFan")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(container.textContent).toBe("");
    vi.useRealTimers();
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

  it("restores the centered default BRB scene when the library is empty", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      scene: {
        mode: "brb",
        message: "Grabbing water, back in 5",
        countdownEndsAt: null,
        setAtMs: 1,
      },
    };
    const { container } = render(<StreamSceneWidget token="tok" />);
    expect(screen.getByText("BE RIGHT BACK")).toBeTruthy();
    expect(screen.getByText("Grabbing water, back in 5")).toBeTruthy();
    const defaultScene = screen.getByTestId("stream-scene-default");
    expect(defaultScene.parentElement?.dataset.sceneLayout).toBe("default");
    expect(defaultScene.style.justifyContent).toBe("center");
    expect(container.querySelectorAll(".scn-ember")).toHaveLength(14);
    expect(screen.queryByTestId("stream-scene-hud")).toBeNull();
    expect(screen.queryByTestId("broll-player")).toBeNull();
  });

  it("automatically uses b-roll and the compact HUD when clips exist", () => {
    vi.stubGlobal("innerWidth", 1920);
    vi.stubGlobal("innerHeight", 1080);
    mockStudio = {
      ...EMPTY_STUDIO,
      broll: {
        ...DEFAULT_BROLL_CONFIG,
        clips: [
          {
            id: "hold-the-line",
            title: "Hold at the natural",
            videoId: "abcDEF12345",
            startSeconds: 90,
            endSeconds: 140,
          },
        ],
      },
      scene: {
        mode: "starting",
        message: "Loading into ladder",
        countdownEndsAt: Date.now() + 5 * 60_000,
        setAtMs: Date.now(),
      },
    };
    render(<StreamSceneWidget token="tok" />);

    expect(screen.getByText("STARTING SOON")).toBeTruthy();
    expect(screen.getByText("Loading into ladder")).toBeTruthy();
    expect(screen.getByText(/^0?5:00$|^0?4:5\d$/)).toBeTruthy();
    expect(screen.getByTestId("broll-player").dataset.clipCount).toBe("1");
    expect(screen.getByTestId("broll-player").dataset.audioOwner).toBe("true");
    expect(screen.getByTestId("broll-player").dataset.videoFormat).toBe(
      "horizontal",
    );
    const hud = screen.getByTestId("stream-scene-hud");
    expect(hud.parentElement?.dataset.sceneLayout).toBe("broll");
    expect(hud.style.top).toContain("clamp(");
    expect(hud.style.width).toBe("min(88vw, 820px)");
    expect(screen.queryByTestId("stream-scene-default")).toBeNull();
  });

  it("keeps a 1080x1920 standalone copy video-only", () => {
    vi.stubGlobal("innerWidth", 1080);
    vi.stubGlobal("innerHeight", 1920);
    mockStudio = {
      ...EMPTY_STUDIO,
      broll: {
        ...DEFAULT_BROLL_CONFIG,
        clips: [
          {
            id: "vertical-highlight",
            title: "Vertical highlight",
            videoId: "abcDEF12345",
            startSeconds: 90,
            endSeconds: 140,
          },
        ],
      },
      scene: {
        mode: "brb",
        message: "Vertical break",
        countdownEndsAt: null,
        setAtMs: Date.now(),
      },
    };

    render(<StreamSceneWidget token="tok" />);
    expect(screen.getByTestId("broll-player").dataset.audioOwner).toBe("false");
    expect(screen.getByTestId("broll-player").dataset.videoFormat).toBe(
      "vertical",
    );
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

  it("keeps post-game results but does not reuse them as current-opponent intel", () => {
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
    expect(screen.getAllByText(/LAST GAME: WIN vs Printf \(PvZ\)/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/HEAD-TO-HEAD vs Printf/)).toHaveLength(0);
    expect(screen.queryAllByText(/BARCODE REVEALED/)).toHaveLength(0);
    expect(screen.queryAllByText(/REMATCH:/)).toHaveLength(0);
    expect(screen.queryAllByText(/CHEESE WATCH/)).toHaveLength(0);
    expect(screen.queryAllByText(/SCOUT:/)).toHaveLength(0);
    expect(screen.queryAllByText(/BEST ANSWER:/)).toHaveLength(0);
    expect(screen.queryAllByText(/MMR GAP:/)).toHaveLength(0);
  });

  it("reads live-opponent intel from the in-game envelope with NOW PLAYING", () => {
    render(
      <StatsTickerWidget
        token="tok"
        live={{ myMmr: 1_000 }}
        session={{
          wins: 1,
          losses: 0,
          games: 1,
          mmrCurrent: 6700,
          region: "NA",
        }}
        liveGame={{
          type: "liveGameState",
          phase: "match_in_progress",
          capturedAt: 1,
          opponent: { name: "Serral", profile: { region: "US" } },
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
    expect(screen.getAllByText(/MMR GAP: opponent \+100/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/opponent \+5,800/)).toHaveLength(0);
  });

  it("suppresses the MMR gap when the session belongs to another region", () => {
    render(
      <StatsTickerWidget
        token="tok"
        session={{
          wins: 1,
          losses: 0,
          games: 1,
          mmrCurrent: 6700,
          region: "NA",
        }}
        liveGame={{
          type: "liveGameState",
          phase: "match_in_progress",
          capturedAt: 1,
          gameKey: "eu-game",
          opponent: { name: "Clem", profile: { region: "EU" } },
          streamerHistory: { oppName: "Clem", oppMmr: 6800 },
        }}
      />,
    );

    expect(screen.getAllByText(/NOW PLAYING: vs Clem/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/MMR GAP:/)).toHaveLength(0);
  });

  it("does not show the previous opponent while current enrichment is pending", () => {
    render(
      <StatsTickerWidget
        token="tok"
        live={{
          result: "win",
          oppName: "PreviousOpponent",
          matchup: "PvT",
          headToHead: { wins: 4, losses: 2 },
          cheeseProbability: 0.8,
        }}
        liveGame={{
          type: "liveGameState",
          phase: "match_loading",
          capturedAt: 2,
          gameKey: "new-game",
          opponent: { name: "CurrentOpponent", race: "Zerg" },
        }}
      />,
    );

    expect(screen.queryAllByText(/HEAD-TO-HEAD vs PreviousOpponent/)).toHaveLength(0);
    expect(screen.queryAllByText(/CHEESE WATCH/)).toHaveLength(0);
    expect(screen.queryAllByText(/NOW PLAYING: vs PreviousOpponent/)).toHaveLength(0);
    expect(screen.getAllByText(/LAST GAME: WIN vs PreviousOpponent/).length).toBeGreaterThan(0);
  });

  it("removes opponent intel as soon as the live match ends", () => {
    const live = {
      result: "loss" as const,
      oppName: "Serral",
      matchup: "PvZ",
      headToHead: { wins: 0, losses: 3 },
      cheeseProbability: 0.55,
    };
    const active = {
      type: "liveGameState" as const,
      phase: "match_in_progress" as const,
      capturedAt: 1,
      gameKey: "game-1",
      streamerHistory: {
        oppName: "Serral",
        matchup: "PvZ",
        headToHead: { wins: 0, losses: 2 },
        cheeseProbability: 0.55,
      },
    };
    const { rerender } = render(
      <StatsTickerWidget token="tok" live={live} liveGame={active} />,
    );
    expect(screen.getAllByText(/NOW PLAYING: vs Serral/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/HEAD-TO-HEAD vs Serral: 0–2/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CHEESE WATCH: 55%/).length).toBeGreaterThan(0);

    rerender(
      <StatsTickerWidget
        token="tok"
        live={live}
        liveGame={{ ...active, phase: "match_ended" }}
      />,
    );

    expect(screen.queryAllByText(/NOW PLAYING: vs Serral/)).toHaveLength(0);
    expect(screen.queryAllByText(/HEAD-TO-HEAD vs Serral/)).toHaveLength(0);
    expect(screen.queryAllByText(/CHEESE WATCH/)).toHaveLength(0);
    expect(screen.getAllByText(/LAST GAME: LOSS vs Serral \(PvZ\)/).length).toBeGreaterThan(0);
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
  it("does not show the all-time oracle leaderboard while idle", () => {
    mockEngagement = {
      ...EMPTY_ENGAGEMENT,
      oracles: [
        { user: "Fingo", platform: "twitch", score: 10, correct: 1, total: 1 },
      ],
    };
    const { container } = render(<ChatOracleWidget token="tok" />);
    expect(container.textContent).toBe("");
  });

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
    // Regression: the dismiss timer used to be keyed on lastEvent
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
      // …and remain visible for the full 30-second result window.
      act(() => {
        vi.advanceTimersByTime(27_000);
      });
      expect(screen.getByText(/Nobody called it/)).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1_000);
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
    expect(screen.getByTestId("stream-scene-default")).toBeTruthy();
    expect(screen.queryByTestId("broll-player")).toBeNull();
  });

  it("StreamSceneWidget Test keeps the compact b-roll layout for a configured library", () => {
    mockStudio = {
      ...EMPTY_STUDIO,
      broll: {
        ...DEFAULT_BROLL_CONFIG,
        clips: [
          {
            id: "carrier-finish",
            title: "Carrier fleet closes it out",
            videoId: "ZYXwvu98765",
            startSeconds: 300,
            endSeconds: 348,
          },
        ],
      },
    };
    render(<StreamSceneWidget token="tok" live={testFire("stream-scene")} />);

    expect(screen.getByText("TEST")).toBeTruthy();
    expect(screen.getByTestId("stream-scene-hud")).toBeTruthy();
    expect(screen.getByTestId("broll-player").dataset.clipCount).toBe("1");
    expect(screen.queryByTestId("stream-scene-default")).toBeNull();
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
    // Later events arrive on the demo cadence but wait their turn.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("TestRaider")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("TestRaider")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8000);
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
