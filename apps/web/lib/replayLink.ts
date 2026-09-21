import {
  gameAnalysisHref,
  type OpponentNavigationContext,
} from "./opponentNavigation";

/** Keep malformed or unbounded URL values out of playback clocks. */
export const MAX_REPLAY_LINK_TIME_SEC = 24 * 60 * 60;

export function clampReplayTime(
  seconds: number | null | undefined,
  durationSec?: number | null,
): number | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const duration = durationSec != null && Number.isFinite(durationSec) && durationSec >= 0
    ? durationSec
    : MAX_REPLAY_LINK_TIME_SEC;
  return Math.min(seconds, duration, MAX_REPLAY_LINK_TIME_SEC);
}

/** Game analysis URLs accept decimal game seconds, never wall-clock dates. */
export function replayTimeFromQuery(
  query: Record<string, string | string[] | undefined>,
): number | null {
  const raw = Array.isArray(query.t) ? query.t[0] : query.t;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  return clampReplayTime(Number(value));
}

/** A timestamped game analysis link that preserves opponent-source context. */
export function gameReplayHref(
  gameId: string,
  timeSec?: number | null,
  opponent?: OpponentNavigationContext | null,
): string {
  const base = gameAnalysisHref(gameId, opponent);
  const time = clampReplayTime(timeSec);
  return time == null ? base : `${base}${base.includes("?") ? "&" : "?"}t=${time}`;
}
