import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlayerChannelLinks, safeChannelUrl } from "../PlayerChannelLinks";

afterEach(cleanup);

describe("player channel links", () => {
  it("shows channel links independently of replay recordings without opening the row", () => {
    const openRow = vi.fn();
    render(<div onClick={openRow}><PlayerChannelLinks playerName="Harstem" channels={{ youtube: "https://www.youtube.com/@Harstem?tracking=1", twitch: "https://www.twitch.tv/harstem" }} /></div>);
    const link = screen.getByRole("link", { name: "Visit Harstem's YouTube channel" });
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/@Harstem");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link);
    expect(openRow).not.toHaveBeenCalled();
    expect(screen.queryByText(/POV|recording/)).toBeNull();
  });
  it.each([
    ["https://youtube.com.evil.example/@player", "youtube"],
    ["https://www.youtube.com/watch?v=abcdefghijk", "youtube"],
    ["https://www.twitch.tv/videos/123", "twitch"],
    ["https://www.twitch.tv/directory", "twitch"],
    ["https://user:pass@www.twitch.tv/player", "twitch"],
    ["https://www.twitch.tv:123/player", "twitch"],
    ["javascript:alert(1)", "twitch"],
  ] as const)("rejects unsafe or non-channel URLs: %s", (url, platform) => {
    expect(safeChannelUrl(url, platform)).toBeNull();
  });
  it("renders nothing for an empty or malformed directory result", () => {
    const { container } = render(<PlayerChannelLinks playerName="Player" channels={{ youtube: "https://evil.example/" }} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("group")).toBeNull();
  });
});
