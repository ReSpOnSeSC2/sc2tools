/**
 * Guides feature flag. Every guide surface (pages, nav links, sitemap
 * entries, internal links) is hidden unless the flag is on, so the
 * feature can ship dark and be switched on per deployment.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so the env var must
 * be read with its literal name (never a computed key) for client
 * bundles to see it. The value itself is parsed by the shared
 * `isGuidesFlagOn` (also used by next.config.mjs for the /meta redirect).
 */
import { isGuidesFlagOn } from "@/lib/guides/guidesFlag.mjs";

/**
 * True when `NEXT_PUBLIC_GUIDES_ENABLED` is "1", "true", "yes", "on" or
 * "all" (trimmed, case-insensitive; the same set as the API's
 * GUIDES_ENABLED).
 *
 * Example: with `NEXT_PUBLIC_GUIDES_ENABLED=On`, `guidesEnabled()` → true;
 * unset, "0" or "admins" → false.
 */
export function guidesEnabled(): boolean {
  return isGuidesFlagOn(process.env.NEXT_PUBLIC_GUIDES_ENABLED);
}
