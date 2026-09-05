"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "./clientApi";
import { sanitizeMapPlayback } from "./mapReplay";

const RECORDING_TIMEOUT_MS = 18 * 60 * 1000;
const ACTIVE_STATUSES = new Set(["queued", "processing", "uploading"]);
const FALLBACK_READ_AT_MS = [60_000, 5 * 60_000, 10 * 60_000, 17 * 60_000];

type RecordingState = {
  epoch: number;
  refreshing: boolean;
  refreshMessage: string;
  requestId: string | null;
  completedRequestId: string | null;
  startedAt: number;
  startedWithEnginePlayback: boolean;
  loadedRequestId: string | null;
  fallbackReads: number;
};

const emptyState = (epoch: number): RecordingState => ({
  epoch, refreshing: false, refreshMessage: "", requestId: null,
  completedRequestId: null, startedAt: 0, startedWithEnginePlayback: true,
  loadedRequestId: null, fallbackReads: 0,
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
    { revalidateOnFocus: false, refreshInterval: 0 },
  );
  const statusReq = useApi<Record<string, unknown>>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/map-playback/status` : null,
    { revalidateOnFocus: false, refreshInterval: gameId && state.refreshing ? 3000 : 0 },
  );
  const playback = useMemo(
    () => gameId && req.data ? sanitizeMapPlayback(req.data) : null,
    [gameId, req.data],
  );
  const canRefresh = !!gameId && typeof req.request === "function";
  const rebuild = gameId ? (statusReq.data?.rebuild ?? (statusReq.data ? undefined : req.data?.rebuild)) as {
    status?: string; message?: string; requestId?: string; updatedAt?: number;
  } | undefined : undefined;
  const jobId = typeof rebuild?.requestId === "string" && rebuild.requestId ? rebuild.requestId : null;
  const jobStatus = rebuild?.status;
  const jobMessage = rebuild?.message;
  const updatedAt = rebuild?.updatedAt;
  const error = gameId ? req.error : undefined;
  const progressError = gameId ? statusReq.error ?? req.error : undefined;
  const completionRead = useRef({ key: "", attempts: 0 });
  const reloadPlayback = req.mutate;
  const playbackRequest = useRef(req.request);
  playbackRequest.current = req.request;
  const readPlayback = useCallback(async (stillCurrent: () => boolean) => {
    const readEpoch = scope.current.epoch;
    const readGeneration = scope.current.request;
    // SWR's no-argument mutate resolves cached data even when revalidation
    // fails. Only a rejecting authenticated GET can prove this download ran.
    const response = await playbackRequest.current<Record<string, unknown>>({ method: "GET" });
    if (!stillCurrent() || scope.current.epoch !== readEpoch || scope.current.request !== readGeneration) return false;
    await reloadPlayback(response, { revalidate: false });
    return stillCurrent() && scope.current.epoch === readEpoch && scope.current.request === readGeneration;
  }, [reloadPlayback]);

  useEffect(() => {
    if (!gameId || !state.refreshing || !state.requestId || jobId !== state.requestId ||
        jobStatus !== "complete" || state.loadedRequestId === state.requestId) return;
    const key = `${epoch}:${state.requestId}`;
    if (completionRead.current.key !== key) completionRead.current = { key, attempts: 0 };
    let cancelled = false;
    let retryTimer: number | undefined;
    const load = async () => {
      const attempt = completionRead.current;
      if (cancelled || scope.current.epoch !== epoch || attempt.key !== key || attempt.attempts >= 3) return;
      attempt.attempts += 1;
      try {
        const fresh = await readPlayback(() => !cancelled && scope.current.epoch === epoch);
        if (fresh) patch({ loadedRequestId: state.requestId });
      } catch {
        if (cancelled || scope.current.epoch !== epoch) return;
        patch({ refreshMessage: "Recording finished. Retrying the playback download…" });
        if (attempt.attempts < 3) retryTimer = window.setTimeout(load, 30_000);
        else patch({ refreshing: false, refreshMessage: "Recording finished, but playback could not be downloaded. Reopen this game to try again." });
      }
    };
    void load();
    return () => { cancelled = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [gameId, epoch, state.refreshing, state.requestId, state.loadedRequestId, jobId, jobStatus, readPlayback, patch]);

  useEffect(() => {
    if (!gameId || !state.refreshing || !state.requestId || jobId === state.requestId ||
        state.fallbackReads >= FALLBACK_READ_AT_MS.length) return;
    // A restarted API may lose its in-memory job. Recheck the heavy record at
    // four bounded milestones, never every status tick.
    const generation = scope.current.request;
    const timer = window.setTimeout(() => {
      patch({ fallbackReads: state.fallbackReads + 1 });
      void readPlayback(() => scope.current.epoch === epoch && scope.current.request === generation).catch(() => undefined);
    }, Math.max(0, state.startedAt + FALLBACK_READ_AT_MS[state.fallbackReads] - Date.now()));
    return () => window.clearTimeout(timer);
  }, [gameId, epoch, state.refreshing, state.requestId, state.startedAt, state.fallbackReads, jobId, readPlayback, patch]);

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
    if (jobStatus === "complete" && sameJob && state.loadedRequestId === state.requestId) {
      if (playback?.fidelity?.positions !== "engine") {
        patch({ refreshing: false, refreshMessage: "Recording finished, but recorded playback is unavailable. Generate playback again." });
        return;
      }
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
    if (progressError && progressError.code !== "playback_not_computed") {
      if ([401, 403].includes(progressError.status) || progressError.code === "game_not_found") {
        patch({ refreshing: false, refreshMessage: progressError.message || "This replay is no longer available. Sign in again and reopen it." });
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
    state.loadedRequestId, jobId, jobStatus, jobMessage, progressError, patch]);

  const refresh = async () => {
    if (!canRefresh || state.refreshing || scope.current.requesting) return;
    const generation = ++scope.current.request;
    scope.current.requesting = true;
    const isCurrent = () => scope.current.epoch === epoch && scope.current.request === generation;
    patch({ refreshing: true, requestId: null, completedRequestId: null,
      loadedRequestId: null, fallbackReads: 0,
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
      await statusReq.mutate().catch(() => undefined);
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
