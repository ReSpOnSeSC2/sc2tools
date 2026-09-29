"use client";

/**
 * TryPage — the anonymous /try flow: pick replays, analyze them in this
 * browser, see an instant report, optionally save the games to a free
 * account.
 *
 *   intake (ReplayIntake) → analysis starts on selection → [PlayerChooser]
 *   → ParseProgress → games stored on this device (7 days) → InstantReport
 *   → "Save these games" card → (sign up → /try?resume=1 → upload → /app)
 *
 * The analyzer (worker + Pyodide) starts warming up on the visitor's first
 * intent to add replays (pressing "Choose replays", dragging files over
 * the drop zone, focusing the intake), never on page load. Replays never
 * leave the device; saving uploads the parsed games only, each tagged
 * with the engine version that parsed it. A revisit within 7 days shows
 * the stored report at once, with "Analyze more replays" to add to it.
 * Keyboard focus follows the flow: into the progress panel when a run
 * starts, onto the intake after "Analyze more replays" or clearing local
 * data, and onto the report when it (re)appears. In "admins" rollout mode
 * everyone but admins sees a "Coming soon" panel instead.
 *
 * Example:
 *   <TryPage mode="all" />
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, FlaskConical, ShieldCheck } from "lucide-react";
import { Button, EmptyStatePanel } from "@/components/ui";
import { trackInstantError, trackInstantOpen, trackInstantReportView } from "@/lib/instant/analytics";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { errorCopy } from "@/lib/instant/errorCopy";
import { MAX_TRY_FILES } from "@/lib/instant/fileIntake";
import type { InstantImportMode } from "@/lib/instant/flag";
import { loadTryGames, saveTryGames, type TryGameInput } from "@/lib/instant/localStore";
import { buildInstantReport, parseInstantPayload, type InstantReport as InstantReportData } from "@/lib/instant/report";
import type { EngineInfo, ErrorKind, IntakeSource, ParsedGame } from "@/lib/instant/types";
import { useInstantImport } from "@/lib/instant/useInstantImport";
import { useInstantSession, type InstantSession, type UseInstantSessionOptions } from "@/lib/instant/useInstantSession";
import { BrowserVsAgentTable } from "./BrowserVsAgentTable";
import { InstantReport } from "./InstantReport";
import { LocalDataControls } from "./LocalDataControls";
import { ParseProgress } from "./ParseProgress";
import { PlayerChooser } from "./PlayerChooser";
import { ReplayIntake } from "./ReplayIntake";
import { SaveGamesCta, TryResume, useTryUpload, type TryUpload } from "./TryResume";

export const PRIVACY_LINE =
  "Your replays are analyzed on this device. Nothing leaves your browser unless you choose to save the games to an account.";

/**
 * /try analyses at most 25 replays (newest kept), 1v1 only, over all time:
 * the cap already bounds the work, and a 90-day window would hide the
 * games of someone who has not played for a while.
 */
export const TRY_SESSION_OPTIONS: UseInstantSessionOptions = {
  maxFiles: MAX_TRY_FILES,
  onlyOneVsOne: true,
  initialDateWindow: { kind: "all" },
};

export interface TryPageProps {
  /** Rollout mode (never "off": the route 404s then). */
  mode: Exclude<InstantImportMode, "off">;
}

function TryHero() {
  return (
    <header className="space-y-4">
      <p className="kicker">No download · No account needed</p>
      {/* The first line keeps the searched-for name ("StarCraft II replay
          analyzer") in the H1 without changing the visual headline. */}
      <h1>
        <span className="block text-body font-semibold text-text-muted">Free StarCraft II replay analyzer</span>
        <span className="mt-1 block font-display text-h1 text-text md:text-display-lg">
          Analyze your replays in your browser
        </span>
      </h1>
      <p className="max-w-prose text-body-lg text-text-muted">
        Drop up to {MAX_TRY_FILES} StarCraft II replays and get an instant report: your record by matchup, your
        openers, your macro and why you lost your last game.
      </p>
      <p className="flex max-w-prose items-start gap-2 rounded-xl border-2 border-line bg-bg-elevated/60 p-3 text-body font-semibold text-text">
        <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" aria-hidden />
        <span>{PRIVACY_LINE}</span>
      </p>
    </header>
  );
}

function ComingSoon() {
  return (
    <EmptyStatePanel
      size="lg"
      icon={<FlaskConical className="h-6 w-6" aria-hidden />}
      title="Coming soon"
      description="Analyzing replays in your browser is being tested with a small group first. Until then, the free desktop agent analyzes every game you play."
      action={
        <Link
          href="/download"
          className="inline-flex min-h-[44px] items-center font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Get the desktop agent
        </Link>
      }
    />
  );
}

function EngineErrorPanel({ kind, onRetry, onReset }: { kind: ErrorKind | null; onRetry: () => void; onReset: () => void }) {
  const copy = errorCopy(kind ?? "engine_unavailable");
  return (
    <div role="alert" className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard">
      <p className="flex items-start gap-2 text-body font-semibold text-text">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" aria-hidden />
        {copy.title}
      </p>
      <p className="text-caption text-text-muted">{copy.hint}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="ghost" onClick={onReset}>
          Start over
        </Button>
      </div>
    </div>
  );
}

interface ToolViewProps {
  session: InstantSession;
  onFiles: (files: File[], source: IntakeSource) => void;
  /** Bumped to move keyboard focus onto the intake (0 = leave focus alone). */
  intakeFocusKey: number;
}

function IntakePanel({ session, onFiles, intakeFocusKey }: ToolViewProps) {
  const count = session.files.length;
  const nothingFound = session.lastIntake !== null && session.lastIntake.found === 0;
  return (
    <div className="space-y-3">
      <ReplayIntake
        onFiles={onFiles}
        onIntent={session.prewarm}
        focusKey={intakeFocusKey}
        disabled={session.busy}
        maxFiles={MAX_TRY_FILES}
        dateWindow={session.dateWindow}
        onDateWindowChange={session.setDateWindow}
        fileCount={count}
        estimate={session.estimate}
        allowFolderInput
      />
      {/* Always mounted so assistive tech announces the note when it appears. */}
      <p role="status" className="flex items-start gap-2 text-caption font-semibold text-text empty:hidden">
        {nothingFound ? (
          <>
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden />
            <span>We didn&apos;t find any StarCraft II replays (.SC2Replay) in that selection.</span>
          </>
        ) : null}
      </p>
      {session.phase === "ready" ? (
        <Button onClick={() => void session.start()}>
          Analyze {count} {count === 1 ? "replay" : "replays"}
        </Button>
      ) : null}
    </div>
  );
}

function ToolBody({ session, onFiles, intakeFocusKey }: ToolViewProps) {
  const { phase } = session;
  if (phase === "choosing") {
    return <PlayerChooser candidates={session.candidates} onChoose={(toon) => void session.choose(toon)} onCancel={session.cancel} />;
  }
  if (phase === "error") {
    return <EngineErrorPanel kind={session.error} onRetry={() => void session.start()} onReset={session.reset} />;
  }
  if (session.busy || phase === "done") {
    return (
      <div className="space-y-3">
        <ParseProgress
          progress={session.progress}
          phase={phase}
          total={session.files.length}
          failed={session.failed}
          onCancel={session.cancel}
          autoFocus={session.busy}
        />
        {phase === "done" && session.parsed.length === 0 ? (
          <div className="space-y-2">
            <p className="text-body font-semibold text-text">None of these replays could be analyzed.</p>
            <Button onClick={session.reset}>Choose other replays</Button>
          </div>
        ) : null}
      </div>
    );
  }
  return <IntakePanel session={session} onFiles={onFiles} intakeFocusKey={intakeFocusKey} />;
}

interface TryToolProps {
  session: InstantSession;
  /** Shown while adding to an existing report: go back without analyzing. */
  onCancelAdding?: () => void;
  intakeFocusKey: number;
}

/**
 * Intake → player question → progress (analysis starts as soon as replays are picked).
 *
 * Example:
 *   <TryTool session={session} />
 */
function TryTool({ session, onCancelAdding, intakeFocusKey }: TryToolProps) {
  const { addFiles, start } = session;
  const onFiles = useCallback(
    (files: File[], source: IntakeSource) => {
      void addFiles(files, source).then(() => start());
    },
    [addFiles, start],
  );
  return (
    <section aria-label="Analyze replays" className="space-y-4">
      <ToolBody session={session} onFiles={onFiles} intakeFocusKey={intakeFocusKey} />
      {session.truncatedCount > 0 ? (
        <p className="text-caption text-text-muted">
          Only the newest {MAX_TRY_FILES} replays are analyzed here; {session.truncatedCount} older{" "}
          {session.truncatedCount === 1 ? "one was" : "ones were"} left out.
        </p>
      ) : null}
      {onCancelAdding && !session.busy && session.phase !== "choosing" ? (
        <Button variant="ghost" onClick={onCancelAdding}>
          Back to your report
        </Button>
      ) : null}
    </section>
  );
}

function toInput(game: TryGameInput): TryGameInput {
  return { gameId: game.gameId, json: game.json, date: game.date, engineVersion: game.engineVersion };
}

/** A finished run's games, tagged with the engine that parsed them. */
function fromParsed(parsed: ReadonlyArray<ParsedGame>, info: EngineInfo | null): TryGameInput[] {
  const engineVersion = info?.engineVersion ?? INSTANT_ENGINE_VERSION;
  return parsed.map((game) => ({ gameId: game.gameId, json: game.json, date: game.date, engineVersion }));
}

/** Union by gameId (newer wins), newest game first. */
function mergeGames(base: ReadonlyArray<TryGameInput>, fresh: ReadonlyArray<TryGameInput>): TryGameInput[] {
  const byId = new Map(base.map((game) => [game.gameId, game]));
  for (const game of fresh) byId.set(game.gameId, game);
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** Save to IndexedDB and read everything back; null when storage is unavailable. */
async function persist(fresh: ReadonlyArray<TryGameInput>): Promise<TryGameInput[] | null> {
  try {
    await saveTryGames(fresh, Date.now());
    return (await loadTryGames(Date.now())).map(toInput);
  } catch {
    // Private mode / blocked site data: keep the games in memory only.
    trackInstantError({ kind: "storage_unavailable" });
    return null;
  }
}

interface TryGames {
  games: TryGameInput[];
  /** False once this browser refused to store games. */
  persisted: boolean;
  clear(): void;
}

/**
 * Games for the report: the ones stored on this device (loaded on mount)
 * plus each finished run's parsed games (saved, then re-read).
 *
 * Example:
 *   const stored = useTryGames(session, () => setAdding(false));
 */
function useTryGames(session: Pick<InstantSession, "phase" | "parsed" | "engineInfo">, onSaved: () => void): TryGames {
  const { phase, parsed, engineInfo } = session;
  const [state, setState] = useState<{ games: TryGameInput[]; persisted: boolean }>({ games: [], persisted: true });
  const onSavedRef = useRef(onSaved);
  const handled = useRef<ParsedGame[] | null>(null);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  useEffect(() => {
    let active = true;
    loadTryGames(Date.now()).then(
      (games) => {
        if (active) setState((prev) => ({ ...prev, games: mergeGames(games.map(toInput), prev.games) }));
      },
      () => undefined, // Unavailable storage is reported when a save fails.
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (phase !== "done" || parsed.length === 0 || handled.current === parsed) return;
    handled.current = parsed;
    const fresh = fromParsed(parsed, engineInfo);
    void persist(fresh).then((saved) => {
      setState((prev) => ({ games: saved ?? mergeGames(prev.games, fresh), persisted: saved !== null }));
      onSavedRef.current();
    });
  }, [phase, parsed, engineInfo]);
  const clear = useCallback(() => setState((prev) => ({ ...prev, games: [] })), []);
  return { ...state, clear };
}

/** Fire `instant_open` once per page view (StrictMode-safe). */
function useTrackOpen(): void {
  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    trackInstantOpen();
  }, []);
}

/** The report over the stored/parsed games (null when none is usable); tracks each view. */
function useReport(games: ReadonlyArray<TryGameInput>): InstantReportData | null {
  const report = useMemo(() => {
    if (games.length === 0) return null;
    const built = buildInstantReport(games.flatMap((game) => parseInstantPayload(game.json) ?? []), new Date());
    return built.totals.games > 0 ? built : null;
  }, [games]);
  const tracked = useRef<InstantReportData | null>(null);
  useEffect(() => {
    if (!report || tracked.current === report) return;
    tracked.current = report;
    trackInstantReportView();
  }, [report]);
  return report;
}

interface WorkspaceState {
  session: InstantSession;
  stored: TryGames;
  upload: TryUpload;
  report: InstantReportData | null;
  /** The intake/progress panel is on screen (no report yet, adding, or a run in flight). */
  showTool: boolean;
  /** Adding to an existing report (shows "Back to your report"). */
  adding: boolean;
  /** Opened as `/try?resume=1`: the save card sits at the top instead. */
  resumeMode: boolean;
  /** Bumped when a finished run refreshed the report (moves focus to it). */
  reportFocusKey: number;
  /** Bumped when the intake should take focus (adding more, after clearing). */
  intakeFocusKey: number;
  markResume(): void;
  startAdding(): void;
  stopAdding(): void;
  onCleared(): void;
}

/**
 * State + actions behind the /try workspace (session, stored games,
 * upload, report, "adding more" mode).
 *
 * Example:
 *   const ws = useWorkspace();
 *   ws.showTool ? <TryTool session={ws.session} /> : null
 */
function useWorkspace(): WorkspaceState {
  useTrackOpen();
  const session = useInstantSession(TRY_SESSION_OPTIONS);
  const [adding, setAdding] = useState(false);
  const [resumeMode, setResumeMode] = useState(false);
  const [reportFocusKey, setReportFocusKey] = useState(0);
  const [intakeFocusKey, setIntakeFocusKey] = useState(0);
  const stored = useTryGames(session, () => {
    setAdding(false);
    setReportFocusKey((key) => key + 1);
  });
  const upload = useTryUpload();
  const report = useReport(stored.games);
  const markResume = useCallback(() => setResumeMode(true), []);
  const { reset } = session;
  const focusIntake = () => setIntakeFocusKey((key) => key + 1);
  const startAdding = () => {
    reset();
    setAdding(true);
    focusIntake();
  };
  const stopAdding = () => {
    reset();
    setAdding(false);
    setReportFocusKey((key) => key + 1);
  };
  const onCleared = () => {
    stored.clear();
    reset();
    setAdding(false);
    focusIntake();
  };
  const active = session.busy || session.phase === "choosing" || session.phase === "error";
  const showTool = report === null || adding || active;
  return {
    session, stored, upload, report, showTool, adding, resumeMode, reportFocusKey, intakeFocusKey,
    markResume, startAdding, stopAdding, onCleared,
  };
}

/** The report, the save card and the local-data controls (only once a report exists). */
function ReportArea({ ws }: { ws: WorkspaceState }) {
  if (!ws.report) return null;
  const moreButton = (
    <Button variant="secondary" onClick={ws.startAdding}>
      Analyze more replays
    </Button>
  );
  return (
    <>
      <InstantReport report={ws.report} actions={ws.showTool ? null : moreButton} focusKey={ws.reportFocusKey} />
      {ws.resumeMode ? null : <SaveGamesCta upload={ws.upload} games={ws.stored.games} />}
      <LocalDataControls persisted={ws.stored.persisted} onCleared={ws.onCleared} />
    </>
  );
}

/** What the last run skipped, kept above the report once the tool has closed. */
function RunFailures({ session }: { session: InstantSession }) {
  if (session.phase !== "done" || session.failed.length === 0) return null;
  return <ParseProgress progress={null} phase="done" total={session.files.length} failed={session.failed} onCancel={session.cancel} />;
}

function Workspace() {
  const ws = useWorkspace();
  return (
    <div className="space-y-8">
      <Suspense fallback={null}>
        <TryResume upload={ws.upload} games={ws.stored.games} onResume={ws.markResume} />
      </Suspense>
      {ws.showTool ? (
        <TryTool
          session={ws.session}
          onCancelAdding={ws.report && ws.adding ? ws.stopAdding : undefined}
          intakeFocusKey={ws.intakeFocusKey}
        />
      ) : (
        <RunFailures session={ws.session} />
      )}
      <ReportArea ws={ws} />
      <BrowserVsAgentTable />
    </div>
  );
}

function AdminGate() {
  const gate = useInstantImport();
  if (gate.loading) {
    return (
      <p role="status" className="text-body text-text-muted">
        Checking access…
      </p>
    );
  }
  return gate.enabled ? <Workspace /> : <ComingSoon />;
}

/**
 * The /try page body (see module comment).
 *
 * Example:
 *   <TryPage mode={getInstantImportMode() === "all" ? "all" : "admins"} />
 */
export function TryPage({ mode }: TryPageProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <TryHero />
      {mode === "all" ? <Workspace /> : <AdminGate />}
    </div>
  );
}
