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

/** The real match key behind a start trigger; null for Test and keyless starts. */
export function gameKeyFromTriggerKey(triggerKey: string | null): string | null {
  if (!triggerKey?.startsWith("game:") || triggerKey === "game:unkeyed") return null;
  return triggerKey.slice("game:".length);
}

// Keep the browser draw in the same early-game window as the desktop draw.
const RANDOMIZER_LIVE_WINDOW_SEC = 30;

export function isCompletedOverlayGame(live: LiveGamePayload | null): boolean {
  return !!live && !live.isTest && (live.postGame === true || !!live.result || typeof live.durationSec === "number");
}

function randomizerMatchTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  const key = gameStartTriggerKey(live, liveGame);
  if (live?.isTest) return key;
  if (liveGame?.synthetic || liveGame?.isReplay || !gameKeyFromTriggerKey(key)) return null;
  if (isCompletedOverlayGame(live) && (!liveGame || live?.gameKey === liveGame.gameKey)) return null;
  return key;
}

function inRandomizerStartWindow(liveGame: LiveGameEnvelope | null): boolean {
  const elapsed = Math.max(0, liveGame?.displayTime ?? 0);
  const receivedAt = liveGame?.receivedAt;
  const snapshotAge = typeof receivedAt === "number" ? Math.max(0, Date.now() - receivedAt) / 1000 : 0;
  return elapsed + snapshotAge < RANDOMIZER_LIVE_WINDOW_SEC;
}

/** A late socket snapshot may identify a match without being a new start. */
export function randomizerStartTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  const key = randomizerMatchTriggerKey(live, liveGame);
  return live?.isTest || inRandomizerStartWindow(liveGame) ? key : null;
}

/** A reveal admitted during loading can finish its normal visibility window. */
export function useRandomizerTriggerKey(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  const admitted = useRef<string | null>(null);
  const key = randomizerMatchTriggerKey(live, liveGame);
  const early = live?.isTest || inRandomizerStartWindow(liveGame);
  useEffect(() => {
    if (early && gameKeyFromTriggerKey(key)) admitted.current = key;
  }, [key, early]);
  return early || admitted.current === key ? key : null;
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
