"use client";

// useTestFireFlag — shared Settings Test-button latch for the
// self-driven overlay widgets (multichat + the Stream Studio family).
//
// These widgets render off their own data feeds (chat engines, the
// Stream Dock studio state) rather than game payloads, so a Settings
// Test fire can't light them up by itself: they read the shared
// ``overlay:live`` socket payload for exactly one thing — the test
// stamp — and swap in clearly-labelled demo content while the flag is
// up. This hook owns the flag semantics, generalized from the
// multichat widget's original useTestFire:
//
//   • Rising edge — a test-stamped payload targeting ``widgetId`` (or
//     an untargeted "Test all" payload) flips the flag on. Each fresh
//     test payload re-arms the window.
//   • Self-cap — the flag clears itself after TEST_DURATION_MS; the
//     self-driven widgets bypass the payload visibility timer, so
//     they must cap their own demo.
//   • Latch — NON-test payload deliveries mid-window (socket resync
//     replaying the latest real snapshot, an actual game ending) must
//     NOT abort the demo; they're ignored.
//   • ``live === null`` — ``overlay:clear``, the Settings Stop
//     button — clears the flag immediately.

import { useEffect, useRef, useState } from "react";
import { TEST_DURATION_MS } from "@/components/overlay/widgetLifecycle";
import type { LiveGamePayload } from "@/components/overlay/types";

/**
 * True while a Settings Test fire targeting ``widgetId`` is inside
 * its demo window. See the module comment for the exact semantics.
 */
export function useTestFireFlag(
  live: LiveGamePayload | null | undefined,
  widgetId: string,
): boolean {
  const [active, setActive] = useState(false);
  const stopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStop = () => {
    if (stopRef.current) clearTimeout(stopRef.current);
    stopRef.current = null;
  };

  useEffect(() => {
    if (live === null) {
      // overlay:clear — the Stop button. End the demo immediately.
      clearStop();
      setActive(false);
      return;
    }
    const isTestPayload = Boolean(
      live?.isTest && (!live.testWidget || live.testWidget === widgetId),
    );
    // Real payloads mid-demo (resync replay, an actual game ending)
    // must NOT abort the run — leave the stop timer alone.
    if (!isTestPayload) return;

    clearStop();
    setActive(true);
    stopRef.current = setTimeout(() => {
      stopRef.current = null;
      setActive(false);
    }, TEST_DURATION_MS);
  }, [live, widgetId]);

  // Unmount-only cleanup — per-dep cleanup would defeat the latch.
  useEffect(() => clearStop, []);

  return active;
}
