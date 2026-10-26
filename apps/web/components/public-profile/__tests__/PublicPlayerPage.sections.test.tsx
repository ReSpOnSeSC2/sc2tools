import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicPlayerPage } from "../PublicPlayerPage";
import { PUBLIC_PLAYER } from "../__fixtures__/publicPlayer";
vi.mock("next/image", () => ({ default: ({ alt = "", src }: { alt?: string; src: string }) => <span data-image={src}>{alt}</span> }));
vi.mock("@/components/community/CommunityBuildOwnerControls", () => ({ CommunityBuildOwnerControls: () => null }));
vi.mock("@/components/community/CommunityOwnerReplayCount", () => ({ CommunityOwnerReplayCount: () => null }));
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
  render(<PublicPlayerPage requestedTab="builds" profile={{ ...PUBLIC_PLAYER, publishedBuilds: [{ slug: "shared", title: "Public build", description: "A public opening", matchup: "PvT", votes: 1, publishedAt: "2026-10-01", updatedAt: null }] }} />);
  expect(screen.getByRole("link", { name: "builds" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("link", { name: "replays" })).toBeNull(); expect(screen.queryByRole("link", { name: "reviews" })).toBeNull();
  expect(screen.getByRole("link", { name: "Public build" }).getAttribute("href")).toBe("/community/builds/shared");
});

it("retains author sort, matchup filters, description search and publishing summary on the canonical Builds tab", () => {
  const builds = Array.from({ length: 6 }, (_, index) => ({ slug: `public-${index}`, title: `Published ${index}`,
    description: index === 2 ? "A scouting timing" : "Steady macro", matchup: index < 4 ? "PvZ" : "PvT",
    votes: index === 4 ? 12 : 0, publishedAt: `2026-0${8 - index}-01T00:00:00Z`, updatedAt: null }));
  render(<PublicPlayerPage requestedTab="builds" profile={{ ...PUBLIC_PLAYER, displayName: "Public Author", publishedBuildCount: 6,
    publishedBuilds: builds, joinedAt: "2025-01-01" }} />);
  const list = () => screen.getByRole("list", { name: "Published builds" });
  const titles = () => within(list()).getAllByRole("heading", { level: 3 }).map(node => node.textContent);
  expect(titles()[0]).toBe("Published 0");
  fireEvent.click(screen.getByRole("radio", { name: "Top" })); expect(titles()[0]).toBe("Published 4");
  fireEvent.click(screen.getByRole("radio", { name: "New" })); expect(titles()[0]).toBe("Published 0");
  fireEvent.click(screen.getByRole("button", { name: "PvZ · 4" })); expect(titles()).toHaveLength(4);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search author's builds" }), { target: { value: "scouting" } });
  expect(titles()).toEqual(["Published 2"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search author's builds" }), { target: { value: "missing" } });
  expect(screen.getByText("No builds match “missing”")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear" })); expect(titles()).toHaveLength(6);
  expect(within(list()).queryByRole("link", { name: "Public Author" })).toBeNull();
  expect(screen.getByText("Mar 2026")).toBeTruthy(); expect(screen.getByText("Across 2 matchups")).toBeTruthy();
});

it("describes the bounded browser cohort without claiming it includes every publication", () => {
  render(<PublicPlayerPage requestedTab="builds" profile={{ ...PUBLIC_PLAYER, publishedBuildCount: 100, joinedAt: "2025-01-01",
    publishedBuilds: [{ slug: "recent", title: "Recent published build", description: "Public", matchup: null, votes: 0, publishedAt: "2026-10-01", updatedAt: null }] }} />);
  expect(screen.getByText("Showing the latest 1 build in this recent publication sample.")).toBeTruthy();
  expect(screen.queryByText(/of 100|100 published builds/)).toBeNull();
  expect(screen.getByText("Jan 2025")).toBeTruthy();
});
