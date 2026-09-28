/**
 * The one parser for NEXT_PUBLIC_GUIDES_ENABLED. Shared by
 * lib/guides/flags.ts (pages, nav, sitemap, internal links) and
 * next.config.mjs (the /meta redirect), so the redirect target and the
 * pages can never disagree about whether guides are on.
 *
 * Plain ESM JavaScript because Node loads next.config.mjs directly, with
 * no TypeScript step. The JSDoc types flow into the TypeScript callers.
 *
 * The accepted spellings are the same set as the API's GUIDES_ENABLED
 * parser (apps/api/src/config/loader.js), trimmed and case-insensitive,
 * so one value set on both apps always agrees. "all" counts as on because
 * the other rollout flags (NEXT_PUBLIC_REVIEWS_ENABLED,
 * NEXT_PUBLIC_INSTANT_IMPORT) use it for "everyone"; guides have no
 * admins-only stage, so "admins" and anything else is off.
 */

/** Values (after trim + lowercase) that switch guides on. */
const GUIDES_FLAG_ON_VALUES = new Set(["1", "true", "yes", "on", "all"]);

/**
 * True when a raw flag value switches guides on.
 *
 * Example: `isGuidesFlagOn(" On ")` → true; `isGuidesFlagOn("all")` → true;
 * `isGuidesFlagOn("admins")` → false;
 * `isGuidesFlagOn(undefined)` → false.
 *
 * @param {string | null | undefined} raw
 * @returns {boolean}
 */
export function isGuidesFlagOn(raw) {
  return typeof raw === "string" && GUIDES_FLAG_ON_VALUES.has(raw.trim().toLowerCase());
}
