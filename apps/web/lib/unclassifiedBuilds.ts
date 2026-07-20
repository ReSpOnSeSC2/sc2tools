/**
 * Unclassified-build recognition — shared predicate for insight and
 * recommendation surfaces.
 *
 * The replay-engine's build detector emits two flavors of "we couldn't
 * classify this game" (see apps/replay-engine/core/strategy_detector*.py):
 *
 *   - "Unclassified - <Race>" — no signature in the registry matched at
 *     all (the bare race-level sentinel).
 *   - "<X>v<Y> - Macro Transition (Unclassified)" /
 *     "<Race> - Standard Play (Unclassified)" — the game reached the
 *     macro phase but matched no specific pattern (the catch-alls).
 *
 * Aggregation surfaces (Builds tab, Stock Market universe, meta radar
 * tables) may still show the catch-alls because they carry matchup info
 * and their share of games is a real, factual slice of the corpus. But
 * surfaces that PROMOTE a build — "build heating up", "dust it off",
 * recent-form headings, meta movers — must never crown one: an
 * unclassified label is by definition not a build the player can choose
 * to queue with. Those surfaces gate on this predicate.
 */
export function isUnclassifiedBuild(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return /^Unclassified\s*-\s*/i.test(trimmed) || /\(Unclassified\)$/i.test(trimmed);
}
