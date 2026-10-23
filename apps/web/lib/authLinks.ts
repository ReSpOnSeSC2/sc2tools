/**
 * Sign-in and sign-up links that carry where to come back to, as
 * `?redirect_url=` (the same parameter /reviews already uses). The value
 * is encoded once; the auth pages decide whether to honour it.
 *
 * Example:
 *   signInHref("/community/builds/abc")
 *   // -> "/sign-in?redirect_url=%2Fcommunity%2Fbuilds%2Fabc"
 */

/** Only same-site paths are ever sent back; anything else drops the parameter. */
function isSitePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

function withReturnTo(base: string, returnTo: string): string {
  return isSitePath(returnTo)
    ? `${base}?redirect_url=${encodeURIComponent(returnTo)}`
    : base;
}

/** /sign-in that returns to `returnTo` (a site path such as "/community"). */
export function signInHref(returnTo: string): string {
  return withReturnTo("/sign-in", returnTo);
}

/** /sign-up that returns to `returnTo` (a site path such as "/community"). */
export function signUpHref(returnTo: string): string {
  return withReturnTo("/sign-up", returnTo);
}
