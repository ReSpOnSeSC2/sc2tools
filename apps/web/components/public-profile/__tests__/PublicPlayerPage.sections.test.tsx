import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicPlayerPage } from "../PublicPlayerPage";
import { PUBLIC_PLAYER } from "../__fixtures__/publicPlayer";
vi.mock("next/image", () => ({ default: ({ alt = "", src }: { alt?: string; src: string }) => <span data-image={src}>{alt}</span> }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("hides all optional sections and crosslinks until separately enabled", () => {
  const { container } = render(<PublicPlayerPage profile={{ ...PUBLIC_PLAYER, recentForm: [{ result: "W", matchup: "PvT", date: "2026-10-20" }], currentStreak: { kind: "W", count: 4 }, lastPlayedAt: "2026-10-20", mmrHistory: [{ date: "2026-10-20", mmr: 9999, games: 10 }], channels: [{ platform: "twitch", url: "https://twitch.tv/synthetic" }], maps: [{ name: "Hidden map", games: 20, wins: 12, losses: 8 }], replayArchive: { handle: PUBLIC_PLAYER.handle, total: 20 } }} />);
  expect(screen.getByRole("navigation", { name: "Player sections" }).textContent).toBe("overview");
  expect(screen.queryByText("Recent form")).toBeNull(); expect(container.textContent).not.toMatch(/Hidden map|9999|Last played|4-win|Browse 20 replays/);
  expect(screen.queryByRole("link", { name: "twitch" })).toBeNull();
});
it("shows recent pips oldest first with race/date labels and an honest sample summary", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  render(<PublicPlayerPage profile={{ ...PUBLIC_PLAYER, sections: { ...PUBLIC_PLAYER.sections!, showRecentForm: true },
    recentForm: [{ result: "W", matchup: "PvT", date: "2026-10-23T12:00:00Z" }, { result: "W", matchup: "PvZ", date: "2026-10-22T12:00:00Z" }, { result: "L", matchup: "PvP", date: "2026-10-21T12:00:00Z" }], currentStreak: { kind: "W", count: 2 }, lastPlayedAt: "2026-10-23T12:00:00Z" }} />);
  const list = screen.getByRole("list", { name: "Last 3: 2 wins, 1 loss" });
  expect(list.querySelector("li")?.getAttribute("aria-label")).toMatch(/^Loss, PvP,/);
  expect(screen.getByText("2-win streak")).toBeTruthy(); expect(screen.getByText("Last played 2 days ago")).toBeTruthy();
});
it("hides the entire recent card below three games and does not show a one-result streak", () => {
  render(<PublicPlayerPage profile={{ ...PUBLIC_PLAYER, sections: { ...PUBLIC_PLAYER.sections!, showRecentForm: true }, recentForm: [{ result: "W", matchup: "PvT", date: "2026-10-23" }], currentStreak: { kind: "W", count: 1 }, lastPlayedAt: "2026-10-23" }} />);
  expect(screen.queryByText("Recent form")).toBeNull(); expect(screen.queryByText(/Last played|1-win/)).toBeNull();
});
it("gives enabled tabs a page-current navigation and keeps missing sections out", () => {
  render(<PublicPlayerPage requestedTab="builds" profile={{ ...PUBLIC_PLAYER, publishedBuilds: [{ slug: "shared", title: "Public build", matchup: "PvT", votes: 1 }] }} />);
  expect(screen.getByRole("link", { name: "builds" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("link", { name: "replays" })).toBeNull(); expect(screen.queryByRole("link", { name: "reviews" })).toBeNull();
  expect(screen.getByRole("link", { name: "Public build" }).getAttribute("href")).toBe("/community/builds/shared");
});
