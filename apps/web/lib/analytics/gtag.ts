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
 *
 * Every event also reports its page in the normalized form of
 * ``./pageLocation``. Left alone, gtag.js fills in the browser's real
 * address on any event that does not state one — its own automatic
 * events included (engagement time, outbound clicks, file downloads,
 * form use) — and repeats the browser's referrer on all of them. Either
 * can hold a game id, an opponent id or a player's name. So these
 * wrappers keep gtag's page state normalized (``syncAnalyticsPage``),
 * attach the location to custom events themselves, and send nothing at
 * all from an untracked surface (Google's opt-out flag, see
 * ``syncAnalyticsOptOut``). Measured in docs/handoff/growth/X1.md;
 * decided in ADR 0076.
 */

import { GA_MEASUREMENT_ID, syncAnalyticsOptOut } from "./consent";
import {
  INTERNAL_TRAFFIC_TYPE,
  isInternalBrowser,
} from "./internalTraffic";
import {
  analyticsPageLocation,
  analyticsPageState,
  analyticsPageTitle,
  isUntrackedPath,
} from "./pageLocation";

export { analyticsPageState } from "./pageLocation";

type GtagFn = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: GtagFn;
    [key: `ga-disable-${string}`]: boolean | undefined;
  }
}

/**
 * Safe accessor for the global gtag fn: null until gtag.js is set up,
 * and whenever nothing may be sent (no consent, or an untracked page).
 * Asking also brings Google's opt-out flag up to date with the address,
 * so every wrapper is right at the moment it is called.
 */
function gtag(): GtagFn | null {
  if (typeof window === "undefined" || !GA_MEASUREMENT_ID) return null;
  if (syncAnalyticsOptOut()) return null;
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
 * Keep gtag.js pointed at the page the visitor is on. Called on every
 * navigation, whether or not a page view is sent for it.
 *
 * On a tracked page this replaces gtag's page state, which its automatic
 * events inherit. On an untracked one it only raises Google's opt-out
 * flag (through the accessor), so an already loaded gtag.js stays quiet
 * until the visitor is back on a tracked page.
 *
 * Example:
 *   syncAnalyticsPage("/app/opponents/1-S2-1-123", "?tab=games");
 *   // gtag("set", { page_location: ".../app/opponents/:pulseId" })
 */
export function syncAnalyticsPage(pathname: string, search = ""): void {
  const fn = gtag();
  if (!fn || isUntrackedPath(pathname)) return;
  fn("set", analyticsPageState(pathname, search));
}

/**
 * Record a SPA page view. The App Router does client-side navigation,
 * so we send these manually on route change (the stream's "page changes
 * based on browser history events" option is off, so this is the only
 * page_view source after the first load).
 *
 * The page state is replaced first, so the automatic events that follow
 * on this page inherit the same normalized location. Only
 * ``page_location`` is sent with the event itself: GA4 derives the page
 * path and query from it. (Sending ``page_path`` with a query string as
 * well made GA report "/?source=pwa?source=pwa"-style duplicated
 * queries.) Untracked surfaces are skipped entirely.
 *
 * Example:
 *   pageview("/app/game/abc", "?tab=macro"); // page_location ".../app/game/:gameId"
 */
export function pageview(pathname: string, search = ""): void {
  const fn = gtag();
  if (!fn || isUntrackedPath(pathname)) return;
  const state = analyticsPageState(pathname, search);
  fn("set", state);
  fn(
    "event",
    "page_view",
    withTrafficType({ page_location: state.page_location }),
  );
}

/**
 * Record an arbitrary custom event from the page the visitor is on.
 *
 * The event states its own normalized location and fixed title instead of leaning on
 * gtag's page state: a component can fire one while a navigation is
 * still settling, before the new page's state is in place. A caller
 * cannot override it, and nothing is sent from an untracked surface.
 *
 * Example (on /app/game/abc?tab=macro):
 *   gaEvent("review_requested", { level: "gold" });
 *   // page_location ".../app/game/:gameId"
 */
export function gaEvent(
  action: string,
  params: Record<string, unknown> = {},
): void {
  const fn = gtag();
  if (!fn) return;
  const { origin, pathname, search } = window.location;
  fn(
    "event",
    action,
    withTrafficType({
      ...params,
      page_location: analyticsPageLocation(origin, pathname, search),
      page_title: analyticsPageTitle(pathname),
    }),
  );
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
