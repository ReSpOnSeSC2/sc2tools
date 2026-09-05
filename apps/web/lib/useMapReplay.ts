"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "./clientApi";
import { sanitizeMapPlayback } from "./mapReplay";

const RECORDING_TIMEOUT_MS = 18 * 60 * 1000;
const ACTIVE_STATUSES = new Set(["queued", "processing", "uploading"]);

type RecordingState = {
  epoch: number;
  refreshing: boolean;
  refreshMessage: string;
  requestId: string | null;
  completedRequestId: string | null;
  startedAt: number;
  startedWithEnginePlayback: boolean;
};

const emptyState = (epoch: number): RecordingState => ({
  epoch, refreshing: false, refreshMessage: "", requestId: null,
  completedRequestId: null, startedAt: 0, startedWithEnginePlayback: true,
});

/** One recording controller shared by the replay panel and its host's actions. */
export function useMapReplay(gameId: string | null) {
  // Scope the returned state during render, before effects run. Navigating A →
  // B → A must not expose A's previous completion to the new host for a frame.
  const scope = useRef({ gameId, epoch: 0, request: 0, requesting: false });
  if (scope.current.gameId !== gameId) {
    scope.current = { gameId, epoch: scope.current.epoch + 1, request: 0, requesting: false };
  }
  const epoch = scope.current.epoch;
  const [stored, setStored] = useState(() => emptyState(epoch));
  const state = stored.epoch === epoch ? stored : emptyState(epoch);
  const patch = useCallback((update: Partial<RecordingState>) => {
    setStored(previous => scope.current.epoch === epoch
      ? { ...(previous.epoch === epoch ? previous : emptyState(epoch)), ...update }
      : previous);
  }, [epoch]);
  useEffect(() => () => { scope.current.request += 1; }, [gameId]);

  const req = useApi<Record<string, unknown>>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/map-playback` : null,
    { revalidateOnFocus: false, refreshInterval: gameId && state.refreshing ? 3000 : 0 },
  );
  const playback = useMemo(
    () => gameId && req.data ? sanitizeMapPlayback(req.data) : null,
    [gameId, req.data],
  );
  const canRefresh = !!gameId && typeof req.request === "function";
  const rebuild = gameId ? req.data?.rebuild as {
    status?: string; message?: string; requestId?: string; updatedAt?: number;
  } | undefined : undefined;
  const jobId = typeof rebuild?.requestId === "string" && rebuild.requestId ? rebuild.requestId : null;
  const jobStatus = rebuild?.status;
  const jobMessage = rebuild?.message;
  const updatedAt = rebuild?.updatedAt;
  const error = gameId ? req.error : undefined;

  useEffect(() => {
    if (!canRefresh || !jobId || !ACTIVE_STATUSES.has(jobStatus || "") ||
        state.refreshing || state.requestId !== null || state.startedAt > 0) return;
    // Closing a modal does not cancel the desktop job. Resume its progress
    // from GET without dispatching another capture or requiring a second click.
    const now = Date.now();
    patch({ refreshing: true, requestId: jobId, completedRequestId: null,
      startedWithEnginePlayback: playback?.fidelity?.positions === "engine",
      startedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? Math.min(now, Math.max(now - RECORDING_TIMEOUT_MS, updatedAt)) : now,
      refreshMessage: jobStatus === "uploading"
        ? "Recording finished. Uploading the map playback…"
        : "Recording playback with StarCraft II. You can keep reviewing this game while it runs…",
    });
  }, [canRefresh, jobId, jobStatus, updatedAt, state.refreshing, state.requestId, state.startedAt, playback, patch]);

  useEffect(() => {
    if (!gameId || !state.refreshing) return;
    const sameJob = state.requestId !== null && jobId === state.requestId;
    if (jobStatus === "failed" && sameJob) {
      patch({ refreshing: false, refreshMessage: jobMessage || "Recording failed. Keep the desktop agent open and try again." });
      return;
    }
    // A first complete engine payload after our ACK proves the tracker data
    // was replaced, even if an API restart lost its in-memory job. Existing
    // engine recordings and reduced-detail output still need this job's status.
    if (state.requestId && !state.startedWithEnginePlayback &&
        playback?.fidelity?.positions === "engine" && playback.fidelity.complete === true &&
        playback.fidelity.attacks === "observed") {
      patch({ refreshing: false, completedRequestId: state.requestId,
        refreshMessage: "Recorded playback is ready." });
      return;
    }
    if (jobStatus === "complete" && sameJob && playback?.fidelity?.positions === "engine") {
      const attacksObserved = playback.fidelity.attacks === "observed";
      patch({ refreshing: false,
        completedRequestId: attacksObserved ? state.requestId : null,
        refreshMessage: !attacksObserved
          ? "Movement is ready, but this recording has no attack data. Update the desktop agent and generate playback again."
          : playback.fidelity.complete === false
            ? "Recorded playback is ready with reduced detail for this large replay."
            : "Recorded playback is ready.",
      });
      return;
    }
    if (error && error.code !== "playback_not_computed") {
      if ([401, 403].includes(error.status) || error.code === "game_not_found") {
        patch({ refreshing: false, refreshMessage: error.message || "This replay is no longer available. Sign in again and reopen it." });
        return;
      }
      patch({ refreshMessage: "Could not check recording progress. Retrying while your desktop agent continues working…" });
    } else if (sameJob && jobStatus === "uploading") {
      patch({ refreshMessage: "Recording finished. Uploading the map playback…" });
    }
    const timer = window.setTimeout(() => {
      patch({ refreshing: false, refreshMessage: "Recording is still processing. Keep the desktop agent open and check back shortly." });
    }, Math.max(0, RECORDING_TIMEOUT_MS - (Date.now() - state.startedAt)));
    return () => window.clearTimeout(timer);
  }, [gameId, state.refreshing, state.requestId, state.startedAt, state.startedWithEnginePlayback, playback,
    jobId, jobStatus, jobMessage, error, patch]);

  const refresh = async () => {
    if (!canRefresh || state.refreshing || scope.current.requesting) return;
    const generation = ++scope.current.request;
    scope.current.requesting = true;
    const isCurrent = () => scope.current.epoch === epoch && scope.current.request === generation;
    patch({ refreshing: true, requestId: null, completedRequestId: null,
      startedWithEnginePlayback: playback?.fidelity?.positions === "engine",
      refreshMessage: "Preparing recorded playback with your desktop agent…", startedAt: Date.now() });
    try {
      const accepted = await req.request<{ requestId?: string; rebuild?: { requestId?: string } }>({
        method: "POST", body: JSON.stringify({ fidelity: "engine" }),
      });
      if (!isCurrent()) return;
      const requestId = accepted?.rebuild?.requestId ?? accepted?.requestId;
      if (typeof requestId !== "string" || !requestId) {
        throw new Error("The rebuild was not acknowledged. Update the desktop agent and try again.");
      }
      patch({ requestId, refreshMessage: "Recording playback with StarCraft II. You can keep reviewing this game while it runs…" });
      // An intermittent first GET must not cancel an accepted desktop job.
      await req.mutate().catch(() => undefined);
    } catch (failure) {
      if (!isCurrent()) return;
      patch({ refreshing: false, refreshMessage: (failure as { message?: string })?.message ||
        "Could not refresh this replay. Check that your desktop agent is connected." });
    } finally {
      if (isCurrent()) scope.current.requesting = false;
    }
  };

  return {
    playback,
    isLoading: !!gameId && req.isLoading,
    error,
    canRefresh,
    refreshing: !!gameId && state.refreshing,
    refreshMessage: gameId ? state.refreshMessage : "",
    refresh,
    completedRequestId: gameId ? state.completedRequestId : null,
  };
}

export type MapReplayController = ReturnType<typeof useMapReplay>;
