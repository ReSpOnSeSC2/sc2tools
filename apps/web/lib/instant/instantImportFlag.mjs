/**
 * The one parser for NEXT_PUBLIC_INSTANT_IMPORT. Shared by
 * lib/instant/flag.ts (pages, nav, sitemap) and next.config.mjs (the
 * /arcade share-link redirect), so the redirect can never point at /try
 * while the page itself is hidden.
 *
 * Plain ESM JavaScript because Node loads next.config.mjs directly, with
 * no TypeScript step. The JSDoc types flow into the TypeScript callers.
 */

/**
 * Parse the flag; anything unrecognised (including unset) is "off".
 *
 * Example: `parseInstantImportMode(" Admins ")` → "admins";
 * `parseInstantImportMode("yes")` → "off";
 * `parseInstantImportMode(undefined)` → "off".
 *
 * @param {string | null | undefined} raw
 * @returns {"off" | "admins" | "all"}
 */
export function parseInstantImportMode(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "all" || value === "admins") return value;
  return "off";
}
