/**
 * The browser-session marker behind Settings → "Default tab".
 *
 * AnalyzerFrame sets `sc2_app_session=1` the first time any /app page
 * mounts. The cookie has no Max-Age, so it ends with the browser
 * session. The /app page (a server component) applies the saved
 * default tab only while the cookie is missing, so the preference
 * picks where the dashboard opens, and clicking Today afterwards
 * always shows Today: the page request carries the cookie.
 *
 * Shared by the server page and the client frame, so it holds no
 * client-only imports.
 */

/** Cookie name; present means "this browser session has opened the dashboard". */
export const APP_SESSION_COOKIE = "sc2_app_session";

/**
 * Set the marker. Never throws: with cookies blocked the user can't stay
 * signed in anyway, so the worst case is the default tab applying again.
 */
export function markAppSession(): void {
  try {
    document.cookie = `${APP_SESSION_COOKIE}=1; Path=/; SameSite=Lax`;
  } catch {
    /* cookies unavailable */
  }
}
