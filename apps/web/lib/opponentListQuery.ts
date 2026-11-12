export const OPPONENT_LIST_PATH = "/app/opponents";
export const OPPONENT_FILTER_KEY = "opponentFilter";
export const LEGACY_OPPONENT_FILTER_KEY = "q";

/** Migrate a list URL when writing it, while keeping old bookmarks readable. */
export function canonicalizeOpponentFilter(params: URLSearchParams) {
  if (!params.has(LEGACY_OPPONENT_FILTER_KEY)) return;
  if (!params.has(OPPONENT_FILTER_KEY)) {
    for (const legacy of params.getAll(LEGACY_OPPONENT_FILTER_KEY)) {
      params.append(OPPONENT_FILTER_KEY, legacy);
    }
  }
  params.delete(LEGACY_OPPONENT_FILTER_KEY);
}
