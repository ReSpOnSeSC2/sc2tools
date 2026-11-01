// The public guide results page (ADR 0069, 2026-11-01 amendment): /search?q=,
// 1-80 code points with no control character or unpaired surrogate. Pure, for
// the server page, the lazy palette and its activation policy.
import { normalizeCommandQuery } from "./commandSearch";

export const PUBLIC_SEARCH_PATH = "/search";
export const PUBLIC_SEARCH_QUERY_MAX = 80;

export type PublicSearchQuery = Readonly<
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "too_long"; prefill: string }
  | { kind: "ok"; query: string }
>;

function unpairedSurrogate(value: string): boolean {
  for (const point of value) {
    const unit = point.charCodeAt(0);
    if (point.length === 1 && unit >= 0xd800 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * Example: parsePublicSearchQuery("  12 pool ") → {kind: "ok", query: "12 pool"}. A repeated
 * q (an array) or a missing one is empty; only outer whitespace is trimmed.
 */
export function parsePublicSearchQuery(raw: unknown): PublicSearchQuery {
  if (typeof raw !== "string") return { kind: "empty" };
  if (/\p{Cc}/u.test(raw) || unpairedSurrogate(raw)) return { kind: "invalid" };
  const points = Array.from(raw.trim());
  // A query that folds to nothing (only combining marks, say) would match every guide.
  if (!points.length || !normalizeCommandQuery(points.join(""))) return { kind: "empty" };
  return points.length > PUBLIC_SEARCH_QUERY_MAX
    ? { kind: "too_long", prefill: points.slice(0, PUBLIC_SEARCH_QUERY_MAX).join("") }
    : { kind: "ok", query: points.join("") };
}

/** The page for a valid query, else null. Example: publicSearchHref("12 pool") → "/search?q=12%20pool". */
export function publicSearchHref(raw: string): string | null {
  const parsed = parsePublicSearchQuery(raw);
  return parsed.kind === "ok" ? `${PUBLIC_SEARCH_PATH}?q=${encodeURIComponent(parsed.query)}` : null;
}

/** Re-derives a palette destination exactly: the fixed path, one q, no hash. */
export function isPublicSearchHref(href: unknown): href is string {
  if (typeof href !== "string" || !href.startsWith(`${PUBLIC_SEARCH_PATH}?q=`)) return false;
  let url: URL;
  try { url = new URL(href, "http://search.invalid"); } catch { return false; }
  if (url.pathname !== PUBLIC_SEARCH_PATH || url.hash || [...url.searchParams.keys()].join(",") !== "q") return false;
  const query = url.searchParams.get("q");
  return query !== null && publicSearchHref(query) === href;
}
