import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DockChat } from "../DockChat";
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
});
