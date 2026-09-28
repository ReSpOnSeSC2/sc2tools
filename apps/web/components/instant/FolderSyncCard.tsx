"use client";

/**
 * FolderSyncCard — keep the account in sync with the visitor's StarCraft II
 * replay folder, straight from the browser.
 *
 *   Chrome / Edge (File System Access API): "Choose your StarCraft II
 *   folder" once; the read-only handle is remembered on this device, new
 *   replays are uploaded whenever an SC2 Tools tab is open (see
 *   FolderSyncAutoRunner), and after a browser restart one click on
 *   "Resume sync" re-grants read access. "Stop syncing" forgets the folder
 *   and its ledger.
 *   Firefox / Safari: no persistent folder access, so the card explains
 *   that and offers a one-off folder import (`<input webkitdirectory>`)
 *   through the same runner — the ledger still skips replays already done.
 *
 * `useFolderSync()` holds the state and actions so the import panel's
 * "Sync a replay folder" button can start the same flow (the folder
 * picker must be opened synchronously inside that click).
 *
 * Example:
 *   const folderSync = useFolderSync();
 *   <BrowserImportPanel folderSync={folderSync} />
 *   <FolderSyncCard controller={folderSync} />
 */
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { FolderSync, Play, RotateCcw, Square } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { Badge, Button, ConfirmDialog } from "@/components/ui";
import { API_BASE, apiCall } from "@/lib/clientApi";
import { fmtAgo } from "@/lib/format";
import { trackInstantError, trackInstantFolderSyncResume } from "@/lib/instant/analytics";
import { createEngineClient } from "@/lib/instant/engineClient";
import { EngineError } from "@/lib/instant/engineErrors";
import { errorCopy } from "@/lib/instant/errorCopy";
import {
  filesFromDirectoryInput,
  pickReplaysFolder,
  queryReadPermission,
  requestReadPermission,
  supportsDirectoryPicker,
  type DirectoryHandleLike,
  type ReadPermission,
} from "@/lib/instant/folderSync";
import {
  fetchProfileToons,
  runFolderSyncExclusive,
  syncedReplayCount,
  type FolderSyncProgress,
  type FolderSyncSource,
  type FolderSyncSummary,
} from "@/lib/instant/folderSyncRunner";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import type { TokenGetter } from "@/lib/instant/httpRetry";
import type { UploadCounts } from "@/lib/instant/importRunner";
import { clearFolderHandle, clearLedger, getLastFolderScanAt, loadFolderHandle, saveFolderHandle } from "@/lib/instant/localStore";
import { ImportSummary } from "./ImportSummary";
import { OsPathHints } from "./OsPathHints";

interface FolderSyncState {
  /** null until mounted: browser support is only known client-side. */
  mode: "picker" | "input" | null;
  loaded: boolean;
  handle: DirectoryHandleLike | null;
  permission: ReadPermission | null;
  lastScanAt: number | null;
  syncedCount: number | null;
  running: boolean;
  progress: FolderSyncProgress | null;
  lastRun: FolderSyncSummary | null;
  error: string | null;
  /** False when IndexedDB is blocked (private window): nothing is remembered. */
  storageAvailable: boolean;
}

export interface FolderSyncController extends Omit<FolderSyncState, "handle"> {
  folderName: string | null;
  /** Opens the folder picker; call directly from a click handler. */
  pickFolder(): void;
  /** Re-grants read access (click handler) and syncs. */
  resume(): void;
  syncNow(): void;
  /** One-off import of an `<input webkitdirectory>` selection. */
  importFiles(files: ReadonlyArray<File>): void;
  /** Forget the folder and its ledger. */
  stop(): Promise<void>;
  cancel(): void;
}

const INITIAL: FolderSyncState = {
  mode: null, loaded: false, handle: null, permission: null, lastScanAt: null, syncedCount: null,
  running: false, progress: null, lastRun: null, error: null, storageAvailable: true,
};

const ALREADY_RUNNING = "Folder Sync is already running in another SC2 Tools tab.";
const UNEXPECTED = "Folder Sync stopped unexpectedly. Try again.";
const NO_REPLAYS =
  "No ladder replays found in that folder. Choose your StarCraft II Accounts folder (or a player folder inside it).";
const PICKER_FAILED = "Your browser didn't open the folder picker. Try again, or drag the folder onto the import area.";

function syncErrorText(error: unknown): string {
  if (!(error instanceof EngineError)) return UNEXPECTED;
  const copy = errorCopy(error.kind);
  return `${copy.title}. ${copy.hint}`;
}

async function loadStoredState(): Promise<Partial<FolderSyncState>> {
  try {
    const handle = await loadFolderHandle();
    const permission = handle ? await queryReadPermission(handle) : null;
    return { handle, permission, lastScanAt: await getLastFolderScanAt(), syncedCount: await syncedReplayCount() };
  } catch {
    trackInstantError({ kind: "storage_unavailable" });
    return { storageAvailable: false };
  }
}

type Patch = (next: Partial<FolderSyncState>) => void;
type StateRef = { readonly current: FolderSyncState };

/** One pass; resolves once its result (or error) is in state. */
async function runOnePass(
  source: FolderSyncSource,
  getToken: TokenGetter,
  signal: AbortSignal,
  patch: Patch,
  stateRef: StateRef,
): Promise<void> {
  try {
    const summary = await runFolderSyncExclusive({
      source, engineFactory: () => createEngineClient(), getToken, apiBase: API_BASE,
      engineVersion: INSTANT_ENGINE_VERSION, profileToons: () => fetchProfileToons(getToken, apiCall),
      now: Date.now, signal, onProgress: (progress) => patch({ progress }),
    });
    if (summary === null) patch({ error: ALREADY_RUNNING });
    else patch({ lastRun: summary, lastScanAt: summary.aborted ? stateRef.current.lastScanAt : Date.now() });
    patch({ syncedCount: await syncedReplayCount().catch(() => stateRef.current.syncedCount) });
  } catch (error) {
    if (error instanceof EngineError) trackInstantError({ kind: error.kind });
    patch({ error: syncErrorText(error) });
  }
}

/** The sync pass itself: one at a time, cancellable, result kept in state. */
function useSyncRunner(patch: Patch, stateRef: StateRef) {
  const { getToken } = useAuth();
  const abortRef = useRef<AbortController | null>(null);
  const passRef = useRef<Promise<void> | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const sync = useCallback(
    (source: FolderSyncSource): Promise<void> => {
      if (passRef.current) return passRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      patch({ running: true, progress: null, error: null });
      const pass = runOnePass(source, getToken, controller.signal, patch, stateRef).finally(() => {
        passRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
        patch({ running: false, progress: null });
      });
      passRef.current = pass;
      return pass;
    },
    [getToken, patch, stateRef],
  );
  const cancel = useCallback(() => abortRef.current?.abort(), []);
  /** Cancels the running pass (if any) and resolves once it has wound down. */
  const cancelAndWait = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    await passRef.current;
  }, []);
  return { sync, cancel, cancelAndWait };
}

/** Folder actions; the picker and permission prompts run inside the click. */
function useFolderActions(patch: Patch, stateRef: StateRef, runner: ReturnType<typeof useSyncRunner>) {
  const { sync, cancel, cancelAndWait } = runner;
  const pickFolder = useCallback(() => {
    // pickReplaysFolder opens the picker synchronously, inside the click.
    void pickReplaysFolder()
      .then(async (handle) => {
        if (!handle) return;
        await saveFolderHandle(handle).catch(() => patch({ storageAvailable: false }));
        patch({ handle, permission: "granted" });
        await sync({ handle });
      })
      .catch(() => patch({ error: PICKER_FAILED }));
  }, [patch, sync]);
  const resume = useCallback(() => {
    const handle = stateRef.current.handle;
    if (!handle) return;
    void requestReadPermission(handle).then(async (permission) => {
      patch({ permission });
      if (permission !== "granted") return;
      trackInstantFolderSyncResume();
      await sync({ handle });
    });
  }, [patch, stateRef, sync]);
  const syncNow = useCallback(() => {
    const { handle, permission } = stateRef.current;
    if (handle && permission === "granted") void sync({ handle });
    else resume();
  }, [resume, stateRef, sync]);
  const importFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      const replays = filesFromDirectoryInput(files);
      if (replays.length === 0) patch({ error: NO_REPLAYS });
      else void sync({ files: replays });
    },
    [patch, sync],
  );
  const stop = useCallback(async () => {
    // Let a running pass wind down first, so none of its results land
    // after the folder and its ledger are forgotten.
    await cancelAndWait();
    await Promise.all([clearFolderHandle(), clearLedger()]).catch(() => undefined);
    patch({ handle: null, permission: null, syncedCount: 0, lastRun: null, error: null });
  }, [cancelAndWait, patch]);
  return { pickFolder, resume, syncNow, importFiles, stop, cancel };
}

/**
 * State + actions for Folder Sync (see module comment).
 *
 * Example:
 *   const folder = useFolderSync();
 *   <Button onClick={folder.pickFolder}>Choose your StarCraft II folder</Button>
 */
export function useFolderSync(): FolderSyncController {
  const [state, setState] = useState<FolderSyncState>(INITIAL);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const patch = useCallback<Patch>((next) => setState((prev) => ({ ...prev, ...next })), []);
  useEffect(() => {
    let alive = true;
    const mode = supportsDirectoryPicker() ? "picker" : "input";
    void loadStoredState().then((stored) => {
      if (alive) patch({ ...stored, mode, loaded: true });
    });
    return () => {
      alive = false;
    };
  }, [patch]);
  const actions = useFolderActions(patch, stateRef, useSyncRunner(patch, stateRef));
  const { handle, ...rest } = state;
  return { ...rest, folderName: handle?.name ?? null, ...actions };
}

const STAGE_LABELS: Record<FolderSyncProgress["stage"], string> = {
  walking: "Looking for replays",
  reading: "Analysing new replays",
  uploading: "Uploading",
};

/**
 * Status line for a running pass.
 *
 * Example:
 *   syncProgressLabel({ stage: "uploading", done: 3, total: 10 }); // -> "Uploading… 3 of 10"
 */
export function syncProgressLabel(progress: FolderSyncProgress | null): string {
  if (!progress || progress.stage === "walking") return `${STAGE_LABELS.walking}… ${progress?.done ?? 0} found`;
  return `${STAGE_LABELS[progress.stage]}… ${Math.min(progress.done, progress.total)} of ${progress.total}`;
}

function SyncBar({ progress }: { progress: FolderSyncProgress }) {
  const done = Math.min(progress.done, progress.total);
  return (
    <div
      role="progressbar"
      aria-label="Folder Sync progress"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={done}
      className="h-2 overflow-hidden rounded-full border border-line bg-bg-surface"
    >
      <div className="h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round((done / progress.total) * 100)}%` }} />
    </div>
  );
}

function SyncProgress({ progress, onCancel }: { progress: FolderSyncProgress | null; onCancel: () => void }) {
  const counting = progress !== null && progress.stage !== "walking" && progress.total > 0;
  return (
    <div className="space-y-2 rounded-lg bg-bg-elevated p-3">
      <p role="status" aria-live="polite" className="text-caption font-semibold text-text">
        {syncProgressLabel(progress)}
      </p>
      {counting ? <SyncBar progress={progress} /> : null}
      {progress?.stage === "reading" && progress.done === 0 ? (
        <p className="text-caption text-text-muted">The first run downloads the analyzer (about 8 MB) once.</p>
      ) : null}
      <Button variant="secondary" onClick={onCancel} iconLeft={<Square className="h-4 w-4" aria-hidden />}>
        Stop this sync
      </Button>
    </div>
  );
}

function FolderStatus({ folder }: { folder: FolderSyncController }) {
  const synced = folder.syncedCount ?? 0;
  return (
    <div className="space-y-1 text-caption text-text-muted">
      <p>
        Syncing <strong className="break-all text-text">{folder.folderName}</strong>
      </p>
      <p>
        Last checked {folder.lastScanAt ? fmtAgo(folder.lastScanAt) : "never"} · {synced} {synced === 1 ? "replay" : "replays"}{" "}
        synced from this folder
      </p>
    </div>
  );
}

function PickerActions({ folder, onStop }: { folder: FolderSyncController; onStop: () => void }) {
  if (!folder.folderName) {
    return (
      <Button onClick={folder.pickFolder} disabled={folder.running} iconLeft={<FolderSync className="h-4 w-4" aria-hidden />}>
        Choose your StarCraft II folder
      </Button>
    );
  }
  const needsGrant = folder.permission === "prompt";
  const denied = folder.permission === "denied";
  return (
    <div className="space-y-2">
      {needsGrant ? <p className="text-caption text-text-muted">Your browser asks for your OK again after it restarts.</p> : null}
      {denied ? <p className="text-caption text-text-muted">Access to this folder was blocked. Choose it again to keep syncing.</p> : null}
      <div className="flex flex-wrap gap-2">
        {denied ? (
          <Button onClick={folder.pickFolder} disabled={folder.running} iconLeft={<FolderSync className="h-4 w-4" aria-hidden />}>
            Choose the folder again
          </Button>
        ) : (
          <Button onClick={needsGrant ? folder.resume : folder.syncNow} disabled={folder.running} iconLeft={needsGrant ? <RotateCcw className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}>
            {needsGrant ? "Resume sync" : "Sync now"}
          </Button>
        )}
        <Button variant="ghost" onClick={onStop} disabled={folder.running}>
          Stop syncing
        </Button>
      </div>
    </div>
  );
}

function InputFallback({ folder }: { folder: FolderSyncController }) {
  const input = useRef<HTMLInputElement | null>(null);
  // `webkitdirectory` is non-standard and missing from React's input types.
  const attach = useCallback((node: HTMLInputElement | null) => {
    input.current = node;
    node?.setAttribute("webkitdirectory", "");
  }, []);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
    event.currentTarget.value = "";
    if (files.length > 0) folder.importFiles(files);
  };
  return (
    <div className="space-y-2">
      <p className="text-caption text-text-muted">
        This browser can&apos;t keep access to a folder between visits — automatic Folder Sync needs Chrome or Edge. You can
        still import a whole folder now; replays already imported are skipped next time.
      </p>
      <Button onClick={() => input.current?.click()} disabled={folder.running} iconLeft={<FolderSync className="h-4 w-4" aria-hidden />}>
        Import a replay folder
      </Button>
      <input ref={attach} type="file" multiple onChange={onChange} tabIndex={-1} aria-label="Replay folder to import" className="sr-only" />
    </div>
  );
}

/**
 * Result of the last pass. A folder without ladder replays is most likely
 * the wrong folder, so that gets its own hint instead of "nothing new";
 * a cancelled pass says so even when it stopped before uploading.
 */
function LastRun({ run }: { run: FolderSyncSummary }) {
  if (run.found === 0 && !run.aborted) return <p className="text-caption text-text-muted">{NO_REPLAYS}</p>;
  if (run.newFiles === 0 && !run.aborted) {
    return <p className="text-caption text-text-muted">No new replays since the last check.</p>;
  }
  const counts: UploadCounts = run.aborted && !run.stoppedReason ? { ...run, stoppedReason: "aborted" } : run;
  return <ImportSummary counts={counts} failed={run.failed} />;
}

/** Mode-specific controls, then progress, errors and the last result. */
function FolderSyncBody({ folder, onStop }: { folder: FolderSyncController; onStop: () => void }) {
  if (!folder.loaded) return <p className="text-caption text-text-muted">Checking Folder Sync…</p>;
  return (
    <>
      {folder.mode === "picker" && folder.folderName ? <FolderStatus folder={folder} /> : null}
      {folder.mode === "picker" ? <PickerActions folder={folder} onStop={onStop} /> : <InputFallback folder={folder} />}
      {!folder.storageAvailable ? (
        <p className="text-caption text-text-muted">This browser won&apos;t let us remember the folder (private window?), so each sync starts fresh.</p>
      ) : null}
      {folder.running ? <SyncProgress progress={folder.progress} onCancel={folder.cancel} /> : null}
      {folder.error ? <p role="alert" className="text-caption text-danger">{folder.error}</p> : null}
      {!folder.running && folder.lastRun ? <LastRun run={folder.lastRun} /> : null}
    </>
  );
}

/** The card body for a given controller. */
function FolderSyncCardView({ folder, className }: { folder: FolderSyncController; className: string }) {
  const headingId = useId();
  const [confirmStop, setConfirmStop] = useState(false);
  return (
    <section
      id="folder-sync"
      aria-labelledby={headingId}
      className={["space-y-4 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard", className].filter(Boolean).join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="font-display text-h4 text-text">Folder Sync</h2>
        <Badge variant="cyan" size="sm">Chrome &amp; Edge</Badge>
      </div>
      <p className="text-caption text-text-muted">
        Pick your StarCraft II folder once. While an SC2 Tools tab is open, new ladder replays are analysed in the browser and
        uploaded — at most every 10 minutes, and only files that changed. Nothing is written to the folder.
      </p>
      <FolderSyncBody folder={folder} onStop={() => setConfirmStop(true)} />
      <details className="rounded-lg border-2 border-line bg-bg-surface px-3">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Where is my StarCraft II folder?
        </summary>
        <OsPathHints className="pb-3" folderPicking />
      </details>
      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void folder.stop();
        }}
        title="Stop syncing this folder?"
        description="This browser forgets the folder and which replays it already uploaded. Games already in your account stay there."
        confirmLabel="Stop syncing"
        intent="danger"
      />
    </section>
  );
}

function OwnFolderSyncCard({ className }: { className: string }) {
  const folder = useFolderSync();
  return <FolderSyncCardView folder={folder} className={className} />;
}

export interface FolderSyncCardProps {
  /** Share state with the import panel; the card creates its own otherwise. */
  controller?: FolderSyncController;
  className?: string;
}

/**
 * Folder Sync settings card (see module comment).
 *
 * Example:
 *   <FolderSyncCard />
 */
export function FolderSyncCard({ controller, className = "" }: FolderSyncCardProps) {
  return controller ? (
    <FolderSyncCardView folder={controller} className={className} />
  ) : (
    <OwnFolderSyncCard className={className} />
  );
}
