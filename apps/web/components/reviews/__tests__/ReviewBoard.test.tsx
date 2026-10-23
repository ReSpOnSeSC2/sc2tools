import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock("../ReviewReplayDownload", () => ({ ReviewReplayDownload: () => <button>Download replay</button> }));

import { ReviewBoardFilters } from "../ReviewBoardFilters";
import { ReviewCard, age } from "../ReviewCard";
import { ActiveFilterChips } from "../ActiveFilterChips";
import { ReviewBoardPagination } from "../ReviewBoardPagination";
import {
  boardQuery,
  commentClusters,
  parseBoardFilters,
  pinNumbers,
  redditShareUrl,
  type ReviewCard as Card,
  type ReviewComment,
} from "@/lib/reviews";

afterEach(() => {
  cleanup();
  harness.push.mockReset();
});

describe("board filters", () => {
  it("parse only known values and round-trip to the same URL", () => {
    const filters = parseBoardFilters({ sort: "top", matchup: "PvZ", band: "5", tag: "macro", unanswered: "1" });
    expect(filters).toEqual({ sort: "top", race: null, matchup: "PvZ", band: 5, tag: "macro", unanswered: true });
    expect(boardQuery(filters)).toBe("?sort=top&matchup=PvZ&band=5&tag=macro&unanswered=1");
    expect(parseBoardFilters({ sort: "drop", matchup: "XvY", band: "9", tag: "<x>" })).toEqual({
      sort: "hot", race: null, matchup: null, band: null, tag: null, unanswered: false,
    });
    expect(boardQuery(parseBoardFilters({}))).toBe("");
    expect(boardQuery(parseBoardFilters({}), { cursor: "abc" })).toBe("?cursor=abc");
  });

  it("navigate to canonical board URLs", () => {
    render(<ReviewBoardFilters filters={parseBoardFilters({ sort: "new" })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Matchup" }), { target: { value: "PvZ" } });
    expect(harness.push).toHaveBeenLastCalledWith("/reviews?sort=new&matchup=PvZ", { scroll: false });
    fireEvent.change(screen.getByRole("combobox", { name: "League band" }), { target: { value: "4" } });
    expect(harness.push).toHaveBeenLastCalledWith("/reviews?sort=new&band=4", { scroll: false });
    fireEvent.click(screen.getByRole("checkbox", { name: "Unanswered" }));
    expect(harness.push).toHaveBeenLastCalledWith("/reviews?sort=new&unanswered=1", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: "Hot" }));
    expect(harness.push).toHaveBeenLastCalledWith("/reviews", { scroll: false });
  });

  it("round-trips race and gives an exact matchup precedence over an incompatible race", () => {
    expect(boardQuery(parseBoardFilters({ race: "P", unanswered: "1" }))).toBe("?race=P&unanswered=1");
    expect(parseBoardFilters({ race: "T", matchup: "PvZ" })).toMatchObject({ race: null, matchup: "PvZ" });
    expect(parseBoardFilters({ race: "Protoss" }).race).toBeNull();
    expect(boardQuery({ ...parseBoardFilters({ matchup: "PvZ" }), race: "T" })).toBe("?matchup=PvZ");
  });

  it("restricts matchups to the chosen asker race and clears a mismatched matchup on race changes", () => {
    const { rerender } = render(<ReviewBoardFilters filters={parseBoardFilters({ race: "P", matchup: "PvZ" })} />);
    expect(within(screen.getByRole("combobox", { name: "Matchup" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["All", "PvP", "PvT", "PvZ"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Race (asker race)" }), { target: { value: "T" } });
    expect(harness.push).toHaveBeenLastCalledWith("/reviews?race=T", { scroll: false });
    rerender(<ReviewBoardFilters filters={parseBoardFilters({ matchup: "PvZ" })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Race (asker race)" }), { target: { value: "P" } });
    expect(harness.push).toHaveBeenLastCalledWith("/reviews?race=P&matchup=PvZ", { scroll: false });
  });

  it("gives each rendered filter form unique label associations", () => {
    render(<><ReviewBoardFilters filters={parseBoardFilters({})} /><ReviewBoardFilters filters={parseBoardFilters({})} /></>);
    const races = screen.getAllByRole("combobox", { name: "Race (asker race)" });
    expect(races).toHaveLength(2);
    expect(races[0].id).not.toBe(races[1].id);
    expect(screen.getAllByRole("combobox", { name: "Matchup" })).toHaveLength(2);
  });

  it("removes individual filters and clears everything while preserving the chosen sort", () => {
    render(<ActiveFilterChips filters={parseBoardFilters({ sort: "new", race: "P", matchup: "PvZ", band: "4", tag: "macro", unanswered: "1" })} />);
    expect(screen.getByRole("link", { name: "Remove filter Race: Protoss" }).getAttribute("href")).toBe("/reviews?sort=new&matchup=PvZ&band=4&tag=macro&unanswered=1");
    expect(screen.getByRole("link", { name: "Remove filter Matchup: PvZ" }).getAttribute("href")).toBe("/reviews?sort=new&race=P&band=4&tag=macro&unanswered=1");
    expect(screen.getByRole("link", { name: "Remove filter League: Diamond" }).getAttribute("href")).not.toContain("band=");
    expect(screen.getByRole("link", { name: "Remove filter Focus: Macro" }).getAttribute("href")).not.toContain("tag=");
    expect(screen.getByRole("link", { name: "Remove filter Unanswered" }).getAttribute("href")).not.toContain("unanswered=");
    expect(screen.getByRole("link", { name: "Clear all" }).getAttribute("href")).toBe("/reviews?sort=new");
  });

  it("offers Newest only on older pages and keeps all filters in pagination links", () => {
    const filters = parseBoardFilters({ race: "Z", tag: "scouting", unanswered: "1" });
    const { rerender } = render(<ReviewBoardPagination filters={filters} nextCursor="next" />);
    expect(screen.queryByRole("link", { name: /Newest/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Older requests/ }).getAttribute("href")).toBe("/reviews?race=Z&tag=scouting&unanswered=1&cursor=next");
    rerender(<ReviewBoardPagination filters={filters} cursor="current" nextCursor="next" />);
    expect(screen.getByText("Showing older requests")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Newest/ }).getAttribute("href")).toBe("/reviews?race=Z&tag=scouting&unanswered=1");
    expect(screen.getAllByRole("link").every((link) => link.getAttribute("rel") === "nofollow")).toBe(true);
  });
});

describe("review card", () => {
  it("shows matchup, result, band, question, age, review count and the best tick", () => {
    const card: Card = {
      id: "AAAAAAAAAAAAAAAA", url: "/reviews/AAAAAAAAAAAAAAAA", question: "Why did my blink all-in fail?",
      tags: ["build_order"], matchup: "PvZ", map: "Alcyone LE", result: "Loss", durationSec: 640,
      askerLabel: "Anonymous Protoss", askerBand: { id: 4, label: "Diamond" }, desiredLevel: "anyone",
      status: "answered", reviewCount: 3, helpfulCount: 1, hasBest: true, hasPlayback: true,
      createdAt: "2026-09-27T10:00:00.000Z", lastActivityAt: null,
    };
    render(<ul><ReviewCard card={card} now={Date.parse("2026-09-27T13:00:00Z")} /></ul>);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/reviews/AAAAAAAAAAAAAAAA");
    for (const text of ["PvZ", "Loss", "Diamond", "Why did my blink all-in fail?", "3h ago", "3 reviews", "Best review"]) {
      expect(link.textContent).toContain(text);
    }
    expect(age("2026-09-20T13:00:00Z", Date.parse("2026-09-27T13:00:00Z"))).toBe("7d ago");
  });

  it("keeps compact downloads in the metadata flow and outside the question link", () => {
    const card = { id: "a", url: "/reviews/a", question: "Where should I have scouted?", matchup: "PvZ", askerBand: { id: 4, label: "Diamond" }, createdAt: "2026-09-27T10:00:00Z", reviewCount: 2, replayShared: true } as Card;
    const { container } = render(<ul><ReviewCard card={card} now={Date.parse("2026-09-27T13:00:00Z")} variant="compact" /></ul>);
    const link = screen.getByRole("link", { name: card.question });
    const download = screen.getByRole("button", { name: "Download replay" });
    expect(link.contains(download)).toBe(false);
    expect(download.parentElement?.parentElement?.textContent).toContain("2 reviews");
    expect(download.parentElement?.className).not.toContain("absolute");
    expect(container.querySelector("img")).toBeNull();
    expect(link.className).not.toMatch(/pr-(14|16)/);
    expect(link.querySelector("p")?.className).toContain("line-clamp-2");
  });
});

describe("pins, clusters and sharing", () => {
  const c = (id: string, t: number, extra: Partial<ReviewComment> = {}): ReviewComment => ({
    id, parentId: null, state: "visible", author: null, body: "x", gameTimeSec: t, endTimeSec: null, mapPoint: null,
    upvotes: 0, upvoted: false, helpful: false, best: false, mine: false, canEdit: false, createdAt: null, editedAt: null, ...extra,
  });

  it("numbers pins in thread order and clusters comments on the timeline", () => {
    const comments = [
      c("a", 312, { mapPoint: { x: 1, y: 2 } }),
      c("b", 315),
      c("c", 318, { mapPoint: { x: 3, y: 4 } }),
      c("d", 60, { state: "deleted" }),
    ];
    expect([...pinNumbers(comments)]).toEqual([["a", 1], ["c", 2]]);
    expect(commentClusters(comments, 640)).toEqual([{ startSec: 310, count: 3, ids: ["a", "b", "c"] }]);
  });

  it("prefills the Reddit title", () => {
    const url = redditShareUrl("https://sc2tools.com/reviews/x", "Why did my blink all-in fail?", "PvZ");
    const params = new URL(url).searchParams;
    expect(params.get("title")).toBe("[PvZ] Why did my blink all-in fail? — timestamped replay review");
    expect(params.get("url")).toBe("https://sc2tools.com/reviews/x");
  });
});
