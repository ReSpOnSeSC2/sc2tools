import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityBuildCard } from "../CommunityBuildCard";
import { VoteScore } from "../VoteScore";
import type { CommunityBuildListItem } from "../types";

vi.mock("../CommunityBuildOwnerControls", () => ({ CommunityBuildOwnerControls: () => null }));
vi.mock("../CommunityOwnerReplayCount", () => ({ CommunityOwnerReplayCount: () => <span>41 classified replays</span> }));
afterEach(cleanup);
const build: CommunityBuildListItem = { slug: "pvt-three-gate", ownerUserId: "owner-1", authorProfileHandle: "author-0123456789", authorName: "A".repeat(80), title: "PvT 3 Gate", description: "Three gate pressure", matchup: "PvT", votes: 0, publishedAt: "2026-08-13T12:00:00Z", updatedAt: "2026-10-03T12:00:00Z", build: { race: "Protoss", skillLevel: "diamond" } };

describe("Community scores and cards", () => {
  it.each([[3, "+3", "text-success"], [-2, "−2", "text-danger"], [0, "0", "text-text-dim"]] as const)("uses one signed score for %s", (votes, text, tone) => {
    const { container } = render(<VoteScore votes={votes} />);
    const score = screen.getByLabelText(`Net score ${text}`);
    expect(score.textContent).toBe(text); expect(score.className).toContain(tone); expect(score.className).toContain("tabular-nums");
    expect(container.querySelector("svg")).toBeNull();
  });
  it("keeps long names in flow and gives the title an independent stretched link", () => {
    const { container } = render(<CommunityBuildCard build={build} />);
    const author = screen.getByRole("link", { name: build.authorName });
    expect(author.getAttribute("href")).toBe("/players/author-0123456789");
    expect(author.title).toBe(build.authorName); expect(author.querySelector("span")?.className).toContain("truncate");
    expect(author.parentElement?.className).toContain("max-w-[50%]");
    expect(screen.getByRole("link", { name: build.title }).className).toContain("after:inset-0");
    expect(screen.getByText("Diamond")).toBeTruthy(); expect(screen.getByLabelText("Net score 0")).toBeTruthy();
    expect(screen.getByText("41 classified replays")).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull(); expect(container.querySelector(".pr-24")).toBeNull();
    expect(author.closest("footer")?.className).toContain("relative");
  });
  it("hides redundant author chips on author pages", () => {
    render(<CommunityBuildCard build={build} hideAuthor />);
    expect(screen.queryByRole("link", { name: build.authorName })).toBeNull();
    expect(screen.getByRole("link", { name: build.title })).toBeTruthy();
  });
  it("previews the first five signature deadlines in chronological order", () => {
    render(<CommunityBuildCard build={{ ...build, build: { ...build.build, signature: [300, 60, 240, 120, 360, 180].map((beforeSec) => ({ unit: "Marine", count: 1, beforeSec })) } }} />);
    expect(within(screen.getByRole("list", { name: "Key build steps" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Marine before 1:00", "Marine before 2:00", "Marine before 3:00", "Marine before 4:00", "Marine before 5:00"]);
  });
  it("only previews positive v3 requirements, never absence or maximum constraints", () => {
    render(<CommunityBuildCard build={{ ...build, build: { rules: [
      { type: "count_max", name: "BuildRoboticsFacility", count: 0, time_lt: 30 },
      { type: "not_before", name: "BuildTwilightCouncil", time_lt: 60 },
      { type: "count_exact", name: "TrainMarine", count: 0, time_lt: 90 },
      { type: "count_max", name: "BuildGateway", count: 2, time_lt: 100 },
      { type: "before", name: "BuildStargate", time_lt: 240 },
      { type: "count_min", name: "TrainAdept", count: 2, time_lt: 180 },
    ] } }} />);
    const list = screen.getByRole("list", { name: "Key build steps" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Adept before 3:00", "Stargate before 4:00"]);
  });
  it("omits the step strip for builds without timing data", () => {
    render(<CommunityBuildCard build={build} />); expect(screen.queryByRole("list", { name: "Key build steps" })).toBeNull();
  });
});
