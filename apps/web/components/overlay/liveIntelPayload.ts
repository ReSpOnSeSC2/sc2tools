import type { LiveGameEnvelope, LiveGamePayload } from "./types";
import type { WidgetId } from "./widgetLifecycle";

/** These cards can use the same historical context as the scouting report. */
export const LIVE_INTEL_WIDGETS: ReadonlyArray<WidgetId> = [
  "streak", "cheese", "rematch", "rival", "meta", "topbuilds", "fav-opening", "best-answer",
];

export function isLiveIntelWidget(widget: WidgetId): boolean {
  return LIVE_INTEL_WIDGETS.includes(widget);
}

/** Replay results keep their priority; active games use only their own history. */
export function liveIntelPayload(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): LiveGamePayload | null {
  if (live?.isTest) return live;
  if (!liveGame || liveGame.phase === "match_ended") return live;
  if (liveGame.isReplay
    || (liveGame.phase !== "match_started" && liveGame.phase !== "match_in_progress")) return null;
  if (live?.result && live.gameKey && live.gameKey === liveGame.gameKey) return live;
  const history = liveGame.streamerHistory;
  const opponent = liveGame.opponent?.name?.trim().toLowerCase();
  if (!history || !opponent || history.oppName?.trim().toLowerCase() !== opponent) return null;
  return { ...history, gameKey: liveGame.gameKey };
}

/** Wait for useful content before consuming a card's one window per match. */
export function hasLiveIntel(widget: WidgetId, payload: LiveGamePayload | null): boolean {
  if (!payload) return false;
  switch (widget) {
    case "streak": return !!payload.streak && payload.streak.count >= 3;
    case "cheese": return typeof payload.cheeseProbability === "number" && payload.cheeseProbability >= 0.4;
    case "rematch": return !!payload.rematch?.isRematch;
    case "rival": return !!payload.rival;
    case "meta": return !!payload.meta?.topBuilds?.length;
    case "topbuilds": return !!payload.topBuilds?.length;
    case "fav-opening": return !!payload.favOpening;
    case "best-answer": return !!payload.bestAnswer;
    default: return false;
  }
}
