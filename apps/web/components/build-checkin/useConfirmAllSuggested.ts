"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useOwnerRequestScope } from "@/lib/clientApi";
import {
  buildIntentErrorCode,
  buildIntentErrorMessage,
  confirmGameIntent,
  type GameIntentState,
} from "@/lib/buildIntent";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";
import { checkInPendingKey, claimCheckInPending } from "./checkInPending";
import { checkInErrorStatus, confirmedText } from "./useCheckInActions";

/** One queued game whose suggestion "Confirm all suggested" confirms. */
export interface ConfirmAllTarget {
  gameId: string;
  key: string;
  name: string;
}

export type ConfirmAllResult =
  | { gameId: string; ok: true; state: GameIntentState; text: string }
  | { gameId: string; ok: false; text: string };

export interface ConfirmAllProgress {
  phase: "idle" | "running" | "paused" | "finished";
  /** Games in the current run. */
  total: number;
  confirmed: number;
  failed: number;
  /** The game being confirmed right now. */
  currentGameId: string | null;
  /** Why the run paused (signed out, rate limited). */
  pausedReason: string | null;
  /** The original, still-unconfirmed suggestions, in their admitted order. */
  remaining: readonly ConfirmAllTarget[];
}

const IDLE: ConfirmAllProgress = {
  phase: "idle", total: 0, confirmed: 0, failed: 0, currentGameId: null, pausedReason: null, remaining: [],
};

/** Responses that stop the run: nothing after them can succeed right now. */
const PAUSE_REASONS: Record<number, string> = {
  401: "your sign-in expired. Sign in again, then retry.",
  429: "too many check-in changes at once. Wait a moment, then retry.",
};

type Attempt = ConfirmAllResult | { paused: string } | null;

const isAborted = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";

/**
 * "Confirm all suggested": confirms each target's suggestion one at a
 * time, in list order, through the same write as a single Confirm. Each
 * game holds the shared check-in lock while it saves, so its own Confirm
 * shows the spinner. A 401 or 429 pauses the run (the rest can be
 * retried); any other failure is reported for that game and the run moves
 * on. `stop()` (the queue closed) lets the request in flight finish and
 * starts no other. Lives in the always-mounted queue shell, so closing the
 * dialog never aborts the write in flight.
 */
export function useConfirmAllSuggested(onResult: (result: ConfirmAllResult) => void) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const { bump } = useBuildCheckInRevision(false);
  const [progress, setProgress] = useState<ConfirmAllProgress>(IDLE);
  const runRef = useRef(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const attempt = useCallback(
    async (requestOwner: string, target: ConfirmAllTarget): Promise<Attempt> => {
      const lock = checkInPendingKey(requestOwner, target.gameId);
      const release = lock ? claimCheckInPending(lock, "confirm") : null;
      if (!release) return { gameId: target.gameId, ok: false, text: "This game is already being saved." };
      try {
        const state = await runOwned(requestOwner, async (scopedToken, signal, assertCurrent) => {
          const token = async () => {
            const value = await scopedToken();
            if (!value) throw { status: 401, code: "unauthenticated", message: "Sign in again before changing this build." };
            return value;
          };
          const next = await confirmGameIntent(token, target.gameId, target.key, undefined, { signal });
          assertCurrent();
          return next;
        }, 20_000);
        return { gameId: target.gameId, ok: true, state, text: confirmedText(state, target.name) };
      } catch (error) {
        if (isAborted(error)) return null;
        const status = checkInErrorStatus(error);
        if (status !== undefined && PAUSE_REASONS[status]) return { paused: PAUSE_REASONS[status] };
        const text = buildIntentErrorCode(error) === "request_timeout"
          ? "Saving this check-in took too long. Refresh before trying again."
          : buildIntentErrorMessage(error);
        return { gameId: target.gameId, ok: false, text };
      } finally {
        release();
      }
    },
    [runOwned],
  );

  const start = useCallback(
    async (targets: readonly ConfirmAllTarget[]) => {
      if (!owner || targets.length === 0) return;
      const run = ++runRef.current;
      let confirmed = 0;
      let failed = 0;
      let pausedReason: string | null = null;
      let remaining = targets;
      const report = (patch: Partial<ConfirmAllProgress>) => {
        if (runRef.current === run) setProgress((current) => ({ ...current, ...patch }));
      };
      setProgress({ ...IDLE, phase: "running", total: targets.length, remaining });
      for (const target of targets) {
        report({ currentGameId: target.gameId });
        const outcome = await attempt(owner, target);
        // Closed (or restarted) meanwhile: the write in flight has finished;
        // nothing else starts and nothing is reported to a list that is gone.
        if (runRef.current !== run || outcome === null) break;
        if ("paused" in outcome) {
          pausedReason = outcome.paused;
          break;
        }
        if (outcome.ok) {
          confirmed += 1;
          remaining = remaining.filter((pending) => pending.gameId !== target.gameId);
        } else failed += 1;
        onResultRef.current(outcome);
        report({ confirmed, failed, remaining });
      }
      bump();
      report({
        phase: pausedReason ? "paused" : "finished",
        currentGameId: null,
        confirmed,
        failed,
        pausedReason,
      });
    },
    [attempt, bump, owner],
  );

  /** Stop after the request in flight and forget the run. */
  const stop = useCallback(() => {
    runRef.current += 1;
    setProgress(IDLE);
  }, []);

  useLayoutEffect(() => { stop(); }, [owner, stop]);

  return { progress, start, stop };
}

export type ConfirmAllController = ReturnType<typeof useConfirmAllSuggested>;
