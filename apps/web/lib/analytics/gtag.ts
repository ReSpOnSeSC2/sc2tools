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
 *
 * Every event from a browser flagged as internal (an admin signed in
 * there, see ``./internalTraffic``) carries ``traffic_type: "internal"``
 * so the GA4 Internal Traffic data filter can drop it.
 */

import { GA_MEASUREMENT_ID } from "./consent";
import {
  INTERNAL_TRAFFIC_TYPE,
  isInternalBrowser,
} from "./internalTraffic";
import { analyticsPageLocation, isUntrackedPath } from "./pageLocation";

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

/** Whether gtag.js has been initialised on this page (consent granted). */
export function isGtagReady(): boolean {
  return gtag() !== null;
}

/** Add the internal-traffic marker to an event's params on flagged browsers. */
function withTrafficType(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return isInternalBrowser()
    ? { ...params, traffic_type: INTERNAL_TRAFFIC_TYPE }
    : params;
}

/**
 * Record a SPA page view. The App Router does client-side navigation,
 * so we send these manually on route change (the stream's "page changes
 * based on browser history events" option is off, so this is the only
 * page_view source after the first load).
 *
 * Only ``page_location`` is sent: GA4 derives the page path and query
 * from it. (Sending ``page_path`` with a query string as well made GA
 * report "/?source=pwa?source=pwa"-style duplicated queries.) The
 * location is normalized by ``analyticsPageLocation`` and untracked
 * surfaces are skipped entirely.
 *
 * Example:
 *   pageview("/app/game/abc", "?tab=macro"); // page_location ".../app/game/:gameId"
 */
export function pageview(pathname: string, search = ""): void {
  const fn = gtag();
  if (!fn || !GA_MEASUREMENT_ID || isUntrackedPath(pathname)) return;
  fn(
    "event",
    "page_view",
    withTrafficType({
      page_location: analyticsPageLocation(window.location.origin, pathname, search),
    }),
  );
}

/** Record an arbitrary custom event. */
export function gaEvent(
  action: string,
  params: Record<string, unknown> = {},
): void {
  const fn = gtag();
  if (!fn) return;
  fn("event", action, withTrafficType(params));
}

/**
 * Tag the rest of this page's events (including GA's automatic ones) as
 * internal. Called once when an admin is first detected on a browser
 * that already has GA running; later page loads pick the flag up in the
 * init script before the first event.
 */
export function tagSessionAsInternal(): void {
  const fn = gtag();
  if (!fn) return;
  fn("set", { traffic_type: INTERNAL_TRAFFIC_TYPE });
}
