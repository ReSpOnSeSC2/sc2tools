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

import { safeReturnPath } from "./safeReturnPath";
export { safeReturnPath } from "./safeReturnPath";
export { useReturnTo } from "./authReturnHooks";

function authHref(page: "/sign-in" | "/sign-up", returnTo?: string | null): string {
  const path = safeReturnPath(returnTo);
  return path ? `${page}?redirect_url=${encodeURIComponent(path)}` : page;
}

/** /sign-in that returns to `returnTo` afterwards. */
export function signInHref(returnTo?: string | null): string {
  return authHref("/sign-in", returnTo);
}

/** /sign-up that carries `returnTo` along. */
export function signUpHref(returnTo?: string | null): string {
  return authHref("/sign-up", returnTo);
}
