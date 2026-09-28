/**
 * Canonical (lowercase) guide URLs. Every guide URL segment is lowercase
 * ("/guides/pvz/stargate-into-glaives"), so a hand-typed or legacy
 * mixed-case URL ("/guides/PvZ") is permanently redirected to its
 * lowercase form instead of 404ing. middleware.ts sends that redirect
 * before the ISR cache (one hop, one Location header); the pages keep
 * the same check as a fallback for paths the middleware matcher skips.
 *
 * Deliberately free of the build catalog (lib/guides/slugs.ts imports
 * it) so the middleware bundle stays small: the matchup test is a
 * pattern that equals slugs.ts GUIDE_MATCHUPS, and a test keeps the two
 * and GUIDES_BASE_PATH in step.
 */

/** slugs.ts GUIDES_BASE_PATH. */
const GUIDES_PREFIX = "/guides";
/** One lowercase guide URL segment (matchup, build, strategy or map slug). */
const LOWER_SEGMENT_RE = /^[a-z0-9-]{1,80}$/;
const MAPS_SEGMENT = "maps";
/** A lowercase matchup slug: "pvz", "tvt", … (the nine GUIDE_MATCHUPS). */
const MATCHUP_SEGMENT_RE = /^[ptz]v[ptz]$/;

/**
 * The lowercase form of a guide path that carries uppercase letters, or
 * null when the path is already lowercase or its lowercase form could
 * never be a guide URL (then the page's normal 404 applies).
 *
 * Example: `lowercaseGuidePath("/guides/PvZ/Stargate-into-Glaives")` →
 * "/guides/pvz/stargate-into-glaives"; `lowercaseGuidePath("/guides/pvz")` → null;
 * `lowercaseGuidePath("/guides/PvX")` → null.
 */
export function lowercaseGuidePath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower === path || !path.startsWith(`${GUIDES_PREFIX}/`)) return null;
  const [first, ...rest] = lower.slice(GUIDES_PREFIX.length + 1).split("/");
  if (![first, ...rest].every((segment) => LOWER_SEGMENT_RE.test(segment))) return null;
  const isKnownFirst = first === MAPS_SEGMENT || MATCHUP_SEGMENT_RE.test(first);
  return isKnownFirst ? lower : null;
}
