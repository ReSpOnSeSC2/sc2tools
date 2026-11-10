import { formatClock, parseClock, type ReviewComment } from "./reviews";

/**
 * Review-page navigation: the deep links a review page admits, the links
 * its copy actions produce, the timed-comment stepper and the thread
 * filters. Pure so the page, the thread and their tests share one model.
 */

/** "#comment-<id>" wins over "?t=" when a URL carries both. */
export type ReviewDeepLink = { kind: "comment"; id: string } | { kind: "time"; t: number };

const COMMENT_HASH = /^#comment-([\w-]+)$/;

export function parseCommentHash(hash: string): string | null {
  const match = COMMENT_HASH.exec(hash);
  return match ? match[1] : null;
}

/** ``?t=`` accepts the replay clock's own forms: "5:12", "1:05:12" or "312". */
export function parseReviewDeepLink(hash: string, search: string): ReviewDeepLink | null {
  const id = parseCommentHash(hash);
  if (id) return { kind: "comment", id };
  let raw: string | null = null;
  try { raw = new URLSearchParams(search).get("t"); } catch { raw = null; }
  const t = raw === null ? null : parseClock(raw);
  return t === null ? null : { kind: "time", t };
}

/** Keep a linked moment inside the game; an unknown length only floors at 0. */
export function clampReviewTime(t: number, durationSec: number | null): number {
  const max = typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, Number.isFinite(t) ? t : 0), max);
}

export function reviewCommentUrl(origin: string, requestUrl: string, commentId: string): string {
  return `${origin}${requestUrl}#comment-${commentId}`;
}

export function reviewMomentUrl(origin: string, requestUrl: string, seconds: number): string {
  return `${origin}${requestUrl}?t=${formatClock(seconds)}`;
}

/** A comment a reader sees as a card (not a [deleted] or blocked placeholder). */
export function isShownComment(comment: ReviewComment): boolean {
  return comment.state === "visible" || comment.state === "hidden";
}

export type ThreadFilter = "focus" | "pins" | "replies";

export const THREAD_FILTERS: ReadonlyArray<{ key: ThreadFilter; label: string }> = [
  { key: "focus", label: "In focus range" },
  { key: "pins", label: "Map pins" },
  { key: "replies", label: "Has replies" },
];

type Range = { startSec: number; endSec: number };

/** The comment's [start, end] overlaps the asker's focus range, edges included. */
export function overlapsFocusRange(comment: ReviewComment, range: Range | null): boolean {
  if (!range || comment.gameTimeSec === null) return false;
  const end = comment.endTimeSec ?? comment.gameTimeSec;
  return comment.gameTimeSec <= range.endSec && end >= range.startSec;
}

function shownReplyCounts(comments: readonly ReviewComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) {
    if (c.parentId && isShownComment(c)) counts.set(c.parentId, (counts.get(c.parentId) ?? 0) + 1);
  }
  return counts;
}

function matchesFilter(comment: ReviewComment, filter: ThreadFilter, range: Range | null, replies: Map<string, number>): boolean {
  if (filter === "focus") return overlapsFocusRange(comment, range);
  if (filter === "pins") return comment.mapPoint !== null;
  return !comment.parentId && (replies.get(comment.id) ?? 0) > 0;
}

export type ThreadFilterResult = {
  /** Shown comments matching every active filter (AND); null when none is active. */
  matching: Set<string> | null;
  /** Comments each chip would match on its own. */
  counts: Record<ThreadFilter, number>;
};

export function filterThread(
  comments: readonly ReviewComment[],
  active: ReadonlySet<ThreadFilter>,
  range: Range | null,
): ThreadFilterResult {
  const replies = shownReplyCounts(comments);
  const shown = comments.filter(isShownComment);
  const counts = { focus: 0, pins: 0, replies: 0 } as Record<ThreadFilter, number>;
  for (const { key } of THREAD_FILTERS) {
    counts[key] = shown.filter((c) => matchesFilter(c, key, range, replies)).length;
  }
  if (active.size === 0) return { matching: null, counts };
  const keys = [...active];
  const matching = new Set(shown.filter((c) => keys.every((key) => matchesFilter(c, key, range, replies))).map((c) => c.id));
  return { matching, counts };
}

/** Timed shown comments, top-level and replies, in replay order (then posting order). */
export function timedComments(comments: readonly ReviewComment[], matching: Set<string> | null = null): ReviewComment[] {
  return comments
    .filter((c) => isShownComment(c) && c.gameTimeSec !== null && (!matching || matching.has(c.id)))
    .sort((a, b) => (a.gameTimeSec ?? 0) - (b.gameTimeSec ?? 0)
      || (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
      || a.id.localeCompare(b.id));
}

export type StepPosition = {
  /** Index of the active comment in the list, or null when none is active. */
  index: number | null;
  prev: ReviewComment | null;
  next: ReviewComment | null;
};

const SAME_MOMENT_SEC = 0.05;

/**
 * Where Prev/Next go: from the active comment, or, when none is active,
 * from the replay clock (Next is the first comment at or after it).
 */
export function stepPosition(list: readonly ReviewComment[], activeId: string | null, currentTime: number): StepPosition {
  const index = activeId ? list.findIndex((c) => c.id === activeId) : -1;
  if (index >= 0) return { index, prev: list[index - 1] ?? null, next: list[index + 1] ?? null };
  const after = list.findIndex((c) => (c.gameTimeSec ?? 0) >= currentTime - SAME_MOMENT_SEC);
  const nextIndex = after < 0 ? list.length : after;
  return { index: null, prev: list[nextIndex - 1] ?? null, next: list[nextIndex] ?? null };
}

export function stepAnnouncement(list: readonly ReviewComment[], comment: ReviewComment): string {
  const position = list.findIndex((c) => c.id === comment.id) + 1;
  return `Comment ${position} of ${list.length} at ${formatClock(comment.gameTimeSec)} by ${comment.author?.label ?? "SC2 Player"}`;
}

export type ThreadOrder = "top" | "timeline";
export const THREAD_ORDER_KEY = "sc2tools:reviews:thread-order";

export function readThreadOrder(): ThreadOrder {
  try { return window.localStorage.getItem(THREAD_ORDER_KEY) === "timeline" ? "timeline" : "top"; }
  catch { return "top"; }
}

export function writeThreadOrder(order: ThreadOrder): void {
  try { window.localStorage.setItem(THREAD_ORDER_KEY, order); } catch { /* The order still applies for this visit. */ }
}

/**
 * The review page's own keys, outside the replay and form fields. The
 * global "?" sheet lists them under "This page"; the page never binds "?"
 * itself.
 */
export const REVIEW_SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: "N", label: "Next timed comment" },
  { keys: "P", label: "Previous timed comment" },
  { keys: "C", label: "Comment at the current replay time" },
  { keys: "?", label: "Show keyboard shortcuts" },
];
