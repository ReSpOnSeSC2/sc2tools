/**
 * Post-auth redirect allowlist for the /try → sign-up/sign-in → claim flow.
 *
 * The sign-up and sign-in pages read `?redirect_url=` and hand it to Clerk
 * as `forceRedirectUrl`. Anything user-controlled that ends up in a
 * redirect is an open-redirect risk, so exactly ONE destination is
 * allowed: `/try?resume=1` (the /try page picks up the games it stored on
 * this device and saves them to the new account). Every other value —
 * other paths, protocol-relative `//host`, absolute URLs, extra query
 * parameters, fragments, whitespace, or any of those percent-encoded —
 * is rejected, and the caller keeps its default destination.
 *
 * Example:
 *   safeAuthRedirect("/try?resume=1");     // -> "/try?resume=1"
 *   safeAuthRedirect("%2Ftry%3Fresume%3D1"); // -> "/try?resume=1"
 *   safeAuthRedirect("//evil.com");         // -> null
 */

/** The only post-auth destination /try hands to Clerk. */
export const TRY_RESUME_PATH = "/try?resume=1";

/** `redirect_url` value for the sign-up/sign-in links on /try (encoded once). */
const TRY_RESUME_PARAM = encodeURIComponent(TRY_RESUME_PATH);

/** Sign-up link that brings a new account back to /try to save its games. */
export const TRY_SIGN_UP_HREF = `/sign-up?redirect_url=${TRY_RESUME_PARAM}`;

/** Sign-in link that brings an existing account back to /try to save its games. */
export const TRY_SIGN_IN_HREF = `/sign-in?redirect_url=${TRY_RESUME_PARAM}`;

/** Decode one level of percent-encoding; null when the value is malformed. */
function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed escapes (e.g. "%E0%A4%A") are never a valid destination.
    return null;
  }
}

/**
 * The allowed post-auth destination for a raw `redirect_url` value, or
 * null when it is anything but `/try?resume=1` (as-is or percent-encoded
 * once more). Always returns the canonical constant, never the input.
 *
 * Example:
 *   safeAuthRedirect(searchParams.get("redirect_url")) ?? "/welcome";
 *   safeAuthRedirect("/try?resume=1&x=//evil"); // -> null
 *   safeAuthRedirect("https://evil.com");       // -> null
 */
export function safeAuthRedirect(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (value === TRY_RESUME_PATH) return TRY_RESUME_PATH;
  return decodeOnce(value) === TRY_RESUME_PATH ? TRY_RESUME_PATH : null;
}
