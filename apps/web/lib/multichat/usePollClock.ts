"use client";

import { useEffect, useState } from "react";
import { POLL_CLOCK_SKEW_MS, pollVoteCutoffMs, type PollTiming } from "./poll";

/** Advance the visible countdown and stop ticking when the result settles. */
export function usePollClock(poll: PollTiming | null) {
  const cutoff = poll ? pollVoteCutoffMs(poll) : null;
  const [tick, setTick] = useState<{ cutoff: number | null; now: number }>(() => ({ cutoff, now: Date.now() }));
  useEffect(() => {
    if (cutoff === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const advance = () => {
      const now = Date.now();
      setTick({ cutoff, now });
      if (now < cutoff + POLL_CLOCK_SKEW_MS) timer = setTimeout(advance, 250);
    };
    advance();
    return () => clearTimeout(timer);
  }, [cutoff]);
  return tick.cutoff === cutoff ? tick.now : Date.now();
}
