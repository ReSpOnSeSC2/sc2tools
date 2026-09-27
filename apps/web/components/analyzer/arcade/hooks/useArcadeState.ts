"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@clerk/nextjs";
import type { ArcadeState, ModeRecord } from "../types";
import { todayKey } from "../ArcadeEngine";
import {
  applyPlayBadgeProgress,
  applyStockMarketSettlement,
  awardBadge,
} from "../badges";
import { arcadeStoreFor, type ArcadeMutator } from "./arcadeStore";

/** One finished attempt, as recorded by recordPlay. */
export interface PlayInput {
  modeId: string;
  tz: string;
  xp: number;
  raw: number;
  correct: boolean;
  bestRun?: number;
}

/**
 * useArcadeState — the Arcade's server-persisted ArcadeState.
 *
 * Every caller shares one store per account (see arcadeStore.ts), so a
 * write from one surface can no longer be overwritten by another
 * surface's stale copy. The blob is tiny (≤ ~3 kB) and is always written
 * whole — see /v1/me/preferences/:type semantics.
 *
 * Read path: hydrate once per store; if the server returns {} we stay on
 * ARCADE_STATE_DEFAULT until the user does something that mutates.
 * Write path: every mutator applies to the shared state and schedules a
 * debounced flush of the merged state; when the last Arcade surface
 * unmounts, a pending flush goes out immediately.
 */
export function useArcadeState() {
  const { getToken, isSignedIn, isLoaded, userId } = useAuth();
  const store = arcadeStoreFor(
    isLoaded ? (isSignedIn ? (userId ?? "current") : "signed-out") : null,
    Boolean(isLoaded && isSignedIn),
  );
  // Set before the first subscribe so the initial hydrate has a token.
  store.setTokenGetter(getToken);
  useEffect(() => {
    store.setTokenGetter(getToken);
  }, [store, getToken]);
  const { state, hydrated } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const update = useCallback((mut: ArcadeMutator) => store.update(mut), [store]);

  /* ──────── ergonomic mutators ──────── */

  const recordPlay = useCallback(
    (input: PlayInput) => update((prev) => applyPlay(prev, input, new Date())),
    [update],
  );

  const unlockCard = useCallback(
    (slug: string) => {
      update((prev) => {
        if (prev.unlockedCards[slug]) return prev;
        return {
          ...prev,
          unlockedCards: {
            ...prev.unlockedCards,
            [slug]: { unlockedAt: new Date().toISOString() },
          },
        };
      });
    },
    [update],
  );

  const earnBadge = useCallback(
    (id: string) => {
      update((prev) => awardBadge(prev, id, new Date()));
    },
    [update],
  );

  /**
   * Record a finished Stock Market week's portfolio P&L (idempotent per
   * week) and award Tycoon when the green-week run is long enough.
   */
  const settleStockMarket = useCallback(
    (weekKey: string, pnlPct: number) => {
      update((prev) => applyStockMarketSettlement(prev, { weekKey, pnlPct }, new Date()));
    },
    [update],
  );

  const spendMinerals = useCallback(
    (cost: number): boolean => {
      let success = false;
      update((prev) => {
        if (prev.minerals < cost) return prev;
        success = true;
        return { ...prev, minerals: prev.minerals - cost };
      });
      return success;
    },
    [update],
  );

  return {
    state,
    hydrated,
    update,
    recordPlay,
    unlockCard,
    earnBadge,
    settleStockMarket,
    spendMinerals,
  };
}

/**
 * Fold one finished attempt into the state: per-mode record, XP,
 * minerals, the daily play streak, and run-based badge progress
 * (Streak Hunter, Veto Sleuth, Closer, Detective) in the same write.
 */
export function applyPlay(prev: ArcadeState, input: PlayInput, now: Date): ArcadeState {
  const day = todayKey(now, input.tz);
  const prevRecord: ModeRecord = prev.records[input.modeId] ?? {
    bestRaw: 0,
    bestXp: 0,
    attempts: 0,
    correct: 0,
    lastPlayedAt: now.toISOString(),
  };
  const nextRecord: ModeRecord = {
    ...prevRecord,
    attempts: prevRecord.attempts + 1,
    correct: prevRecord.correct + (input.correct ? 1 : 0),
    bestRaw: Math.max(prevRecord.bestRaw, input.raw),
    bestXp: Math.max(prevRecord.bestXp, input.xp),
    lastPlayedAt: now.toISOString(),
    bestRun:
      input.bestRun !== undefined
        ? Math.max(prevRecord.bestRun ?? 0, input.bestRun)
        : prevRecord.bestRun,
  };
  const played: ArcadeState = {
    ...prev,
    xp: { ...prev.xp, total: prev.xp.total + Math.max(0, input.xp) },
    minerals: prev.minerals + (input.correct ? 5 : 1),
    streak: { count: nextStreakCount(prev.streak, day), lastPlayedDay: day },
    records: { ...prev.records, [input.modeId]: nextRecord },
  };
  return applyPlayBadgeProgress(
    played,
    { modeId: input.modeId, day, correct: input.correct },
    now,
  );
}

/**
 * Daily play streak: unchanged when already played today, +1 on the
 * next calendar day, otherwise it restarts at 1.
 */
function nextStreakCount(streak: ArcadeState["streak"], day: string): number {
  const last = streak.lastPlayedDay;
  if (last === day) return streak.count;
  if (!last) return 1;
  const lastT = new Date(`${last}T00:00:00Z`).getTime();
  const dayT = new Date(`${day}T00:00:00Z`).getTime();
  return Math.round((dayT - lastT) / 86_400_000) === 1 ? streak.count + 1 : 1;
}
