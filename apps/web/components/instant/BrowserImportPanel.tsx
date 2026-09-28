"use client";

/**
 * BrowserImportPanel — the signed-in "import in your browser" flow:
 *
 *   pick replays (files, a folder or a .zip; or start Folder Sync)
 *   → analyze them in this tab (the same engine as the desktop agent)
 *   → "which player are you?" when the replays don't say
 *   → upload to the account, remember the confirmed player, and
 *     optionally back up the original .SC2Replay files
 *   → a summary with counts, grouped skips/failures and a link to /app.
 *
 * The backup toggle only appears when the server has a replay store AND
 * has verified that browsers may PUT to it (`/v1/me/replay-archive-status`
 * → `enabled` and `browserUploadReady`; the R2 bucket's CORS rule) and is
 * on by default then, so the intro mentions the replay-file copy exactly
 * when it applies; file hashes are only computed when it is on. The analyzer (Pyodide)
 * warms up on the visitor's first intent to add replays and is otherwise
 * started by "Analyze" (or a dropped .zip).
 *
 * Accessibility: one always-mounted polite status region announces the
 * upload and its result; focus moves to the progress panel, the upload
 * card and the summary as each replaces the control that had focus.
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
import { secondsUntilRetry } from "@/lib/instant/displayUnits";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { errorCopy } from "@/lib/instant/errorCopy";
import { supportsDirectoryPicker } from "@/lib/instant/folderSync";
import { runBrowserUpload, type BrowserUploadProgress, type BrowserUploadSummary } from "@/lib/instant/importRunner";
import { profileToons } from "@/lib/instant/profileHandles";
import { isRunningPhase } from "@/lib/instant/sessionState";
import type { EngineClient } from "@/lib/instant/types";
import { useInstantSession, type InstantSession } from "@/lib/instant/useInstantSession";
import type { FolderSyncController } from "./FolderSyncCard";
import { ImportSummary, importHeadline } from "./ImportSummary";
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
 * Human label for an upload step (games already in the account count as
 * done, so the count reaches the total).
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
    return `Our servers are busy — retrying in ${secondsUntilRetry(upload.retryInMs)} s…`;
  }
  return `Uploading games… ${upload.settled} of ${upload.total}`;
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

/** Visual progress; announced once through the panel's status region, and focused on mount. */
function UploadProgressCard({ progress, onCancel }: { progress: BrowserUploadProgress | null; onCancel: () => void }) {
  const label = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    label.current?.focus();
  }, []);
  return (
    <section aria-label="Upload progress" className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard">
      <p ref={label} tabIndex={-1} className="text-body font-semibold text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
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
      Analyze and upload {count} {count === 1 ? "replay" : "replays"}
    </Button>
  );
}

/** The fields of `GET /v1/me/replay-archive-status` the panel reads. */
interface ReplayArchiveCapability {
  enabled?: boolean;
  /** The server verified R2 accepts browser PUTs (its CORS rule); absent on older APIs. */
  browserUploadReady?: boolean;
}

/**
 * Whether this browser can back up original replays: the server stores
 * them AND has verified R2 accepts PUTs from the site (missing → no).
 *
 * Example:
 *   backupCapability({ enabled: true }); // -> false
 *   backupCapability({ enabled: true, browserUploadReady: true }); // -> true
 */
export function backupCapability(status: ReplayArchiveCapability | null | undefined): boolean {
  return status?.enabled === true && status.browserUploadReady === true;
}

/** Profile toons + backup capability for the signed-in user. */
function useImportContext() {
  const profile = useApi<unknown>("/v1/me/profile");
  const archive = useApi<ReplayArchiveCapability>("/v1/me/replay-archive-status");
  const toons = useMemo(() => profileToons(profile.data), [profile.data]);
  return { profileToons: toons, capability: backupCapability(archive.data) };
}

interface IntakeBlockProps {
  session: InstantSession;
  folderSync?: FolderSyncController;
  pickerSupported: boolean;
  capability: boolean;
  backupChoice: boolean;
  onBackupChoice: (next: boolean) => void;
  /** Bumped to move focus back onto the intake ("Import more replays"). */
  focusKey: number;
}

/**
 * What the last selection left out: nothing usable, or replays beyond the
 * per-run cap. Always mounted so assistive tech announces each change.
 *
 * Example:
 *   <IntakeNotes session={session} />
 */
export function IntakeNotes({ session }: { session: Pick<InstantSession, "lastIntake" | "truncatedCount"> }) {
  const nothingFound = session.lastIntake !== null && session.lastIntake.found === 0;
  const left = session.truncatedCount;
  return (
    <div role="status" className="space-y-1 text-caption empty:hidden">
      {nothingFound ? <p className="font-semibold text-text">No .SC2Replay files in that selection.</p> : null}
      {left > 0 ? (
        <p className="text-text-muted">
          Only the newest {MAX_BROWSER_IMPORT_FILES} replays are imported in one run; {left} older{" "}
          {left === 1 ? "one was" : "ones were"} left out — use Folder Sync (or run again) for the rest.
        </p>
      ) : null}
    </div>
  );
}

function IntakeBlock({ session, folderSync, pickerSupported, capability, backupChoice, onBackupChoice, focusKey }: IntakeBlockProps) {
  return (
    <>
      <ReplayIntake
        onFiles={(files, source) => void session.addFiles(files, source)}
        onIntent={session.prewarm}
        focusKey={focusKey}
        onPickFolder={folderSync && pickerSupported ? folderSync.pickFolder : undefined}
        allowFolderInput={!folderSync}
        disabled={session.busy}
        maxFiles={MAX_BROWSER_IMPORT_FILES}
        dateWindow={session.dateWindow}
        onDateWindowChange={session.setDateWindow}
        fileCount={session.files.length}
        estimate={session.estimate}
      />
      <IntakeNotes session={session} />
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
      truncatedCount={session.truncatedCount}
      autoFocus
    />
  );
}

/**
 * What leaves the device, stated for the current backup setting: the
 * analysis always, a private copy of each replay file only while the
 * backup is available and ticked.
 *
 * Example:
 *   uploadScopeLine(true, true); // -> "…then the results are uploaded to your account, plus a private copy of each replay file…"
 */
export function uploadScopeLine(capability: boolean, backupChoice: boolean): string {
  const base = "Replays are analyzed right here in your browser, then the results are uploaded to your account";
  if (!capability) return `${base} — no download needed.`;
  return backupChoice
    ? `${base}, plus a private copy of each replay file while the backup box below is ticked.`
    : `${base}. Replay files stay on this device (the backup box below is off).`;
}

function PanelIntro({ capability, backupChoice }: { capability: boolean; backupChoice: boolean }) {
  return (
    <div className="space-y-1">
      <h2 className="font-display text-h3 text-text">Import replays in your browser</h2>
      <p className="text-caption text-text-muted">{uploadScopeLine(capability, backupChoice)}</p>
    </div>
  );
}

/** One polite region for the upload's start and result (inserted-with-text regions are often skipped). */
function panelAnnouncement(upload: ReturnType<typeof useBrowserUpload>): string {
  if (upload.status === "uploading") return "Uploading your games…";
  if (upload.status === "done" && upload.summary) return importHeadline(upload.summary);
  return "";
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

/** Everything after "Analyze": player choice, progress, errors, upload, summary. */
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
        <ParseProgress
          progress={session.progress}
          phase={session.phase}
          total={session.files.length}
          failed={session.failed}
          onCancel={session.cancel}
          autoFocus
        />
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
  const [intakeFocusKey, setIntakeFocusKey] = useState(0);
  useEffect(() => {
    trackInstantOpen();
    setPickerSupported(supportsDirectoryPicker());
  }, []);
  const importMore = (): void => {
    upload.reset();
    session.reset();
    setIntakeFocusKey((key) => key + 1);
  };
  return (
    <section aria-label="Import replays in your browser" className={[compact ? "space-y-4" : "space-y-5", className].filter(Boolean).join(" ")}>
      <p role="status" aria-live="polite" className="sr-only">
        {panelAnnouncement(upload)}
      </p>
      {intro ? <PanelIntro capability={capability} backupChoice={backupChoice} /> : null}
      {isIntakePhase(session.phase) ? (
        <IntakeBlock
          session={session}
          folderSync={folderSync}
          pickerSupported={pickerSupported}
          capability={capability}
          backupChoice={backupChoice}
          onBackupChoice={setBackupChoice}
          focusKey={intakeFocusKey}
        />
      ) : null}
      <RunStatus session={session} folderSync={folderSync} upload={upload} compact={compact} onImportMore={importMore} />
    </section>
  );
}
