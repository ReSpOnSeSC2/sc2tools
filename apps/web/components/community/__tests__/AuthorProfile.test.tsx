import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AuthorProfile } from "../AuthorProfile";
import type { CommunityAuthorProfile } from "../types";
vi.mock("../CommunityBuildOwnerControls", () => ({ CommunityBuildOwnerControls: () => null }));
vi.mock("../CommunityOwnerReplayCount", () => ({ CommunityOwnerReplayCount: () => null }));

/**
 * Community author pages share the public-profile opt-in (a published
 * build under a public author name), so each one links to the author's
 * /p/ player profile — previously nothing linked there.
 */

const profile: CommunityAuthorProfile = {
  userId: "user 42",
  displayName: "ReSpOnSe",
  joinedAt: null,
  builds: [],
  totalBuilds: 0,
  totalVotes: 0,
  primaryRace: null,
  topMatchup: null,
  topBuild: null,
  recent: [],
};

describe("AuthorProfile", () => {
  afterEach(cleanup);

  test("links to the author's public player profile", () => {
    render(<AuthorProfile profile={profile} />);
    const link = screen.getByRole("link", { name: /player profile/i });
    expect(link.getAttribute("href")).toBe("/p/user%2042");
  });

  test("escapes hostile author names inside JSON-LD without changing their data", () => {
    const displayName = '</script><script>alert(1)</script>';
    const { container } = render(<AuthorProfile profile={{ ...profile, displayName }} />);
    const body = container.querySelector('script[type="application/ld+json"]')!.textContent!;
    expect(body).not.toContain("</script");
    expect(body).not.toContain("<");
    expect(JSON.parse(body).name).toBe(displayName);
  });

  test("shows accurate publishing dates, matchup count, average and one shared top score", () => {
    const builds = Array.from({ length: 6 }, (_, i) => ({ slug: `build-${i}`, title: `Build ${i}`, description: i === 2 ? "A timing with scouts" : "Macro opening", matchup: i < 4 ? "PvZ" : "PvT", votes: i === 4 ? 12 : 0, publishedAt: `2026-0${8 - i}-01T00:00:00Z`, authorName: "ReSpOnSe", ownerUserId: profile.userId }));
    render(<AuthorProfile profile={{ ...profile, builds, totalBuilds: 6, totalVotes: 12, joinedAt: "2025-01-01T00:00:00Z", topBuild: builds[4] }} />);
    expect(screen.getByText("Publishing since").parentElement?.textContent).toContain("Mar 2026");
    expect(screen.getByText("Across 2 matchups")).toBeTruthy();
    expect(screen.getByText("Avg. score per build").parentElement?.textContent).toContain("2.0");
    expect(screen.queryByText(/Member/)).toBeNull();
    expect(screen.getByText("Publishing since").parentElement?.parentElement?.className).toContain("lg:grid-cols-5");
    const list = screen.getByRole("list", { name: "Published builds" });
    const titles = () => within(list).getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    expect(titles()[0]).toBe("Build 0");
    fireEvent.click(screen.getByRole("radio", { name: "Top" })); expect(titles()[0]).toBe("Build 4"); expect(titles()[1]).toBe("Build 0");
    fireEvent.click(screen.getByRole("radio", { name: "New" })); expect(titles()[0]).toBe("Build 0");
    expect(screen.getByRole("button", { name: "PvZ · 4" })).toBeTruthy(); expect(screen.queryByRole("button", { name: /ZvZ/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "PvT · 2" })); expect(titles()).toEqual(["Build 4", "Build 5"]);
    expect(within(list).queryByRole("link", { name: "ReSpOnSe" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search author's builds" }), { target: { value: "scouts" } });
    expect(screen.getByText("No builds match “scouts”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search author's builds" }), { target: { value: "scouts" } });
    expect(within(screen.getByRole("list", { name: "Published builds" })).getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["Build 2"]);
  });

  test("uses joinedAt only as a fallback and has no average with zero builds", () => {
    render(<AuthorProfile profile={{ ...profile, joinedAt: "2026-03-01T00:00:00Z" }} />);
    expect(screen.getByText("Publishing since").parentElement?.textContent).toContain("Mar 2026");
    expect(screen.getByText("Avg. score per build").parentElement?.textContent).toContain("—");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});
