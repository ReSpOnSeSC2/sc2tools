import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));

import { ReviewBoardFilters } from "../ReviewBoardFilters";
import { ReviewCard, age } from "../ReviewCard";
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
    expect(filters).toEqual({ sort: "top", matchup: "PvZ", band: 5, tag: "macro", unanswered: true });
    expect(boardQuery(filters)).toBe("?sort=top&matchup=PvZ&band=5&tag=macro&unanswered=1");
    expect(parseBoardFilters({ sort: "drop", matchup: "XvY", band: "9", tag: "<x>" })).toEqual({
      sort: "hot", matchup: null, band: null, tag: null, unanswered: false,
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
