"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import {
  ARCADE_STATE_DEFAULT,
  type ArcadeState,
  type ModeRecord,
} from "../types";
import { levelForXp, todayKey } from "../ArcadeEngine";

const PREF_PATH = "/v1/me/preferences/arcade";
const FLUSH_DEBOUNCE_MS = 600;

/**
 * useArcadeState — server-persisted ArcadeState with optimistic local
 * updates and debounced flush. The blob is tiny (≤ ~3 kB) so we always
 * write the whole thing — see /v1/me/preferences/:type semantics.
 *
 * Read path: hydrate once on mount; if the server returns {} we stay
 * on ARCADE_STATE_DEFAULT until the user does something that mutates.
 *
 * Write path: every mutator clones, mutates, schedules a flush. If the
 * tab unmounts mid-debounce, the pending flush still fires via the
 * cleanup ref so we don't drop a streak bump on tab close.
 */
export function useArcadeState() {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const [state, setState] = useState<ArcadeState>(ARCADE_STATE_DEFAULT);
  const [hydrated, setHydrated] = useState(false);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingState = useRef<ArcadeState | null>(null);

  const flushNow = useCallback(async (next: ArcadeState) => {
    if (!isSignedIn) return;
    try {
      await apiCall(getToken, PREF_PATH, {
        method: "PUT",
        body: JSON.stringify(next),
      });
    } catch {
      // Persistence failures are non-fatal — local state still
      // reflects the user's progress for this session.
    }
  }, [getToken, isSignedIn]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const remote = await apiCall<Partial<ArcadeState>>(getToken, PREF_PATH);
        if (cancelled) return;
        if (remote && typeof remote === "object" && Object.keys(remote).length > 0) {
          setState({ ...ARCADE_STATE_DEFAULT, ...remote } as ArcadeState);
        }
      } catch {
        // Treat any read error as "no state yet" — user keeps default.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    return () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        if (pendingState.current) void flushNow(pendingState.current);
      }
    };
  }, [flushNow]);

  const update = useCallback(
    (mut: (prev: ArcadeState) => ArcadeState) => {
      setState((prev) => {
        const next = mut(prev);
        // Recompute level off raw xp on every write so it never drifts.
        next.xp = { total: next.xp.total, level: levelForXp(next.xp.total) };
        pendingState.current = next;
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          void flushNow(next);
        }, FLUSH_DEBOUNCE_MS);
        return next;
      });
    },
    [flushNow],
  );

  /* ──────── ergonomic mutators ──────── */

  const recordPlay = useCallback(
    (input: {
      modeId: string;
      tz: string;
      xp: number;
      raw: number;
      correct: boolean;
      bestRun?: number;
    }) => {
      update((prev) => {
        const day = todayKey(new Date(), input.tz);
        const prevRecord: ModeRecord = prev.records[input.modeId] ?? {
          bestRaw: 0,
          bestXp: 0,
          attempts: 0,
          correct: 0,
          lastPlayedAt: new Date().toISOString(),
        };
        const nextRecord: ModeRecord = {
          ...prevRecord,
          attempts: prevRecord.attempts + 1,
          correct: prevRecord.correct + (input.correct ? 1 : 0),
          bestRaw: Math.max(prevRecord.bestRaw, input.raw),
          bestXp: Math.max(prevRecord.bestXp, input.xp),
          lastPlayedAt: new Date().toISOString(),
          bestRun:
            input.bestRun !== undefined
              ? Math.max(prevRecord.bestRun ?? 0, input.bestRun)
              : prevRecord.bestRun,
        };
        // Streak: bump if today differs from lastPlayedDay; reset to 1
        // when more than 1 calendar day has passed.
        const last = prev.streak.lastPlayedDay;
        let nextStreak = prev.streak.count;
        if (last === day) {
          // already played today — no streak change
        } else if (!last) {
          nextStreak = 1;
        } else {
          const lastT = new Date(`${last}T00:00:00Z`).getTime();
          const dayT = new Date(`${day}T00:00:00Z`).getTime();
          const diffDays = Math.round((dayT - lastT) / 86_400_000);
          nextStreak = diffDays === 1 ? prev.streak.count + 1 : 1;
        }
        return {
          ...prev,
          xp: { ...prev.xp, total: prev.xp.total + Math.max(0, input.xp) },
          minerals: prev.minerals + (input.correct ? 5 : 1),
          streak: { count: nextStreak, lastPlayedDay: day },
          records: { ...prev.records, [input.modeId]: nextRecord },
        };
      });
    },
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
      update((prev) => {
        if (prev.badges[id]) return prev;
        return {
          ...prev,
          badges: { ...prev.badges, [id]: { earnedAt: new Date().toISOString() } },
          minerals: prev.minerals + 25,
        };
      });
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
    spendMinerals,
  };
}
