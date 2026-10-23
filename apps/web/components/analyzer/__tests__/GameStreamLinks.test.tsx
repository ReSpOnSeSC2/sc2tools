import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GameStreamLinks, type GameStreamLink } from "../GameStreamLinks";

afterEach(cleanup);
const twitch: GameStreamLink = { platform: "twitch", perspective: "opponent", playerName: "Foe", url: "https://www.twitch.tv/videos/99", offsetSec: 65 };
const youtube: GameStreamLink = { platform: "youtube", perspective: "me", url: "https://www.youtube.com/watch?v=abc", offsetSec: 120 };

it("keeps the default POV chips and only offers validated timestamped VODs", () => {
  render(<GameStreamLinks links={[twitch, { ...youtube, url: "javascript:alert(1)" }]} />);
  const link = screen.getByRole("link", { name: "Watch Opponent POV on Twitch at 1:05 - Foe" });
  expect(link.getAttribute("href")).toBe("https://www.twitch.tv/videos/99?t=0h1m5s");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.queryByRole("button")).toBeNull();
});

it("uses one link for one valid toolbar VOD", () => {
  render(<GameStreamLinks links={[twitch]} variant="toolbar" />);
  expect(screen.getByRole("link", { name: "Watch VOD" }).getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.queryByRole("button")).toBeNull();
});

it("opens a keyboard menu for multiple VODs and returns focus on Escape", () => {
  render(<GameStreamLinks links={[twitch, youtube]} variant="toolbar" />);
  const trigger = screen.getByRole("button", { name: "VODs" });
  trigger.focus(); fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const links = screen.getAllByRole("menuitem");
  expect(document.activeElement).toBe(links[0]);
  fireEvent.keyDown(links[0], { key: "ArrowDown" });
  expect(document.activeElement).toBe(links[1]);
  expect(links[1].getAttribute("href")).toBe("https://www.youtube.com/watch?v=abc&t=120s");
  fireEvent.keyDown(links[1], { key: "Home" }); expect(document.activeElement).toBe(links[0]);
  fireEvent.keyDown(links[0], { key: "End" }); expect(document.activeElement).toBe(links[1]);
  fireEvent.keyDown(links[1], { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
