"use client";

import { useEffect, useRef } from "react";
import { searchShortcutBlocked } from "@/lib/usePageSearchShortcut";

export type ReviewShortcutHandlers = {
  onNext: () => void;
  onPrev: () => void;
  /** Absent when the viewer can't comment right now. */
  onCompose?: () => void;
};

function insideReplayStage(node: EventTarget | null): boolean {
  return node instanceof Element && Boolean(node.closest("[data-replay-stage]"));
}

/**
 * The page's own keys: N / P step through timed comments and C starts a
 * comment at the replay time. They act only outside form fields, dialogs
 * and menus, with no modifier held, and never while the replay stage has
 * focus (it owns N/P and the playback keys there). "?" stays with the
 * global sheet, which lists these keys under "This page".
 */
export function reviewShortcutIgnored(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey || searchShortcutBlocked(event)
    || insideReplayStage(event.target) || insideReplayStage(document.activeElement);
}

export function useReviewShortcuts(handlers: ReviewShortcutHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (reviewShortcutIgnored(event)) return;
      const key = event.key.toLowerCase();
      const current = latest.current;
      if (key === "n") { event.preventDefault(); current.onNext(); }
      else if (key === "p") { event.preventDefault(); current.onPrev(); }
      else if (key === "c" && current.onCompose) { event.preventDefault(); current.onCompose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
