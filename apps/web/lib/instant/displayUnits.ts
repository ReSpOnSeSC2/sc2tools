/**
 * Shared units and small formatters for Instant Analysis copy, so progress
 * bars, retry countdowns and "uploads resume at" lines never re-declare
 * their own magic numbers.
 *
 * Example:
 *   percentOf(3, 12);                        // -> 25
 *   secondsUntilRetry(4200);                 // -> 5
 *   uploadsResumeText(Date.parse("2026-09-29T00:00:00Z")); // -> "Uploads resume after Tue 2:00 AM." (locale time)
 */

/** Milliseconds per second. */
export const MS_PER_SECOND = 1000;
/** Scale of a percentage. */
export const PERCENT = 100;

/**
 * Whole percent of `done` out of `total` (0 when there is no total).
 *
 * Example:
 *   percentOf(1, 3); // -> 33
 */
export function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((Math.min(done, total) / total) * PERCENT);
}

/**
 * A retry wait in whole seconds, rounded up and never below 1.
 *
 * Example:
 *   secondsUntilRetry(undefined); // -> 1
 */
export function secondsUntilRetry(ms: number | undefined): number {
  return Math.max(1, Math.ceil((ms ?? 0) / MS_PER_SECOND));
}

const RESUME_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" };

/**
 * When browser uploads resume after the daily cap, in the visitor's local
 * time; null without a usable time.
 *
 * Example:
 *   uploadsResumeText(null); // -> null
 */
export function uploadsResumeText(resetAt: number | null | undefined, locale?: string): string | null {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
  return `Uploads resume after ${new Intl.DateTimeFormat(locale, RESUME_FORMAT).format(resetAt)}.`;
}
