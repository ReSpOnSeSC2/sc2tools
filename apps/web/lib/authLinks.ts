/**
 * Sign-in / sign-up links that bring the visitor back to the page they
 * were on. Clerk reads `redirect_url` on /sign-in; /sign-up sends new
 * accounts through the /welcome setup wizard first, so there the value
 * is a hint only (see app/sign-up).
 *
 * Only same-site paths are passed through. Anything else (an absolute
 * URL, a protocol-relative "//host") falls back to the bare auth page,
 * so these helpers can never build an open redirect.
 *
 * Example:
 *   signInHref("/builds/proxy-gate"); // -> "/sign-in?redirect_url=%2Fbuilds%2Fproxy-gate"
 *   signUpHref("https://evil.test");  // -> "/sign-up"
 */

/** True for a path on this site ("/x"), never "//host" or a full URL. */
function isSitePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

function authHref(page: "/sign-in" | "/sign-up", returnTo: string): string {
  return isSitePath(returnTo) ? `${page}?redirect_url=${encodeURIComponent(returnTo)}` : page;
}

/** /sign-in that returns to `returnTo` afterwards. */
export function signInHref(returnTo: string): string {
  return authHref("/sign-in", returnTo);
}

/** /sign-up that carries `returnTo` along. */
export function signUpHref(returnTo: string): string {
  return authHref("/sign-up", returnTo);
}
