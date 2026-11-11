"use client";

import { useEffect, useRef, useState } from "react";
import type { ReviewComment } from "@/lib/reviews";
import {
  clampReviewTime,
  isShownComment,
  parseReviewDeepLink,
} from "@/lib/reviewNavigation";

/** Whether the replay can take a seek yet: loaded, still loading, or never. */
export type PlaybackReadiness = "pending" | "ready" | "none";

type Pending =
  | { kind: "time"; t: number; composedAt: number | null }
  | { kind: "comment"; id: string; selected: boolean };

export type ReviewDeepLinkOptions = {
  comments: readonly ReviewComment[];
  /** Auth is known and the viewer's own thread has loaded, so an unknown id is final. */
  settled: boolean;
  playback: PlaybackReadiness;
  durationSec: number | null;
  onSelect: (commentId: string) => void;
  onSeek: (seconds: number, commentId?: string) => void;
  onScroll: (commentId: string) => void;
  onCompose: (seconds: number) => void;
  onMissing: () => void;
};

/** Advance one pending link as far as the page allows; null when it is done. */
function advance(pending: Pending, o: ReviewDeepLinkOptions): Pending | null {
  const canSeek = o.playback !== "pending";
  if (pending.kind === "time") {
    const t = clampReviewTime(pending.t, o.durationSec);
    if (pending.composedAt !== t) o.onCompose(t);
    if (!canSeek) return pending.composedAt === t ? pending : { ...pending, composedAt: t };
    o.onSeek(t);
    return null;
  }
  if (!o.settled) return pending;
  const comment = o.comments.find((c) => c.id === pending.id);
  if (!comment || !isShownComment(comment)) {
    o.onMissing();
    return null;
  }
  if (!pending.selected) o.onSelect(comment.id);
  if (comment.gameTimeSec !== null && !canSeek) return pending.selected ? pending : { ...pending, selected: true };
  // Without map playback the replay can't follow, so the card just scrolls.
  if (comment.gameTimeSec !== null && o.playback === "ready") o.onSeek(clampReviewTime(comment.gameTimeSec, o.durationSec), comment.id);
  o.onScroll(comment.id);
  return null;
}

/**
 * Admit "#comment-<id>" and "?t=5:12" when the page opens, and later
 * location hash changes. A comment is selected, then the replay
 * seeks to it once playback is ready, then its card scrolls into view;
 * a time opens the composer there and seeks. Unknown or deleted ids are
 * reported without moving the page. Nothing here writes to the URL.
 */
export function useReviewDeepLink(options: ReviewDeepLinkOptions): void {
  const [pending, setPending] = useState<Pending | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const followLocation = () => {
      const link = parseReviewDeepLink(window.location.hash, window.location.search);
      if (!link) setPending(null);
      else setPending(link.kind === "time" ? { ...link, composedAt: null } : { ...link, selected: false });
    };
    followLocation();
    window.addEventListener("hashchange", followLocation);
    return () => window.removeEventListener("hashchange", followLocation);
  }, []);

  const { comments, settled, playback, durationSec } = options;
  useEffect(() => {
    if (!pending) return;
    const next = advance(pending, latest.current);
    if (next !== pending) setPending(next);
  }, [pending, comments, settled, playback, durationSec]);
}
