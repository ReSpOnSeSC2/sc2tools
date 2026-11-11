/**
 * What Google Analytics is told a page is, on every event: page views,
 * custom events and gtag.js's own automatic ones (lib/analytics/gtag
 * keeps gtag's page state on these forms). The referrer follows the
 * same rules.
 *
 * Three rules keep the GA4 page reports readable and free of private
 * values:
 *
 *   1. Some surfaces are never reported at all — operator-only admin
 *      screens, the token-authenticated OBS overlay and Stream Dock (the
 *      token in their URL is a credential), and shared replay archives
 *      (a player's archive activity stays private).
 *   2. Per-record screens collapse to one page per screen type, so
 *      "/app/game/<id>" and "/app/opponents/<id>" report as a single page
 *      each instead of hundreds, and no game ids, opponent ids or player
 *      names reach GA.
 *   3. Only attribution parameters survive in the query string (utm_*,
 *      ad click ids and the PWA launch marker). Everything else — tabs,
 *      filters, opponent ids and names — is dropped, and so is the hash.
 *
 * Example:
 *   analyticsPageLocation("https://sc2tools.com", "/app/game/abc", "?tab=x&utm_source=reddit")
 *   // -> "https://sc2tools.com/app/game/:gameId?utm_source=reddit"
 */

/** Paths that are never sent to Google Analytics. */
const UNTRACKED_PATHS: ReadonlyArray<RegExp> = [
  /^\/admin(?:\/|$)/,
  /^\/overlay(?:\/|$)/,
  /^\/dock(?:\/|$)/,
  /^\/wrapped(?:\/|$)/,
  /^\/(?:p|players)\/[^/]+\/replays(?:\/|$)/,
];

/** Per-record screens, collapsed to their route pattern. */
const DYNAMIC_ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/app\/game\/[^/]+/, "/app/game/:gameId"],
  [/^\/app\/opponents\/[^/]+/, "/app/opponents/:pulseId"],
  [/^\/builds\/[^/]+/, "/builds/:slug"],
  [/^\/community\/opponents\/[^/]+/, "/community/opponents/:pulseId"],
  [/^\/community\/authors\/[^/]+/, "/community/authors/:userId"],
  [/^\/card(?:\/.*)?$/, "/card/:type/:class"],
  // A share link's token is the page's credential.
  [/^\/g\/[^/]+/, "/g/:token"],
];

/** Query parameters GA4 needs for traffic attribution, plus the PWA launch marker. */
const ATTRIBUTION_PARAMS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "source",
]);

/**
 * Whether a path must never be reported to analytics.
 *
 * Example: `isUntrackedPath("/admin/users")` → true; `isUntrackedPath("/guides")` → false.
 */
export function isUntrackedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return UNTRACKED_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * Collapse a per-record path to its route pattern; other paths pass through.
 *
 * Example: `normalizePagePath("/app/opponents/1-S2-1-123")` → "/app/opponents/:pulseId".
 */
export function normalizePagePath(pathname: string): string {
  for (const [pattern, replacement] of DYNAMIC_ROUTES) {
    if (pattern.test(pathname)) return pathname.replace(pattern, replacement);
  }
  return pathname;
}

/**
 * Keep only the attribution parameters of a query string ("" when none are left).
 *
 * Example: `analyticsSearch("?tab=opponents&utm_source=reddit")` → "?utm_source=reddit".
 */
export function analyticsSearch(search: string | null | undefined): string {
  if (!search) return "";
  const kept = new URLSearchParams();
  new URLSearchParams(search).forEach((value, key) => {
    if (ATTRIBUTION_PARAMS.has(key)) kept.append(key, value);
  });
  const query = kept.toString();
  return query ? `?${query}` : "";
}

/**
 * The page_location sent with a page_view: origin + normalized path +
 * attribution-only query, never a hash.
 *
 * Example: `analyticsPageLocation("https://sc2tools.com", "/", "?source=pwa")`
 * → "https://sc2tools.com/?source=pwa".
 */
export function analyticsPageLocation(
  origin: string,
  pathname: string,
  search?: string | null,
): string {
  return `${origin}${normalizePagePath(pathname)}${analyticsSearch(search)}`;
}

/**
 * The page_referrer sent with every event ("" when there is none).
 *
 * The browser's referrer is the previous page's full address whenever
 * that page was on this site: a link opened in a new tab, a reload, any
 * full page load. So it gets the same treatment as a page location, and
 * one from an untracked surface is cut down to the site root. Another
 * site's referrer is attribution data and passes through unchanged.
 *
 * Example:
 *   analyticsReferrer("https://sc2tools.com/app/opponents/1-S2-1-123?tab=games", "https://sc2tools.com")
 *   // -> "https://sc2tools.com/app/opponents/:pulseId"
 */
export function analyticsReferrer(
  referrer: string | null | undefined,
  origin: string,
): string {
  if (!referrer) return "";
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }
  if (url.origin !== origin) return referrer;
  if (isUntrackedPath(url.pathname)) return `${origin}/`;
  return analyticsPageLocation(origin, url.pathname, url.search);
}
