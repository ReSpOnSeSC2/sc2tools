"use client";

import { useEffect, useRef } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "./types";

/** Match identity for start-only widgets, independent of phase/profile updates. */
export function gameStartTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  if (live?.isTest) {
    return `test:${live.testNonce ?? live.gameKey ?? live.matchup ?? "x"}`;
  }
  if (liveGame) {
    const active = liveGame.phase === "match_loading"
      || liveGame.phase === "match_started"
      || liveGame.phase === "match_in_progress";
    return active ? `game:${liveGame.gameKey || "unkeyed"}` : null;
  }
  if (live && !live.result) return `game:${live.gameKey || "unkeyed"}`;
  return null;
}

/** A partial envelope with no key cannot replace an already-known match. */
export function useGameStartTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  const lastKnownGame = useRef<string | null>(null);
  const key = gameStartTriggerKey(live, liveGame);
  useEffect(() => {
    if (key?.startsWith("game:") && key !== "game:unkeyed") {
      lastKnownGame.current = key;
    }
  }, [key]);
  return key === "game:unkeyed" ? lastKnownGame.current ?? key : key;
}
