/**
 * Internal-traffic tagging for Google Analytics.
 *
 * A browser where an SC2 Tools admin has signed in is remembered as
 * internal (a localStorage flag that outlives signing out), and every GA
 * event from it carries `traffic_type: "internal"`. The GA4 property's
 * "Internal Traffic" data filter matches exactly that parameter, so once
 * the filter is Active the owner's own testing and admin work stops
 * inflating the reports. IP rules can't do this job: the owner browses
 * from several networks and mobile connections.
 *
 * The flag is read synchronously by the GA init script (see
 * components/analytics/GoogleAnalytics.tsx), so it must stay a plain
 * localStorage key with the literal value "1".
 *
 * Example:
 *   markInternalBrowser(); // after /v1/me reports isAdmin
 *   isInternalBrowser();   // -> true, on this browser from now on
 */

export const INTERNAL_TRAFFIC_STORAGE_KEY = "sc2tools.internalTraffic.v1";

/** The value GA4's Internal Traffic data filter matches on `traffic_type`. */
export const INTERNAL_TRAFFIC_TYPE = "internal";

/** Whether this browser is flagged as internal. SSR-safe; unreadable storage → false. */
export function isInternalBrowser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Flag this browser as internal. Returns true only when the flag was newly
 * set (so the caller can update an already-running GA session once).
 */
export function markInternalBrowser(): boolean {
  if (typeof window === "undefined" || isInternalBrowser()) return false;
  try {
    window.localStorage.setItem(INTERNAL_TRAFFIC_STORAGE_KEY, "1");
    return true;
  } catch {
    // Storage blocked (private mode): nothing to persist; the caller
    // still tags the current page's events.
    return true;
  }
}
