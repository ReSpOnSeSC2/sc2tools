"use client";

/**
 * BrowserImportPanel — the signed-in "import in your browser" flow:
 *
 *   pick replays (files, a folder or a .zip; or start Folder Sync)
 *   → analyse them in this tab (the same engine as the desktop agent)
 *   → "which player are you?" when the replays don't say
 *   → upload to the account, remember the confirmed player, and
 *     optionally back up the original .SC2Replay files
 *   → a summary with counts, grouped skips/failures and a link to /app.
 *
 * The backup toggle only appears when the server has a replay store
 * (`/v1/me/replay-archive-status` → `enabled`) and is on by default then;
 * file hashes are only computed when it is on. The analyzer (Pyodide)
 * starts only when the visitor presses "Analyse" (or drops a .zip).
 *
 * Example:
 *   <BrowserImportPanel onDone={(summary) => setImported(summary.uploaded)} />
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui";
import { API_BASE, useApi } from "@/lib/clientApi";
import { trackInstantOpen } from "@/lib/instant/analytics";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { errorCopy } from "@/lib/instant/errorCopy";
import { supportsDirectoryPicker } from "@/lib/instant/folderSync";
import { runBrowserUpload, type BrowserUploadProgress, type BrowserUploadSummary } from "@/lib/instant/importRunner";
import { profileToons } from "@/lib/instant/profileHandles";
import { isRunningPhase } from "@/lib/instant/sessionState";
import type { EngineClient } from "@/lib/instant/types";
import { useInstantSession, type InstantSession } from "@/lib/instant/useInstantSession";
import type { FolderSyncController } from "./FolderSyncCard";
import { ImportSummary } from "./ImportSummary";
import { ParseProgress } from "./ParseProgress";
import { PlayerChooser } from "./PlayerChooser";
import { ReplayIntake } from "./ReplayIntake";

/**
 * Replays per browser run: every parsed payload is held in memory until it
 * is uploaded, so whole libraries go through Folder Sync (chunked) instead.
 */
export const MAX_BROWSER_IMPORT_FILES = 500;

export interface BrowserImportPanelProps {
  /** Tighter layout without the intro or the dashboard link (onboarding). */
  compact?: boolean;
  /** Show the panel's own heading + intro; defaults to `!compact`. */
  intro?: boolean;
  onDone?: (summary: BrowserUploadSummary) => void;
  /** Shared Folder Sync state; enables "Sync a replay folder" in Chrome/Edge. */
  folderSync?: FolderSyncController;
  /** Engine factory (tests inject a mock). */
  clientFactory?: () => EngineClient;
  className?: string;
}

type UploadStatus = "idle" | "uploading" | "done" | "error";

interface UploadState {
  status: UploadStatus;
  progress: BrowserUploadProgress | null;
  summary: BrowserUploadSummary | null;
}

const IDLE_UPLOAD: UploadState = { status: "idle", progress: null, summary: null };

const NOTHING_TO_UPLOAD: BrowserUploadSummary = {
  uploaded: 0, created: 0, skippedExisting: 0, rejected: 0, pending: 0,
  backup: null, backupSkipped: "nothing_to_back_up", toonsSaved: false,
};

/**
 * Human label for an upload step.
 *
 * Example:
 *   uploadStageLabel({ stage: "backup", done: 2, total: 5 }); // -> "Backing up original replay files… 2 of 5"
 */
export function uploadStageLabel(progress: BrowserUploadProgress | null): string {
  if (!progress) return "Preparing the upload…";
  if (progress.stage === "profile") return "Remembering which player is you…";
  if (progress.stage === "backup") return `Backing up original replay files… ${progress.done} of ${progress.total}`;
  const { upload } = progress;
  if (upload.phase === "checking") return "Checking which games your account already has…";
  if (upload.phase === "waiting") {
    return `Our servers are busy — retrying in ${Math.ceil((upload.retryInMs ?? 0) / 1000)} s…`;
  }
  return `Uploading games… ${upload.accepted} of ${upload.total}`;
}

/** Upload the finished session's games once; cancellable. */
function useBrowserUpload(
  session: InstantSession,
  backup: { enabled: boolean; capabilityEnabled: boolean },
  onDone?: (summary: BrowserUploadSummary) => void,
) {
  const { getToken } = useAuth();
  const [state, setState] = useState<UploadState>(IDLE_UPLOAD);
  const abortRef = useRef<AbortController | null>(null);
  const startedFor = useRef<InstantSession["parsedWithFiles"] | null>(null);
  const settings = useRef({ backup, onDone });
  useEffect(() => {
    settings.current = { backup, onDone };
  });
  useEffect(() => () => abortRef.current?.abort(), []);

  const upload = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setState({ status: "uploading", progress: null, summary: null });
    try {
      const summary = session.parsedWithFiles.length === 0 ? NOTHING_TO_UPLOAD : await runBrowserUpload({
        parsedWithFiles: session.parsedWithFiles, getToken, apiBase: API_BASE, engineVersion: INSTANT_ENGINE_VERSION,
        backup: settings.current.backup, confirmedToons: session.chosenToon ? [session.chosenToon] : [],
        signal: controller.signal, onProgress: (progress) => setState((prev) => ({ ...prev, progress })),
      });
      if (abortRef.current !== controller) return; // reset or replaced meanwhile
      setState({ status: "done", progress: null, summary });
      settings.current.onDone?.(summary);
    } catch {
      if (abortRef.current !== controller) return; // reset or replaced meanwhile
      setState({ status: "error", progress: null, summary: null });
    }
  }, [getToken, session.chosenToon, session.parsedWithFiles]);

  useEffect(() => {
    if (session.phase !== "done" || startedFor.current === session.parsedWithFiles) return;
    startedFor.current = session.parsedWithFiles;
    void upload();
  }, [session.phase, session.parsedWithFiles, upload]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    startedFor.current = null;
    setState(IDLE_UPLOAD);
  }, []);
  const cancel = useCallback(() => abortRef.current?.abort(), []);
  return { ...state, retry: upload, reset, cancel };
}

function BackupToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (next: boolean) => void; disabled: boolean }) {
  const hintId = useId();
  return (
    <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border-2 border-line bg-bg-surface px-3 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={disabled}
        aria-describedby={hintId}
        className="mt-1 h-4 w-4 flex-shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      />
      <span className="min-w-0">
        <span className="block text-caption font-semibold text-text">Also back up original replay files</span>
        <span id={hintId} className="block text-caption text-text-muted">
          Keeps a private copy of each .SC2Replay in your account so you can download it later.
        </span>
      </span>
    </label>
  );
}

function UploadProgressCard({ progress, onCancel }: { progress: BrowserUploadProgress | null; onCancel: () => void }) {
  return (
    <section aria-label="Upload progress" className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard">
      <p role="status" aria-live="polite" className="text-body font-semibold text-text">
        {uploadStageLabel(progress)}
      </p>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </section>
  );
}

function EngineErrorCard({ session, onStartOver }: { session: InstantSession; onStartOver: () => void }) {
  if (!session.error) return null;
  const copy = errorCopy(session.error);
  return (
    <div role="alert" className="space-y-2 rounded-xl border-2 border-danger/50 bg-danger/10 p-4">
      <p className="text-body font-semibold text-text">{copy.title}</p>
      <p className="text-caption text-text-muted">{copy.hint}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void session.start()}>
          Try again
        </Button>
        <Button variant="ghost" onClick={onStartOver}>
          Start over
        </Button>
      </div>
    </div>
  );
}

function StartButton({ session }: { session: InstantSession }) {
  const count = session.files.length;
  if (session.phase !== "ready" || count === 0) return null;
  return (
    <Button size="lg" onClick={() => void session.start()} disabled={session.expanding} iconLeft={<Play className="h-4 w-4" aria-hidden />}>
      Analyse and upload {count} {count === 1 ? "replay" : "replays"}
    </Button>
  );
}

/** Profile toons + backup capability for the signed-in user. */
function useImportContext() {
  const profile = useApi<unknown>("/v1/me/profile");
  const archive = useApi<{ enabled?: boolean }>("/v1/me/replay-archive-status");
  const toons = useMemo(() => profileToons(profile.data), [profile.data]);
  return { profileToons: toons, capability: archive.data?.enabled === true };
}

interface IntakeBlockProps {
  session: InstantSession;
  folderSync?: FolderSyncController;
  pickerSupported: boolean;
  capability: boolean;
  backupChoice: boolean;
  onBackupChoice: (next: boolean) => void;
}

function IntakeBlock({ session, folderSync, pickerSupported, capability, backupChoice, onBackupChoice }: IntakeBlockProps) {
  return (
    <>
      <ReplayIntake
        onFiles={(files, source) => void session.addFiles(files, source)}
        onPickFolder={folderSync && pickerSupported ? folderSync.pickFolder : undefined}
        allowFolderInput={!folderSync}
        disabled={session.busy}
        maxFiles={MAX_BROWSER_IMPORT_FILES}
        dateWindow={session.dateWindow}
        onDateWindowChange={session.setDateWindow}
        fileCount={session.files.length}
        estimate={session.estimate}
      />
      {capability ? <BackupToggle checked={backupChoice} onChange={onBackupChoice} disabled={session.busy} /> : null}
      <StartButton session={session} />
    </>
  );
}

function UploadResult({
  upload,
  session,
  compact,
  onImportMore,
}: {
  upload: ReturnType<typeof useBrowserUpload>;
  session: InstantSession;
  compact: boolean;
  onImportMore: () => void;
}) {
  if (upload.status === "uploading") return <UploadProgressCard progress={upload.progress} onCancel={upload.cancel} />;
  if (upload.status === "error") {
    return (
      <div role="alert" className="space-y-2 rounded-xl border-2 border-danger/50 bg-danger/10 p-4">
        <p className="text-body font-semibold text-text">The upload stopped unexpectedly</p>
        <p className="text-caption text-text-muted">Try again — games already uploaded are skipped automatically.</p>
        <Button variant="secondary" onClick={() => void upload.retry()}>Try again</Button>
      </div>
    );
  }
  if (upload.status !== "done" || !upload.summary) return null;
  return (
    <ImportSummary
      counts={upload.summary}
      backup={upload.summary.backup}
      failed={session.failed}
      onImportMore={onImportMore}
      showDashboardLink={!compact}
    />
  );
}

function PanelIntro() {
  return (
    <div className="space-y-1">
      <h2 className="font-display text-h3 text-text">Import replays in your browser</h2>
      <p className="text-caption text-text-muted">
        Replays are analysed right here, then only the analysis is uploaded to your account — no download needed.
      </p>
    </div>
  );
}

function isIntakePhase(phase: InstantSession["phase"]): boolean {
  return phase === "idle" || phase === "ready";
}

interface RunStatusProps {
  session: InstantSession;
  folderSync?: FolderSyncController;
  upload: ReturnType<typeof useBrowserUpload>;
  compact: boolean;
  onImportMore: () => void;
}

/** Everything after "Analyse": player choice, progress, errors, upload, summary. */
function RunStatus({ session, folderSync, upload, compact, onImportMore }: RunStatusProps) {
  const parsing = isRunningPhase(session.phase) && session.phase !== "choosing";
  return (
    <>
      {folderSync?.running ? (
        <p role="status" className="text-caption text-text-muted">Syncing your replay folder — progress is shown under Folder Sync.</p>
      ) : null}
      {session.phase === "choosing" ? (
        <PlayerChooser candidates={session.candidates} onChoose={(toon) => void session.choose(toon)} onCancel={session.cancel} />
      ) : null}
      {parsing ? (
        <ParseProgress progress={session.progress} phase={session.phase} total={session.files.length} failed={session.failed} onCancel={session.cancel} />
      ) : null}
      {session.phase === "error" ? <EngineErrorCard session={session} onStartOver={onImportMore} /> : null}
      <UploadResult upload={upload} session={session} compact={compact} onImportMore={onImportMore} />
    </>
  );
}

/**
 * Signed-in browser import (see module comment).
 *
 * Example:
 *   <BrowserImportPanel compact onDone={() => setDone(true)} />
 */
export function BrowserImportPanel(props: BrowserImportPanelProps) {
  const { compact = false, intro = !compact, onDone, folderSync, clientFactory, className = "" } = props;
  const { profileToons: toons, capability } = useImportContext();
  const [backupChoice, setBackupChoice] = useState(true);
  const [pickerSupported, setPickerSupported] = useState(false);
  const session = useInstantSession({
    profileToons: toons,
    onlyOneVsOne: false,
    wantDigests: backupChoice && capability,
    maxFiles: MAX_BROWSER_IMPORT_FILES,
    clientFactory,
  });
  const upload = useBrowserUpload(session, { enabled: backupChoice, capabilityEnabled: capability }, onDone);
  useEffect(() => {
    trackInstantOpen();
    setPickerSupported(supportsDirectoryPicker());
  }, []);
  const importMore = (): void => {
    upload.reset();
    session.reset();
  };
  return (
    <section aria-label="Import replays in your browser" className={[compact ? "space-y-4" : "space-y-5", className].filter(Boolean).join(" ")}>
      {intro ? <PanelIntro /> : null}
      {isIntakePhase(session.phase) ? (
        <IntakeBlock
          session={session}
          folderSync={folderSync}
          pickerSupported={pickerSupported}
          capability={capability}
          backupChoice={backupChoice}
          onBackupChoice={setBackupChoice}
        />
      ) : null}
      <RunStatus session={session} folderSync={folderSync} upload={upload} compact={compact} onImportMore={importMore} />
    </section>
  );
}
