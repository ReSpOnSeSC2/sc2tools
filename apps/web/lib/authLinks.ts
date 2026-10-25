/**
 * Sign-in / sign-up links that bring the visitor back to the page they
 * were on. Clerk reads `redirect_url` on /sign-in; /sign-up sends new
 * accounts through the /welcome setup wizard first, so there the value
 * is a hint only (see app/sign-up).
 *
 * Only allowlisted public/action paths are passed through. Unsupported
 * private paths and unsafe destinations fall back to the bare auth page.
 *
 * Example:
 *   signInHref("/guides/pvp/blink"); // -> "/sign-in?redirect_url=%2Fguides%2Fpvp%2Fblink"
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
