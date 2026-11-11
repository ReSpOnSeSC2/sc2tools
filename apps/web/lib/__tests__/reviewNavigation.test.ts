import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment } from "../reviews";
import {
  THREAD_ORDER_KEY,
  clampReviewTime,
  filterThread,
  overlapsFocusRange,
  parseReviewDeepLink,
  readThreadOrder,
  reviewCommentUrl,
  reviewMomentUrl,
  stepAnnouncement,
  stepPosition,
  timedComments,
  writeThreadOrder,
  type ThreadFilter,
} from "../reviewNavigation";

function comment(id: string, extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id, parentId: null, state: "visible",
    author: { label: `Author ${id}`, isAsker: false, profileHref: null, verified: null, badges: [], flair: null },
    body: "Scout their third before you move out.", gameTimeSec: 100, endTimeSec: null, mapPoint: null,
    upvotes: 0, upvoted: false, helpful: false, best: false, mine: false, canEdit: false,
    createdAt: "2026-10-01T10:00:00.000Z", editedAt: null, ...extra,
  };
}

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe("deep links", () => {
  it("admits #comment-<id> over ?t= and reads the replay clock forms", () => {
    expect(parseReviewDeepLink("#comment-AbC_12-x", "?t=5:12")).toEqual({ kind: "comment", id: "AbC_12-x" });
    expect(parseReviewDeepLink("", "?t=5:12")).toEqual({ kind: "time", t: 312 });
    expect(parseReviewDeepLink("", "?t=312")).toEqual({ kind: "time", t: 312 });
    expect(parseReviewDeepLink("#builds", "?t=1:05:12")).toEqual({ kind: "time", t: 3912 });
    expect(parseReviewDeepLink("#comment-", "?t=5:99")).toBeNull();
    expect(parseReviewDeepLink("#comment-a b", "")).toBeNull();
  });

  it("clamps a linked moment into the game", () => {
    expect(clampReviewTime(900, 640)).toBe(640);
    expect(clampReviewTime(-4, 640)).toBe(0);
    expect(clampReviewTime(312, null)).toBe(312);
  });

  it("builds the comment and moment links the copy actions share", () => {
    expect(reviewCommentUrl("https://sc2tools.com", "/reviews/AAAA", "BBBB")).toBe("https://sc2tools.com/reviews/AAAA#comment-BBBB");
    expect(reviewMomentUrl("https://sc2tools.com", "/reviews/AAAA", 312.7)).toBe("https://sc2tools.com/reviews/AAAA?t=5:12");
  });
});

describe("thread filters", () => {
  const range = { startSec: 300, endSec: 360 };

  it("treats the focus-range overlap edges as inside", () => {
    expect(overlapsFocusRange(comment("a", { gameTimeSec: 360 }), range)).toBe(true);
    expect(overlapsFocusRange(comment("b", { gameTimeSec: 280, endTimeSec: 300 }), range)).toBe(true);
    expect(overlapsFocusRange(comment("c", { gameTimeSec: 250, endTimeSec: 299 }), range)).toBe(false);
    expect(overlapsFocusRange(comment("d", { gameTimeSec: 361 }), range)).toBe(false);
    expect(overlapsFocusRange(comment("e", { gameTimeSec: null }), range)).toBe(false);
    expect(overlapsFocusRange(comment("f", { gameTimeSec: 320 }), null)).toBe(false);
  });

  it("counts each chip alone and combines active chips with AND", () => {
    const comments = [
      comment("pinned-in-range", { gameTimeSec: 320, mapPoint: { x: 1, y: 2 } }),
      comment("in-range", { gameTimeSec: 340 }),
      comment("reply", { parentId: "in-range", gameTimeSec: 345, mapPoint: { x: 3, y: 4 } }),
      comment("deleted-reply", { parentId: "pinned-in-range", state: "deleted" }),
      comment("late-pin", { gameTimeSec: 600, mapPoint: { x: 5, y: 6 } }),
    ];
    const none = filterThread(comments, new Set(), range);
    expect(none.matching).toBeNull();
    expect(none.counts).toEqual({ focus: 3, pins: 3, replies: 1 });
    const only = (filters: ThreadFilter[]) => [...(filterThread(comments, new Set(filters), range).matching ?? [])];
    expect(only(["pins"])).toEqual(["pinned-in-range", "reply", "late-pin"]);
    expect(only(["focus", "pins"])).toEqual(["pinned-in-range", "reply"]);
    // A deleted reply doesn't make a conversation.
    expect(only(["replies"])).toEqual(["in-range"]);
    expect(only(["replies", "pins"])).toEqual([]);
  });
});

describe("timed-comment stepper", () => {
  const list = timedComments([
    comment("late", { gameTimeSec: 500 }),
    comment("untimed", { gameTimeSec: null }),
    comment("reply-early", { parentId: "late", gameTimeSec: 100, createdAt: "2026-10-01T12:00:00.000Z" }),
    comment("early", { gameTimeSec: 100, createdAt: "2026-10-01T11:00:00.000Z" }),
    comment("gone", { gameTimeSec: 200, state: "removed" }),
    comment("mid", { gameTimeSec: 300 }),
  ]);

  it("walks shown timed comments, top-level and replies, by time then posting order", () => {
    expect(list.map((c) => c.id)).toEqual(["early", "reply-early", "mid", "late"]);
  });

  it("steps from the active comment and stops at both ends", () => {
    expect(stepPosition(list, "mid", 0)).toMatchObject({ index: 2, prev: { id: "reply-early" }, next: { id: "late" } });
    expect(stepPosition(list, "early", 0)).toMatchObject({ index: 0, prev: null, next: { id: "reply-early" } });
    expect(stepPosition(list, "late", 0)).toMatchObject({ index: 3, prev: { id: "mid" }, next: null });
  });

  it("steps from the replay clock when nothing is active", () => {
    expect(stepPosition(list, null, 250)).toMatchObject({ index: 2, prev: { id: "reply-early" }, next: { id: "mid" } });
    expect(stepPosition(list, null, 300)).toMatchObject({ next: { id: "mid" } });
    expect(stepPosition(list, null, 0)).toMatchObject({ prev: null, next: { id: "early" } });
    expect(stepPosition(list, "filtered-out", 900)).toMatchObject({ index: 3, prev: { id: "late" }, next: null });
  });

  it("announces where a step landed", () => {
    expect(stepAnnouncement(list, list[2])).toBe("Comment 3 of 4 at 5:00 by Author mid");
  });
});

describe("thread order memory", () => {
  it("remembers Timeline and defaults to Top", () => {
    expect(readThreadOrder()).toBe("top");
    writeThreadOrder("timeline");
    expect(window.localStorage.getItem(THREAD_ORDER_KEY)).toBe("timeline");
    expect(readThreadOrder()).toBe("timeline");
  });

  it("tolerates storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => writeThreadOrder("timeline")).not.toThrow();
    expect(readThreadOrder()).toBe("top");
  });
});
