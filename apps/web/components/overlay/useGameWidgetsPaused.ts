"use client";
import { useCallback, useRef, useState } from "react";
const GAME_WIDGETS = new Set(["opponent", "match-result", "post-game", "mmr-delta", "streak", "cheese", "rematch", "rival", "rank", "meta", "topbuilds", "fav-opening", "best-answer", "scouting", "session", "randomizer", "ghost-build", "session-recap", "chat-oracle", "stats-ticker", "series"]);
export const isGameWidget = (widget: string) => GAME_WIDGETS.has(widget);

/** Uses the existing Studio socket replay; never opens another connection/read.
 * Wait for that authoritative snapshot on a cold source to avoid a paused-game flash. */
export function useGameWidgetsPaused(token: string) {
  const currentToken = useRef(token); currentToken.current = token;
  const [snapshot, setSnapshot] = useState<{ token: string; paused: boolean } | null>(null);
  const receivePause = useCallback((raw: unknown) => {
    if (currentToken.current !== token || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const value = (raw as Record<string, unknown>).gameWidgetsPaused;
    // Missing is the legacy API default. Malformed explicit values fail closed.
    if (value !== undefined && typeof value !== "boolean") return;
    setSnapshot({ token, paused: value === true });
  }, [token]);
  const resetPause = useCallback(() => { if (currentToken.current === token) setSnapshot(null); }, [token]);
  return { gameWidgetsPaused: snapshot?.token !== token || snapshot.paused, receivePause, resetPause };
}
