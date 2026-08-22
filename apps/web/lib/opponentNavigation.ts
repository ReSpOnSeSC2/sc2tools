export const OPPONENT_QUERY_PARAM = "opponent";
export const OPPONENT_NAME_QUERY_PARAM = "opponentName";

export type OpponentNavigationContext = {
  pulseId: string;
  displayName?: string | null;
};

type QueryRecord = Record<string, string | string[] | undefined>;

/**
 * Read the opponent source carried by a game-analysis URL. The profile id is
 * the durable part of the context; the display name is only presentation copy.
 */
export function opponentContextFromQuery(
  query: QueryRecord,
): OpponentNavigationContext | null {
  const pulseId = clean(first(query[OPPONENT_QUERY_PARAM]), 256);
  if (!pulseId) return null;

  return {
    pulseId,
    displayName: clean(first(query[OPPONENT_NAME_QUERY_PARAM]), 120),
  };
}

/** Link to game analysis, optionally retaining the opponent-profile source. */
export function gameAnalysisHref(
  gameId: string,
  opponent?: OpponentNavigationContext | null,
): string {
  const base = `/app/game/${encodeURIComponent(gameId)}`;
  const pulseId = clean(opponent?.pulseId, 256);
  if (!pulseId) return base;

  const query = new URLSearchParams({ [OPPONENT_QUERY_PARAM]: pulseId });
  const displayName = clean(opponent?.displayName, 120);
  if (displayName) query.set(OPPONENT_NAME_QUERY_PARAM, displayName);
  return `${base}?${query.toString()}`;
}

/**
 * Stable URL that re-opens one opponent dossier after navigation.
 * Dossiers are real routes (/app/opponents/[pulseId]); the old
 * `/app?tab=opponents&opponent=…` shape is still accepted by /app,
 * which redirects it here, so pre-redesign bookmarks keep working.
 */
export function opponentProfileHref(
  opponent?: OpponentNavigationContext | null,
): string {
  const pulseId = clean(opponent?.pulseId, 256);
  if (!pulseId) return "/app";

  return `/app/opponents/${encodeURIComponent(pulseId)}`;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clean(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
