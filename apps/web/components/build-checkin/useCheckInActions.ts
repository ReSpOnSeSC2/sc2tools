"use client";

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useToastOptional } from "@/components/ui/Toast";
import {
  buildIntentErrorCode,
  buildIntentErrorMessage,
  confirmGameIntent,
  saveGameIntentNotes,
  skipGameIntent,
  type GameIntentState,
} from "@/lib/buildIntent";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";

export type CheckInBusy = "confirm" | "skip" | "notes" | null;

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
 * Confirm / "No set build" / notes writes for one game, shared by the game
 * page card and the queue. Every success refreshes all check-in surfaces
 * through the shared revision and confirms with a toast; failures get
 * check-in specific copy both as a toast and as an inline status line.
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
    ): Promise<CheckInOutcome> => {
      if (inFlight.current) return { state: null, errorCode: null };
      inFlight.current = true;
      setBusy(kind);
      setMessage(null);
      try {
        const state = await call();
        const text = describe(state);
        setMessage({ text, error: false, kind });
        toastContext?.toast.success(text);
        onUpdatedRef.current?.(state);
        bump();
        return { state, errorCode: null };
      } catch (error) {
        const text = buildIntentErrorMessage(error);
        setMessage({ text, error: true, kind });
        toastContext?.toast.error(
          kind === "notes" ? "Couldn't save your notes" : "Couldn't save your check-in",
          { description: text },
        );
        return { state: null, errorCode: buildIntentErrorCode(error) };
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [bump, toastContext],
  );

  const confirm = useCallback(
    (buildKey: string, buildName: string, notes?: string) =>
      run(
        "confirm",
        () => confirmGameIntent(getToken, gameId, buildKey, notes),
        (state) =>
          state.applied
            ? `Counted toward ${state.build?.name ?? buildName}`
            : `Check-in saved: ${state.build?.name ?? buildName}`,
      ),
    [run, getToken, gameId],
  );

  const skip = useCallback(
    (notes?: string) =>
      run(
        "skip",
        () => skipGameIntent(getToken, gameId, notes),
        () => "Marked as no set build",
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

  return { busy, message, clearMessage, confirm, skip, saveNotes };
}
