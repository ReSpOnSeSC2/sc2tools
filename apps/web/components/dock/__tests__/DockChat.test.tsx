import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DockChat } from "../DockChat";
import type { ChatEvent } from "@/lib/multichat/events";
import type { ChatMessage, MultichatConfig } from "@/lib/multichat/types";

const PLATFORMS: MultichatConfig = {
  twitch: { enabled: true, channel: "streamer" },
  kick: { enabled: true, channel: "streamer", chatroomId: 42 },
  youtube: { enabled: true, channel: "streamer" },
  tiktok: { enabled: true, username: "streamer" },
};

const CASES = [
  { platform: "twitch", label: "Twitch", short: "TW", user: "twitch-user" },
  { platform: "kick", label: "Kick", short: "KK", user: "kick-user" },
  { platform: "youtube", label: "YouTube", short: "YT", user: "youtube-user" },
  { platform: "tiktok", label: "TikTok", short: "TT", user: "tiktok-user" },
] as const;

afterEach(cleanup);

describe("DockChat", () => {
  it("shows a visible, accessible platform indicator on every message", () => {
    const messages: ChatMessage[] = CASES.map(({ platform, user }) => ({
      platform,
      id: "shared-id",
      user,
      text: `hello from ${platform}`,
      badges: [],
      atMs: 1,
    }));

    render(
      <DockChat
        loaded
        platforms={PLATFORMS}
        messages={messages}
        statuses={{}}
        blockedUsers={[]}
        busy={false}
        onHighlight={vi.fn()}
        onBlock={vi.fn()}
      />,
    );

    const list = within(screen.getByTestId("dock-chat-list"));
    for (const { label, short, user } of CASES) {
      const message = list.getByText(`hello from ${label.toLowerCase()}`);
      const row = message.closest("button");
      expect(row).not.toBeNull();

      const indicator = within(row as HTMLButtonElement).getByLabelText(
        `${label} chat`,
      );
      expect(indicator.textContent).toBe(short);
      expect(indicator.getAttribute("title")).toBe(`${label} chat`);
      expect(row?.textContent).toContain(user);
    }
  });

  it("merges clearly styled events into the timeline without chat actions", () => {
    const messages: ChatMessage[] = [
      {
        platform: "twitch",
        id: "before",
        user: "EarlyViewer",
        text: "before event",
        badges: [],
        atMs: 10,
      },
      {
        platform: "kick",
        id: "after",
        user: "LaterViewer",
        text: "after event",
        badges: [],
        atMs: 30,
      },
    ];
    const events: ChatEvent[] = [
      {
        platform: "youtube",
        id: "member-1",
        kind: "member",
        user: "NewMember",
        detail: "joined the channel",
        amount: "3 months",
        atMs: 20,
      },
    ];

    render(
      <DockChat
        loaded
        platforms={PLATFORMS}
        messages={messages}
        events={events}
        statuses={{}}
        blockedUsers={[]}
        busy={false}
        onHighlight={vi.fn()}
        onBlock={vi.fn()}
      />,
    );

    const list = screen.getByTestId("dock-chat-list");
    expect(Array.from(list.children).map((row) => row.textContent)).toEqual([
      expect.stringContaining("before event"),
      expect.stringContaining("NewMember joined the channel"),
      expect.stringContaining("after event"),
    ]);
    const eventRow = screen.getByTestId("dock-event-row");
    expect(within(eventRow).getByText("Member")).toBeTruthy();
    expect(within(eventRow).getByText("3 months")).toBeTruthy();
    expect(within(eventRow).getByLabelText("YouTube event")).toBeTruthy();
    expect(within(eventRow).queryByRole("button")).toBeNull();
  });

  it("removes blocked-user events with normalized Dock identities", () => {
    const events: ChatEvent[] = [
      {
        platform: "twitch",
        id: "blocked-raid",
        kind: "raid",
        user: "@BLOCKEDRAIDER",
        detail: "raided the channel",
        atMs: 20,
      },
      {
        platform: "youtube",
        id: "allowed-member",
        kind: "member",
        user: "WelcomeMember",
        detail: "joined",
        atMs: 21,
      },
    ];

    render(
      <DockChat
        loaded
        platforms={PLATFORMS}
        messages={[]}
        events={events}
        statuses={{}}
        blockedUsers={["  blockedraider  "]}
        busy={false}
        onHighlight={vi.fn()}
        onBlock={vi.fn()}
      />,
    );

    expect(screen.queryByText("@BLOCKEDRAIDER")).toBeNull();
    expect(screen.getByText("WelcomeMember")).toBeTruthy();
    expect(screen.getAllByTestId("dock-event-row")).toHaveLength(1);
  });
});
