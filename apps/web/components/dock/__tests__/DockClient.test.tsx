import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

afterEach(() => {
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
