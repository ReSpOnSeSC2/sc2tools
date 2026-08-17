import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DockClient } from "../DockClient";
import type { MultichatConfig } from "@/lib/multichat/types";
import type { MultiChatState } from "@/lib/multichat/useMultiChat";

let mockChat: MultiChatState = {
  messages: [],
  events: [],
  statuses: {},
  active: false,
};
const engagementSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: () => mockChat,
}));

vi.mock("@/lib/multichat/useEngagementReporter", () => ({
  useEngagementReporter: (...args: unknown[]) => engagementSpy(...args),
}));

const CONFIG: MultichatConfig = { twitch: { enabled: true, channel: "me" } };
let configState: MultichatConfig = CONFIG;

const EMPTY_STUDIO = {
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
};

// Route the dock's three fetch surfaces: token config GET, studio GET,
// studio POST (which echoes a sanitized full state).
const fetchMock = vi.fn();
let studioState: Record<string, unknown> = { ...EMPTY_STUDIO };

beforeEach(() => {
  engagementSpy.mockClear();
  configState = CONFIG;
  studioState = { ...EMPTY_STUDIO };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/config")) {
      return { ok: true, json: async () => ({ config: configState }) };
    }
    if (String(url).includes("/studio")) {
      if (init?.method === "POST") {
        const patch = JSON.parse(String(init.body));
        studioState = { ...studioState, ...patch };
        return { ok: true, json: async () => studioState };
      }
      return { ok: true, json: async () => studioState };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  mockChat = { messages: [], events: [], statuses: {}, active: false };
});

afterEach(async () => {
  // Drain the dock's startup fetch continuations (config GET, studio
  // GET) before tearing down — a test that never awaits fetch-driven
  // DOM can otherwise leak resolved-promise callbacks into the next
  // test's act() window, where they break React's synchronous update
  // flush (observed as the next test's first click getting "lost").
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function studioPosts(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).includes("/studio") &&
        (init as RequestInit | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("DockClient", () => {
  it("does not render a standalone build-vote section", async () => {
    render(<DockClient token="tok_test" />);
    await screen.findByText("Live chat");
    expect(screen.queryByText("Chat picks the build")).toBeNull();
    expect(screen.queryByRole("button", { name: "Build vote" })).toBeNull();
  });

  it("renders the merged chat feed with platform status", async () => {
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      events: [],
      messages: [
        {
          platform: "twitch",
          id: "1",
          user: "Viewer",
          text: "gg wp",
          badges: [],
          atMs: 1,
        },
      ],
    };
    render(<DockClient token="tok_test" />);
    expect(await screen.findByText("gg wp")).toBeTruthy();
    expect(screen.getByText("Viewer")).toBeTruthy();
    expect(await screen.findByText("Twitch")).toBeTruthy();
  });

  it("keeps config-side moderation closed until a successful retry", async () => {
    vi.useFakeTimers();
    let configGets = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/config")) {
        configGets += 1;
        if (configGets === 1) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ config: configState }) };
      }
      if (String(url).includes("/studio")) {
        return { ok: true, json: async () => studioState };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const message = {
      platform: "twitch" as const,
      id: "config-wait-message",
      user: "ConfigWaiter",
      text: "wait for authoritative config",
      badges: [],
      atMs: Date.now(),
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [message],
      events: [],
    };

    render(<DockClient token="tok_test" />);
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(configGets).toBe(1);
    expect(screen.queryByText(message.text)).toBeNull();
    expect(engagementSpy).toHaveBeenLastCalledWith("tok_test", [], []);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(configGets).toBe(2);
    expect(screen.getByText(message.text)).toBeTruthy();
    expect(engagementSpy).toHaveBeenLastCalledWith(
      "tok_test",
      [message],
      [],
    );
  });

  it("masks the previous token's config and studio state immediately", async () => {
    let holdNewConfig = false;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes("/config")) {
        if (holdNewConfig && target.includes("new-token")) {
          return new Promise(() => undefined);
        }
        return { ok: true, json: async () => ({ config: configState }) };
      }
      if (target.includes("/studio")) {
        return { ok: true, json: async () => studioState };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const message = {
      platform: "twitch" as const,
      id: "token-change-message",
      user: "OldTokenViewer",
      text: "old token activity",
      badges: [],
      atMs: Date.now(),
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [message],
      events: [],
    };

    const view = render(<DockClient token="old-token" />);
    expect(await screen.findByText(message.text)).toBeTruthy();

    holdNewConfig = true;
    view.rerender(<DockClient token="new-token" />);

    expect(screen.queryByText(message.text)).toBeNull();
    expect(engagementSpy).toHaveBeenLastCalledWith("new-token", [], []);
  });

  it("fails closed after a studio fetch error and unlocks on retry", async () => {
    vi.useFakeTimers();
    let studioGets = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/config")) {
        return { ok: true, json: async () => ({ config: configState }) };
      }
      if (String(url).includes("/studio") && !init?.method) {
        studioGets += 1;
        if (studioGets === 1) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return { ok: true, json: async () => studioState };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const message = {
      platform: "twitch" as const,
      id: "moderation-wait-message",
      user: "PossiblyBlocked",
      text: "wait for the blocklist",
      badges: [],
      atMs: Date.now(),
    };
    const event = {
      platform: "twitch" as const,
      id: "moderation-wait-event",
      kind: "follow" as const,
      user: "PossiblyBlockedFollower",
      detail: "followed",
      atMs: Date.now() + 1,
    };
    mockChat = {
      active: true,
      statuses: { twitch: { state: "connected" } },
      messages: [message],
      events: [event],
    };

    render(<DockClient token="tok_test" />);
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(studioGets).toBe(1);
    expect(screen.queryByText(message.text)).toBeNull();
    expect(screen.queryByText(event.user)).toBeNull();
    expect(engagementSpy).toHaveBeenLastCalledWith("tok_test", [], []);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(studioGets).toBe(2);
    expect(screen.getByText(message.text)).toBeTruthy();
    expect(screen.getByText(event.user)).toBeTruthy();
    expect(engagementSpy).toHaveBeenLastCalledWith(
      "tok_test",
      [message],
      [event],
    );
  });

  it("excludes Dock-blocked messages and events from engagement", async () => {
    studioState = { ...EMPTY_STUDIO, blockedUsers: [" @BlockedUser "] };
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
      atMs: Date.now(),
    };
    mockChat = {
      active: true,
      statuses: {},
      messages: [
        allowedMessage,
        { ...allowedMessage, id: "blocked-message", user: "BLOCKEDUSER" },
      ],
      events: [
        allowedEvent,
        { ...allowedEvent, id: "blocked-event", user: "@blockeduser" },
      ],
    };

    render(<DockClient token="tok_test" />);

    await waitFor(() => {
      expect(engagementSpy).toHaveBeenLastCalledWith(
        "tok_test",
        [allowedMessage],
        [allowedEvent],
      );
    });
    expect(screen.queryByText("BLOCKEDUSER")).toBeNull();
    expect(screen.queryByText("@blockeduser")).toBeNull();
    expect(screen.getByText("FriendlyFollower")).toBeTruthy();
  });

  it("excludes Settings-blocked activity from the Dock and engagement", async () => {
    configState = {
      ...CONFIG,
      appearance: { blockedUsers: " @SettingsBlocked ", hideBots: false },
    };
    const allowedMessage = {
      platform: "twitch" as const,
      id: "settings-allowed-message",
      user: "FriendlyViewer",
      text: "hello",
      badges: [],
      atMs: Date.now(),
    };
    const allowedEvent = {
      platform: "twitch" as const,
      id: "settings-allowed-event",
      kind: "follow" as const,
      user: "FriendlyFollower",
      detail: "followed",
      atMs: Date.now(),
    };
    mockChat = {
      active: true,
      statuses: {},
      messages: [
        allowedMessage,
        {
          ...allowedMessage,
          id: "settings-blocked-message",
          user: "SETTINGSBLOCKED",
          text: "should stay out of engagement",
        },
      ],
      events: [
        allowedEvent,
        {
          ...allowedEvent,
          id: "settings-blocked-event",
          user: "@settingsblocked",
        },
      ],
    };

    render(<DockClient token="tok_test" />);

    await waitFor(() => {
      expect(engagementSpy).toHaveBeenLastCalledWith(
        "tok_test",
        [allowedMessage],
        [allowedEvent],
      );
    });
    expect(screen.queryByText("should stay out of engagement")).toBeNull();
    expect(screen.queryByText("@settingsblocked")).toBeNull();
    expect(screen.getByText("FriendlyFollower")).toBeTruthy();
  });

  it("Highlight POSTs the message to the studio endpoint", async () => {
    mockChat = {
      active: true,
      statuses: {},
      events: [],
      messages: [
        {
          platform: "kick",
          id: "k1",
          user: "Fan",
          text: "great game!",
          badges: [],
          atMs: 2,
        },
      ],
    };
    render(<DockClient token="tok_test" />);
    await screen.findByText("great game!");
    // Scoped to the feed — the narrow-mode jump tabs also say "Highlight".
    const list = within(screen.getByTestId("dock-chat-list"));
    fireEvent.click(list.getByRole("button", { name: "Highlight" }));
    await waitFor(() => {
      expect(studioPosts()).toEqual([
        {
          highlight: { platform: "kick", user: "Fan", text: "great game!" },
        },
      ]);
    });
    // The POST response becomes the rendered state — the pin shows up.
    expect(await screen.findByText("kick · Fan")).toBeTruthy();
  });

  it("blocking a user takes two taps and POSTs the blocklist", async () => {
    mockChat = {
      active: true,
      statuses: {},
      events: [],
      messages: [
        {
          platform: "twitch",
          id: "t1",
          user: "Spammer",
          text: "buy followers",
          badges: [],
          atMs: 3,
        },
      ],
    };
    render(<DockClient token="tok_test" />);
    await screen.findByText("buy followers");
    const block = screen.getByRole("button", { name: "Block" });
    fireEvent.click(block); // arms
    expect(studioPosts()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm?" }));
    await waitFor(() => {
      expect(studioPosts()).toEqual([{ blockedUsers: ["Spammer"] }]);
    });
  });

  it("starting a poll POSTs question + options with status open", async () => {
    render(<DockClient token="tok_test" />);
    fireEvent.change(await screen.findByPlaceholderText("Poll question"), {
      target: { value: "Next matchup?" },
    });
    fireEvent.change(screen.getByPlaceholderText("Option 1"), {
      target: { value: "PvT" },
    });
    fireEvent.change(screen.getByPlaceholderText("Option 2"), {
      target: { value: "PvZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start poll" }));
    await waitFor(() => {
      expect(studioPosts()).toEqual([
        { poll: { question: "Next matchup?", options: ["PvT", "PvZ"], status: "open" } },
      ]);
    });
  });

  it("removing a saved goal POSTs the reduced list immediately (no Save tap)", async () => {
    // Regression: ✕ used to edit only the local draft — the row
    // vanished from the dock while the stream kept showing the goal
    // until "Save goals" was ALSO pressed.
    studioState = {
      ...EMPTY_STUDIO,
      goals: [
        { label: "Followers", current: 5, target: 10 },
        { label: "Subs", current: 1, target: 5 },
      ],
    };
    render(<DockClient token="tok_test" />);
    expect(await screen.findByDisplayValue("Subs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove goal 2" }));
    await waitFor(() => {
      expect(studioPosts()).toEqual([
        { goals: [{ label: "Followers", current: 5, target: 10 }] },
      ]);
    });
    // The POST response re-hydrates the draft — the row is really gone.
    await waitFor(() => {
      expect(screen.queryByDisplayValue("Subs")).toBeNull();
    });
    expect(screen.getByDisplayValue("Followers")).toBeTruthy();
  });

  it("removing a blank in-progress row never POSTs", async () => {
    render(<DockClient token="tok_test" />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove goal 1" }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Goal label")).toBeNull();
    });
    expect(studioPosts()).toEqual([]);
  });

  it("Scenes: Starting soon POSTs the scene with a countdown", async () => {
    render(<DockClient token="tok_test" />);
    fireEvent.change(
      await screen.findByPlaceholderText(/Optional message/),
      { target: { value: "grabbing water" } },
    );
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "▶ Starting soon" }));
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(1);
    });
    const scene = (studioPosts()[0] as { scene: Record<string, unknown> })
      .scene;
    expect(scene.mode).toBe("starting");
    expect(scene.message).toBe("grabbing water");
    // Default 5-minute countdown lands in a sane window around now+5m.
    const ends = Number(scene.countdownEndsAt);
    expect(ends).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
    expect(ends).toBeLessThan(before + 5 * 60_000 + 10_000);
    // The POST response becomes state — the status row + Go live show.
    expect(await screen.findByText("Starting Soon on stream")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go live" }));
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(2);
    });
    // Going live off Starting Soon also auto-marks the stream start
    // for the clip log's VOD offsets.
    expect(studioPosts()[1].scene).toBeNull();
    expect(Number(studioPosts()[1].streamStartMs)).toBeGreaterThan(0);
  });

  it("Timer: Start posts endsAt; Clear posts null", async () => {
    render(<DockClient token="tok_test" />);
    fireEvent.change(await screen.findByPlaceholderText(/Optional label/), {
      target: { value: "Next game in" },
    });
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "⏱ Start timer" }));
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(1);
    });
    const t = (studioPosts()[0] as { timer: Record<string, unknown> }).timer;
    expect(t.label).toBe("Next game in");
    expect(Number(t.endsAt)).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
    expect(await screen.findByText(/Next game in on stream/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(2);
    });
    expect(studioPosts()[1]).toEqual({ timer: null });
  });

  it("Mark stream start POSTs the go-live epoch; Clear posts null", async () => {
    render(<DockClient token="tok_test" />);
    const before = Date.now();
    fireEvent.click(
      await screen.findByRole("button", { name: "⏺ Mark stream start" }),
    );
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(1);
    });
    const mark = Number(studioPosts()[0].streamStartMs);
    expect(mark).toBeGreaterThanOrEqual(before);
    expect(mark).toBeLessThan(before + 10_000);
    // POST response hydrates — the mark row with Clear appears.
    fireEvent.click(await screen.findByRole("button", { name: "Clear mark" }));
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(2);
    });
    expect(studioPosts()[1]).toEqual({ streamStartMs: null });
  });

  it("Go live off Starting Soon auto-marks the stream start", async () => {
    studioState = {
      ...EMPTY_STUDIO,
      scene: {
        mode: "starting",
        message: "",
        countdownEndsAt: null,
        setAtMs: Date.now(),
      },
    };
    render(<DockClient token="tok_test" />);
    const before = Date.now();
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
    await waitFor(() => {
      expect(studioPosts()).toHaveLength(1);
    });
    const patch = studioPosts()[0];
    expect(patch.scene).toBeNull();
    expect(Number(patch.streamStartMs)).toBeGreaterThanOrEqual(before);
  });

  it("saving a VOD URL POSTs it", async () => {
    render(<DockClient token="tok_test" />);
    fireEvent.change(
      await screen.findByPlaceholderText(/Paste VOD URL/),
      { target: { value: "https://www.twitch.tv/videos/42" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(studioPosts()).toEqual([
        { vodUrl: "https://www.twitch.tv/videos/42" },
      ]);
    });
  });

  it("renders the goals editor", async () => {
    render(<DockClient token="tok_test" />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add goal" }));
    expect(screen.getByPlaceholderText("Goal label")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Increment/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Decrement/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Current value" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Target value" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save goals" })).toBeTruthy();
  });
});
