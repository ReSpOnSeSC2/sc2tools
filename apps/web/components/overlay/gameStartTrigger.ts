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

/** Scouting waits for gameplay and an identified opponent, including on resync. */
export function scoutingStartTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  if (live?.isTest) return gameStartTriggerKey(live, liveGame);
  if (liveGame) {
    if (liveGame.isReplay
      || (liveGame.phase !== "match_started" && liveGame.phase !== "match_in_progress")
      || !liveGame.opponent?.name?.trim()) return null;
  } else if (!live?.oppName?.trim()) {
    return null;
  }
  return gameStartTriggerKey(live, liveGame);
}

/** Keep a legacy keyless start's identity when its real key arrives later. */
export function useScoutingStartTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  const previous = useRef<{ identity: string; gameKey: string | null; opponent: string } | null>(null);
  const aliases = useRef(new Map<string, string>());
  const legacySequence = useRef(0);
  const key = scoutingStartTriggerKey(live, liveGame);
  const opponent = (liveGame?.opponent?.name ?? live?.oppName ?? "").trim().toLowerCase();
  const realKey = key?.startsWith("game:") && key !== "game:unkeyed" ? key : null;
  let identity = key;
  let sequence = legacySequence.current;
  if (key?.startsWith("game:")) {
    const last = previous.current;
    if (realKey && aliases.current.has(realKey)) {
      identity = aliases.current.get(realKey)!;
    } else if (last && last.opponent === opponent && (!realKey || !last.gameKey)) {
      identity = last.identity;
    } else if (!realKey) {
      sequence += 1;
      identity = `game:legacy:${sequence}`;
    }
  }
  useEffect(() => {
    if (identity?.startsWith("game:")) {
      const last = previous.current;
      previous.current = {
        identity,
        gameKey: realKey ?? (last?.identity === identity ? last.gameKey : null),
        opponent,
      };
      legacySequence.current = sequence;
      if (realKey) aliases.current.set(realKey, identity);
    } else if (liveGame?.phase === "match_ended") {
      // A null/menu snapshot can be a transient gap before the real key
      // arrives. Only a confirmed end retires the legacy match identity.
      previous.current = null;
    }
  }, [identity, realKey, opponent, sequence, liveGame]);
  return identity;
}
