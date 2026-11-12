export const OPPONENT_LIST_PATH = "/app/opponents";
const OPPONENT_LIST_ROUTE = /^\/app\/opponents\/?$/u;
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

/** Compare a saved list address with either form of its return URL. */
export function canonicalOpponentListUrl(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !OPPONENT_LIST_ROUTE.test(url.pathname)) return null;
    canonicalizeOpponentFilter(url.searchParams);
    return `${OPPONENT_LIST_PATH}${url.search}`;
  } catch {
    return null;
  }
}
