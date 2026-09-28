"use client";

/**
 * FolderSyncCard — keep the account in sync with the visitor's StarCraft II
 * replay folder, straight from the browser.
 *
 *   Chrome / Edge (File System Access API): "Choose your StarCraft II
 *   folder" once; the read-only handle is remembered on this device for
 *   the signed-in account, new replays are uploaded each time the visitor
 *   opens or returns to the SC2 Tools dashboard (see
 *   FolderSyncAutoRunner), and after a browser restart one click on
 *   "Resume sync" re-grants read access. "Stop syncing" forgets the folder
 *   and its ledger. A folder remembered for another account shows a
 *   "Use this folder for this account" prompt instead of any sync control.
 *   Firefox / Safari: no persistent folder access, so the card explains
 *   that and offers a one-off folder import (`<input webkitdirectory>`)
 *   through the same runner — the ledger still skips replays already done,
 *   and "Forget import history" clears it.
 *
 * State and actions live in `useFolderSync()` so the import panel's
 * "Sync a replay folder" button can start the same flow (the folder
 * picker must be opened synchronously inside that click).
 *
 * Example:
 *   const folderSync = useFolderSync();
 *   <BrowserImportPanel folderSync={folderSync} />
 *   <FolderSyncCard controller={folderSync} />
 */
import { useCallback, useId, useRef, useState, type ChangeEvent } from "react";
import { FolderSync, Play, RotateCcw, Square } from "lucide-react";
import { Badge, Button, ConfirmDialog } from "@/components/ui";
import { fmtAgo } from "@/lib/format";
import { percentOf } from "@/lib/instant/displayUnits";
import { AUTO_SCAN_INTERVAL_MINUTES } from "@/lib/instant/folderSync";
import type { FolderSyncProgress, FolderSyncSummary } from "@/lib/instant/folderSyncRunner";
import type { UploadCounts } from "@/lib/instant/importRunner";
import { ImportSummary } from "./ImportSummary";
import { OsPathHints } from "./OsPathHints";
import { NO_REPLAYS, useFolderSync, type FolderSyncController } from "./useFolderSync";

export { useFolderSync, type FolderSyncController } from "./useFolderSync";

const STAGE_LABELS: Record<FolderSyncProgress["stage"], string> = {
  walking: "Looking for replays",
  reading: "Analyzing new replays",
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
      <div className="h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${percentOf(done, progress.total)}%` }} />
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

/** A folder is remembered, but for another account: nothing syncs until this account claims it. */
function OwnerMismatch({ folder }: { folder: FolderSyncController }) {
  return (
    <div className="space-y-2">
      <p className="text-caption text-text-muted">
        <span className="block font-semibold text-text">Folder Sync in this browser was set up by another account.</span>
        Nothing from <strong className="break-all text-text">{folder.folderName}</strong> is synced into your account
        until you choose to use it here. Its sync history on this device is cleared first.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={folder.claimForThisAccount} disabled={folder.running} iconLeft={<FolderSync className="h-4 w-4" aria-hidden />}>
          Use this folder for this account
        </Button>
        <Button variant="ghost" onClick={folder.pickFolder} disabled={folder.running}>
          Choose another folder
        </Button>
      </div>
    </div>
  );
}

function InputFallback({ folder, onForget }: { folder: FolderSyncController; onForget: () => void }) {
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
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => input.current?.click()} disabled={folder.running} iconLeft={<FolderSync className="h-4 w-4" aria-hidden />}>
          Import a replay folder
        </Button>
        {(folder.historyCount ?? 0) > 0 ? (
          <Button variant="ghost" onClick={onForget} disabled={folder.running}>
            Forget import history
          </Button>
        ) : null}
      </div>
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

function ModeControls({ folder, onStop }: { folder: FolderSyncController; onStop: () => void }) {
  if (folder.mode !== "picker") return <InputFallback folder={folder} onForget={onStop} />;
  if (folder.ownerMismatch) return <OwnerMismatch folder={folder} />;
  return (
    <>
      {folder.folderName ? <FolderStatus folder={folder} /> : null}
      <PickerActions folder={folder} onStop={onStop} />
    </>
  );
}

/** Mode-specific controls, then progress, errors and the last result. */
function FolderSyncBody({ folder, onStop }: { folder: FolderSyncController; onStop: () => void }) {
  if (!folder.loaded) return <p className="text-caption text-text-muted">Checking Folder Sync…</p>;
  return (
    <>
      <ModeControls folder={folder} onStop={onStop} />
      {!folder.storageAvailable ? (
        <p className="text-caption text-text-muted">This browser won&apos;t let us remember the folder (private window?), so each sync starts fresh.</p>
      ) : null}
      {folder.running ? <SyncProgress progress={folder.progress} onCancel={folder.cancel} /> : null}
      {folder.error ? <p role="alert" className="text-caption text-danger">{folder.error}</p> : null}
      {!folder.running && folder.lastRun ? <LastRun run={folder.lastRun} /> : null}
    </>
  );
}

/**
 * What the card promises, per mode: automatic sync only happens where the
 * folder can be remembered, and only when the dashboard is opened or
 * returned to (see FolderSyncAutoRunner).
 *
 * Example:
 *   folderSyncIntro("picker"); // -> "Pick your StarCraft II folder once. Each time you open…"
 */
export function folderSyncIntro(mode: FolderSyncController["mode"]): string {
  if (mode === "input") {
    return "Import your whole StarCraft II folder at once; replays already imported from it are skipped next time. Nothing is written to the folder.";
  }
  return (
    `Pick your StarCraft II folder once. Each time you open or return to your SC2 Tools dashboard (at most every ${AUTO_SCAN_INTERVAL_MINUTES} ` +
    "minutes), new ladder replays are analyzed in the browser and uploaded — only files that changed. Nothing is written to the folder."
  );
}

function StopDialog({ folder, open, onClose }: { folder: FolderSyncController; open: boolean; onClose: () => void }) {
  const picker = folder.mode === "picker";
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={() => {
        onClose();
        void folder.stop();
      }}
      title={picker ? "Stop syncing this folder?" : "Forget import history?"}
      description={
        picker
          ? "This browser forgets the folder and which replays it already uploaded. Games already in your account stay there."
          : "This browser forgets which replays it already imported (their file names and dates). Games already in your account stay there; a later import checks every replay again."
      }
      confirmLabel={picker ? "Stop syncing" : "Forget import history"}
      intent="danger"
    />
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
        {folder.mode === "picker" ? <Badge variant="cyan" size="sm">Chrome &amp; Edge</Badge> : null}
      </div>
      {folder.mode ? <p className="text-caption text-text-muted">{folderSyncIntro(folder.mode)}</p> : null}
      <FolderSyncBody folder={folder} onStop={() => setConfirmStop(true)} />
      <details className="rounded-lg border-2 border-line bg-bg-surface px-3">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Where is my StarCraft II folder?
        </summary>
        <OsPathHints className="pb-3" folderPicking />
      </details>
      <StopDialog folder={folder} open={confirmStop} onClose={() => setConfirmStop(false)} />
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
