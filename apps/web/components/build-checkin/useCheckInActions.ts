"use client";

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useToastOptional } from "@/components/ui/Toast";
import {
  buildIntentErrorCode,
  buildIntentErrorMessage,
  confirmGameIntent,
  saveGameIntentNotes,
  setOpponentBuild,
  skipGameIntent,
  type GameIntentState,
  type GameIntentWriteOptions,
} from "@/lib/buildIntent";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";

export type CheckInBusy = "confirm" | "skip" | "notes" | "opponent" | null;

export interface CheckInOutcome {
  state: GameIntentState | null;
  /** API error code on failure (e.g. "not_eligible", "unknown_build"). */
  errorCode: string | null;
}

export interface CheckInMessage {
  text: string;
  error: boolean;
  kind: Exclude<CheckInBusy, null>;
}

/**
 * Wording for one write when the default doesn't fit, e.g. a build that
 * was just created in the editor ("Saved to your library and checked in").
 */
export interface CheckInCopy {
  /** Success toast and status line. */
  success?: string;
  /** Failure toast title, toast description and status line. */
  failure?: (
    errorCode: string | null,
    defaultText: string,
  ) => { title: string; description: string; inline: string };
}

/**
 * Confirm / "No set build" / opponent correction / notes writes for one
 * game, shared by the game page card and the queue. Every success
 * refreshes all check-in surfaces through the shared revision and
 * confirms with a toast; failures get check-in specific copy both as a
 * toast and as an inline status line.
 */
export function useCheckInActions(
  gameId: string,
  onUpdated?: (state: GameIntentState) => void,
) {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const { bump } = useBuildCheckInRevision(false);
  const [busy, setBusy] = useState<CheckInBusy>(null);
  const [message, setMessage] = useState<CheckInMessage | null>(null);
  const inFlight = useRef(false);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  const run = useCallback(
    async (
      kind: Exclude<CheckInBusy, null>,
      call: () => Promise<GameIntentState>,
      describe: (state: GameIntentState) => string,
      copy?: CheckInCopy,
    ): Promise<CheckInOutcome> => {
      if (inFlight.current) return { state: null, errorCode: null };
      inFlight.current = true;
      setBusy(kind);
      setMessage(null);
      try {
        const state = await call();
        const text = copy?.success ?? describe(state);
        setMessage({ text, error: false, kind });
        toastContext?.toast.success(text);
        onUpdatedRef.current?.(state);
        bump();
        return { state, errorCode: null };
      } catch (error) {
        const errorCode = buildIntentErrorCode(error);
        const text = buildIntentErrorMessage(error);
        const failure = copy?.failure?.(errorCode, text) ?? {
          title:
            kind === "notes"
              ? "Couldn't save your notes"
              : kind === "opponent"
                ? "Couldn't save the opponent's build"
                : "Couldn't save your check-in",
          description: text,
          inline: text,
        };
        setMessage({ text: failure.inline, error: true, kind });
        toastContext?.toast.error(failure.title, { description: failure.description });
        return { state: null, errorCode };
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [bump, toastContext],
  );

  const confirm = useCallback(
    (
      buildKey: string,
      buildName: string,
      notes?: string,
      opts?: GameIntentWriteOptions & { copy?: CheckInCopy },
    ) =>
      run(
        "confirm",
        () => confirmGameIntent(getToken, gameId, buildKey, notes, opts),
        (state) =>
          state.applied
            ? `Counted toward ${state.build?.name ?? buildName}`
            : `Check-in saved: ${state.build?.name ?? buildName}`,
        opts?.copy,
      ),
    [run, getToken, gameId],
  );

  const skip = useCallback(
    (notes?: string, opts?: GameIntentWriteOptions) =>
      run(
        "skip",
        () => skipGameIntent(getToken, gameId, notes, opts),
        () => "Marked as no set build",
      ),
    [run, getToken, gameId],
  );

  /** Correct the opponent's build; `null` goes back to the replay's label. */
  const setOpponent = useCallback(
    (
      buildKey: string | null,
      buildName: string | null,
      notes?: string,
      opts?: { copy?: CheckInCopy },
    ) =>
      run(
        "opponent",
        () => setOpponentBuild(getToken, gameId, buildKey, notes),
        (state) => {
          if (buildKey === null) return "Opponent's build reset to the replay's label";
          const name = state.opponent?.build?.name ?? buildName ?? "the build you picked";
          return state.opponent?.applied
            ? `Opponent's build set to ${name}`
            : `Opponent's build: ${name}`;
        },
        opts?.copy,
      ),
    [run, getToken, gameId],
  );

  const saveNotes = useCallback(
    (notes: string) =>
      run(
        "notes",
        () => saveGameIntentNotes(getToken, gameId, notes),
        () => "Notes saved",
      ),
    [run, getToken, gameId],
  );

  const clearMessage = useCallback(() => setMessage(null), []);

  return { busy, message, clearMessage, confirm, skip, setOpponent, saveNotes };
}

export type CheckInActions = ReturnType<typeof useCheckInActions>;
