/**
 * Instant Analysis rollout flag (`NEXT_PUBLIC_INSTANT_IMPORT`).
 *
 *   "off"    — default; the browser importer is hidden everywhere.
 *   "admins" — only accounts whose `/v1/me` says `isAdmin: true`.
 *   "all"    — everyone (the anonymous /try page included).
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` only where the variable is
 * referenced literally, so the default parameter below must stay a
 * literal `process.env.NEXT_PUBLIC_INSTANT_IMPORT` access.
 *
 * Example:
 *   if (getInstantImportMode() === "all") showTryLink();
 */

export type InstantImportMode = "off" | "admins" | "all";

/**
 * Parse the flag; anything unrecognised (including unset) is "off".
 *
 * Example:
 *   getInstantImportMode(" Admins "); // -> "admins"
 *   getInstantImportMode("yes");      // -> "off"
 */
export function getInstantImportMode(
  env: string | undefined = process.env.NEXT_PUBLIC_INSTANT_IMPORT,
): InstantImportMode {
  const value = (env ?? "").trim().toLowerCase();
  if (value === "all" || value === "admins") return value;
  return "off";
}
