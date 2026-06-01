"use client";

/**
 * Thin typed wrappers over the global ``gtag`` queue.
 *
 * These are no-ops until ``<GoogleAnalytics>`` has injected gtag.js
 * (which only happens after the visitor opts in), so they're safe to
 * call from anywhere — an event fired before consent simply doesn't go
 * anywhere. Keeping the ``window.gtag`` access behind these helpers
 * means component code never has to reach into ``window`` or repeat
 * the ``typeof`` guard.
 */

import { GA_MEASUREMENT_ID } from "./consent";

type GtagFn = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: GtagFn;
  }
}

/** Safe accessor for the global gtag fn. */
function gtag(): GtagFn | null {
  if (typeof window === "undefined") return null;
  return typeof window.gtag === "function" ? window.gtag : null;
}

/**
 * Record a SPA page view. The App Router does client-side navigation,
 * so we send these manually on route change instead of relying on
 * gtag's automatic ``page_view`` (which only fires on hard loads).
 */
export function pageview(url: string): void {
  const fn = gtag();
  if (!fn || !GA_MEASUREMENT_ID) return;
  fn("event", "page_view", { page_path: url, page_location: window.location.href });
}

/** Record an arbitrary custom event. */
export function gaEvent(
  action: string,
  params: Record<string, unknown> = {},
): void {
  const fn = gtag();
  if (!fn) return;
  fn("event", action, params);
}
