"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useToastOptional } from "@/components/ui/Toast";
import { useOwnerRequestScope } from "@/lib/clientApi";
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
import { checkInPendingKey, claimCheckInPending, useCheckInPending, type CheckInBusy } from "./checkInPending";

export type { CheckInBusy } from "./checkInPending";

type ActionScope = {
  owner: string | null; gameId: string; active: boolean;
  controller: AbortController | null; release: (() => void) | null;
};
type ScopedWrite = (getToken: () => Promise<string | null>, signal: AbortSignal) => Promise<GameIntentState>;
const RETIRED_OUTCOME: CheckInOutcome = { state: null, errorCode: null };
const retired = () => new DOMException("This build check-in is no longer current.", "AbortError");
const isAborted = (error: unknown) => error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";

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
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const scopeRef = useRef<ActionScope>({ owner, gameId, active: !!owner, controller: null, release: null });
  let scope = scopeRef.current;
  if (scope.owner !== owner || scope.gameId !== gameId) {
    scope.active = false;
    scope = { owner, gameId, active: !!owner, controller: null, release: null };
    scopeRef.current = scope;
  }
  useLayoutEffect(() => {
    scope.active = !!owner;
    return () => {
      scope.active = false;
      scope.controller?.abort();
      scope.release?.();
      scope.controller = null;
      scope.release = null;
    };
  }, [scope, owner]);
  const pendingKey = checkInPendingKey(owner, gameId);
  const busy = useCheckInPending(pendingKey);
  const toastContext = useToastOptional();
  const { bump } = useBuildCheckInRevision(false);
  const [feedback, setFeedback] = useState<{ scope: ActionScope; message: CheckInMessage | null }>({ scope, message: null });
  const message = feedback.scope === scope ? feedback.message : null;
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  const run = useCallback(
    async (
      kind: Exclude<CheckInBusy, null>,
      call: ScopedWrite,
      describe: (state: GameIntentState) => string,
      copy?: CheckInCopy,
      callerSignal?: AbortSignal,
    ): Promise<CheckInOutcome> => {
      if (!owner || !pendingKey || !scope.active || scopeRef.current !== scope || callerSignal?.aborted) return RETIRED_OUTCOME;
      const release = claimCheckInPending(pendingKey, kind);
      if (!release) return RETIRED_OUTCOME;
      const controller = new AbortController();
      scope.controller = controller;
      scope.release = release;
      const abort = () => controller.abort();
      callerSignal?.addEventListener("abort", abort, { once: true });
      const current = () => scope.active && scopeRef.current === scope && scope.controller === controller && !controller.signal.aborted;
      setFeedback({ scope, message: null });
      try {
        const state = await runOwned(owner, async (scopedToken, signal, assertCurrent) => {
          const token = async () => {
            if (!current()) throw retired();
            const value = await scopedToken();
            if (!current()) throw retired();
            if (!value) throw { status: 401, code: "unauthenticated", message: "Sign in again before changing this build." };
            return value;
          };
          const next = await call(token, signal);
          assertCurrent();
          if (!current()) throw retired();
          return next;
        }, 20_000, controller.signal);
        if (!current()) return RETIRED_OUTCOME;
        const text = copy?.success ?? describe(state);
        setFeedback({ scope, message: { text, error: false, kind } });
        // Publish the committed write before a queue's onUpdated callback can
        // remove its card. Every external callback may synchronously retire
        // this editor; no later UI delivery may then use a replacement scope.
        bump();
        if (!current()) return RETIRED_OUTCOME;
        toastContext?.toast.success(text);
        if (!current()) return RETIRED_OUTCOME;
        onUpdatedRef.current?.(state);
        return current() ? { state, errorCode: null } : RETIRED_OUTCOME;
      } catch (error) {
        if (!current() || isAborted(error)) return RETIRED_OUTCOME;
        const errorCode = buildIntentErrorCode(error);
        const text = errorCode === "request_timeout"
          ? "Saving your check-in took too long. Refresh the game before trying again."
          : buildIntentErrorMessage(error);
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
        if (!current()) return RETIRED_OUTCOME;
        setFeedback({ scope, message: { text: failure.inline, error: true, kind } });
        toastContext?.toast.error(failure.title, { description: failure.description });
        return current() ? { state: null, errorCode } : RETIRED_OUTCOME;
      } finally {
        callerSignal?.removeEventListener("abort", abort);
        release();
        if (scope.controller === controller) {
          scope.controller = null;
          scope.release = null;
        }
      }
    },
    [bump, toastContext, owner, pendingKey, runOwned, scope],
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
        (token, signal) => confirmGameIntent(token, gameId, buildKey, notes, { ...opts, signal }),
        (state) =>
          state.applied
            ? `Counted toward ${state.build?.name ?? buildName}`
            : `Check-in saved: ${state.build?.name ?? buildName}`,
        opts?.copy,
        opts?.signal,
      ),
    [run, gameId],
  );

  const skip = useCallback(
    (notes?: string, opts?: GameIntentWriteOptions) =>
      run(
        "skip",
        (token, signal) => skipGameIntent(token, gameId, notes, { ...opts, signal }),
        () => "Marked as no set build",
        undefined,
        opts?.signal,
      ),
    [run, gameId],
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
        (token, signal) => setOpponentBuild(token, gameId, buildKey, notes, { signal }),
        (state) => {
          if (buildKey === null) return "Opponent's build reset to the replay's label";
          const name = state.opponent?.build?.name ?? buildName ?? "the build you picked";
          return state.opponent?.applied
            ? `Opponent's build set to ${name}`
            : `Opponent's build: ${name}`;
        },
        opts?.copy,
      ),
    [run, gameId],
  );

  const saveNotes = useCallback(
    (notes: string) =>
      run(
        "notes",
        (token, signal) => saveGameIntentNotes(token, gameId, notes, { signal }),
        () => "Notes saved",
      ),
    [run, gameId],
  );

  const clearMessage = useCallback(() => {
    if (scope.active && scopeRef.current === scope) setFeedback({ scope, message: null });
  }, [scope]);

  return { busy, message, clearMessage, confirm, skip, setOpponent, saveNotes };
}

export type CheckInActions = ReturnType<typeof useCheckInActions>;
