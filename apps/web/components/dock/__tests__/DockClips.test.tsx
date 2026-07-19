import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockClips, formatOffset, vodLinkAt } from "../DockClips";
import type { ClipMoment } from "@/lib/multichat/useEngagementState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const START = 1_700_000_000_000;
const MOMENTS: ClipMoment[] = [
  {
    atMs: START + (2 * 3600 + 12 * 60 + 10) * 1000, // 2:12:10 in
    kind: "game-event",
    reason: "Victory vs GeNieS — 3-game win streak",
    sampleLines: [],
  },
  {
    atMs: START + 125 * 1000, // 2:05 in
    kind: "chat-spike",
    reason: "Chat spiked — 14 messages in 10s (usual ~3)",
    sampleLines: ["fan: CLIP IT"],
  },
];

describe("formatOffset / vodLinkAt", () => {
  it("formats offsets under and over an hour", () => {
    expect(formatOffset(125_000)).toBe("2:05");
    expect(formatOffset((2 * 3600 + 12 * 60 + 10) * 1000)).toBe("2:12:10");
  });

  it("builds twitch h/m/s and youtube seconds deep links", () => {
    expect(
      vodLinkAt("https://www.twitch.tv/videos/42", (2 * 3600 + 12 * 60 + 10) * 1000),
    ).toBe("https://www.twitch.tv/videos/42?t=2h12m10s");
    expect(vodLinkAt("https://youtu.be/abc123", 7_930_000)).toBe(
      "https://youtu.be/abc123?t=7930s",
    );
    // Unknown hosts stay plain — clickable, no seek param.
    expect(vodLinkAt("https://example.com/vod", 60_000)).toBe(
      "https://example.com/vod",
    );
  });
});

describe("DockClips", () => {
  it("shows offsets and VOD deep links when start + URL are set", () => {
    render(
      <DockClips
        moments={MOMENTS}
        streamStartMs={START}
        vodUrl="https://www.twitch.tv/videos/42"
        busy={false}
        onPost={async () => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /2:12:10 in/ });
    expect(link.getAttribute("href")).toBe(
      "https://www.twitch.tv/videos/42?t=2h12m10s",
    );
    expect(screen.getByRole("link", { name: /2:05 in/ })).toBeTruthy();
  });

  it("shows plain offsets without a VOD URL and none without a mark", () => {
    const { rerender } = render(
      <DockClips
        moments={MOMENTS}
        streamStartMs={START}
        vodUrl={null}
        busy={false}
        onPost={async () => {}}
      />,
    );
    expect(screen.getByText("2:05 in")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    rerender(
      <DockClips
        moments={MOMENTS}
        streamStartMs={null}
        vodUrl={null}
        busy={false}
        onPost={async () => {}}
      />,
    );
    expect(screen.queryByText(/in$/)).toBeNull();
  });

  it("Copy timestamps writes chronological offset lines", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <DockClips
        moments={MOMENTS}
        streamStartMs={START}
        vodUrl={null}
        busy={false}
        onPost={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy timestamps" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const text = writeText.mock.calls[0][0];
    const lines = text.split("\n");
    // Chronological (oldest first), offset-stamped.
    expect(lines[0]).toBe("2:05 — Chat spiked — 14 messages in 10s (usual ~3)");
    expect(lines[1]).toBe("2:12:10 — Victory vs GeNieS — 3-game win streak");
  });
});
