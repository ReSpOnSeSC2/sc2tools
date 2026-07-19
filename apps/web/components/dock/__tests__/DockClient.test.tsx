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

vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: () => mockChat,
}));

const CONFIG: MultichatConfig = { twitch: { enabled: true, channel: "me" } };

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
  studioState = { ...EMPTY_STUDIO };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/config")) {
      return { ok: true, json: async () => ({ config: CONFIG }) };
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
    expect(screen.getByText("Twitch")).toBeTruthy();
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
