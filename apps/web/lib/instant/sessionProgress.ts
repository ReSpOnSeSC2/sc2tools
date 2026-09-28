/**
 * Progress plumbing for `useInstantSession`: turn engine progress events
 * into `SessionProgress` samples and throttle them so React re-renders at
 * most every `PROGRESS_INTERVAL_MS` however chatty the worker is.
 *
 * The throttle uses timers rather than `requestAnimationFrame` on purpose:
 * rAF is paused in background tabs, and a long import keeps running (and
 * should show the right count) when the visitor switches tabs.
 *
 * Example:
 *   const throttle = createThrottle((p: SessionProgress) => dispatch({ type: "progress", progress: p }));
 *   engine.parseFiles(requests, { onProgress: (e) => throttle.push(toSessionProgress(e)) });
 *   throttle.flush(); // push the last sample now
 */
import type { SessionProgress } from "./sessionState";
import type { EngineProgress } from "./types";

/** Minimum gap between two progress renders. */
export const PROGRESS_INTERVAL_MS = 100;

/** Leading + trailing throttle over a single latest value. */
export interface Throttle<T> {
  /** Offer a new value; applied now or at the end of the interval. */
  push(value: T): void;
  /** Apply the pending value (if any) immediately. */
  flush(): void;
  /** Drop the pending value and any scheduled apply. */
  cancel(): void;
}

/**
 * Create a throttle that applies the latest pushed value at most once per
 * `intervalMs` (first value immediately, last value never lost unless
 * cancelled).
 *
 * Example:
 *   const t = createThrottle(render, 100);
 *   t.push(a); t.push(b); // renders a now, b after ~100 ms
 */
export function createThrottle<T>(
  apply: (value: T) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS,
  now: () => number = Date.now,
): Throttle<T> {
  let pending: { value: T } | null = null;
  let lastApplied = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = (): void => {
    clearTimer();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastApplied = now();
    apply(value);
  };
  return {
    push(value: T): void {
      pending = { value };
      if (timer !== null) return;
      const wait = lastApplied + intervalMs - now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    flush,
    cancel(): void {
      clearTimer();
      pending = null;
    },
  };
}

/**
 * Map an engine event to a progress sample (`done` counts finished files).
 *
 * Example:
 *   toSessionProgress({ phase: "parse", index: 2, total: 5, fileName: "a", ms: 900, ok: true }).done; // -> 3
 */
export function toSessionProgress(event: EngineProgress): SessionProgress {
  const finished = event.ms !== undefined;
  return {
    phase: event.phase,
    index: event.index,
    total: event.total,
    done: Math.min(event.total, finished ? event.index + 1 : event.index),
    fileName: event.fileName,
  };
}
