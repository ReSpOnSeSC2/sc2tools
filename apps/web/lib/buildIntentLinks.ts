/**
 * Build check-in deep links. Kept free of "use client" so the game page's
 * server route can parse `?newBuild=` without pulling in the client-only
 * check-in module (lib/buildIntent.ts re-exports the builders).
 */

/** Which side of a game a check-in (or a new build) is about. */
export type CheckInSide = "you" | "opponent";

/** Query parameter that opens "Add new build" on a game page. */
export const NEW_BUILD_QUERY_PARAM = "newBuild";

/**
 * The game page with the build editor open for one side. The desktop
 * agent's "Add new build…" link builds the same URL.
 *
 * Example: `newBuildHref("a|b", "opponent")` → "/app/game/a%7Cb?newBuild=opponent".
 */
export function newBuildHref(gameId: string, side: CheckInSide): string {
  return `/app/game/${encodeURIComponent(gameId)}?${NEW_BUILD_QUERY_PARAM}=${side}`;
}

/**
 * `?newBuild=you|opponent` from a route's search params; anything else
 * (missing, empty, unknown) is null. Repeated params use the first value.
 *
 * Example: `newBuildSideFromQuery({ newBuild: ["opponent", "you"] })` → "opponent".
 */
export function newBuildSideFromQuery(
  query: Record<string, string | string[] | undefined>,
): CheckInSide | null {
  const raw = query[NEW_BUILD_QUERY_PARAM];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value === "you" || value === "opponent" ? value : null;
}

/**
 * The same location without `?newBuild=`, keeping every other query
 * parameter (replay time, opponent backlink) and the hash, so a refresh
 * after the editor opened doesn't open it again.
 *
 * Example: `withoutNewBuildParam("/app/game/g1", "?t=90&newBuild=you", "")`
 * → "/app/game/g1?t=90".
 */
export function withoutNewBuildParam(
  pathname: string,
  search: string,
  hash = "",
): string {
  const params = new URLSearchParams(search);
  params.delete(NEW_BUILD_QUERY_PARAM);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
