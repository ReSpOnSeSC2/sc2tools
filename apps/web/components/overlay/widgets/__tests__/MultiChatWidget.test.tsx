import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MultiChatWidget } from "../MultiChatWidget";
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

vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: () => mockChat,
}));

// The config loader hits the token-authed relay; stub fetch with the
// wire shape the API serves.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ config: mockConfig.config ?? {} }),
  });
  mockConfig = { config: null, loaded: false };
  mockChat = { messages: [], events: [], statuses: {}, active: false };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderWidget() {
  const view = render(<MultiChatWidget token="tok_test" />);
  // Let the config fetch promise chain settle.
  await screen.findByText(/./, undefined, { timeout: 2000 }).catch(() => null);
  return view;
}

describe("MultiChatWidget", () => {
  it("shows the setup hint when no platform is configured", async () => {
    mockConfig.config = { twitch: { enabled: false } };
    await renderWidget();
    expect(
      await screen.findByText(/No chat platforms configured yet/),
    ).toBeTruthy();
  });

  it("renders merged messages with platform chips and colors", async () => {
    mockConfig.config = { twitch: { enabled: true, channel: "me" } };
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
          atMs: 1,
        },
        {
          platform: "tiktok",
          id: "2",
          user: "tikfan",
          text: "hello from tiktok",
          badges: [],
          atMs: 2,
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
});
