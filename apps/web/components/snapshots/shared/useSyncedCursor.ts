"use client";

import { useCallback, useEffect, useState } from "react";

// Synchronizes a "current tick" cursor across the page's four band
// charts plus the heat-row timeline. One hook → shared state.
// Components that read it accept the focused tick and (optionally)
// register a hover callback so the underlying chart can highlight
// the cursor without re-rendering the whole page.

export interface SyncedCursor {
  tick: number | null;
  setTick: (t: number | null) => void;
  pinned: boolean;
  setPinned: (b: boolean) => void;
  togglePin: () => void;
}

export function useSyncedCursor(initial: number | null = null): SyncedCursor {
  const [tick, setTickState] = useState<number | null>(initial);
  const [pinned, setPinned] = useState(false);

  const setTick = useCallback(
    (t: number | null) => {
      if (pinned) return;
      setTickState(t);
    },
    [pinned],
  );

  const togglePin = useCallback(() => setPinned((p) => !p), []);

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        setTickState((t) => (t === null ? 0 : Math.max(0, t - 30)));
      } else if (e.key === "ArrowRight") {
        setTickState((t) => (t === null ? 0 : Math.min(1200, t + 30)));
      } else if (e.key === "Escape") {
        setPinned(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);

  return { tick, setTick, pinned, setPinned, togglePin };
}
