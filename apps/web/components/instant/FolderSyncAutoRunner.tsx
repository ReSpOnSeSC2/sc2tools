"use client";

/**
 * FolderSyncAutoRunner — background Folder Sync while the dashboard is open.
 *
 * Mounted by the /app frame when browser import is enabled. Whenever the
 * tab gains focus or becomes visible (debounced by 2 s, plus once on
 * mount) it checks, in order: is a folder remembered on this device? Has
 * the last scan aged past 10 minutes? Then the folder's read permission:
 *
 *   granted → sync in the background with a small status chip, and a
 *             toast when new games were uploaded;
 *   prompt  → a small banner with a one-click "Resume sync" (the browser
 *             only re-grants access inside a click);
 *   denied  → nothing.
 *
 * At most one sync runs at a time; the engine (Pyodide) only starts when
 * there are new or changed replays; unmounting cancels a running pass.
 * After the daily browser-upload cap is reached, auto-sync pauses until
 * the cap resets (midnight UTC) instead of re-parsing replays every 10
 * minutes only to be refused.
 *
 * Example:
 *   {browserImportEnabled ? <FolderSyncAutoRunner /> : null}
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderSync, Loader2 } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import { API_BASE, apiCall } from "@/lib/clientApi";
import { trackInstantError, trackInstantFolderSyncResume } from "@/lib/instant/analytics";
import { createEngineClient } from "@/lib/instant/engineClient";
import { EngineError } from "@/lib/instant/engineErrors";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import {
  queryReadPermission,
  requestReadPermission,
  shouldAutoScan,
  type DirectoryHandleLike,
  type ReadPermission,
} from "@/lib/instant/folderSync";
import {
  fetchProfileToons,
  runFolderSyncExclusive,
  type FolderSyncProgress,
  type FolderSyncSummary,
} from "@/lib/instant/folderSyncRunner";
import { getLastFolderScanAt, loadFolderHandle } from "@/lib/instant/localStore";
import type { TokenGetter } from "@/lib/instant/httpRetry";

/** Focus / visibility bursts within this window trigger one check. */
export const AUTO_SYNC_DEBOUNCE_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the server's daily browser-upload cap resets (next midnight UTC).
 * Until then a background pass would only re-parse a chunk of replays and
 * be refused again, so auto-sync pauses for the rest of the visit.
 *
 * Example:
 *   nextUtcMidnight(Date.parse("2026-09-28T12:00:00Z")); // -> Date.parse("2026-09-29T00:00:00Z")
 */
export function nextUtcMidnight(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

/** Everything the runner touches outside React (injectable for tests). */
export interface AutoRunnerDeps {
  loadFolderHandle(): Promise<DirectoryHandleLike | null>;
  getLastFolderScanAt(): Promise<number | null>;
  queryReadPermission(handle: DirectoryHandleLike): Promise<ReadPermission>;
  requestReadPermission(handle: DirectoryHandleLike): Promise<ReadPermission>;
  runSync(
    handle: DirectoryHandleLike,
    signal: AbortSignal,
    onProgress: (progress: FolderSyncProgress) => void,
  ): Promise<FolderSyncSummary | null>;
  now(): number;
}

export interface FolderSyncAutoRunnerProps {
  /** Test seams; production uses IndexedDB, the File System Access API and the real runner. */
  deps?: Partial<AutoRunnerDeps>;
  className?: string;
}

type Status = "idle" | "prompt" | "running";

function defaultDeps(getToken: TokenGetter): AutoRunnerDeps {
  return {
    loadFolderHandle,
    getLastFolderScanAt,
    queryReadPermission,
    requestReadPermission,
    now: Date.now,
    runSync(handle, signal, onProgress) {
      return runFolderSyncExclusive({
        source: { handle }, engineFactory: () => createEngineClient(), getToken, apiBase: API_BASE,
        engineVersion: INSTANT_ENGINE_VERSION, profileToons: () => fetchProfileToons(getToken, apiCall),
        now: Date.now, signal, onProgress,
      });
    },
  };
}

/** The remembered folder when a background scan is due, else null. */
async function dueFolder(deps: AutoRunnerDeps): Promise<DirectoryHandleLike | null> {
  try {
    const handle = await deps.loadFolderHandle();
    if (!handle) return null;
    return shouldAutoScan(await deps.getLastFolderScanAt(), deps.now()) ? handle : null;
  } catch {
    return null; // storage blocked (private window): nothing remembered to sync
  }
}

type ToastApi = NonNullable<ReturnType<typeof useToastOptional>>["toast"];

/** Toast new uploads and a reached daily cap; silence otherwise. */
function notifySummary(toast: ToastApi | undefined, summary: FolderSyncSummary | null): void {
  if (!toast || !summary) return;
  if (summary.uploaded > 0) {
    const noun = summary.uploaded === 1 ? "game" : "games";
    toast.success(`${summary.uploaded} new ${noun} synced from your replay folder`);
  }
  if (summary.stoppedReason === "daily_cap") toast.warning("Daily browser upload limit reached");
}

/**
 * The sync pass with toast feedback; `alive` guards against late updates.
 * `pausedUntilRef` holds off auto-sync after the daily cap was reached.
 */
function useBackgroundSync(depsRef: { readonly current: AutoRunnerDeps }) {
  const toast = useToastOptional()?.toast;
  // A ref keeps `run` (and so the focus listeners) stable across renders.
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  });
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<FolderSyncProgress | null>(null);
  const runningRef = useRef(false);
  const pausedUntilRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);
  const run = useCallback(
    async (handle: DirectoryHandleLike): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("running");
      setProgress(null);
      try {
        const summary = await depsRef.current.runSync(handle, controller.signal, (next) => {
          if (aliveRef.current) setProgress(next);
        });
        if (summary?.stoppedReason === "daily_cap") pausedUntilRef.current = nextUtcMidnight(depsRef.current.now());
        if (aliveRef.current) notifySummary(toastRef.current, summary);
      } catch (error) {
        if (error instanceof EngineError) trackInstantError({ kind: error.kind });
      } finally {
        runningRef.current = false;
        if (aliveRef.current) setStatus("idle");
      }
    },
    [depsRef],
  );
  return { status, setStatus, progress, run, runningRef, aliveRef, pausedUntilRef };
}

/**
 * Focus / visibility driven checks, debounced (see module comment).
 * `pendingRef` holds the folder waiting for a "Resume sync" click;
 * `snoozedRef` hides that banner until the next page load ("Not now").
 */
function useAutoChecks(depsRef: { readonly current: AutoRunnerDeps }, sync: ReturnType<typeof useBackgroundSync>) {
  const pendingRef = useRef<DirectoryHandleLike | null>(null);
  const snoozedRef = useRef(false);
  const { run, setStatus, runningRef, aliveRef, pausedUntilRef } = sync;
  const check = useCallback(async (): Promise<void> => {
    const deps = depsRef.current;
    if (runningRef.current || deps.now() < pausedUntilRef.current) return;
    const handle = await dueFolder(deps);
    if (!handle || !aliveRef.current) return;
    const permission = await deps.queryReadPermission(handle);
    if (!aliveRef.current) return;
    if (permission === "granted") await run(handle);
    else if (permission === "prompt" && !snoozedRef.current) {
      pendingRef.current = handle;
      setStatus("prompt");
    }
  }, [aliveRef, depsRef, pausedUntilRef, run, runningRef, setStatus]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void check();
      }, AUTO_SYNC_DEBOUNCE_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") schedule();
    };
    schedule();
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [check]);
  return { pendingRef, snoozedRef };
}

function chipCount(progress: FolderSyncProgress | null): string {
  if (!progress || progress.stage === "walking" || progress.total <= 0) return "…";
  return ` · ${Math.min(progress.done, progress.total)} of ${progress.total}`;
}

/** The live region announces the sync once; the per-file count is visual only. */
function StatusChip({ progress }: { progress: FolderSyncProgress | null }) {
  return (
    <p className="inline-flex min-h-[32px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-3 text-caption text-text-muted shadow-hard">
      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>
        <span role="status" aria-live="polite">Syncing new replays from your folder</span>
        <span aria-hidden className="tabular-nums">{chipCount(progress)}</span>
      </span>
    </p>
  );
}

function ResumeBanner({ onResume, onDismiss }: { onResume: () => void; onDismiss: () => void }) {
  return (
    <section
      aria-label="Folder Sync paused"
      className="flex flex-col gap-3 rounded-xl border-2 border-line bg-bg-surface px-4 py-3 shadow-hard sm:flex-row sm:items-center"
    >
      <FolderSync className="hidden h-5 w-5 flex-shrink-0 text-accent-cyan sm:block" aria-hidden />
      <p className="min-w-0 flex-1 text-caption text-text-muted">
        <span className="block font-semibold text-text">Folder Sync is paused</span>
        Your browser needs your OK to read your StarCraft II folder again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onResume}>Resume sync</Button>
        <Button variant="ghost" onClick={onDismiss}>Not now</Button>
      </div>
    </section>
  );
}

/**
 * Background Folder Sync for the dashboard (see module comment).
 *
 * Example:
 *   <FolderSyncAutoRunner />
 */
export function FolderSyncAutoRunner({ deps, className = "" }: FolderSyncAutoRunnerProps) {
  const { getToken } = useAuth();
  const merged = useMemo<AutoRunnerDeps>(() => ({ ...defaultDeps(getToken), ...deps }), [deps, getToken]);
  const depsRef = useRef(merged);
  useEffect(() => {
    depsRef.current = merged;
  });
  const sync = useBackgroundSync(depsRef);
  const { pendingRef, snoozedRef } = useAutoChecks(depsRef, sync);
  const { status, setStatus, progress, run } = sync;
  const resume = (): void => {
    const handle = pendingRef.current;
    if (!handle) return;
    // The permission prompt must open inside this click.
    void depsRef.current.requestReadPermission(handle).then(async (permission) => {
      if (permission === "prompt") return;
      pendingRef.current = null;
      setStatus("idle");
      if (permission !== "granted") return;
      trackInstantFolderSyncResume();
      await run(handle);
    });
  };
  const snooze = (): void => {
    snoozedRef.current = true;
    setStatus("idle");
  };
  if (status === "idle") return null;
  return (
    <div className={className}>
      {status === "running" ? <StatusChip progress={progress} /> : null}
      {status === "prompt" ? <ResumeBanner onResume={resume} onDismiss={snooze} /> : null}
    </div>
  );
}
