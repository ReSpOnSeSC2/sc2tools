/**
 * The one parser for NEXT_PUBLIC_GUIDES_ENABLED. Shared by
 * lib/guides/flags.ts (pages, nav, sitemap, internal links) and
 * next.config.mjs (the /meta redirect), so the redirect target and the
 * pages can never disagree about whether guides are on.
 *
 * Plain ESM JavaScript because Node loads next.config.mjs directly, with
 * no TypeScript step. The JSDoc types flow into the TypeScript callers.
 *
 * The accepted spellings match the "on" values of
 * NEXT_PUBLIC_REVIEWS_ENABLED (lib/reviews.ts): trimmed and
 * case-insensitive.
 */

/** Values (after trim + lowercase) that switch guides on. */
const GUIDES_FLAG_ON_VALUES = new Set(["1", "true", "on"]);

/**
 * True when a raw flag value switches guides on.
 *
 * Example: `isGuidesFlagOn(" On ")` → true; `isGuidesFlagOn("yes")` → false;
 * `isGuidesFlagOn(undefined)` → false.
 *
 * @param {string | null | undefined} raw
 * @returns {boolean}
 */
export function isGuidesFlagOn(raw) {
  return typeof raw === "string" && GUIDES_FLAG_ON_VALUES.has(raw.trim().toLowerCase());
}
