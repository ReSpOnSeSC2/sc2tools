import type { Metadata } from "next";

/**
 * Search Console ownership token for the root metadata
 * (`<meta name="google-site-verification">`), from
 * NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION. Unset or blank → no tag at all.
 * Read at call time so tests can stub it; the root layout calls it once.
 *
 * Example: with the env set to "abc123" → `{ google: "abc123" }`.
 */
export function siteVerification(): Metadata["verification"] | undefined {
  const google = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim();
  return google ? { google } : undefined;
}
