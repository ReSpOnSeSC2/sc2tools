import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  MultiChatWidget,
  useMultichatConfig,
  type LoadedConfig,
} from "../MultiChatWidget";
import { DEFAULT_APPEARANCE } from "@/lib/multichat/appearance";
import { DEFAULT_ALERTS } from "@/lib/multichat/alerts";
import type { MultichatConfig } from "@/lib/multichat/types";
import type { MultiChatState } from "@/lib/multichat/useMultiChat";

let mockConfig: { config: MultichatConfig | null; loaded: boolean } = {
  config: null,
  loaded: false,
};
let mockChat: MultiChatState = {
  messages: [],
  events: [],
  statuses: {},
  active: false,
};
let mockStudioBlockedUsers: string[] = [];
let mockStudioSnapshotReady = true;

const hookSpies = vi.hoisted(() => ({
  engagement: vi.fn(),
  sound: vi.fn(),
  tts: vi.fn(),
  commands: vi.fn(),
  translation: vi.fn(),
}));

vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: () => mockChat,
}));

vi.mock("@/lib/multichat/useStudioState", () => ({
  useStudioState: () => ({
    blockedUsers: mockStudioBlockedUsers,
    loaded: true,
    snapshotReady: mockStudioSnapshotReady,
  }),
}));

vi.mock("@/lib/multichat/useEngagementReporter", () => ({
  useEngagementReporter: (...args: unknown[]) =>
    hookSpies.engagement(...args),
}));

vi.mock("@/lib/multichat/useChatSound", () => ({
  useChatSound: (...args: unknown[]) => hookSpies.sound(...args),
}));

vi.mock("@/lib/multichat/useChatTts", () => ({
  useChatTts: (...args: unknown[]) => {
    hookSpies.tts(...args);
    return { needsGesture: false, onUserGesture: vi.fn() };
  },
}));

vi.mock("@/lib/multichat/useCommandAnswers", () => ({
  useCommandAnswers: (...args: unknown[]) => {
    hookSpies.commands(...args);
    return null;
  },
}));

vi.mock("@/lib/multichat/useTranslation", () => ({
  useTranslation: (...args: unknown[]) => {
    hookSpies.translation(...args);
    return {};
  },
}));

// The config loader hits the token-authed relay; stub fetch with the
// wire shape the API serves.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ config: mockConfig.config ?? {} }),
  });
  mockConfig = { config: null, loaded: false };
  mockChat = { messages: [], events: [], statuses: {}, active: false };
  mockStudioBlockedUsers = [];
  mockStudioSnapshotReady = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderWidget() {
  const view = render(<MultiChatWidget token="tok_test" />);
  // Let the config fetch promise chain settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

function ConfigProbe({
  token,
  onConfig,
}: {
  token: string;
  onConfig?: (config: LoadedConfig) => void;
}) {
  const config = useMultichatConfig(token);
  onConfig?.(config);
  return (
    <div data-testid="config-state">
      {config.loaded
        ? `ready:${config.platforms?.twitch?.channel ?? "none"}`
        : "unverified"}
    </div>
  );
}

function requireLoadedConfig(config: LoadedConfig | null): LoadedConfig {
  if (!config) throw new Error("Expected the config probe to have rendered");
  return config;
}

describe("MultiChatWidget", () => {
  it("loads and sanitizes the alerts section outside platform config", async () => {
    let latestConfig: LoadedConfig | null = null;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {
          twitch: { enabled: true, channel: "alert-channel" },
          alerts: {
            eventVisuals: {
              follow: "frog-hype",
              raid: "shuffle",
              reward: "not-a-real-preset",
              notAnEvent: "cash-pop",
            },
            motion: "maximum",
            durationSec: 99,
            showHistory: false,
            injectedCss: "url(javascript:alert(1))",
          },
        },
      }),
    });

    render(
      <ConfigProbe
        token="alerts-token"
        onConfig={(config) => { latestConfig = config; }}
      />,
    );
    expect(await screen.findByText("ready:alert-channel")).toBeTruthy();

    const loaded = requireLoadedConfig(latestConfig);
    expect(loaded.alerts.eventVisuals).toMatchObject({
      follow: "frog-hype",
      raid: "shuffle",
      reward: "classic",
      sub: "classic",
    });
    expect(Object.keys(loaded.alerts.eventVisuals)).toHaveLength(11);
    expect(loaded.alerts.eventVisuals).not.toHaveProperty("notAnEvent");
    expect(loaded.alerts).toMatchObject({
      motion: "maximum",
      durationSec: 15,
      showHistory: false,
    });
    expect(loaded.alerts).not.toHaveProperty("injectedCss");
    expect(loaded.platforms).not.toHaveProperty("alerts");
  });

  it("keeps config unverified after failure and unlocks on a successful retry", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { twitch: { enabled: true, channel: "retry-channel" } },
        }),
      });

    render(<ConfigProbe token="retry-token" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("config-state").textContent).toBe("unverified");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("config-state").textContent).toBe(
      "ready:retry-channel",
    );
  });

  it("masks the previous config immediately when the overlay token changes", async () => {
    let latestConfig: LoadedConfig | null = null;
    let resolveNew: ((value: unknown) => void) | null = null;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("old-token")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            config: {
              twitch: { enabled: true, channel: "old-channel" },
              alerts: { eventVisuals: { follow: "frog-party" } },
            },
          }),
        });
      }
      return new Promise((resolve) => {
        resolveNew = resolve;
      });
    });

    const observeConfig = (config: LoadedConfig) => { latestConfig = config; };
    const view = render(
      <ConfigProbe token="old-token" onConfig={observeConfig} />,
    );
    expect(await screen.findByText("ready:old-channel")).toBeTruthy();
    expect(requireLoadedConfig(latestConfig).alerts.eventVisuals.follow)
      .toBe("frog-party");

    view.rerender(
      <ConfigProbe token="new-token" onConfig={observeConfig} />,
    );
    expect(screen.getByTestId("config-state").textContent).toBe("unverified");
    expect(requireLoadedConfig(latestConfig).platforms).toBeNull();
    expect(requireLoadedConfig(latestConfig).alerts).toEqual(
      DEFAULT_ALERTS,
    );

    await act(async () => {
      resolveNew?.({
        ok: true,
        json: async () => ({
          config: {
            twitch: { enabled: true, channel: "new-channel" },
            alerts: { eventVisuals: { follow: "cash-pop" } },
          },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("config-state").textContent).toBe(
      "ready:new-channel",
    );
    expect(requireLoadedConfig(latestConfig).alerts.eventVisuals.follow)
      .toBe("cash-pop");
  });

  it("keeps platform config identity stable across alerts-only refreshes", async () => {
    vi.useFakeTimers();
    let latestConfig: LoadedConfig | null = null;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            twitch: { enabled: true, channel: "stable-channel" },
            alerts: { eventVisuals: { follow: "classic" } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            twitch: { enabled: true, channel: "stable-channel" },
            alerts: {
              eventVisuals: { follow: "laughing-man" },
              motion: "maximum",
            },
          },
        }),
      });

    render(
      <ConfigProbe
        token="stable-token"
        onConfig={(config) => { latestConfig = config; }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const initial = requireLoadedConfig(latestConfig);
    expect(initial.loaded).toBe(true);
    expect(initial.alerts.eventVisuals.follow).toBe("classic");
    const initialPlatforms = initial.platforms;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const refreshed = requireLoadedConfig(latestConfig);
    expect(refreshed.alerts.eventVisuals.follow).toBe("laughing-man");
    expect(refreshed.alerts.motion).toBe("maximum");
    expect(refreshed.platforms).toBe(initialPlatforms);
    expect(refreshed.platforms).not.toHaveProperty("alerts");
  });

  it("renders a silent audio=0 copy without enabling TTS or dings", async () => {
    window.history.replaceState({}, "", "/overlay/tok/widget/multichat?audio=0");
    mockConfig.config = {
      twitch: { enabled: true, channel: "me" },
      tts: { enabled: true },
      sound: { enabled: true },
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      events: [],
      messages: [{
        platform: "twitch",
        id: "silent-copy",
        user: "StillVisible",
        text: "the follower still renders",
        badges: [],
        atMs: Date.now(),
      }],
    };

    await renderWidget();

    expect(await screen.findByText("the follower still renders")).toBeTruthy();
    expect(hookSpies.tts.mock.calls.at(-1)?.[1]).toMatchObject({
      enabled: false,
    });
    expect(hookSpies.sound.mock.calls.at(-1)?.[1]).toMatchObject({
      enabled: false,
    });
  });

  it("shows the setup hint when no platform is configured", async () => {
    mockConfig.config = { twitch: { enabled: false } };
    await renderWidget();
    expect(
      await screen.findByText(/No chat platforms configured yet/),
    ).toBeTruthy();
  });

  it("renders merged messages with platform chips and colors", async () => {
    mockConfig.config = { twitch: { enabled: true, channel: "me" } };
    const now = Date.now();
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      events: [],
      messages: [
        {
          platform: "twitch",
          id: "1",
          user: "PurpleViewer",
          text: "gg wp",
          color: "#FF69B4",
          badges: ["moderator"],
          atMs: now,
        },
        {
          platform: "tiktok",
          id: "2",
          user: "tikfan",
          text: "hello from tiktok",
          badges: [],
          atMs: now,
        },
      ],
    };
    await renderWidget();
    expect(await screen.findByText("PurpleViewer")).toBeTruthy();
    expect(screen.getByText("gg wp")).toBeTruthy();
    expect(screen.getByText("hello from tiktok")).toBeTruthy();
    expect(screen.getByTitle("Twitch")).toBeTruthy();
    expect(screen.getByTitle("TikTok")).toBeTruthy();
    expect(screen.getByTitle("Moderator")).toBeTruthy();
  });

  it("shows normalized events without sending them through message effects", async () => {
    mockConfig.config = { twitch: { enabled: true, channel: "me" } };
    const now = Date.now();
    const message = {
      platform: "twitch" as const,
      id: "chat-1",
      user: "Viewer",
      text: "hello chat",
      badges: [],
      atMs: now,
    };
    const event = {
      platform: "twitch" as const,
      id: "raid-1",
      kind: "raid" as const,
      user: "RaidLeader",
      detail: "raided the channel",
      amount: "42 viewers",
      atMs: now + 1,
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [message],
      events: [event],
    };

    await renderWidget();

    const eventRow = await screen.findByTestId("mc-event-row");
    expect(eventRow.textContent).toContain("RaidLeader raided the channel");
    expect(eventRow.textContent).toContain("42 viewers");
    expect(screen.getByLabelText("Twitch event")).toBeTruthy();
    expect(hookSpies.engagement).toHaveBeenLastCalledWith(
      "tok_test",
      [message],
      [event],
    );
    for (const effect of [
      hookSpies.sound,
      hookSpies.tts,
      hookSpies.commands,
      hookSpies.translation,
    ]) {
      expect(effect.mock.calls.at(-1)?.[0]).toEqual([message]);
    }
  });

  it("filters Settings and Stream Dock blocked users from cards and engagement", async () => {
    mockConfig.config = {
      twitch: { enabled: true, channel: "me" },
      appearance: {
        ...DEFAULT_APPEARANCE,
        blockedUsers: "  @SettingsBlocked  ",
      },
    };
    mockStudioBlockedUsers = [" @DockBlocked "];
    const allowedMessage = {
      platform: "twitch" as const,
      id: "allowed-message",
      user: "FriendlyViewer",
      text: "hello",
      badges: [],
      atMs: Date.now(),
    };
    const allowedEvent = {
      platform: "twitch" as const,
      id: "allowed-event",
      kind: "follow" as const,
      user: "FriendlyFollower",
      detail: "followed",
      atMs: Date.now() + 1,
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [
        allowedMessage,
        {
          ...allowedMessage,
          id: "settings-message",
          user: "@SETTINGSBLOCKED",
          text: "must stay hidden",
        },
      ],
      events: [
        allowedEvent,
        {
          ...allowedEvent,
          id: "settings-event",
          user: "settingsblocked",
        },
        {
          ...allowedEvent,
          id: "dock-event",
          user: "DOCKBLOCKED",
        },
      ],
    };

    await renderWidget();

    expect(await screen.findByText("FriendlyFollower")).toBeTruthy();
    expect(screen.queryByText("must stay hidden")).toBeNull();
    expect(screen.queryByText("settingsblocked")).toBeNull();
    expect(screen.queryByText("DOCKBLOCKED")).toBeNull();
    expect(hookSpies.engagement).toHaveBeenLastCalledWith(
      "tok_test",
      [allowedMessage],
      [allowedEvent],
    );
  });

  it("fails closed until the Stream Dock blocklist snapshot is authoritative", async () => {
    mockConfig.config = { twitch: { enabled: true, channel: "me" } };
    mockStudioSnapshotReady = false;
    const message = {
      platform: "twitch" as const,
      id: "unverified-chat",
      user: "MaybeBlocked",
      text: "must wait for moderation",
      badges: [],
      atMs: Date.now(),
    };
    const event = {
      platform: "twitch" as const,
      id: "unverified-follow",
      kind: "follow" as const,
      user: "MaybeBlockedFollower",
      detail: "followed",
      atMs: Date.now() + 1,
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [message],
      events: [event],
    };

    const view = await renderWidget();

    expect(screen.queryByText(message.text)).toBeNull();
    expect(screen.queryByText(event.user)).toBeNull();
    expect(hookSpies.engagement).toHaveBeenLastCalledWith("tok_test", [], []);
    expect(hookSpies.sound.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(hookSpies.tts.mock.calls.at(-1)?.[0]).toEqual([]);

    mockStudioSnapshotReady = true;
    view.rerender(<MultiChatWidget token="tok_test" />);

    expect(await screen.findByText(message.text)).toBeTruthy();
    expect(screen.getByText(event.user)).toBeTruthy();
    expect(hookSpies.engagement).toHaveBeenLastCalledWith(
      "tok_test",
      [message],
      [event],
    );
  });

  it("uses the cheer event sound without stacking generic chat audio", async () => {
    mockConfig.config = {
      twitch: { enabled: true, channel: "me" },
      tts: { enabled: true },
      sound: {
        enabled: true,
        eventSoundsEnabled: true,
        eventVolume: 80,
        eventSounds: { cheer: "coin" },
      },
    };
    const now = Date.now();
    const cheerMessage = {
      platform: "twitch" as const,
      id: "cheer-chat",
      user: "CheerFan",
      text: "Cheer100 great game",
      badges: [],
      atMs: now,
      pairedEventKind: "cheer" as const,
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [cheerMessage],
      events: [{
        platform: "twitch",
        id: "cheer-chat:cheer",
        kind: "cheer",
        user: "CheerFan",
        detail: "cheered",
        amount: "100 bits",
        atMs: now,
      }],
    };

    await renderWidget();

    expect(await screen.findByText("Cheer100 great game")).toBeTruthy();
    expect(hookSpies.tts.mock.calls.at(-1)?.[0]).toEqual([
      { ...cheerMessage, suppressAudio: true },
    ]);
    expect(hookSpies.sound.mock.calls.at(-1)?.[0]).toEqual([
      { ...cheerMessage, suppressAudio: true },
    ]);
    // Non-audio behavior still receives the original chat line.
    expect(hookSpies.commands.mock.calls.at(-1)?.[0]).toEqual([cheerMessage]);
  });

  it("surfaces per-platform status while not fully connected", async () => {
    mockConfig.config = {
      twitch: { enabled: true, channel: "me" },
      tiktok: { enabled: true, username: "me" },
    };
    mockChat = {
      active: true,
      statuses: {
        twitch: { state: "connected" },
        tiktok: { state: "offline" },
      },
      messages: [],
      events: [],
    };
    await renderWidget();
    // TikTok offline → status row visible with the offline label; the
    // stream itself is unaffected.
    expect(await screen.findByText("offline")).toBeTruthy();
    expect(screen.getByText("Connected — waiting for chat…")).toBeTruthy();
  });

  it("removes an idle chat line at its configured 30-second lifetime", async () => {
    const base = Date.parse("2026-08-08T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(base);

    try {
      mockConfig.config = {
        twitch: { enabled: true, channel: "me" },
        appearance: { ...DEFAULT_APPEARANCE, messageTtlSec: 30 },
      };
      mockChat = {
        active: true,
        statuses: { twitch: { state: "connected" } },
        events: [
          {
            platform: "twitch",
            id: "ttl-event",
            kind: "follow",
            user: "FreshFollower",
            detail: "followed the channel",
            atMs: base,
          },
        ],
        messages: [
          {
            platform: "twitch",
            id: "ttl",
            user: "Viewer",
            text: "expires on time",
            badges: [],
            atMs: base,
          },
        ],
      };

      render(<MultiChatWidget token="tok_test" />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText("expires on time")).toBeTruthy();
      expect(screen.getByText("FreshFollower")).toBeTruthy();
      act(() => vi.advanceTimersByTime(29_999));
      expect(screen.getByText("expires on time")).toBeTruthy();
      expect(screen.getByText("FreshFollower")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText("expires on time")).toBeNull();
      expect(screen.queryByText("FreshFollower")).toBeNull();
    } finally {
      cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
