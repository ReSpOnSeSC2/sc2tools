/**
 * Guides feature flag. Every guide surface (pages, nav links, sitemap
 * entries, internal links) is hidden unless the flag is on, so the
 * feature can ship dark and be switched on per deployment.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so the env var must
 * be read with its literal name (never a computed key) for client
 * bundles to see it.
 */

const ENABLED_VALUES: ReadonlySet<string> = new Set(["1", "true"]);

/**
 * True when `NEXT_PUBLIC_GUIDES_ENABLED` is exactly "1" or "true".
 *
 * Example: with `NEXT_PUBLIC_GUIDES_ENABLED=1`, `guidesEnabled()` → true;
 * unset, "0" or "yes" → false.
 */
export function guidesEnabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_GUIDES_ENABLED;
  return typeof raw === "string" && ENABLED_VALUES.has(raw);
}
